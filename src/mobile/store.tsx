import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import catalogJson from '../../production/catalog/creatures.json';
import { CreatureCatalogEntry, GachaResult, GachaState, OwnedCreature, Rarity } from './domain';
import { mobileApi, ServerGameState } from './api';

export type FeedEvent = { id: string; source: 'Claude Code' | 'Codex'; title: string; tokens: number; xp: number; consumed: boolean };
export const catalog = catalogJson as unknown as CreatureCatalogEntry[];

type UsageDay = { day: string; claude: number; codex: number };
type MobileStore = {
  catalog: CreatureCatalogEntry[]; gacha: GachaState; feed: FeedEvent[]; selected: OwnedCreature;
  weeklyUsage: UsageDay[]; lastDraw?: GachaResult; loading: boolean; ready: boolean; error?: string;
  activityBoost: number;
  rarityWeights: Record<Rarity, number>; drawing: boolean; feeding: boolean;
  selectCreature: (instanceId: string) => void;
  draw: () => Promise<void>; feedCreature: (eventId: string) => Promise<void>; refresh: () => Promise<void>;
};

const emptyStarter: OwnedCreature = { instanceId: 'none', creatureId: 'PG-001', level: 1, xp: 0, hunger: 0, uniqueColor: false };
const initialGacha: GachaState = { tokens: 0, pity: 0, inventory: [], seed: 0 };
const MobileStoreContext = createContext<MobileStore | null>(null);

function mapState(state: ServerGameState) {
  const inventory: OwnedCreature[] = state.creatures.map((item) => ({
    instanceId: item.id, creatureId: item.catalogId, level: item.level, xp: Number(item.experience),
    hunger: Math.min(100, item.affection), uniqueColor: item.uniqueColor,
  }));
  const claude = Number(state.weeklyUsage.claude_code ?? 0), codex = Number(state.weeklyUsage.codex ?? 0);
  const food = state.items.find((item) => item.itemType === 'food')?.quantity ?? 0;
  return {
    gacha: { tokens: Number(state.tokenBalance), pity: state.pityCount, inventory, seed: 0 },
    usage: [{ day: '금주', claude, codex }],
    activityBoost: state.activityBoost,
    rarityWeights: state.rarityWeights,
    feed: [{ id: 'food', source: 'Claude Code' as const, title: `보유 먹이 · ${food}개`, tokens: claude + codex, xp: 100, consumed: food <= 0 }],
  };
}

export function MobileStoreProvider({ children }: PropsWithChildren) {
  const [gacha, setGacha] = useState(initialGacha);
  const [weeklyUsage, setWeeklyUsage] = useState<UsageDay[]>([{ day: '금주', claude: 0, codex: 0 }]);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [lastDraw, setLastDraw] = useState<GachaResult>();
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [activityBoost, setActivityBoost] = useState(0);
  const [rarityWeights, setRarityWeights] = useState<Record<Rarity, number>>({ PROCESS: 55, AGENT: 25, DAEMON: 12, ORACLE: 6, ARCHITECT: 1.8, ORIGIN: 0.2 });
  const [selectedID, setSelectedID] = useState<string>();
  const [drawing, setDrawing] = useState(false);
  const [feeding, setFeeding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const mapped = mapState(await mobileApi.state());
      setGacha(mapped.gacha); setWeeklyUsage(mapped.usage); setFeed(mapped.feed); setActivityBoost(mapped.activityBoost); setRarityWeights(mapped.rarityWeights); setError(undefined); setReady(true);
    } catch (caught) { setError((caught as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const draw = useCallback(async () => {
    if (drawing) return;
    setDrawing(true);
    try {
      const result = await mobileApi.draw();
      await refresh();
      const creature = catalog.find((item) => item.id === result.creature.catalogId);
      if (creature) {
        const owned: OwnedCreature = { instanceId: result.creature.id, creatureId: creature.id, level: 1, xp: 0, hunger: 0, uniqueColor: result.creature.uniqueColor };
        setLastDraw({ creature, owned, forcedByPity: gacha.pity >= 300, next: gacha });
      }
    } catch (caught) { setError((caught as Error).message); throw caught; }
    finally { setDrawing(false); }
  }, [drawing, gacha, refresh]);

  const feedCreature = useCallback(async (_eventId: string) => {
    if (feeding) return;
    const selected = gacha.inventory.find((item) => item.instanceId === selectedID) ?? gacha.inventory[0]; if (!selected) return;
    setFeeding(true);
    try { await mobileApi.feed(selected.instanceId); await refresh(); }
    catch (caught) { setError((caught as Error).message); throw caught; }
    finally { setFeeding(false); }
  }, [feeding, gacha.inventory, refresh, selectedID]);

  const selected = gacha.inventory.find((item) => item.instanceId === selectedID) ?? gacha.inventory[0] ?? emptyStarter;
  const value = useMemo<MobileStore>(() => ({ catalog, gacha, feed, selected, weeklyUsage, lastDraw, loading, ready, error, activityBoost, rarityWeights, drawing, feeding, selectCreature: setSelectedID, draw, feedCreature, refresh }),
    [gacha, feed, selected, weeklyUsage, lastDraw, loading, ready, error, activityBoost, rarityWeights, drawing, feeding, draw, feedCreature, refresh]);
  return <MobileStoreContext.Provider value={value}>{children}</MobileStoreContext.Provider>;
}

export function useMobileStore() {
  const value = useContext(MobileStoreContext);
  if (!value) throw new Error('useMobileStore must be used inside MobileStoreProvider');
  return value;
}
