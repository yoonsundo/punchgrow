import { createHash, createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalStringify } from '../lib/continuity-assignment/canonical-json.mjs';

const AUTHORITY_SEED_DOMAIN = 'punchgrow:g002:public-ed25519-authority-seed-v1\0';
const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// This is intentionally replaced with the root-derived public authority before
// any signed evidence is accepted. A mutable lock file can never override it.
export const PINNED_AUTHORITY_FINGERPRINT = '423f474c59667e5eabc13a703b8d7de4e97bcba33cdc22340873866db9d6a53f';
export const PINNED_PUBLIC_KEY_SPKI_DER_BASE64 = 'MCowBQYDK2VwAyEAcsAwlczpwUiSV+AyD4X1bttFytshhlq6M1RWU1RWXdE=';

function requireConductorKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  if (key.length < 32) throw new Error('G002 conductor key must contain at least 32 bytes');
  return key;
}

export function deriveAuthority(conductorKey) {
  const seed = createHmac('sha256', requireConductorKey(conductorKey)).update(AUTHORITY_SEED_DOMAIN).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKey,
    publicKeySpkiDerBase64: publicKeySpkiDer.toString('base64'),
    fingerprintSha256: createHash('sha256').update(publicKeySpkiDer).digest('hex'),
  };
}

export function assertDerivedAuthorityPinned(authority) {
  if (PINNED_AUTHORITY_FINGERPRINT.startsWith('__ROOT_') || PINNED_PUBLIC_KEY_SPKI_DER_BASE64.startsWith('__ROOT_')) {
    throw new Error('G002 public authority has not been hard-pinned');
  }
  if (authority.fingerprintSha256 !== PINNED_AUTHORITY_FINGERPRINT || authority.publicKeySpkiDerBase64 !== PINNED_PUBLIC_KEY_SPKI_DER_BASE64) {
    throw new Error('hidden conductor key does not derive the hard-pinned G002 public authority');
  }
}

export function signPublicEvidence(unsignedValue, conductorKey) {
  const authority = deriveAuthority(conductorKey); assertDerivedAuthorityPinned(authority);
  return {
    algorithm: 'Ed25519',
    authorityFingerprint: authority.fingerprintSha256,
    signatureBase64: sign(null, Buffer.from(canonicalStringify(unsignedValue)), authority.privateKey).toString('base64'),
  };
}

export function verifyPublicEvidence(unsignedValue, signature) {
  if (!signature || signature.algorithm !== 'Ed25519' || signature.authorityFingerprint !== PINNED_AUTHORITY_FINGERPRINT
      || typeof signature.signatureBase64 !== 'string') throw new Error('public evidence signature authority is invalid');
  if (PINNED_PUBLIC_KEY_SPKI_DER_BASE64.startsWith('__ROOT_')) throw new Error('G002 public authority has not been hard-pinned');
  const publicKey = createPublicKey({ key: Buffer.from(PINNED_PUBLIC_KEY_SPKI_DER_BASE64, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(canonicalStringify(unsignedValue)), publicKey, Buffer.from(signature.signatureBase64, 'base64'))) {
    throw new Error('public evidence Ed25519 signature verification failed');
  }
  return true;
}
