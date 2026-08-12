import { randomInt } from 'node:crypto';

export const RARITIES = ['PROCESS', 'AGENT', 'DAEMON', 'ORACLE', 'ARCHITECT', 'ORIGIN'] as const;
export type Rarity = (typeof RARITIES)[number];
export const SOURCES = ['claude_code', 'codex'] as const;
export type TokenSource = (typeof SOURCES)[number];
export const GACHA_COST = 500_000;
export const PITY_LIMIT = 300;
export const WEEKLY_USAGE_FOR_MAXIMUM_BONUS = 5_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export interface TokenEvent {
  eventId: string;
  source: TokenSource;
  occurredAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function parseTokenEvent(value: unknown, now = Date.now()): TokenEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['eventId', 'source', 'occurredAt', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unknown fields: ${unknown.join(', ')}`);
  if (!isUuid(body.eventId)) throw new Error('eventId must be a UUID');
  if (!SOURCES.includes(body.source as TokenSource)) throw new Error('source is not allowed');
  if (typeof body.occurredAt !== 'string') throw new Error('occurredAt must be an ISO timestamp');
  const timestamp = Date.parse(body.occurredAt);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 7 * 86_400_000) throw new Error('occurredAt must be within 7 days');
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const item = body[field];
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 1_000_000_000) {
      throw new Error(`${field} must be an integer from 0 to 1000000000`);
    }
  }
  const result = body as unknown as TokenEvent;
  const total = result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens;
  if (total <= 0 || !Number.isSafeInteger(total)) throw new Error('token total must be a positive safe integer');
  return result;
}

export function activityAdjustedWeights(activityBoost: number): Record<Rarity, number> {
  const boost = Math.max(0, Math.min(1, activityBoost));
  return { PROCESS: 55-15*boost, AGENT: 25+boost, DAEMON: 12+4*boost, ORACLE: 6+5*boost, ARCHITECT: 1.8+4.2*boost, ORIGIN: 0.2+0.8*boost };
}

export function selectRarity(pityCount: number, roll = randomInt(1_000_000) / 1_000_000, activityBoost = 0): Rarity {
  if (!Number.isInteger(pityCount) || pityCount < 0 || pityCount > PITY_LIMIT) throw new Error('invalid pity count');
  if (pityCount >= PITY_LIMIT) return 'ORIGIN';
  const weights = activityAdjustedWeights(activityBoost);
  let cursor = roll * 100;
  for (const rarity of RARITIES) { cursor -= weights[rarity]; if (cursor < 0) return rarity; }
  return 'ORIGIN';
}

export function safeInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('expected an integer');
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`integer must be between ${min} and ${max}`);
  return parsed;
}
