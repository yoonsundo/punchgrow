import { canonicalStringify, sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, readContainedFile } from './continuity-assignment/evidence.mjs';
import { G003_PROTOCOL_AUTHORITY_SHA256 } from './g003-v4-authority.mjs';
import { G003_V4_FREEZE_PATH } from './g003-v4-freeze-inventory.mjs';
import { loadVerifiedG003TransitionSnapshot } from './g003-transition-snapshot.mjs';
import { CONTINUITY_DELEGATION_PATH } from '../attest-continuity-authority-delegation.mjs';
import { verifyContinuityAuthorityDelegation } from '../verify-continuity-authority-delegation.mjs';
import { CROSS_AUTHORITY_SUPERSESSION_PATH, verifyCrossAuthoritySupersession } from './continuity-assignment/g002-v2-cross-authority-supersession.mjs';
import { verifyG003PublicEvidence } from './g003-public-authority.mjs';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const G003_V5_PROTOCOL = 'continuity-g003-review-protocol-v5';
export const G003_V5_EVIDENCE = 'production/reports/biological-continuity-v3/g003-evidence-v4';
export const G003_V5_REQUIRED_CONTINUITY_CONSTANTS = Object.freeze([
  'delegationOutputSha256',
  'delegationFileSha256',
  'supersessionOutputSha256',
  'supersessionFileSha256',
  'freezeOutputSha256',
  'freezeFileSha256',
  'freezeTreeSha256',
]);
export const G003_V5_SCHEMA_PATHS = Object.freeze([
  'production/contracts/g003-v5-protocol-authority.schema.json',
  'production/contracts/g003-v5-terminal-activation-v1.schema.json',
  'production/contracts/g003-reviewer-verdict-v2.schema.json',
  'production/contracts/g003-reviewer-assignment-v5.schema.json',
  'production/contracts/g003-primary-vote-v5.schema.json',
  'production/contracts/continuity-candidate-review-v5.schema.json',
  'production/contracts/g003-public-review-artifact-v5.schema.json',
  'production/contracts/g003-review-coverage-v5.schema.json',
  'production/contracts/g003-rejection-archive-v5.schema.json',
  'production/contracts/g003-rejection-observation-v2.schema.json',
  'production/contracts/g003-review-invalidity-v1.schema.json',
  'production/contracts/g003-rejection-tombstone-v2.schema.json',
  'production/contracts/g003-rejection-tombstone-supersession-v1.schema.json',
  'production/contracts/g003-quarantine-assignment-v1.schema.json',
  'production/contracts/g003-quarantine-invalidity-attestation-v1.schema.json',
  'production/contracts/g003-quarantine-adjudication-v1.schema.json',
]);

