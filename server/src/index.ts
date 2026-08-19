import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool, transaction } from './db.js';
import { activityAdjustedWeights, GACHA_COST, isUuid, parseTokenEvent, RARITIES, safeInt, selectRarity, WEEKLY_USAGE_FOR_MAXIMUM_BONUS } from './domain.js';
import { allowedCorsOrigin, collectorSecretMatches, CORS_ALLOW_HEADERS, loadSecurityConfig, SessionAdmissionLimiter } from './security.js';

const PORT = Number(process.env.PORT ?? 4000);
const security = loadSecurityConfig(process.env);
const BODY_LIMIT = 16 * 1024;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
const CATEGORIES = new Set(['start','normal_evolution','branch','mixed','special','mutant']);
const rateLimits = new Map<string, number>();
const sessionAdmissions = new SessionAdmissionLimiter();

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function headers(res: ServerResponse) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-headers', CORS_ALLOW_HEADERS);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = allowedCorsOrigin(req.headers.origin, CORS_ORIGIN);
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
}

function send(res: ServerResponse, status: number, body: unknown) { headers(res); res.statusCode = status; res.end(JSON.stringify(body)); }

async function body(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT) throw new HttpError(413, 'body too large');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > BODY_LIMIT) throw new HttpError(413, 'body too large');
  }
  try { return JSON.parse(data || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function playerId(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'authenticated session required');
  const [encoded, signature, extra] = authorization.slice(7).split('.');
  if (!encoded || !signature || extra) throw new HttpError(401, 'invalid session');
  const expected = createHmac('sha256', security.sessionSecret).update(encoded).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new HttpError(401, 'invalid session'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'invalid session');
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new HttpError(401, 'invalid session'); }
  const { player, issuedAt } = payload as { player?: unknown; issuedAt?: unknown };
  if (!isUuid(player) || !Number.isSafeInteger(issuedAt) || Date.now() - Number(issuedAt) > 366 * 86_400_000) throw new HttpError(401, 'expired session');
  return player;
}

