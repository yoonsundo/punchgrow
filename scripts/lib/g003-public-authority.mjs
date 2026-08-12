import { createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import { canonicalStringify } from './continuity-assignment/canonical-json.mjs';

const AUTHORITY_SEED_DOMAIN = 'punchgrow:g003:public-ed25519-authority-seed-v1\0';
const ROOT_KEY_COMMITMENT_DOMAIN = 'punchgrow:g003:conductor-root-key-commitment-v1\0';
const PUBLIC_SIGNATURE_DOMAIN = 'punchgrow:g003:public-evidence-signature-v1\0';
const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const G003_AUTHORITY_ALGORITHM = 'Ed25519';
export const G003_AUTHORITY_EPOCH = 'g003-authority-epoch-v1';
export const PINNED_G003_AUTHORITY_FINGERPRINT = '91336f3180f8cf86cdef4b35f271c1e64eb609cd6b4e7f53360c777fa1a48e54';
export const PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64 = 'MCowBQYDK2VwAyEA2hr3xHKrFHs6BKu5uG4l7BjrTqAta3QJDQaHoqcWcgY=';
export const PINNED_G003_ROOT_KEY_COMMITMENT_SHA256 = 'd0dfd57a2b4c273efb9a734ab10cc8ff6c087442e10d8ff50dbb09699f3f43f6';

function requireConductorKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  if (key.length < 32) throw new Error('G003 conductor key must contain at least 32 bytes');
  return key;
}

export function deriveG003Authority(conductorKey) {
  const key = requireConductorKey(conductorKey);
  const seed = createHmac('sha256', key).update(AUTHORITY_SEED_DOMAIN).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKey,
    publicKeySpkiDerBase64: publicKeySpkiDer.toString('base64'),
    fingerprintSha256: createHash('sha256').update(publicKeySpkiDer).digest('hex'),
    rootKeyCommitmentSha256: createHmac('sha256', key).update(ROOT_KEY_COMMITMENT_DOMAIN).digest('hex'),
  };
}

export function assertG003ConductorKeyPinned(conductorKey) {
  const authority = deriveG003Authority(conductorKey);
  const actualCommitment = Buffer.from(authority.rootKeyCommitmentSha256, 'hex');
  const expectedCommitment = Buffer.from(PINNED_G003_ROOT_KEY_COMMITMENT_SHA256, 'hex');
  if (authority.fingerprintSha256 !== PINNED_G003_AUTHORITY_FINGERPRINT
      || authority.publicKeySpkiDerBase64 !== PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64
      || actualCommitment.length !== expectedCommitment.length
      || !timingSafeEqual(actualCommitment, expectedCommitment)) {
    throw new Error('hidden conductor key does not derive the hard-pinned G003 public authority and commitment');
  }
  return authority;
}

export function g003PurposeHmac(purposeDomain, value, conductorKey) {
  if (typeof purposeDomain !== 'string' || !purposeDomain.startsWith('punchgrow:g003:') || !purposeDomain.endsWith('\0')) {
    throw new Error('G003 HMAC purpose domain is invalid');
  }
  const key = requireConductorKey(conductorKey);
  assertG003ConductorKeyPinned(key);
  const purposeKey = createHmac('sha256', key).update(purposeDomain).digest();
  return createHmac('sha256', purposeKey).update(canonicalStringify(value)).digest('hex');
}

function signaturePayload(unsignedValue, purpose, schemaSha256) {
  if (typeof purpose !== 'string' || !/^g003:[a-z0-9-]+$/.test(purpose)) throw new Error('G003 signature purpose is invalid');
  if (typeof schemaSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(schemaSha256)) throw new Error('G003 signature schema fingerprint is invalid');
  return {
    domain: PUBLIC_SIGNATURE_DOMAIN,
    authorityEpoch: G003_AUTHORITY_EPOCH,
    purpose,
    schemaSha256,
    unsignedCanonicalBytesBase64: Buffer.from(canonicalStringify(unsignedValue)).toString('base64'),
  };
}

export function signG003PublicEvidence(unsignedValue, conductorKey, { purpose, schemaSha256 } = {}) {
  const authority = assertG003ConductorKeyPinned(conductorKey);
  return {
    algorithm: G003_AUTHORITY_ALGORITHM,
    authorityEpoch: G003_AUTHORITY_EPOCH,
    authorityFingerprint: authority.fingerprintSha256,
    purpose,
    schemaSha256,
    signatureBase64: sign(null, Buffer.from(canonicalStringify(signaturePayload(unsignedValue, purpose, schemaSha256))), authority.privateKey).toString('base64'),
  };
}

export function verifyG003PublicEvidence(unsignedValue, signature, { purpose, schemaSha256 } = {}) {
  const expectedKeys = ['algorithm', 'authorityEpoch', 'authorityFingerprint', 'purpose', 'schemaSha256', 'signatureBase64'];
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)
      || Object.keys(signature).length !== expectedKeys.length || expectedKeys.some((key) => !(key in signature))
      || signature.algorithm !== G003_AUTHORITY_ALGORITHM || signature.authorityEpoch !== G003_AUTHORITY_EPOCH
      || signature.authorityFingerprint !== PINNED_G003_AUTHORITY_FINGERPRINT || signature.purpose !== purpose
      || signature.schemaSha256 !== schemaSha256 || typeof signature.signatureBase64 !== 'string') {
    throw new Error('G003 public evidence signature authority is invalid');
  }
  const signatureBytes = Buffer.from(signature.signatureBase64, 'base64');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature.signatureBase64) throw new Error('G003 public evidence signature encoding is invalid');
  const publicKey = createPublicKey({ key: Buffer.from(PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(canonicalStringify(signaturePayload(unsignedValue, purpose, schemaSha256))), publicKey, signatureBytes)) {
    throw new Error('G003 public evidence Ed25519 signature verification failed');
  }
  return true;
}
