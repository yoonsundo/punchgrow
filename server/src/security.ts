import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

type Environment = Record<string, string | undefined>;

export type SecurityConfig = {
  authMode: 'local';
  collectorSecretHash?: Buffer;
  host: string;
  sessionSecret: string;
};

function secretHash(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function validateSecret(name: 'SESSION_SECRET' | 'COLLECTOR_SECRET', secret: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error(`${name} must be at least 32 bytes`);
  return secret;
}

export const CORS_ALLOW_HEADERS = 'content-type,authorization';

export function allowedCorsOrigin(origin: string | undefined, configuredOrigins: string): string | undefined {
  if (!origin) return undefined;
  const configured = configuredOrigins.split(',').map((item) => item.trim()).filter(Boolean);
  return configured.includes(origin) ? origin : undefined;
}

export function loadSecurityConfig(environment: Environment): SecurityConfig {
  const authMode = environment.AUTH_MODE ?? 'local';
  if (authMode !== 'local') throw new Error('AUTH_MODE must be local; external authentication is not implemented');

  const collectorSecret = environment.COLLECTOR_SECRET === undefined
    ? undefined
    : validateSecret('COLLECTOR_SECRET', environment.COLLECTOR_SECRET);
  const sessionSecret = environment.SESSION_SECRET === undefined
    ? randomBytes(32).toString('base64url')
    : validateSecret('SESSION_SECRET', environment.SESSION_SECRET);

  return {
    authMode,
    collectorSecretHash: collectorSecret ? secretHash(collectorSecret) : undefined,
    host: environment.HOST ?? '127.0.0.1',
    sessionSecret,
  };
}

export function collectorSecretMatches(supplied: string | undefined, expectedHash: Buffer | undefined): boolean {
  if (!supplied || !expectedHash) return false;
  return timingSafeEqual(secretHash(supplied), expectedHash);
}

export class SessionAdmissionLimiter {
  private global: number[] = [];
  private readonly byAddress = new Map<string, number[]>();

  constructor(
    private readonly windowMilliseconds = 60_000,
    private readonly globalLimit = 300,
    private readonly addressLimit = 30,
  ) {}

  admit(address: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMilliseconds;
    this.global = this.global.filter((seen) => seen > cutoff);
    const addressAdmissions = (this.byAddress.get(address) ?? []).filter((seen) => seen > cutoff);
    if (this.global.length >= this.globalLimit || addressAdmissions.length >= this.addressLimit) return false;
    this.global.push(now);
    addressAdmissions.push(now);
    this.byAddress.set(address, addressAdmissions);
    if (this.byAddress.size > this.globalLimit) {
      for (const [key, admissions] of this.byAddress) {
        if (admissions.every((seen) => seen <= cutoff)) this.byAddress.delete(key);
      }
    }
    return true;
  }
}
