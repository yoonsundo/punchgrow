import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const base = process.env.API_URL ?? 'http://127.0.0.1:4001';
const sessionResponse = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(sessionResponse.status, 201);
const { token } = await sessionResponse.json();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const request = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const value = await response.json();
  return { response, value };
};

const initial = await request('/api/game-state');
assert.equal(initial.response.status, 200);
assert.equal(initial.value.tokenBalance, '3000000');

const event = { eventId: randomUUID(), source: 'claude_code', occurredAt: new Date().toISOString(), inputTokens: 700, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0 };
const forged = await fetch(`${base}/api/game-state`, { headers: { authorization: 'Bearer forged' } });
assert.equal(forged.status, 401);
const unsigned = await request('/api/token-ingestions', { method: 'POST', body: JSON.stringify(event) });
assert.equal(unsigned.response.status, 401);
const collectorHeaders = { 'x-collector-secret': process.env.COLLECTOR_SECRET ?? 'punchgrow-local-collector' };
const privacy = await request('/api/token-ingestions', { method: 'POST', headers: collectorHeaders, body: JSON.stringify({ ...event, prompt: 'never store me' }) });
assert.equal(privacy.response.status, 400);
const accepted = await request('/api/token-ingestions', { method: 'POST', headers: collectorHeaders, body: JSON.stringify(event) });
assert.equal(accepted.response.status, 201);
assert.equal(accepted.value.creditedTokens, '1000');
const duplicate = await request('/api/token-ingestions', { method: 'POST', headers: collectorHeaders, body: JSON.stringify(event) });
assert.equal(duplicate.response.status, 200);
assert.equal(duplicate.value.duplicate, true);

const requestId = randomUUID();
const [first, second] = await Promise.all([
  request('/api/gacha', { method: 'POST', body: JSON.stringify({ requestId }) }),
  request('/api/gacha', { method: 'POST', body: JSON.stringify({ requestId }) }),
]);
assert.ok([200, 201].includes(first.response.status));
assert.ok([200, 201].includes(second.response.status));
assert.equal(first.value.creature.id, second.value.creature.id);
const final = await request('/api/game-state');
assert.equal(final.value.tokenBalance, '2501000');
assert.equal(final.value.creatures.length, 1);
assert.equal(final.value.weeklyUsage.claude_code, '1000');
assert.ok(final.value.activityBoost > 0);

const pitySessionResponse = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const pityToken = (await pitySessionResponse.json()).token;
const pityPlayer = JSON.parse(Buffer.from(pityToken.split('.')[0], 'base64url').toString('utf8')).player;
const pityHeaders = { 'content-type': 'application/json', authorization: `Bearer ${pityToken}` };
await fetch(`${base}/api/game-state`, { headers: pityHeaders });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://punchgrow:punchgrow_dev@127.0.0.1:5434/punchgrow' });
await client.connect();
const originIDs = (await client.query("SELECT id FROM catalog_creatures WHERE rarity='ORIGIN'")).rows.map((row) => row.id);
try {
  await client.query('UPDATE players SET pity_count=300 WHERE id=$1', [pityPlayer]);
  await client.query("UPDATE catalog_creatures SET rarity='ARCHITECT' WHERE rarity='ORIGIN'");
  const unavailable = await fetch(`${base}/api/gacha`, { method: 'POST', headers: pityHeaders, body: JSON.stringify({ requestId: randomUUID() }) });
  assert.equal(unavailable.status, 503);
  const unchanged = await (await fetch(`${base}/api/game-state`, { headers: pityHeaders })).json();
  assert.equal(unchanged.tokenBalance, '3000000');
  assert.equal(unchanged.pityCount, 300);
  assert.equal(unchanged.creatures.length, 0);
} finally {
  if (originIDs.length) await client.query("UPDATE catalog_creatures SET rarity='ORIGIN' WHERE id = ANY($1::text[])", [originIDs]);
  await client.end();
}

console.log(JSON.stringify({ status: 'ok', auth: 'signed-session', creature: first.value.creature.catalogId, balance: final.value.tokenBalance }));
