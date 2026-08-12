import test from 'node:test';
import assert from 'node:assert/strict';
import { activityAdjustedWeights, parseTokenEvent, selectRarity } from './domain.js';

const valid = {
  eventId: '123e4567-e89b-42d3-a456-426614174000', source: 'claude_code', occurredAt: new Date().toISOString(),
  inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40,
};

test('token ingestion accepts only the privacy-preserving allowlist', () => {
  assert.equal(parseTokenEvent(valid).inputTokens, 10);
  assert.throws(() => parseTokenEvent({ ...valid, prompt: 'secret' }), /unknown fields: prompt/);
  assert.throws(() => parseTokenEvent({ ...valid, inputTokens: -1 }), /inputTokens/);
  assert.throws(() => parseTokenEvent({ ...valid, inputTokens: 1.5 }), /inputTokens/);
});

test('token ingestion rejects stale and empty events', () => {
  assert.throws(() => parseTokenEvent({ ...valid, occurredAt: '2020-01-01T00:00:00Z' }), /within 7 days/);
  assert.throws(() => parseTokenEvent({ ...valid, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), /positive/);
});

test('gacha rarity boundaries and pity are deterministic', () => {
  assert.equal(selectRarity(0, 0), 'PROCESS');
  assert.equal(selectRarity(0, 0.55), 'AGENT');
  assert.equal(selectRarity(0, 0.999), 'ORIGIN');
  assert.equal(selectRarity(299, 0), 'PROCESS');
  assert.equal(selectRarity(300, 0.9), 'ORIGIN');
  assert.equal(selectRarity(0, 0.405, 1), 'AGENT');
  assert.equal(Object.values(activityAdjustedWeights(1)).reduce((sum, value) => sum + value, 0), 100);
});
