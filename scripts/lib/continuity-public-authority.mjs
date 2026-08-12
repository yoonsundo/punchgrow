import { createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import { canonicalStringify, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertG003ConductorKeyPinned, PINNED_G003_AUTHORITY_FINGERPRINT } from './g003-public-authority.mjs';

const AUTHORITY_SEED_DOMAIN = 'punchgrow:continuity:public-ed25519-authority-seed-v1\0';
const ROOT_KEY_COMMITMENT_DOMAIN = 'punchgrow:continuity:g003-root-key-commitment-v1\0';
const PUBLIC_SIGNATURE_DOMAIN = 'punchgrow:continuity:public-evidence-signature-v1\0';
const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PURPOSE_PATTERN = /^continuity:[a-z0-9-]+$/;

export const CONTINUITY_AUTHORITY_ALGORITHM = 'Ed25519';
export const CONTINUITY_AUTHORITY_EPOCH = 'continuity-authority-epoch-v1';
export const CONTINUITY_DELEGATION_PURPOSE = 'g003:continuity-authority-delegation';
export const CONTINUITY_SUPERSESSION_PURPOSE = 'continuity:g002-v2-supersession';
export const CONTINUITY_ASSIGNMENT_V3_PURPOSE = 'continuity:assignment-v3';
export const G002_V2_IMMUTABLE_PREDECESSOR = Object.freeze({
  publicManifestPath: 'production/reports/biological-continuity-v3/g002-evidence-v2/public-evidence-manifest.json',
  publicManifestFileSha256: '1b30604091b8da34a3191d903836f8e61126405839abac8b2f1576d380cecd37',
  publicManifestOutputSha256: '3fee012ba96fbd22ba5921185495bb5d6cbc622bba7b7a2769c56050af2cf430',
  successorPath: 'production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-redesign-targets-v2.json',
  successorFileSha256: '01b1f63f570f82a304b5e661e14c4454e5b82895dca4e414cfb2b2a511a073f2',
  successorOutputSha256: '6cee5fa6c9c28d5801eac5df8696c3857787ddf4597035194c749be37aac6168',
  assignmentPath: 'production/reports/biological-continuity-v3/g002-evidence-v2/assignment-manifest.json',
  assignmentFileSha256: '9b5d863fa77e6e124b16f64c3268e6badafab801a837d812b07650dd07a2fb0e',
  effectiveAuthoritySha256: '22cf282dd777c8bf5239b8a6e4d56572143f314b983a189a5b0eb589308d1f92',
  immutable: true,
  nativeSignatureClaim: 'NONE_CROSS_AUTHORITY_SUCCESSOR_ONLY',
});

const fail = (message) => { throw new Error(`continuity public authority: ${message}`); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(`${label} fields mismatch`);
};
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function assertContinuityPurpose(purpose) {
  if (typeof purpose !== 'string' || !PURPOSE_PATTERN.test(purpose)
      || purpose.startsWith('g002:') || purpose.startsWith('g003:')) fail('signature purpose namespace is invalid');
  return purpose;
}

export function deriveContinuityAuthority(g003RootKey) {
  const key = Buffer.isBuffer(g003RootKey) ? g003RootKey : Buffer.from(g003RootKey ?? '');
  if (key.length < 32) fail('G003 root key must contain at least 32 bytes');
  assertG003ConductorKeyPinned(key);
  const seed = createHmac('sha256', key).update(AUTHORITY_SEED_DOMAIN).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const authority = {
    privateKey,
    publicKey,
    publicKeySpkiDerBase64: publicKeySpkiDer.toString('base64'),
    fingerprintSha256: createHash('sha256').update(publicKeySpkiDer).digest('hex'),
    rootKeyCommitmentSha256: createHmac('sha256', key).update(ROOT_KEY_COMMITMENT_DOMAIN).digest('hex'),
  };
  if (authority.fingerprintSha256 === PINNED_G003_AUTHORITY_FINGERPRINT) fail('derived authority is not distinct from G003');
  return authority;
}

export function validateContinuityDelegation(delegation, { delegatedSchemaSha256 } = {}) {
  exactKeys(delegation, ['schemaVersion', 'delegationId', 'nonce', 'issuer', 'delegate', 'grant', 'predecessor', 'successorIntentSha256', 'outputSha256', 'publicSignature'], 'delegation');
  if (delegation.schemaVersion !== 'continuity-authority-delegation-v1') fail('delegation schema version mismatch');
  if (typeof delegation.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(delegation.nonce)) fail('delegation nonce mismatch');
  exactKeys(delegation.issuer, ['authorityEpoch', 'authorityFingerprint'], 'delegation issuer');
  if (delegation.issuer.authorityEpoch !== 'g003-authority-epoch-v1' || delegation.issuer.authorityFingerprint !== PINNED_G003_AUTHORITY_FINGERPRINT) fail('delegation issuer mismatch');
  exactKeys(delegation.delegate, ['algorithm', 'authorityEpoch', 'authorityFingerprint', 'publicKeySpkiDerBase64', 'rootKeyCommitmentSha256'], 'delegation delegate');
  if (delegation.delegate.algorithm !== CONTINUITY_AUTHORITY_ALGORITHM || delegation.delegate.authorityEpoch !== CONTINUITY_AUTHORITY_EPOCH
      || !sha(delegation.delegate.authorityFingerprint) || !sha(delegation.delegate.rootKeyCommitmentSha256)
      || delegation.delegate.authorityFingerprint === PINNED_G003_AUTHORITY_FINGERPRINT) fail('delegated authority mismatch');
  const publicDer = Buffer.from(delegation.delegate.publicKeySpkiDerBase64, 'base64');
  if (publicDer.toString('base64') !== delegation.delegate.publicKeySpkiDerBase64
      || createHash('sha256').update(publicDer).digest('hex') !== delegation.delegate.authorityFingerprint) fail('delegated public key binding mismatch');
  exactKeys(delegation.grant, ['purpose', 'schemaVersion', 'schemaSha256', 'successorPath', 'assignmentV3', 'oneTime', 'nativeG002SignatureClaimAllowed'], 'delegation grant');
  if (delegation.grant.purpose !== CONTINUITY_SUPERSESSION_PURPOSE || delegation.grant.schemaVersion !== 'continuity-g002-v2-supersession-v1'
      || delegation.grant.successorPath !== 'production/reports/biological-continuity-v3/continuity-authority/g002-v2-supersession-v1.json'
      || delegation.grant.oneTime !== true || delegation.grant.nativeG002SignatureClaimAllowed !== false
      || !sha(delegation.grant.schemaSha256)) fail('delegation grant mismatch');
  exactKeys(delegation.grant.assignmentV3, ['fixedPath', 'schemaSha256', 'coreSha256'], 'delegation assignment-v3 grant');
  if (delegation.grant.assignmentV3.fixedPath !== 'production/reports/biological-continuity-v3/continuity-authority/continuity-assignment-v3.json'
      || !sha(delegation.grant.assignmentV3.schemaSha256) || !sha(delegation.grant.assignmentV3.coreSha256)) fail('delegation assignment-v3 grant mismatch');
  assertContinuityPurpose(delegation.grant.purpose);
  if (delegatedSchemaSha256 && delegation.grant.schemaSha256 !== delegatedSchemaSha256) fail('delegated schema fingerprint mismatch');
  validatePredecessorBinding(delegation.predecessor);
  if (!sha(delegation.successorIntentSha256)) fail('successor intent fingerprint mismatch');
  const unsigned = structuredClone(delegation); delete unsigned.publicSignature;
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (delegation.outputSha256 !== sha256Canonical(core)) fail('delegation output hash mismatch');
  if (!/^continuity-delegation-[a-f0-9]{24}$/.test(delegation.delegationId)
      || delegation.delegationId !== `continuity-delegation-${sha256Canonical({ predecessor: delegation.predecessor, successorPath: delegation.grant.successorPath }).slice(0, 24)}`) fail('delegation ID mismatch');
  return unsigned;
}

export function assertSingleContinuityDelegationTip(delegations) {
  if (!Array.isArray(delegations)) fail('delegation tip set must be an array');
  const predecessorTips = new Set(); const nonces = new Set(); const paths = new Set();
  for (const delegation of delegations) {
    validateContinuityDelegation(delegation);
    const predecessor = sha256Canonical(delegation.predecessor);
    if (predecessorTips.has(predecessor)) fail('second delegation for the same predecessor is forbidden');
    if (nonces.has(delegation.nonce)) fail('delegation nonce reuse is forbidden');
    if (paths.has(delegation.grant.successorPath)) fail('second delegation path/tip is forbidden');
    predecessorTips.add(predecessor); nonces.add(delegation.nonce); paths.add(delegation.grant.successorPath);
  }
  return true;
}

export function validatePredecessorBinding(value) {
  exactKeys(value, ['publicManifestPath', 'publicManifestFileSha256', 'publicManifestOutputSha256', 'successorPath', 'successorFileSha256', 'successorOutputSha256', 'assignmentPath', 'assignmentFileSha256', 'effectiveAuthoritySha256', 'immutable', 'nativeSignatureClaim'], 'predecessor');
  if (Object.entries(value).filter(([key]) => key.endsWith('Sha256')).some(([, digest]) => !sha(digest))
      || value.immutable !== true || value.nativeSignatureClaim !== 'NONE_CROSS_AUTHORITY_SUCCESSOR_ONLY') fail('predecessor binding mismatch');
  return value;
}

function signaturePayload(unsignedValue, delegation, { purpose, schemaSha256 }) {
  assertContinuityPurpose(purpose);
  const successorGrant = purpose === delegation.grant.purpose && schemaSha256 === delegation.grant.schemaSha256;
  const assignmentGrant = purpose === CONTINUITY_ASSIGNMENT_V3_PURPOSE && schemaSha256 === delegation.grant.assignmentV3.schemaSha256;
  if (!sha(schemaSha256) || (!successorGrant && !assignmentGrant)) fail('signature purpose/schema differs from delegation');
  return {
    domain: PUBLIC_SIGNATURE_DOMAIN,
    authorityEpoch: CONTINUITY_AUTHORITY_EPOCH,
    delegationOutputSha256: delegation.outputSha256,
    purpose,
    schemaSha256,
    unsignedCanonicalBytesBase64: Buffer.from(canonicalStringify(unsignedValue)).toString('base64'),
  };
}

export function signContinuityEvidence(unsignedValue, g003RootKey, delegation, options = {}) {
  const authority = deriveContinuityAuthority(g003RootKey);
  if (authority.fingerprintSha256 !== delegation.delegate.authorityFingerprint
      || authority.publicKeySpkiDerBase64 !== delegation.delegate.publicKeySpkiDerBase64) fail('root key does not derive delegated continuity authority');
  return signContinuityEvidenceWithAuthority(unsignedValue, authority, delegation, options);
}

export function signContinuityEvidenceWithAuthority(unsignedValue, authority, delegation, options = {}) {
  if (authority.fingerprintSha256 !== delegation.delegate.authorityFingerprint
      || authority.publicKeySpkiDerBase64 !== delegation.delegate.publicKeySpkiDerBase64) fail('signing authority differs from delegated continuity key');
  return {
    algorithm: CONTINUITY_AUTHORITY_ALGORITHM,
    authorityEpoch: CONTINUITY_AUTHORITY_EPOCH,
    authorityFingerprint: authority.fingerprintSha256,
    delegationOutputSha256: delegation.outputSha256,
    purpose: options.purpose,
    schemaSha256: options.schemaSha256,
    signatureBase64: sign(null, Buffer.from(canonicalStringify(signaturePayload(unsignedValue, delegation, options))), authority.privateKey).toString('base64'),
  };
}

export function verifyContinuityEvidence(unsignedValue, signature, delegation, options = {}) {
  exactKeys(signature, ['algorithm', 'authorityEpoch', 'authorityFingerprint', 'delegationOutputSha256', 'purpose', 'schemaSha256', 'signatureBase64'], 'signature');
  if (signature.algorithm !== CONTINUITY_AUTHORITY_ALGORITHM || signature.authorityEpoch !== CONTINUITY_AUTHORITY_EPOCH
      || signature.authorityFingerprint !== delegation.delegate.authorityFingerprint
      || signature.delegationOutputSha256 !== delegation.outputSha256 || signature.purpose !== options.purpose
      || signature.schemaSha256 !== options.schemaSha256) fail('signature authority/delegation/purpose/schema mismatch');
  const bytes = Buffer.from(signature.signatureBase64, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature.signatureBase64) fail('signature encoding is invalid');
  const publicKey = createPublicKey({ key: Buffer.from(delegation.delegate.publicKeySpkiDerBase64, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(canonicalStringify(signaturePayload(unsignedValue, delegation, options))), publicKey, bytes)) fail('Ed25519 signature verification failed');
  return true;
}

export function assertContinuityRootCommitment(actualHex, expectedHex) {
  const actual = Buffer.from(actualHex, 'hex'); const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== 32 || expected.length !== 32 || !timingSafeEqual(actual, expected)) fail('root key commitment mismatch');
  return true;
}