const SHA = /^[a-f0-9]{64}$/;
const TAXONOMY_FIELDS = Object.freeze(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']);
const IDENTITY_FIELDS = Object.freeze(['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber']);
const BINDING_FIELDS = Object.freeze([
  'opaqueCandidateId', 'generationRunId', 'packageManifestSha256', 'materialBindingSha256',
  'inputAllowlistSha256', 'promptSha256', 'inputAssetSha256s',
]);
const SIGNED_SCHEMA_BY_PURPOSE = Object.freeze({
  'continuity:g003-reviewer-assignment-v5': 'production/contracts/g003-reviewer-assignment-v5.schema.json',
  'continuity:g003-primary-vote-v5': 'production/contracts/g003-primary-vote-v5.schema.json',
  'continuity:g003-candidate-review-v5': 'production/contracts/continuity-candidate-review-v5.schema.json',
  'continuity:g003-public-review-artifact-v5': 'production/contracts/g003-public-review-artifact-v5.schema.json',
  'continuity:g003-review-coverage-v5': 'production/contracts/g003-review-coverage-v5.schema.json',
  'continuity:g003-rejection-archive-v5': 'production/contracts/g003-rejection-archive-v5.schema.json',
  'continuity:g003-review-invalidity-v1': 'production/contracts/g003-review-invalidity-v1.schema.json',
  'continuity:g003-rejection-tombstone-v2': 'production/contracts/g003-rejection-tombstone-v2.schema.json',
  'continuity:g003-rejection-tombstone-supersession-v1': 'production/contracts/g003-rejection-tombstone-supersession-v1.schema.json',
  'continuity:g003-quarantine-assignment-v1': 'production/contracts/g003-quarantine-assignment-v1.schema.json',
  'continuity:g003-quarantine-invalidity-attestation-v1': 'production/contracts/g003-quarantine-invalidity-attestation-v1.schema.json',
});
const VERIFIED_V5_LOADS = new WeakSet();
const VERIFIED_TERMINAL_HOOKS = new WeakSet();
const CONTINUITY_RECORD_AUTHORITIES = new WeakSet();
const PRODUCTION_CONTINUITY_RECORD_AUTHORITIES = new WeakSet();
const CONTINUITY_RECORD_PURPOSE_BY_SCHEMA = Object.freeze({
  'continuity-g003-reviewer-assignment-v5': 'continuity:g003-reviewer-assignment-v5',
  'continuity-g003-primary-vote-v5': 'continuity:g003-primary-vote-v5',
  'continuity-g003-candidate-review-v5': 'continuity:g003-candidate-review-v5',
  'continuity-g003-public-review-artifact-v5': 'continuity:g003-public-review-artifact-v5',
  'continuity-g003-review-coverage-v5': 'continuity:g003-review-coverage-v5',
  'continuity-g003-review-invalidity-v1': 'continuity:g003-review-invalidity-v1',
  'continuity-g003-rejection-archive-v5': 'continuity:g003-rejection-archive-v5',
  'continuity-g003-rejection-tombstone-v2': 'continuity:g003-rejection-tombstone-v2',
  'continuity-g003-quarantine-assignment-v1': 'continuity:g003-quarantine-assignment-v1',
  'continuity-g003-quarantine-invalidity-attestation-v1': 'continuity:g003-quarantine-invalidity-attestation-v1',
  'continuity-g003-rejection-tombstone-supersession-v1': 'continuity:g003-rejection-tombstone-supersession-v1',
});
const TERMINAL_CONTINUITY_SIGNATURE_DOMAIN = 'punchgrow:continuity:g003-terminal-v5-record-signature-v1\0';

function fail(message) { throw new Error(`G003-v5 authority: ${message}`); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const missing = keys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}
function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || canonicalStringify(actual) !== canonicalStringify(expected)) fail(`${label} differs from the signed package`);
}
function assertSha(value, label) { if (!SHA.test(value ?? '')) fail(`${label} is not a SHA-256`); }
function assertShaArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) fail(`${label} must contain unique SHA-256 values`);
  value.forEach((digest) => assertSha(digest, label));
}
function assertTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be a true UTC ISO timestamp`);
}
function assertTaxonomy(value, label) {
  exactKeys(value, TAXONOMY_FIELDS, label);
  for (const field of TAXONOMY_FIELDS) if (typeof value[field] !== 'string' || !value[field] || value[field].startsWith('unknown')) fail(`${label}.${field} is invalid`);
}
function assertSignedRecord(value, purpose, verifySignature, label) {
  const signature = value?.publicSignature;
  exactKeys(signature, ['algorithm', 'authorityEpoch', 'authorityFingerprint', 'delegationOutputSha256', 'purpose', 'schemaSha256', 'signatureBase64'], `${label} signature`);
  if (signature.algorithm !== 'Ed25519' || signature.authorityEpoch !== 'continuity-authority-epoch-v1' || signature.purpose !== purpose) fail(`${label} signature envelope is invalid`);
  for (const field of ['authorityFingerprint', 'delegationOutputSha256', 'schemaSha256']) assertSha(signature[field], `${label} signature ${field}`);
  const bytes = Buffer.from(signature.signatureBase64, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature.signatureBase64) fail(`${label} signature encoding is invalid`);
  const schemaPath = SIGNED_SCHEMA_BY_PURPOSE[purpose];
  if (!schemaPath || !G003_V5_SCHEMA_PATHS.includes(schemaPath) || typeof verifySignature !== 'function'
      || verifySignature(value, { purpose, schemaPath, claimedSchemaSha256: signature.schemaSha256 }) !== true) fail(`${label} signature is forged`);
}

// Structural construction stays private; production callers must use loadG003V5Authority.
function createG003V5Authority({ priorProtocolAuthoritySha256, continuityAuthority, schemaBindings }) {
  assertSha(priorProtocolAuthoritySha256, 'prior protocol authority');
  exactKeys(continuityAuthority, G003_V5_REQUIRED_CONTINUITY_CONSTANTS, 'continuity authority');
  for (const field of G003_V5_REQUIRED_CONTINUITY_CONSTANTS) assertSha(continuityAuthority[field], `continuity authority ${field}`);
  if (!Array.isArray(schemaBindings) || schemaBindings.length !== G003_V5_SCHEMA_PATHS.length) fail('schema bindings are incomplete');
  if (canonicalStringify(schemaBindings.map((entry) => entry.path)) !== canonicalStringify(G003_V5_SCHEMA_PATHS)) fail('schema binding paths/order changed');
  for (const binding of schemaBindings) {
    exactKeys(binding, ['path', 'sha256'], 'schema binding');
    assertSha(binding.sha256, `schema binding ${binding.path}`);
  }
  const authority = Object.freeze({
    protocol: G003_V5_PROTOCOL,
    priorProtocolAuthoritySha256,
    continuityAuthority: structuredClone(continuityAuthority),
    schemaBindings: structuredClone(schemaBindings),
  });
  return Object.freeze({ ...authority, protocolAuthoritySha256: sha256Canonical(authority) });
}

export function createG003V5AuthorityForTest(options) {
  return createG003V5Authority(options);
}

export async function loadG003V5Authority({ repoRoot } = {}) {
  if (!repoRoot) fail('repoRoot is required');
  const snapshot = await loadVerifiedG003TransitionSnapshot(repoRoot);
  const terminalSchemaPath = 'production/contracts/g003-v5-terminal-activation-v1.schema.json';
  const [delegationBytes, supersessionBytes, ...schemaBytes] = await Promise.all([
    readContainedFile(repoRoot, CONTINUITY_DELEGATION_PATH), readContainedFile(repoRoot, CROSS_AUTHORITY_SUPERSESSION_PATH),
    ...G003_V5_SCHEMA_PATHS.map((schemaPath) => readContainedFile(repoRoot, schemaPath)),
  ]);
  let delegation; let supersession;
  try { delegation = JSON.parse(delegationBytes); supersession = JSON.parse(supersessionBytes); } catch { fail('persisted continuity transition is not JSON'); }
  await verifyContinuityAuthorityDelegation({ repoRoot, delegation, transitionSnapshot: snapshot });
  await verifyCrossAuthoritySupersession({ repoRoot, value: supersession, delegation, transitionSnapshot: snapshot });
  const schemaBindings = G003_V5_SCHEMA_PATHS.map((schemaPath, index) => {
    let schema; try { schema = JSON.parse(schemaBytes[index]); } catch { fail(`schema is not JSON: ${schemaPath}`); }
    return Object.freeze({ path: schemaPath, sha256: sha256Canonical(schema) });
  });
  const continuityAuthority = Object.freeze({
    delegationOutputSha256: delegation.outputSha256, delegationFileSha256: sha256Bytes(delegationBytes),
    supersessionOutputSha256: supersession.outputSha256, supersessionFileSha256: sha256Bytes(supersessionBytes),
    freezeOutputSha256: snapshot.freeze.outputSha256, freezeFileSha256: sha256Bytes(snapshot.freeze.manifestBytes),
    freezeTreeSha256: snapshot.freeze.treeSha256,
  });
  const authority = createG003V5Authority({ priorProtocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, continuityAuthority, schemaBindings });
  const terminalSchemaSha256 = schemaBindings.find((binding) => binding.path === terminalSchemaPath)?.sha256;
  if (!terminalSchemaSha256) fail('terminal activation schema is absent from protocol authority bindings');
  const result = Object.freeze({ authority, delegation, supersession, freeze: snapshot.freeze, terminalSchemaSha256, exactBytes: Object.freeze({ predecessor: snapshot.buffers.assignment, delegation: delegationBytes, supersession: supersessionBytes, freeze: snapshot.freeze.manifestBytes }) });
  VERIFIED_V5_LOADS.add(result);
  return result;
}

export function createG003V5TerminalVerifierHooks(loaded) {
  if (!VERIFIED_V5_LOADS.has(loaded)) fail('v5 terminal verifier requires a concrete publicly verified authority load');
  const exact = (key) => ({ bytes }) => Buffer.from(bytes).equals(loaded.exactBytes[key]);
  const hooks = Object.freeze({
    predecessor: exact('predecessor'), freeze: exact('freeze'), delegation: exact('delegation'), supersession: exact('supersession'),
    v5: ({ value }) => {
      if (value.protocolAuthoritySha256 !== loaded.authority.protocolAuthoritySha256) return false;
      const unsigned = structuredClone(value); delete unsigned.publicSignature;
      try { return verifyG003PublicEvidence(unsigned, value.publicSignature, { purpose: 'g003:v5-terminal-activation', schemaSha256: loaded.terminalSchemaSha256 }); } catch { return false; }
    },
  });
  VERIFIED_TERMINAL_HOOKS.add(hooks); return hooks;
}

export function assertConcreteG003V5TerminalVerifierHooks(hooks) {
  if (!VERIFIED_TERMINAL_HOOKS.has(hooks)) fail('terminal verifier hooks were not created from the concrete public authority loader');
  return true;
}

function terminalContinuitySignaturePayload(unsigned, bindings) {
  return {
    domain: TERMINAL_CONTINUITY_SIGNATURE_DOMAIN, reviewProtocol: G003_V5_PROTOCOL,
    protocolAuthoritySha256: bindings.protocolAuthoritySha256, authorityEpoch: 'continuity-authority-epoch-v1',
    delegationOutputSha256: bindings.delegationOutputSha256, purpose: bindings.purpose,
    schemaSha256: bindings.schemaSha256,
    unsignedCanonicalBytesBase64: Buffer.from(canonicalStringify(unsigned)).toString('base64'),
  };
}

function buildContinuityRecordAuthority({ privateKey, publicKey, protocolAuthoritySha256, delegationOutputSha256, schemaSha256ByPath, production }) {
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const authorityFingerprint = createHash('sha256').update(publicDer).digest('hex');
  const authority = Object.freeze({
    finalize(core, schemaVersion) {
      const purpose = CONTINUITY_RECORD_PURPOSE_BY_SCHEMA[schemaVersion];
      const schemaPath = SIGNED_SCHEMA_BY_PURPOSE[purpose]; const schemaSha256 = schemaSha256ByPath[schemaPath];
      if (!purpose || !schemaPath || !schemaSha256) fail(`terminal continuity record schema is not authorized: ${schemaVersion}`);
      const unsignedCore = { schemaVersion, ...core };
      const unsigned = { ...unsignedCore, outputSha256: sha256Canonical(unsignedCore) };
      const bindings = { protocolAuthoritySha256, delegationOutputSha256, purpose, schemaSha256 };
      const publicSignature = {
        algorithm: 'Ed25519', authorityEpoch: 'continuity-authority-epoch-v1', authorityFingerprint,
        delegationOutputSha256, purpose, schemaSha256,
        signatureBase64: sign(null, Buffer.from(canonicalStringify(terminalContinuitySignaturePayload(unsigned, bindings))), privateKey).toString('base64'),
      };
      const value = Object.freeze({ ...unsigned, publicSignature });
      if (authority.verify(value, { purpose, schemaPath, claimedSchemaSha256: schemaSha256 }) !== true) fail('new terminal continuity record failed immediate public verification');
      return value;
    },
    verify(value, { purpose, schemaPath, claimedSchemaSha256 } = {}) {
      if (CONTINUITY_RECORD_PURPOSE_BY_SCHEMA[value?.schemaVersion] !== purpose || SIGNED_SCHEMA_BY_PURPOSE[purpose] !== schemaPath
          || schemaSha256ByPath[schemaPath] !== claimedSchemaSha256) return false;
      const signature = value.publicSignature;
      if (!signature || signature.algorithm !== 'Ed25519' || signature.authorityEpoch !== 'continuity-authority-epoch-v1'
          || signature.authorityFingerprint !== authorityFingerprint || signature.delegationOutputSha256 !== delegationOutputSha256
          || signature.purpose !== purpose || signature.schemaSha256 !== claimedSchemaSha256) return false;
      const unsigned = structuredClone(value); delete unsigned.publicSignature;
      const core = structuredClone(unsigned); delete core.outputSha256;
      if (unsigned.outputSha256 !== sha256Canonical(core)) return false;
      const bytes = Buffer.from(signature.signatureBase64, 'base64');
      if (bytes.length !== 64 || bytes.toString('base64') !== signature.signatureBase64) return false;
      return verify(null, Buffer.from(canonicalStringify(terminalContinuitySignaturePayload(unsigned,
        { protocolAuthoritySha256, delegationOutputSha256, purpose, schemaSha256: claimedSchemaSha256 }))), publicKey, bytes);
    },
    verifyRecord(value) {
      const purpose = CONTINUITY_RECORD_PURPOSE_BY_SCHEMA[value?.schemaVersion];
      const schemaPath = SIGNED_SCHEMA_BY_PURPOSE[purpose];
      return authority.verify(value, { purpose, schemaPath, claimedSchemaSha256: schemaSha256ByPath[schemaPath] });
    },
  });
  CONTINUITY_RECORD_AUTHORITIES.add(authority);
  if (production) PRODUCTION_CONTINUITY_RECORD_AUTHORITIES.add(authority);
  return authority;
}

export function createTestOnlyG003V5ContinuityRecordAuthority({ protocolAuthoritySha256, delegationOutputSha256, schemaSha256ByPath }) {
  if (process.env.NODE_ENV === 'production') fail('test-only continuity record authority is forbidden in production');
  assertSha(protocolAuthoritySha256, 'test protocol authority'); assertSha(delegationOutputSha256, 'test delegation output');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return buildContinuityRecordAuthority({ privateKey, publicKey, protocolAuthoritySha256, delegationOutputSha256,
    schemaSha256ByPath: structuredClone(schemaSha256ByPath), production: false });
}

export function assertProductionG003V5ContinuityRecordAuthority(authority) {
  if (!PRODUCTION_CONTINUITY_RECORD_AUTHORITIES.has(authority)) fail('production continuity record authority is required');
  return true;
}

export function resolveEffectiveRejectionStateV5({ recordAuthority, ...input }) {
  if (!CONTINUITY_RECORD_AUTHORITIES.has(recordAuthority)) fail('effective rejection resolver requires concrete terminal-v5 continuity authority');
  return resolveEffectiveRejectionState({ ...input, verifySignature: (value, options) => recordAuthority.verify(value, options) });
}

export function materialWideTombstoneKey(materialSha256s) {
  if (!Array.isArray(materialSha256s) || materialSha256s.length !== 2 || new Set(materialSha256s).size !== 2) fail('material hashes must contain two unique hashes');
  for (const digest of materialSha256s) assertSha(digest, 'material hash');
  return sha256Canonical({ domain: 'punchgrow:g003:rejected-child-material-v2', materialSha256s: [...materialSha256s].sort() });
}

export function materialConstituentIndexKeys(materialSha256s) {
  materialWideTombstoneKey(materialSha256s);
  return [...materialSha256s].sort().map((materialSha256) => sha256Canonical({ domain: 'punchgrow:g003:rejected-child-constituent-v1', materialSha256 }));
}

function assertReviewerBinding(observation, assignment, assignmentRawSha256, packageContext) {
  assertSha(assignmentRawSha256, 'assignment raw hash');
  if (sha256Bytes(packageContext.assignmentBytes) !== assignmentRawSha256) fail('assignment raw SHA does not match persisted bytes');
  if (observation.assignmentId !== assignment.assignmentId || observation.assignmentRawSha256 !== assignmentRawSha256) fail('observation borrowed an assignment');
  for (const field of IDENTITY_FIELDS) if (observation[field] !== assignment[field]) fail(`observation borrowed or renamed ${field}`);
  for (const field of BINDING_FIELDS.filter((field) => field !== 'inputAssetSha256s')) {
    if (observation[field] !== assignment[field] || observation[field] !== packageContext[field]) fail(`observation ${field} differs from assignment/package`);
  }
  exactArray(observation.inputAssetSha256s, assignment.inputAssetSha256s, 'observation input assets');
  exactArray(observation.inputAssetSha256s, packageContext.inputAssetSha256s, 'observation input assets');
  assertTaxonomy(observation.requiredChildTaxonomy, 'requiredChildTaxonomy');
  if (canonicalStringify(observation.requiredChildTaxonomy) !== canonicalStringify(packageContext.requiredChildTaxonomy)) fail('reviewer taxonomy claim differs from exact signed requiredChildTaxonomy');
}

function assertFailureFinding(finding, packageContext, index) {
  const label = `failure finding ${index}`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding) || typeof finding.explanation !== 'string' || !finding.explanation.trim()) fail(`${label} is invalid`);
  switch (finding.type) {
    case 'taxonomy-mismatch': {
      exactKeys(finding, ['type', 'field', 'expected', 'observed', 'surfaces', 'explanation'], label);
      if (!TAXONOMY_FIELDS.includes(finding.field) || finding.expected !== packageContext.requiredChildTaxonomy[finding.field]
          || typeof finding.observed !== 'string' || !finding.observed || finding.observed === finding.expected) fail(`${label} taxonomy expected/observed is invalid`);
      exactArray(finding.surfaces, ['master', 'runtime'], `${label} surfaces`);
      break;
    }
    case 'same-creature-failure':
      exactKeys(finding, ['type', 'parentRole', 'expected', 'observed', 'surfaces', 'explanation'], label);
      if (!packageContext.parentRoles.includes(finding.parentRole) || finding.expected !== 'yes' || finding.observed !== 'no') fail(`${label} same-creature evidence is invalid`);
      exactArray(finding.surfaces, ['master', 'runtime'], `${label} surfaces`);
      break;
    case 'anchor-failure': {
      exactKeys(finding, ['type', 'parentRole', 'anchorId', 'expected', 'observed', 'surfaces', 'explanation'], label);
      const anchor = packageContext.requiredAnchors.find((item) => item.parentRole === finding.parentRole && item.anchorId === finding.anchorId);
      if (!anchor || finding.expected !== anchor.description || typeof finding.observed !== 'string' || !finding.observed || finding.observed === finding.expected) fail(`${label} anchor evidence is invalid`);
      exactArray(finding.surfaces, ['master', 'runtime'], `${label} surfaces`);
      break;
    }
    case 'eilu-failure':
      exactKeys(finding, ['type', 'benchmarkId', 'metric', 'expectedMinimum', 'observed', 'explanation'], label);
      if (finding.benchmarkId !== packageContext.eiluBenchmarkId || !['continuityScore', 'anchorRetentionRatio', 'retainedAnchorCount'].includes(finding.metric)
          || !Number.isFinite(finding.expectedMinimum) || !Number.isFinite(finding.observed) || finding.observed >= finding.expectedMinimum) fail(`${label} Eilu evidence is invalid`);
      break;
    case 'canonical-surface-failure':
      exactKeys(finding, ['type', 'surface', 'field', 'expected', 'observed', 'explanation'], label);
      if (!packageContext.canonicalMode || !['master', 'runtime'].includes(finding.surface) || typeof finding.field !== 'string'
          || typeof finding.expected !== 'string' || !finding.expected || typeof finding.observed !== 'string' || !finding.observed || finding.expected === finding.observed) fail(`${label} canonical surface evidence is invalid`);
      break;
    case 'appendage-ambiguity':
      exactKeys(finding, ['type', 'surface', 'expectedAmbiguity', 'observedAmbiguity', 'explanation'], label);
      if (!packageContext.canonicalMode || !['master', 'runtime'].includes(finding.surface) || finding.expectedAmbiguity !== false || finding.observedAmbiguity !== true) fail(`${label} appendage evidence is invalid`);
      break;
    default: fail(`${label} has an unknown typed failure`);
  }
}

function assertPassEvidence(evidence, packageContext) {
  exactKeys(evidence, ['childTaxonomy', 'sameCreatureObservations', 'anchorObservations', 'eiluObservation', 'canonicalSurfaceObservations'], 'PASS evidence');
  assertTaxonomy(evidence.childTaxonomy, 'PASS child taxonomy');
  if (canonicalStringify(evidence.childTaxonomy) !== canonicalStringify(packageContext.requiredChildTaxonomy)) fail('PASS taxonomy differs from requiredChildTaxonomy');
  if (!Array.isArray(evidence.sameCreatureObservations) || evidence.sameCreatureObservations.length !== packageContext.parentRoles.length) fail('PASS same-creature evidence is incomplete');
  for (const item of evidence.sameCreatureObservations) {
    exactKeys(item, ['parentRole', 'sameCreatureGrownUp', 'observation'], 'PASS same-creature observation');
    if (!packageContext.parentRoles.includes(item.parentRole) || item.sameCreatureGrownUp !== 'yes' || typeof item.observation !== 'string' || !item.observation) fail('PASS same-creature observation is invalid');
  }
  if (new Set(evidence.sameCreatureObservations.map((item) => item.parentRole)).size !== packageContext.parentRoles.length) fail('PASS same-creature roles are duplicated');
  if (!Array.isArray(evidence.anchorObservations) || evidence.anchorObservations.length !== packageContext.requiredAnchors.length) fail('PASS anchor evidence is incomplete');
  for (const item of evidence.anchorObservations) {
    exactKeys(item, ['parentRole', 'anchorId', 'requiredDescription', 'satisfied', 'observation'], 'PASS anchor observation');
    const anchor = packageContext.requiredAnchors.find((expected) => expected.parentRole === item.parentRole && expected.anchorId === item.anchorId);
    if (!anchor || item.requiredDescription !== anchor.description || item.satisfied !== true || typeof item.observation !== 'string' || !item.observation) fail('PASS anchor observation is invalid');
  }
  if (new Set(evidence.anchorObservations.map((item) => `${item.parentRole}\0${item.anchorId}`)).size !== packageContext.requiredAnchors.length) fail('PASS anchors are duplicated');
  exactKeys(evidence.eiluObservation, ['benchmarkId', 'continuityScore', 'anchorRetentionRatio', 'retainedAnchorCount', 'observation'], 'PASS Eilu observation');
  if (evidence.eiluObservation.benchmarkId !== packageContext.eiluBenchmarkId
      || !Number.isFinite(evidence.eiluObservation.continuityScore) || evidence.eiluObservation.continuityScore < 0.96 || evidence.eiluObservation.continuityScore > 1
      || !Number.isFinite(evidence.eiluObservation.anchorRetentionRatio) || evidence.eiluObservation.anchorRetentionRatio < 1
      || !Number.isInteger(evidence.eiluObservation.retainedAnchorCount) || evidence.eiluObservation.retainedAnchorCount < 3
      || typeof evidence.eiluObservation.observation !== 'string' || !evidence.eiluObservation.observation) fail('PASS Eilu observation is invalid');
  if (!Array.isArray(evidence.canonicalSurfaceObservations)) fail('PASS canonical surface evidence is invalid');
  if (packageContext.canonicalMode) {
    if (canonicalStringify(evidence.canonicalSurfaceObservations.map((item) => item.surface)) !== canonicalStringify(['master', 'runtime'])) fail('PASS canonical surfaces must be exact and ordered');
    for (const item of evidence.canonicalSurfaceObservations) {
      exactKeys(item, ['surface', 'taxonomyMatches', 'anchorsSatisfied', 'appendageAmbiguity', 'observation'], 'PASS canonical surface');
      if (item.taxonomyMatches !== true || item.anchorsSatisfied !== true || item.appendageAmbiguity !== false || typeof item.observation !== 'string' || !item.observation) fail('PASS canonical surface is invalid');
    }
  } else if (evidence.canonicalSurfaceObservations.length !== 0) fail('non-canonical PASS cannot claim canonical surface evidence');
}

export function assertReviewerAuthoredVerdictV2(observation, { assignment, assignmentBytes, packageContext, now = Date.now() }) {
  const keys = [
    'schemaVersion', 'assignmentId', 'assignmentRawSha256', ...IDENTITY_FIELDS,
    ...BINDING_FIELDS, 'requiredChildTaxonomy', 'verdict', 'passEvidence', 'failureFindings',
    'explanation', 'confidence', 'observedAt',
  ];
  exactKeys(observation, keys, 'reviewer verdict v2');
  if (!['continuity-g003-reviewer-verdict-v2', 'continuity-g003-rejection-observation-v2'].includes(observation.schemaVersion)) fail('reviewer verdict schema is invalid');
  if (typeof observation.assignmentId !== 'string' || observation.assignmentId.length < 16) fail('reviewer verdict assignmentId is invalid');
  for (const field of IDENTITY_FIELDS.filter((field) => field !== 'passNumber')) {
    if (typeof observation[field] !== 'string' || observation[field].length < 8) fail(`reviewer verdict ${field} is invalid`);
  }
  if (![1, 2].includes(observation.passNumber)) fail('reviewer verdict passNumber is invalid');
  if (!/^candidate-[a-f0-9]{24}$/.test(observation.opaqueCandidateId ?? '')) fail('reviewer verdict opaqueCandidateId is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(observation.generationRunId ?? '')) fail('reviewer verdict generationRunId is invalid');
  for (const field of ['assignmentRawSha256', 'packageManifestSha256', 'materialBindingSha256', 'inputAllowlistSha256', 'promptSha256']) assertSha(observation[field], `reviewer verdict ${field}`);
  assertShaArray(observation.inputAssetSha256s, 'reviewer verdict inputAssetSha256s');
  assertTaxonomy(observation.requiredChildTaxonomy, 'reviewer verdict requiredChildTaxonomy');
  if (typeof observation.explanation !== 'string') fail('reviewer verdict explanation must be a string');
  if (!Array.isArray(observation.failureFindings)) fail('reviewer verdict failureFindings must be an array');
  const assignmentRawSha256 = sha256Bytes(assignmentBytes);
  assertReviewerBinding(observation, assignment, assignmentRawSha256, { ...packageContext, assignmentBytes });
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) fail('reviewer confidence is invalid');
  assertTime(observation.observedAt, 'observedAt');
  if (Date.parse(observation.observedAt) > now + 60_000) fail('observedAt is in the future');
  if (Number.isFinite(Date.parse(assignment.assignedAt)) && Date.parse(observation.observedAt) < Date.parse(assignment.assignedAt)) fail('observedAt predates the reviewer assignment');
  if (observation.verdict === 'PASS') {
    if (!observation.passEvidence || typeof observation.passEvidence !== 'object' || Array.isArray(observation.passEvidence)
        || Object.keys(observation.passEvidence).length === 0 || observation.failureFindings.length !== 0 || observation.confidence < 0.96) {
      fail('PASS requires reviewer-authored structured evidence; a boolean verdict cannot create evidence');
    }
    assertPassEvidence(observation.passEvidence, packageContext);
  } else if (observation.verdict === 'REJECT') {
    if (observation.passEvidence !== null || !Array.isArray(observation.failureFindings) || observation.failureFindings.length === 0) fail('REJECT requires structured typed failure findings');
    observation.failureFindings.forEach((finding, index) => assertFailureFinding(finding, packageContext, index));
  } else fail('reviewer verdict must be PASS or REJECT');
  return Object.freeze({ observationSha256: sha256Canonical(observation), verdict: observation.verdict });
}

export function assertRejectionObservationV2(observation, context) {
  if (observation?.schemaVersion !== 'continuity-g003-rejection-observation-v2') fail('attest-rejection requires rejection-observation-v2 bytes');
  const result = assertReviewerAuthoredVerdictV2(observation, context);
  if (result.verdict !== 'REJECT') fail('attest-rejection accepts only a structured REJECT observation');
  return result;
}

const QUARANTINE_BINDINGS = Object.freeze([
  'materialKey', 'materialSha256s', 'archivedMaterialFileSha256s', 'lockedContractSha256',
  'priorRejectionObservationSha256', 'tombstoneOutputSha256', 'tombstoneFileSha256',
]);

function assertQuarantineFrozenBinding(value, frozen, label) {
  if (value.materialKey !== materialWideTombstoneKey(value.materialSha256s)) fail(`${label} material key is invalid`);
  if (value.materialKey !== frozen.materialKey) fail(`${label} targets a different frozen material set`);
  exactArray(value.materialSha256s, frozen.materialSha256s, `${label} material hashes`);
  exactArray(value.archivedMaterialFileSha256s, frozen.archivedMaterialFileSha256s, `${label} archived material file hashes`);
  for (const field of QUARANTINE_BINDINGS.slice(3)) if (value[field] !== frozen[field]) fail(`${label} ${field} differs from the frozen quarantine case`);
}

export function assertQuarantineAssignmentV1(assignment, frozen, { verifySignature }) {
  exactKeys(assignment, [
    'schemaVersion', 'assignmentId', 'role', 'reviewerInstanceId', 'agentTaskId', 'reviewRunId', 'passNumber',
    ...QUARANTINE_BINDINGS, 'obligationCredit', 'pixelDisposition', 'assignedAt', 'outputSha256', 'publicSignature',
  ], 'quarantine assignment');
  if (assignment.schemaVersion !== 'continuity-g003-quarantine-assignment-v1' || assignment.role !== 'quarantine-invalidity'
      || ![1, 2].includes(assignment.passNumber) || assignment.obligationCredit !== 0 || assignment.pixelDisposition !== 'UNCHANGED') fail('quarantine assignment authority is invalid');
  assertQuarantineFrozenBinding(assignment, frozen, 'quarantine assignment');
  for (const field of ['assignmentId', 'reviewerInstanceId', 'agentTaskId', 'reviewRunId']) if (typeof assignment[field] !== 'string' || assignment[field].length < 8) fail(`quarantine assignment ${field} is invalid`);
  assertTime(assignment.assignedAt, 'quarantine assignedAt');
  const core = Object.fromEntries(Object.entries(assignment).filter(([key]) => !['outputSha256', 'publicSignature'].includes(key)));
  if (assignment.outputSha256 !== sha256Canonical(core)) fail('quarantine assignment output hash is forged');
  assertSignedRecord(assignment, 'continuity:g003-quarantine-assignment-v1', verifySignature, 'quarantine assignment');
  return true;
}

export function assertQuarantineInvalidityAttestationV1(attestation, assignment, assignmentBytes, frozen) {
  exactKeys(attestation, [
    'schemaVersion', 'assignmentId', 'assignmentRawSha256', 'reviewerInstanceId', 'agentTaskId', 'reviewRunId', 'passNumber',
    ...QUARANTINE_BINDINGS, 'verdict', 'obligationCredit', 'pixelDisposition', 'invalidityFinding', 'confidence', 'observedAt', 'outputSha256', 'publicSignature',
  ], 'quarantine invalidity attestation');
  if (attestation.schemaVersion !== 'continuity-g003-quarantine-invalidity-attestation-v1' || attestation.verdict !== 'INVALID_REJECTION'
      || attestation.obligationCredit !== 0 || attestation.pixelDisposition !== 'UNCHANGED') fail('quarantine attestation cannot vote for an obligation or accept pixels');
  if (attestation.assignmentId !== assignment.assignmentId || attestation.assignmentRawSha256 !== sha256Bytes(assignmentBytes)) fail('quarantine attestation borrowed an assignment');
  for (const field of ['reviewerInstanceId', 'agentTaskId', 'reviewRunId', 'passNumber']) if (attestation[field] !== assignment[field]) fail(`quarantine attestation borrowed ${field}`);
  assertQuarantineFrozenBinding(attestation, frozen, 'quarantine attestation');
  exactKeys(attestation.invalidityFinding, ['type', 'expected', 'observed', 'evidenceSha256', 'explanation'], 'quarantine invalidity finding');
  if (!['taxonomy-claim-mismatch', 'contract-binding-mismatch', 'observation-material-mismatch', 'tombstone-binding-mismatch'].includes(attestation.invalidityFinding.type)
      || typeof attestation.invalidityFinding.expected !== 'string' || !attestation.invalidityFinding.expected
      || typeof attestation.invalidityFinding.observed !== 'string' || !attestation.invalidityFinding.observed
      || attestation.invalidityFinding.expected === attestation.invalidityFinding.observed
      || typeof attestation.invalidityFinding.explanation !== 'string' || !attestation.invalidityFinding.explanation) fail('quarantine invalidity finding is not typed evidence');
  assertSha(attestation.invalidityFinding.evidenceSha256, 'quarantine invalidity evidence hash');
  if (!Number.isFinite(attestation.confidence) || attestation.confidence < 0.96 || attestation.confidence > 1) fail('quarantine confidence is invalid');
  assertTime(attestation.observedAt, 'quarantine observedAt');
  if (Date.parse(attestation.observedAt) < Date.parse(assignment.assignedAt)) fail('quarantine observedAt predates assignment');
  const core = Object.fromEntries(Object.entries(attestation).filter(([key]) => !['outputSha256', 'publicSignature'].includes(key)));
  if (attestation.outputSha256 !== sha256Canonical(core)) fail('quarantine attestation output hash is forged');
  return Object.freeze({ attestationRawSha256: sha256Canonical(attestation), obligationCredit: 0, pixelDisposition: 'UNCHANGED' });
}

export function adjudicateQuarantineInvalidityV1({ frozen, assignments, assignmentBytes, attestations, attestationBytes, verifySignature }) {
  if (!Array.isArray(assignments) || assignments.length !== 2 || !Array.isArray(assignmentBytes) || assignmentBytes.length !== 2
      || !Array.isArray(attestations) || attestations.length !== 2 || !Array.isArray(attestationBytes) || attestationBytes.length !== 2) fail('quarantine adjudication requires exactly two assignments and attestations');
  const results = assignments.map((assignment, index) => {
    if (!Buffer.isBuffer(assignmentBytes[index]) || !assignmentBytes[index].equals(Buffer.from(canonicalStringify(assignment)))) fail('quarantine assignment raw bytes are not exact canonical assignment bytes');
    if (!Buffer.isBuffer(attestationBytes[index]) || !attestationBytes[index].equals(Buffer.from(canonicalStringify(attestations[index])))) fail('quarantine attestation raw bytes are not exact canonical attestation bytes');
    assertQuarantineAssignmentV1(assignment, frozen, { verifySignature });
    const result = assertQuarantineInvalidityAttestationV1(attestations[index], assignment, assignmentBytes[index], frozen);
    assertSignedRecord(attestations[index], 'continuity:g003-quarantine-invalidity-attestation-v1', verifySignature, 'quarantine attestation');
    return result;
  });
  for (const field of ['assignmentId', 'reviewerInstanceId', 'agentTaskId', 'reviewRunId', 'passNumber']) {
    if (new Set(assignments.map((item) => item[field])).size !== 2) fail(`quarantine assignments are not independent by ${field}`);
  }
  return Object.freeze({
    schemaVersion: 'continuity-g003-quarantine-adjudication-v1', materialKey: frozen.materialKey,
    priorTombstoneSha256: frozen.tombstoneOutputSha256, priorTombstoneFileSha256: frozen.tombstoneFileSha256,
    assignmentRawSha256s: Object.freeze(assignmentBytes.map((bytes) => sha256Bytes(bytes))),
    attestationRawSha256s: Object.freeze(attestationBytes.map((bytes) => sha256Bytes(bytes))),
    invalidityProofSha256: sha256Canonical(attestations.map((item) => item.invalidityFinding)),
    obligationCredit: 0, pixelDisposition: 'UNCHANGED', requiredFreshContinuityReviews: 2,
  });
}

export function resolveEffectiveReviewState({ acceptedReviews = [], invalidities = [], verifySignature }) {
  if (typeof verifySignature !== 'function') fail('review invalidity signature verifier is required');
  const acceptedByHash = new Map();
  for (const review of acceptedReviews) {
    assertSha(review.artifactSha256, 'accepted artifact hash');
    if (acceptedByHash.has(review.artifactSha256)) fail('duplicate accepted artifact');
    acceptedByHash.set(review.artifactSha256, review);
  }
  const invalidityByTarget = new Map(); let previousInvalidity = null;
  const byRecord = new Map();
  for (const invalidity of invalidities) {
    exactKeys(invalidity, ['schemaVersion', 'invalidityId', 'invalidatedArtifactSha256', 'invalidatedArtifactFileSha256', 'reasonCode', 'findingSha256', 'priorInvaliditySha256', 'issuedAt', 'outputSha256', 'publicSignature'], 'review invalidity');
    if (invalidity.schemaVersion !== 'continuity-g003-review-invalidity-v1') fail('review invalidity schema is invalid');
    for (const field of ['invalidityId', 'invalidatedArtifactSha256', 'invalidatedArtifactFileSha256', 'findingSha256', 'outputSha256']) assertSha(invalidity[field], `invalidity ${field}`);
    if (!acceptedByHash.has(invalidity.invalidatedArtifactSha256)) fail('invalidity targets an unknown artifact');
    if (acceptedByHash.get(invalidity.invalidatedArtifactSha256).artifactFileSha256 !== invalidity.invalidatedArtifactFileSha256) fail('invalidity targets changed artifact bytes');
    if (invalidity.outputSha256 !== sha256Canonical(Object.fromEntries(Object.entries(invalidity).filter(([key]) => !['outputSha256', 'publicSignature'].includes(key))))) fail('invalidity output hash is forged');
    assertSignedRecord(invalidity, 'continuity:g003-review-invalidity-v1', verifySignature, 'review invalidity');
    assertTime(invalidity.issuedAt, 'invalidity issuedAt');
    if (byRecord.has(invalidity.outputSha256)) fail('duplicate invalidity record');
    byRecord.set(invalidity.outputSha256, invalidity);
    if (invalidity.priorInvaliditySha256 !== (previousInvalidity?.outputSha256 ?? null)) fail('invalidity chain fork or rollback');
    if (previousInvalidity && Date.parse(invalidity.issuedAt) <= Date.parse(previousInvalidity.issuedAt)) fail('invalidity order is not append-only');
    if (invalidityByTarget.has(invalidity.invalidatedArtifactSha256)) fail('invalidity chain fork or duplicate target');
    invalidityByTarget.set(invalidity.invalidatedArtifactSha256, invalidity);
    previousInvalidity = invalidity;
  }
  const effectiveReviews = acceptedReviews.filter((review) => !invalidityByTarget.has(review.artifactSha256));
  return Object.freeze({ effectiveReviews, preservedReviews: Object.freeze([...acceptedReviews]), invalidatedArtifactSha256s: Object.freeze([...invalidityByTarget.keys()].sort()), autoAcceptedPixels: false });
}

export function resolveEffectiveRejectionState({ tombstones = [], supersessions = [], quarantineEvidenceCases = [], verifySignature }) {
  if (typeof verifySignature !== 'function') fail('rejection effective-state signature verifier is required');
  const byHash = new Map(); const tips = new Map();
  for (const record of tombstones) {
    exactKeys(record, ['value', 'fileSha256'], 'tombstone persisted record');
    assertSha(record.fileSha256, 'tombstone external file hash');
    const tombstone = record.value;
    exactKeys(tombstone, ['schemaVersion', 'tombstoneKey', 'constituentIndexKeys', 'candidateId', 'generationRunId', 'materialSha256s', 'rejectionObservationSha256', 'rejectionArchiveSha256', 'rejectedAt', 'outputSha256', 'publicSignature'], 'tombstone');
    if (tombstone.schemaVersion !== 'continuity-g003-rejection-tombstone-v2' || !/^(g003-candidate:PG-[0-9]{3}|g003-edge:PG-[0-9]{3}:PG-[0-9]{3})$/.test(tombstone.candidateId)
        || typeof tombstone.generationRunId !== 'string' || !tombstone.generationRunId || !Number.isFinite(Date.parse(tombstone.rejectedAt))) fail('tombstone identity/time is invalid');
    const expectedKey = materialWideTombstoneKey(tombstone.materialSha256s);
    if (tombstone.tombstoneKey !== expectedKey) fail('tombstone permits run-ID laundering');
    exactArray(tombstone.constituentIndexKeys, materialConstituentIndexKeys(tombstone.materialSha256s), 'tombstone constituent indexes');
    assertSha(tombstone.outputSha256, 'tombstone output hash');
    const tombstoneCore = Object.fromEntries(Object.entries(tombstone).filter(([key]) => !['outputSha256', 'publicSignature'].includes(key)));
    if (tombstone.outputSha256 !== sha256Canonical(tombstoneCore)) fail('tombstone output hash is forged');
    assertSignedRecord(tombstone, 'continuity:g003-rejection-tombstone-v2', verifySignature, 'tombstone');
    if (byHash.has(tombstone.outputSha256)) fail('duplicate tombstone');
    if (tips.has(expectedKey)) fail('duplicate material-wide tombstone');
    byHash.set(tombstone.outputSha256, record); tips.set(expectedKey, record);
  }
  const quarantineAdjudications = quarantineEvidenceCases.map((evidence) => adjudicateQuarantineInvalidityV1({ ...evidence, verifySignature }));
  const invalidated = new Set(); let previousSupersession = null;
  for (const item of supersessions) {
    exactKeys(item, ['schemaVersion', 'supersessionId', 'tombstoneKey', 'priorTombstoneSha256', 'priorTombstoneFileSha256', 'action', 'reasonCode', 'invalidityProofSha256', 'quarantineAssignmentRawSha256s', 'quarantineAttestationRawSha256s', 'priorSupersessionSha256', 'issuedAt', 'outputSha256', 'publicSignature'], 'tombstone supersession');
    if (item.schemaVersion !== 'continuity-g003-rejection-tombstone-supersession-v1' || item.action !== 'INVALIDATE_REJECTION') fail('tombstone supersession schema/action is invalid');
    const tombstoneRecord = byHash.get(item.priorTombstoneSha256); const tombstone = tombstoneRecord?.value;
    if (!tombstone || tombstone.tombstoneKey !== item.tombstoneKey) fail('tombstone supersession target is forged');
    if (tombstoneRecord.fileSha256 !== item.priorTombstoneFileSha256) fail('tombstone supersession targets changed tombstone bytes');
    assertSha(item.invalidityProofSha256, 'tombstone invalidity proof hash');
    for (const [field, values] of [['quarantine assignment hashes', item.quarantineAssignmentRawSha256s], ['quarantine attestation hashes', item.quarantineAttestationRawSha256s]]) {
      if (!Array.isArray(values) || values.length !== 2 || new Set(values).size !== 2) fail(`${field} must bind two independent raw records`);
      for (const digest of values) assertSha(digest, field);
    }
    const adjudication = quarantineAdjudications.find((proof) => proof.invalidityProofSha256 === item.invalidityProofSha256);
    if (!adjudication || adjudication.materialKey !== item.tombstoneKey || adjudication.priorTombstoneSha256 !== item.priorTombstoneSha256
        || adjudication.priorTombstoneFileSha256 !== item.priorTombstoneFileSha256
        || canonicalStringify(adjudication.assignmentRawSha256s) !== canonicalStringify(item.quarantineAssignmentRawSha256s)
        || canonicalStringify(adjudication.attestationRawSha256s) !== canonicalStringify(item.quarantineAttestationRawSha256s)
        || adjudication.obligationCredit !== 0 || adjudication.pixelDisposition !== 'UNCHANGED' || adjudication.requiredFreshContinuityReviews !== 2) fail('tombstone supersession lacks the exact zero-credit quarantine invalidity proof');
    if (invalidated.has(item.priorTombstoneSha256)) fail('tombstone supersession fork');
    if (item.priorSupersessionSha256 !== (previousSupersession?.outputSha256 ?? null)) fail('tombstone supersession fork or rollback');
    const core = Object.fromEntries(Object.entries(item).filter(([key]) => !['outputSha256', 'publicSignature'].includes(key)));
    if (item.outputSha256 !== sha256Canonical(core)) fail('tombstone supersession output hash is forged');
    assertSignedRecord(item, 'continuity:g003-rejection-tombstone-supersession-v1', verifySignature, 'tombstone supersession');
    assertTime(item.issuedAt, 'tombstone supersession issuedAt');
    if (previousSupersession && Date.parse(item.issuedAt) <= Date.parse(previousSupersession.issuedAt)) fail('tombstone supersession order is not append-only');
    previousSupersession = item; invalidated.add(item.priorTombstoneSha256);
  }
  const effectiveTombstones = tombstones.filter((item) => !invalidated.has(item.value.outputSha256));
  return Object.freeze({
    effectiveTombstones,
    effectiveMaterialKeys: Object.freeze(effectiveTombstones.map((item) => item.value.tombstoneKey).sort()),
    effectiveConstituentIndexKeys: Object.freeze([...new Set(effectiveTombstones.flatMap((item) => item.value.constituentIndexKeys))].sort()),
    invalidatedTombstoneSha256s: Object.freeze([...invalidated].sort()),
    preservedTombstones: Object.freeze([...tombstones]),
    autoAcceptedPixels: false,
    requiredFreshContinuityReviewsByMaterialKey: Object.freeze(Object.fromEntries([...invalidated].map((digest) => [byHash.get(digest).value.tombstoneKey, 2]))),
  });
}

export function assertNoEffectiveMaterialRejection(materialSha256s, effectiveState) {
  const materialKey = materialWideTombstoneKey(materialSha256s);
  const constituentKeys = materialConstituentIndexKeys(materialSha256s);
  if (effectiveState.effectiveMaterialKeys?.includes(materialKey)) fail('exact child material set remains rejected');
  if (constituentKeys.some((key) => effectiveState.effectiveConstituentIndexKeys?.includes(key))) fail('child material reuses a rejected constituent surface');
  return true;
}

export function canonicalReviewerObservationBytes(value) { return Buffer.from(canonicalStringify(value)); }

export async function readReviewerAuthoredObservation(repoRoot, relativePath) {
  assertCanonicalRelativePath(relativePath, 'reviewer observation path');
  const bytes = await readContainedFile(repoRoot, relativePath, 'reviewer observation');
  let value;
  try { value = JSON.parse(bytes); } catch { fail('reviewer observation is not JSON'); }
  if (!bytes.equals(canonicalReviewerObservationBytes(value))) fail('reviewer observation must be canonical JSON bytes');
  return Object.freeze({ value, bytes, sha256: sha256Bytes(bytes) });
}
