export const GACHA_COST = 500_000;
export const ORIGIN_PITY_LIMIT = 300;
export const WEEKLY_USAGE_FOR_MAXIMUM_BONUS = 5_000_000;

export const RARITIES = [
  'PROCESS',
  'AGENT',
  'DAEMON',
  'ORACLE',
  'ARCHITECT',
  'ORIGIN',
] as const;

export type Rarity = (typeof RARITIES)[number];

export type CreatureCatalogEntry = {
  id: string;
  koName: string;
  enName: string;
  lineageId: string;
  category: string;
  stage: number;
  rarity: Rarity;
  bodyForm: string;
  tone: string;
  identity: string;
  lore: string;
  shapeDNA: string[];
  palette: { primary: string; secondary: string; glow: string };
  sharedMotifs: string[];
  evolutionFrom: string | string[] | null;
  imagePath: string;
};

export type OwnedCreature = {
  instanceId: string;
  creatureId: string;
  level: number;
  xp: number;
  hunger: number;
  uniqueColor: boolean;
};

export type GachaState = {
  tokens: number;
  pity: number;
  inventory: OwnedCreature[];
  seed: number;
};

export type GachaResult = {
  next: GachaState;
  creature: CreatureCatalogEntry;
  owned: OwnedCreature;
  forcedByPity: boolean;
};

const BASE_WEIGHTS: Record<Rarity, number> = {
  PROCESS: 55,
  AGENT: 25,
  DAEMON: 12,
  ORACLE: 6,
  ARCHITECT: 1.8,
  ORIGIN: 0.2,
};

export function nextRandom(seed: number) {
  const nextSeed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return { seed: nextSeed, value: nextSeed / 4_294_967_296 };
}

export function activityAdjustedWeights(activityBoost: number): Record<Rarity, number> {
  const boost = Math.max(0, Math.min(1, activityBoost));
  return {
    PROCESS: 55 - 15 * boost,
    AGENT: 25 + 1 * boost,
    DAEMON: 12 + 4 * boost,
    ORACLE: 6 + 5 * boost,
    ARCHITECT: 1.8 + 4.2 * boost,
    ORIGIN: 0.2 + 0.8 * boost,
  };
}

export function selectRarity(value: number, weights: Record<Rarity, number>): Rarity {
  let cursor = value * 100;
  for (const rarity of RARITIES) {
    cursor -= weights[rarity];
    if (cursor < 0) return rarity;
  }
  return 'ORIGIN';
}

export function drawGacha(
  state: GachaState,
  catalog: CreatureCatalogEntry[],
  activityBoost = 0,
): GachaResult {
  if (state.tokens < GACHA_COST) throw new Error('토큰이 부족합니다.');
  if (catalog.length === 0) throw new Error('크리처 카탈로그가 비어 있습니다.');

  const rarityRoll = nextRandom(state.seed);
  const forcedByPity = state.pity >= ORIGIN_PITY_LIMIT;
  const rarity = forcedByPity
    ? 'ORIGIN'
    : selectRarity(rarityRoll.value, activityAdjustedWeights(activityBoost));
  const candidates = catalog.filter((entry) => entry.rarity === rarity);
  if (candidates.length === 0) throw new Error(`${rarity} 등급 카탈로그가 비어 있습니다.`);
  const pool = candidates;
  const creatureRoll = nextRandom(rarityRoll.seed);
  const creature = pool[Math.floor(creatureRoll.value * pool.length)] ?? pool[0];
  const colorRoll = nextRandom(creatureRoll.seed);
  const uniqueColor = colorRoll.value < 0.001;
  const owned: OwnedCreature = {
    instanceId: `${creature.id}-${state.inventory.length + 1}-${colorRoll.seed}`,
    creatureId: creature.id,
    level: 1,
    xp: 0,
    hunger: 18,
    uniqueColor,
  };

  return {
    creature,
    owned,
    forcedByPity,
    next: {
      tokens: state.tokens - GACHA_COST,
      pity: rarity === 'ORIGIN' ? 0 : state.pity + 1,
      inventory: [...state.inventory, owned],
      seed: colorRoll.seed,
    },
  };
}

export function addGrowth(creature: OwnedCreature, xp: number): OwnedCreature {
  const totalXp = Math.max(0, creature.xp + xp);
  const level = Math.floor(totalXp / 1_000) + 1;
  return {
    ...creature,
    xp: totalXp,
    level,
    hunger: Math.min(100, creature.hunger + Math.max(8, Math.round(xp / 80))),
  };
}

export function weeklyTotal(days: Array<{ claude: number; codex: number }>) {
  return days.reduce((total, day) => total + day.claude + day.codex, 0);
}

export function baseWeights() {
  return { ...BASE_WEIGHTS };
}