function createSession() {
  const encoded = Buffer.from(JSON.stringify({ player: randomUUID(), issuedAt: Date.now() })).toString('base64url');
  const signature = createHmac('sha256', security.sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

async function ensurePlayer(id: string) {
  await pool.query('INSERT INTO players(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  await pool.query("INSERT INTO item_inventory(player_id,item_type,quantity) VALUES ($1,'food',3) ON CONFLICT DO NOTHING", [id]);
}

function rateLimit(key: string, milliseconds: number) {
  const now = Date.now();
  const previous = rateLimits.get(key) ?? 0;
  if (now - previous < milliseconds) throw new HttpError(429, 'request rate exceeded');
  rateLimits.set(key, now);
  if (rateLimits.size > 10_000) for (const [id, seen] of rateLimits) if (now - seen > 60_000) rateLimits.delete(id);
}

async function catalog(url: URL, res: ServerResponse) {
  let limit: number, offset: number;
  try {
    limit = safeInt(url.searchParams.get('limit') ?? undefined, 48, 1, 100);
    offset = safeInt(url.searchParams.get('offset') ?? undefined, 0, 0, 10_000);
  } catch (error) { throw new HttpError(400, (error as Error).message); }
  const search = (url.searchParams.get('search') ?? '').trim();
  if (search.length > 60) throw new HttpError(400, 'search is too long');
  const rarity = url.searchParams.get('rarity');
  const category = url.searchParams.get('category');
  if (rarity && !RARITIES.includes(rarity as never)) throw new HttpError(400, 'invalid rarity');
  if (category && !CATEGORIES.has(category)) throw new HttpError(400, 'invalid category');
  const result = await pool.query(`SELECT id, ko_name AS "koName", en_name AS "enName", lineage_id AS "lineageId",
      category, stage, rarity, body_form AS "bodyForm", tone, identity_text AS identity, palette,
      evolution_from AS "evolutionFrom", image_path AS "imagePath", count(*) OVER()::int AS total
    FROM catalog_creatures
    WHERE ($1 = '' OR ko_name ILIKE '%' || $1 || '%' OR en_name ILIKE '%' || $1 || '%' OR id ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR rarity = $2) AND ($3::text IS NULL OR category = $3)
    ORDER BY id LIMIT $4 OFFSET $5`, [search, rarity, category, limit, offset]);
  send(res, 200, { items: result.rows.map(({ total: _total, ...row }) => row), total: result.rows[0]?.total ?? 0, limit, offset });
}

async function gameState(req: IncomingMessage, res: ServerResponse) {
  const id = playerId(req); await ensurePlayer(id);
  const [state, usage, creatures, items] = await Promise.all([
    pool.query('SELECT token_balance::text AS "tokenBalance", total_usage::text AS "totalUsage", pity_count AS "pityCount" FROM players WHERE id=$1', [id]),
    pool.query(`SELECT source, COALESCE(sum(total_tokens),0)::text AS tokens FROM token_ingestions
      WHERE player_id=$1 AND occurred_at >= date_trunc('week', now()) GROUP BY source`, [id]),
    pool.query(`SELECT ci.id, ci.catalog_id AS "catalogId", c.ko_name AS "koName", c.en_name AS "enName", c.rarity,
      c.image_path AS "imagePath", ci.level, ci.experience::text, ci.affection, ci.unique_color AS "uniqueColor", ci.personality
      FROM creature_instances ci JOIN catalog_creatures c ON c.id=ci.catalog_id WHERE ci.player_id=$1 ORDER BY ci.acquired_at DESC LIMIT 100`, [id]),
    pool.query('SELECT item_type AS "itemType", quantity FROM item_inventory WHERE player_id=$1 ORDER BY item_type', [id]),
  ]);
  const weeklyTotal = usage.rows.reduce((sum, row) => sum + Number(row.tokens), 0);
  const activityBoost = Math.min(1, weeklyTotal / WEEKLY_USAGE_FOR_MAXIMUM_BONUS);
  send(res, 200, { ...state.rows[0], weeklyUsage: Object.fromEntries(usage.rows.map((row) => [row.source, row.tokens])), activityBoost, rarityWeights: activityAdjustedWeights(activityBoost), creatures: creatures.rows, items: items.rows, gachaCost: String(GACHA_COST) });
}

async function ingest(req: IncomingMessage, res: ServerResponse) {
  if (!security.collectorSecretHash) throw new HttpError(503, 'token ingestion is disabled: COLLECTOR_SECRET is not configured');
  const id = playerId(req);
  const suppliedSecret = req.headers['x-collector-secret'];
  if (!collectorSecretMatches(typeof suppliedSecret === 'string' ? suppliedSecret : undefined, security.collectorSecretHash)) throw new HttpError(401, 'paired collector required');
  let event; try { event = parseTokenEvent(await body(req)); } catch (error) { throw new HttpError(400, (error as Error).message); }
  const result = await transaction(async (client) => {
    await client.query('INSERT INTO players(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    const inserted = await client.query(`INSERT INTO token_ingestions
      (player_id,event_id,source,occurred_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (player_id,event_id) DO NOTHING RETURNING total_tokens::text AS total`,
      [id,event.eventId,event.source,event.occurredAt,event.inputTokens,event.outputTokens,event.cacheReadTokens,event.cacheWriteTokens]);
    if (!inserted.rowCount) return { accepted: false, duplicate: true };
    rateLimit(`ingest:${id}`, 100);
    await client.query('UPDATE players SET token_balance=token_balance+$2,total_usage=total_usage+$2,updated_at=now() WHERE id=$1', [id, inserted.rows[0].total]);
    return { accepted: true, duplicate: false, creditedTokens: inserted.rows[0].total };
  });
  send(res, result.accepted ? 201 : 200, result);
}

async function gacha(req: IncomingMessage, res: ServerResponse) {
  const id = playerId(req);
  const value = await body(req);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'requestId') || !isUuid((value as Record<string, unknown>).requestId)) throw new HttpError(400, 'requestId must be the only field and must be a UUID');
  const requestId = (value as { requestId: string }).requestId;
  const result = await transaction(async (client) => {
    await client.query('INSERT INTO players(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    const locked = await client.query('SELECT token_balance,pity_count FROM players WHERE id=$1 FOR UPDATE', [id]);
    const existing = await client.query(`SELECT ci.id,ci.catalog_id AS "catalogId",c.ko_name AS "koName",c.en_name AS "enName",c.rarity,c.image_path AS "imagePath",ci.unique_color AS "uniqueColor",ci.personality
      FROM gacha_requests gr JOIN creature_instances ci ON ci.id=gr.creature_instance_id JOIN catalog_creatures c ON c.id=ci.catalog_id
      WHERE gr.player_id=$1 AND gr.request_id=$2`, [id, requestId]);
    if (existing.rowCount) return { duplicate: true, creature: existing.rows[0] };
    rateLimit(`gacha:${id}`, 750);
    if (BigInt(locked.rows[0].token_balance) < BigInt(GACHA_COST)) throw new HttpError(409, 'not enough tokens');
    const weekly = await client.query(`SELECT COALESCE(sum(total_tokens),0)::text AS total FROM token_ingestions WHERE player_id=$1 AND occurred_at >= date_trunc('week',now())`, [id]);
    const activityBoost = Math.min(1, Number(weekly.rows[0].total) / WEEKLY_USAGE_FOR_MAXIMUM_BONUS);
    const rarity = selectRarity(locked.rows[0].pity_count, undefined, activityBoost);
    const choices = await client.query('SELECT id FROM catalog_creatures WHERE rarity=$1 ORDER BY id', [rarity]);
    if (!choices.rowCount) throw new HttpError(503, `catalog pool unavailable: ${rarity}`);
    const catalogId = choices.rows[randomInt(choices.rows.length)].id as string;
    const personalities = ['curious','brave','calm','playful','focused'];
    const uniqueColor = randomInt(1000) === 0;
    const created = await client.query(`INSERT INTO creature_instances
      (player_id,catalog_id,unique_color,personality,str_aptitude,agi_aptitude,wit_aptitude)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [id,catalogId,uniqueColor,personalities[randomInt(personalities.length)],randomInt(1,11),randomInt(1,11),randomInt(1,11)]);
    await client.query('INSERT INTO gacha_requests(player_id,request_id,creature_instance_id) VALUES ($1,$2,$3)', [id,requestId,created.rows[0].id]);
    await client.query('UPDATE players SET token_balance=token_balance-$2,pity_count=$3,updated_at=now() WHERE id=$1', [id,GACHA_COST,rarity === 'ORIGIN' ? 0 : locked.rows[0].pity_count + 1]);
    const creature = await client.query(`SELECT ci.id,ci.catalog_id AS "catalogId",c.ko_name AS "koName",c.en_name AS "enName",c.rarity,c.image_path AS "imagePath",ci.unique_color AS "uniqueColor",ci.personality FROM creature_instances ci JOIN catalog_creatures c ON c.id=ci.catalog_id WHERE ci.id=$1`, [created.rows[0].id]);
    return { duplicate: false, creature: creature.rows[0] };
  });
  send(res, result.duplicate ? 200 : 201, result);
}

async function useItem(req: IncomingMessage, res: ServerResponse) {
  const id = playerId(req); rateLimit(`item:${id}`, 250);
  const value = await body(req);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'body must be an object');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['creatureId','itemType'].includes(key)) || !isUuid(data.creatureId) || data.itemType !== 'food') throw new HttpError(400, 'creatureId and supported itemType food are required');
  const result = await transaction(async (client) => {
    const consumed = await client.query(`UPDATE item_inventory SET quantity=quantity-1 WHERE player_id=$1 AND item_type='food' AND quantity>0 RETURNING quantity`, [id]);
    if (!consumed.rowCount) throw new HttpError(409, 'no food available');
    const grown = await client.query(`UPDATE creature_instances SET experience=experience+100, affection=LEAST(100,affection+2),
      level=LEAST(100,1+floor((experience+100)/1000)) WHERE id=$1 AND player_id=$2 RETURNING level,experience::text,affection`, [data.creatureId,id]);
    if (!grown.rowCount) throw new HttpError(404, 'creature not found');
    return { creature: grown.rows[0], remaining: consumed.rows[0].quantity };
  });
  send(res, 200, result);
}

const server = createServer(async (req, res) => {
  applyCors(req, res);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      await pool.query('SELECT 1'); return send(res, 200, { status: 'ok', catalog: Number((await pool.query('SELECT count(*) FROM catalog_creatures')).rows[0].count) });
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      if (!sessionAdmissions.admit(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, 'session admission rate exceeded');
      return send(res, 201, { token: createSession() });
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') return await catalog(url, res);
    if (req.method === 'GET' && url.pathname === '/api/game-state') return await gameState(req, res);
    if (req.method === 'POST' && url.pathname === '/api/token-ingestions') return await ingest(req, res);
    if (req.method === 'POST' && url.pathname === '/api/gacha') return await gacha(req, res);
    if (req.method === 'POST' && url.pathname === '/api/inventory/use') return await useItem(req, res);
    throw new HttpError(404, 'not found');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    send(res, status, { error: status === 500 ? 'internal server error' : (error as Error).message });
  }
});

server.listen(PORT, security.host, () => console.log(`PunchGrow API listening on ${security.host}:${PORT}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
