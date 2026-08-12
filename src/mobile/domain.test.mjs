import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GACHA_COST,
  ORIGIN_PITY_LIMIT,
  activityAdjustedWeights,
  addGrowth,
  drawGacha,
  weeklyTotal,
} from './domain.ts';

const catalog = [
  { id: 'PG-P', rarity: 'PROCESS' },
  { id: 'PG-O', rarity: 'ORIGIN' },
];

const state = {
  tokens: GACHA_COST * 2,
  pity: 0,
  inventory: [],
  seed: 42,
};

test('activity weights remain normalized and move probability toward rare grades', () => {
  const base = activityAdjustedWeights(0);
  const max = activityAdjustedWeights(1);
  assert.equal(Object.values(base).reduce((a, b) => a + b), 100);
  assert.equal(Object.values(max).reduce((a, b) => a + b), 100);
  assert.ok(max.ORIGIN > base.ORIGIN);
  assert.ok(max.PROCESS < base.PROCESS);
});

test('draw is deterministic, spends tokens, and creates a separate instance', () => {
  const first = drawGacha(state, catalog);
  const replay = drawGacha(state, catalog);
  assert.equal(first.creature.id, replay.creature.id);
  assert.equal(first.owned.instanceId, replay.owned.instanceId);
  assert.equal(first.next.tokens, GACHA_COST);
  assert.equal(first.next.inventory.length, 1);
});

test('pity forces ORIGIN on the draw after 300 consecutive misses', () => {
  const result = drawGacha({ ...state, pity: ORIGIN_PITY_LIMIT }, catalog);
  assert.equal(result.creature.rarity, 'ORIGIN');
  assert.equal(result.forcedByPity, true);
  assert.equal(result.next.pity, 0);
});

test('pity fails without spending when the ORIGIN pool is missing', () => {
  const before = { ...state, pity: ORIGIN_PITY_LIMIT };
  assert.throws(() => drawGacha(before, catalog.filter((item) => item.rarity !== 'ORIGIN')), /ORIGIN/);
  assert.equal(before.tokens, GACHA_COST * 2);
  assert.equal(before.pity, ORIGIN_PITY_LIMIT);
});

test('feeding levels a creature and caps hunger', () => {
  const grown = addGrowth({ instanceId: 'i', creatureId: 'PG-P', level: 1, xp: 900, hunger: 96, uniqueColor: false }, 200);
  assert.equal(grown.level, 2);
  assert.equal(grown.xp, 1_100);
  assert.equal(grown.hunger, 100);
});

test('weekly total includes both tools', () => {
  assert.equal(weeklyTotal([{ claude: 10, codex: 5 }, { claude: 3, codex: 2 }]), 20);
});
