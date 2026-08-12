import path from 'node:path';
import { createHash, sign, verify } from 'node:crypto';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, readContainedFile } from './continuity-assignment/evidence.mjs';
import { deriveContinuityAuthority } from './continuity-public-authority.mjs';
import {
  G003_V5_PROTOCOL,
  G003_V5_SCHEMA_PATHS,
  assertRejectionObservationV2,
  assertReviewerAuthoredVerdictV2,
  materialConstituentIndexKeys,
  materialWideTombstoneKey,
} from './g003-v5-authority.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from './g003-transition-integrity.mjs';

export const G003_V5_CONDUCTOR_COUNTS = Object.freeze({
  queue: 167,
  ordinaryEdges: 170,
  obligations: 337,
  votes: 674,
  votesPerObligation: 2,
});
export const G003_V5_MIXED_SLOT_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `PG-${String(196 + index).padStart(3, '0')}`),
);
export const G003_V5_ASSIGNMENT_SCHEMA = 'continuity-g003-reviewer-assignment-v5';
export const G003_V5_VOTE_SCHEMA = 'continuity-g003-primary-vote-v5';
export const G003_V5_COVERAGE_SCHEMA = 'continuity-g003-review-coverage-v5';

const SHA = /^[a-f0-9]{64}$/;
const MIXED = new Set(G003_V5_MIXED_SLOT_IDS);
const COUNTS = G003_V5_CONDUCTOR_COUNTS;
const VERIFIED_INPUTS = new WeakSet();
const PRODUCTION_VERIFIED_INPUTS = new WeakSet();
const ARTIFACT_AUTHORITIES = new WeakSet();
const PRODUCTION_ARTIFACT_AUTHORITIES = new WeakSet();
const PRODUCTION_SIGNING_AUTHORITIES = new WeakMap();
const PRIVATE_PRODUCTION_SIGNING_AUTHORITIES = new WeakSet();
const PURPOSE_ISSUED_VOTES = new WeakSet();
const PURPOSE_ISSUED_RECORDS = new WeakSet();
const PRODUCTION_CONTEXTS = new WeakSet();
const VERIFIED_LOADED_AUTHORITIES = new WeakMap();
const CONTEXT_LOADED_AUTHORITIES = new WeakMap();
const fail = (message) => { throw new Error(`G003-v5 conductor: ${message}`); };
const assertSha = (value, label) => { if (!SHA.test(value ?? '')) fail(`${label} is not a SHA-256`); };
const assertUtcTime = (value, label) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be a true UTC ISO timestamp`);
};

function assertShaArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) fail(`${label} must contain unique SHA-256 values`);
  value.forEach((digest) => assertSha(digest, label));
}

function assertTaxonomy(value, label) {
  exactKeys(value, ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'], label);
  for (const field of ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']) {
    if (typeof value[field] !== 'string' || !value[field]) fail(`${label}.${field} is invalid`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const missing = keys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}

function edgeKey(edge) { return `${edge.parentId}->${edge.childId}`; }
function obligationIdForQueue(slotId) { return `g003-candidate:${slotId}`; }
function obligationIdForEdge(edge) { return `g003-edge:${edge.parentId}:${edge.childId}`; }

function deriveOrdinaryTaxonomyBindings(scope, rootDirectives) {
  if (!Array.isArray(rootDirectives)) fail('verified terminal authority lacks signed root directives');
  const directive = rootDirectives.find((entry) => entry?.rootId === 'PG-018');
  if (!directive || directive.directive !== 'CORRECT_SPECIES_FAMILY'
      || directive.canonicalTarget?.speciesFamily !== 'ovine') fail('signed PG-018 ovine correction is missing or stale');
  const reachable = new Set(['PG-018']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of scope.ordinaryEdges) {
      if (reachable.has(edge.parentId) && !reachable.has(edge.childId)) { reachable.add(edge.childId); changed = true; }
    }
  }
  for (const mixedId of MIXED) if (reachable.has(mixedId)) fail('fusion-only mixed slot entered ordinary taxonomy propagation');
  const byObligation = Object.create(null);
  for (const slotId of reachable) {
    const candidateId = obligationIdForQueue(slotId);
    if (scope.queueSlotIds.includes(slotId)) byObligation[candidateId] = structuredClone(directive.canonicalTarget);
  }
  for (const edge of scope.ordinaryEdges) {
    if (reachable.has(edge.childId)) byObligation[obligationIdForEdge(edge)] = structuredClone(directive.canonicalTarget);
  }
  return Object.freeze({ rootId: directive.rootId, taxonomy: Object.freeze(structuredClone(directive.canonicalTarget)),
    reachableSlotIds: Object.freeze([...reachable].sort()), byObligation: Object.freeze(byObligation) });
}

export function assertG003V5SignedObligationScope(scope) {
  if (scope?.schemaVersion !== 'continuity-signed-obligation-scope-v1'
      || scope.authority !== 'continuity-g002-v2-supersession-v1') fail('signed obligation scope authority/schema is invalid');
  if (scope.exclusionPolicy !== 'EXCLUDE_MIXED_CHILD_OBLIGATIONS_PRESERVE_FUSION_PROVENANCE') fail('signed obligation scope exclusion policy changed');
  if (!Array.isArray(scope.queueSlotIds) || scope.queueSlotIds.length !== COUNTS.queue
      || new Set(scope.queueSlotIds).size !== COUNTS.queue) fail('signed obligation scope must contain exactly 167 unique queue slots');
  if (scope.queueSlotIds.some((slotId) => MIXED.has(slotId))) fail('mixed PG-196..PG-205 queue obligations are forbidden');
  if (!Array.isArray(scope.ordinaryEdges) || scope.ordinaryEdges.length !== COUNTS.ordinaryEdges
      || new Set(scope.ordinaryEdges.map(edgeKey)).size !== COUNTS.ordinaryEdges) fail('signed obligation scope must contain exactly 170 unique ordinary edges');
  for (const edge of scope.ordinaryEdges) {
    if (!edge || !/^PG-[0-9]{3}$/.test(edge.parentId ?? '') || !/^PG-[0-9]{3}$/.test(edge.childId ?? '')) fail('ordinary edge is malformed');
    if (MIXED.has(edge.parentId) || MIXED.has(edge.childId)) fail('mixed PG-196..PG-205 ordinary obligations are forbidden');
  }
  if (canonicalStringify(scope.excludedMixedSlotIds) !== canonicalStringify(G003_V5_MIXED_SLOT_IDS)) fail('mixed exclusion set changed');
  const expectedCounts = {
    queue: 167, retained: 73, ordinaryEdges: 170, obligations: 337, dependent: 113,
    generatedParentEdges: 113, generatedChildEdges: 128, retainedChildEdges: 42,
    votes: 674, effectiveRoots: 17,
  };
  if (canonicalStringify(scope.counts) !== canonicalStringify(expectedCounts)) fail('signed obligation scope counts changed');
  const obligationIds = [
    ...scope.queueSlotIds.map(obligationIdForQueue),
    ...scope.ordinaryEdges.map(obligationIdForEdge),
  ];
  if (obligationIds.length !== COUNTS.obligations || new Set(obligationIds).size !== COUNTS.obligations) fail('signed obligation scope does not resolve to exactly 337 obligations');
  return Object.freeze(obligationIds);
}

export function createG003V5ConductorContext({
  verifiedInputs,
  v4HistoricalArtifacts = [],
}) {
  if (!VERIFIED_INPUTS.has(verifiedInputs)) fail('context requires branded verified terminal/supersession inputs');
  const { terminalAuthority, signedObligationScope } = verifiedInputs;
  exactKeys(terminalAuthority, [
    'state', 'reviewProtocol', 'priorProtocolAuthoritySha256', 'continuityAuthority', 'schemaBindings',
    'protocolAuthoritySha256', 'terminalOutputSha256', 'terminalFileSha256', 'rootDirectives',
  ], 'terminal v5 authority');
  if (terminalAuthority.state !== 'TERMINAL_V5' || terminalAuthority.reviewProtocol !== G003_V5_PROTOCOL) fail('terminal authority is partial or downgraded');
  for (const field of ['protocolAuthoritySha256', 'terminalOutputSha256', 'terminalFileSha256']) assertSha(terminalAuthority[field], `terminal authority ${field}`);
  if (canonicalStringify(terminalAuthority.schemaBindings.map((binding) => binding.path)) !== canonicalStringify(G003_V5_SCHEMA_PATHS)
      || terminalAuthority.schemaBindings.some((binding) => !SHA.test(binding.sha256 ?? ''))) fail('terminal authority schema bindings are incomplete or reordered');
  const authorityCore = { protocol: terminalAuthority.reviewProtocol,
    priorProtocolAuthoritySha256: terminalAuthority.priorProtocolAuthoritySha256,
    continuityAuthority: terminalAuthority.continuityAuthority, schemaBindings: terminalAuthority.schemaBindings };
  if (terminalAuthority.protocolAuthoritySha256 !== sha256Canonical(authorityCore)) fail('terminal protocol authority does not bind exact schema bytes');
  const obligationIds = assertG003V5SignedObligationScope(signedObligationScope);
  const ordinaryTaxonomy = deriveOrdinaryTaxonomyBindings(signedObligationScope, terminalAuthority.rootDirectives);
  if (!Array.isArray(v4HistoricalArtifacts)) fail('v4 historical artifact inventory must be an array');
  const context = Object.freeze({
    schemaVersion: 'continuity-g003-terminal-v5-conductor-context-v1',
    reviewProtocol: G003_V5_PROTOCOL,
    protocolAuthoritySha256: terminalAuthority.protocolAuthoritySha256,
    terminalOutputSha256: terminalAuthority.terminalOutputSha256,
    terminalFileSha256: terminalAuthority.terminalFileSha256,
    schemaBindings: Object.freeze(structuredClone(terminalAuthority.schemaBindings)),
    signedObligationScopeSha256: sha256Canonical(signedObligationScope),
    obligationIds,
    ordinaryTaxonomy,
    v4HistoricalAuditCount: v4HistoricalArtifacts.length,
    v4HistoricalVoteCredit: 0,
  });
  if (PRODUCTION_VERIFIED_INPUTS.has(verifiedInputs)) PRODUCTION_CONTEXTS.add(context);
  if (VERIFIED_LOADED_AUTHORITIES.has(verifiedInputs)) CONTEXT_LOADED_AUTHORITIES.set(context, VERIFIED_LOADED_AUTHORITIES.get(verifiedInputs));
  return context;
}

export function createTestOnlyG003V5VerifiedInputs({ terminalAuthority, signedObligationScope }) {
  if (process.env.NODE_ENV === 'production') fail('test-only verified inputs are forbidden in production');
  const value = Object.freeze({ terminalAuthority: structuredClone(terminalAuthority), signedObligationScope: structuredClone(signedObligationScope) });
  VERIFIED_INPUTS.add(value);
  return value;
}

export async function loadG003V5VerifiedInputs({ repoRoot, terminalStateRoot } = {}) {
  const [{ verifyG003V5ActiveTerminal, G003_V5_ACTIVATION_FILENAMES }, v5Authority] = await Promise.all([
    import('./g003-v5-terminal-activation.mjs'),
    import('./g003-v5-authority.mjs'),
  ]);
  const loadedAuthority = await v5Authority.loadG003V5Authority({ repoRoot });
  const terminalVerifiers = v5Authority.createG003V5TerminalVerifierHooks(loadedAuthority);
  const terminal = await verifyG003V5ActiveTerminal({ repoRoot, stateRoot: terminalStateRoot, verifiers: terminalVerifiers });
  const supersession = loadedAuthority.supersession;
  if (terminal.state !== 'TERMINAL_V5') fail('terminal v5 and signed supersession must both verify');
  const terminalValue = JSON.parse(terminal.tree.buffers.get(G003_V5_ACTIVATION_FILENAMES.v5));
  if (terminalValue.successorOutputSha256 !== supersession.outputSha256
      || terminalValue.protocolAuthoritySha256 !== loadedAuthority.authority.protocolAuthoritySha256) fail('terminal v5 does not bind the verified signed obligation scope authority');
  const value = Object.freeze({
    terminalAuthority: Object.freeze({ state: terminal.state, reviewProtocol: terminalValue.reviewProtocol,
      priorProtocolAuthoritySha256: loadedAuthority.authority.priorProtocolAuthoritySha256,
      continuityAuthority: structuredClone(loadedAuthority.authority.continuityAuthority),
      schemaBindings: structuredClone(loadedAuthority.authority.schemaBindings),
      protocolAuthoritySha256: terminalValue.protocolAuthoritySha256, terminalOutputSha256: terminalValue.outputSha256,
      terminalFileSha256: terminal.pointer.terminalFileSha256, rootDirectives: structuredClone(supersession.rootDirectives) }),
    signedObligationScope: Object.freeze(structuredClone(supersession.obligationScope)),
  });
  VERIFIED_INPUTS.add(value);
  PRODUCTION_VERIFIED_INPUTS.add(value);
  VERIFIED_LOADED_AUTHORITIES.set(value, loadedAuthority);
  return value;
}

const ASSIGNMENT_KEYS = Object.freeze([
  'schemaVersion', 'assignmentId', 'obligationId', 'opaqueCandidateId', 'generationRunId', 'passNumber',
  'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'packageManifestSha256', 'materialBindingSha256',
  'inputAllowlistSha256', 'promptSha256', 'inputAssetSha256s', 'signedObligationScope', 'assignedAt',
  'requiredChildTaxonomy',
  'reviewContext',
  'childMaterialSha256s',
  'outputSha256', 'publicSignature',
]);

export function assertG003V5ReviewerAssignment(assignment, context, artifactAuthority) {
  exactKeys(assignment, ASSIGNMENT_KEYS, 'v5 reviewer assignment');
  if (assignment.schemaVersion !== G003_V5_ASSIGNMENT_SCHEMA) fail('v5 assignment schema is required; legacy assignments remain audit-only');
  if (!context.obligationIds.includes(assignment.obligationId)) fail('assignment targets an obligation outside the signed scope');
  if (![1, 2].includes(assignment.passNumber)) fail('assignment pass number is invalid');
  if (!/^candidate-[a-f0-9]{24}$/.test(assignment.opaqueCandidateId ?? '')) fail('assignment opaqueCandidateId is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assignment.generationRunId ?? '')) fail('assignment generationRunId is invalid');
  for (const field of ['assignmentId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) {
    const minimum = field === 'assignmentId' ? 16 : 8;
    if (typeof assignment[field] !== 'string' || assignment[field].length < minimum) fail(`assignment ${field} is invalid`);
  }
  for (const field of ['packageManifestSha256', 'materialBindingSha256', 'inputAllowlistSha256', 'promptSha256']) assertSha(assignment[field], `assignment ${field}`);
  assertShaArray(assignment.inputAssetSha256s, 'assignment inputAssetSha256s');
  assertUtcTime(assignment.assignedAt, 'assignment assignedAt');
  assertTaxonomy(assignment.requiredChildTaxonomy, 'assignment requiredChildTaxonomy');
  exactKeys(assignment.signedObligationScope, [
    'schemaVersion', 'scopeSha256', 'protocolAuthoritySha256', 'terminalOutputSha256',
  ], 'assignment signedObligationScope');
  if (assignment.signedObligationScope.schemaVersion !== 'continuity-signed-obligation-scope-binding-v1'
      || assignment.signedObligationScope.scopeSha256 !== context.signedObligationScopeSha256
      || assignment.signedObligationScope.protocolAuthoritySha256 !== context.protocolAuthoritySha256
      || assignment.signedObligationScope.terminalOutputSha256 !== context.terminalOutputSha256) fail('assignment signedObligationScope binding changed');
  const derivedTaxonomy = context.ordinaryTaxonomy.byObligation[assignment.obligationId];
  if (derivedTaxonomy && canonicalStringify(assignment.requiredChildTaxonomy) !== canonicalStringify(derivedTaxonomy)) {
    fail(`${assignment.obligationId} requiredChildTaxonomy is stale; signed ordinary topology requires ovine`);
  }
  exactKeys(assignment.reviewContext, ['parentRoles', 'requiredAnchors', 'eiluBenchmarkId', 'canonicalMode'], 'assignment reviewContext');
  const { parentRoles, requiredAnchors, eiluBenchmarkId, canonicalMode } = assignment.reviewContext;
  if (!Array.isArray(parentRoles) || ![1, 2].includes(parentRoles.length)
      || canonicalStringify(parentRoles) !== canonicalStringify(Array.from({ length: parentRoles.length }, (_, index) => `parent-${index + 1}`))
      || !Array.isArray(requiredAnchors) || typeof canonicalMode !== 'boolean'
      || eiluBenchmarkId !== 'eilu-comparative-visual-v1') fail('assignment reviewContext is invalid');
  const anchorKeys = new Set();
  for (const anchor of requiredAnchors) {
    exactKeys(anchor, ['parentRole', 'anchorId', 'description'], 'assignment required anchor');
    const key = `${anchor.parentRole}\0${anchor.anchorId}`;
    if (!parentRoles.includes(anchor.parentRole) || typeof anchor.anchorId !== 'string' || !anchor.anchorId
        || typeof anchor.description !== 'string' || !anchor.description || anchorKeys.has(key)) fail('assignment required anchor is invalid or duplicated');
    anchorKeys.add(key);
  }
  if (assignment.reviewContext.parentRoles.length === 0 || assignment.reviewContext.parentRoles.some((role) => typeof role !== 'string')) fail('assignment reviewContext parentRoles are invalid');
  if (!Array.isArray(assignment.childMaterialSha256s) || assignment.childMaterialSha256s.length !== 2
      || new Set(assignment.childMaterialSha256s).size !== 2 || assignment.childMaterialSha256s.some((digest) => !SHA.test(digest))) fail('assignment childMaterialSha256s must bind exact master/runtime material');
  if (!ARTIFACT_AUTHORITIES.has(artifactAuthority) || artifactAuthority.verifyRecord(assignment) !== true) fail('v5 assignment signature/output failed public verification');
  return true;
}

function finalizeSigned(core, schemaVersion, artifactAuthority) {
  if (!ARTIFACT_AUTHORITIES.has(artifactAuthority)) fail(`${schemaVersion} requires a purpose/schema-bound artifact authority`);
  const signingAuthority = PRODUCTION_SIGNING_AUTHORITIES.get(artifactAuthority) ?? artifactAuthority;
  if (typeof signingAuthority.finalize !== 'function') fail(`${schemaVersion} signing capability is unavailable`);
  return signingAuthority.finalize(core, schemaVersion);
}

const PRIVATE_SIGNED_SCHEMA_BY_PURPOSE = Object.freeze({
  'continuity:g003-reviewer-assignment-v5': 'production/contracts/g003-reviewer-assignment-v5.schema.json',
  'continuity:g003-primary-vote-v5': 'production/contracts/g003-primary-vote-v5.schema.json',
  'continuity:g003-candidate-review-v5': 'production/contracts/continuity-candidate-review-v5.schema.json',
  'continuity:g003-public-review-artifact-v5': 'production/contracts/g003-public-review-artifact-v5.schema.json',
  'continuity:g003-review-coverage-v5': 'production/contracts/g003-review-coverage-v5.schema.json',
  'continuity:g003-rejection-archive-v5': 'production/contracts/g003-rejection-archive-v5.schema.json',
  'continuity:g003-rejection-tombstone-v2': 'production/contracts/g003-rejection-tombstone-v2.schema.json',
});
const PRIVATE_PURPOSE_BY_SCHEMA = Object.freeze({
  'continuity-g003-reviewer-assignment-v5': { purpose: 'continuity:g003-reviewer-assignment-v5', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-reviewer-assignment-v5'] },
  'continuity-g003-primary-vote-v5': { purpose: 'continuity:g003-primary-vote-v5', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-primary-vote-v5'] },
  'continuity-g003-candidate-review-v5': { purpose: 'continuity:g003-candidate-review-v5', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-candidate-review-v5'] },
  'continuity-g003-public-review-artifact-v5': { purpose: 'continuity:g003-public-review-artifact-v5', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-public-review-artifact-v5'] },
  'continuity-g003-review-coverage-v5': { purpose: 'continuity:g003-review-coverage-v5', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-review-coverage-v5'] },
  'continuity-g003-rejection-archive-v5': { purpose: 'continuity:g003-rejection-archive-v5', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-rejection-archive-v5'] },
  'continuity-g003-rejection-tombstone-v2': { purpose: 'continuity:g003-rejection-tombstone-v2', schemaPath: PRIVATE_SIGNED_SCHEMA_BY_PURPOSE['continuity:g003-rejection-tombstone-v2'] },
});
const PRIVATE_SIGNATURE_DOMAIN = 'punchgrow:continuity:g003-terminal-v5-record-signature-v1\0';

function privateSignaturePayload(unsigned, bindings) {
  return { domain: PRIVATE_SIGNATURE_DOMAIN, reviewProtocol: G003_V5_PROTOCOL,
    protocolAuthoritySha256: bindings.protocolAuthoritySha256, authorityEpoch: 'continuity-authority-epoch-v1',
    delegationOutputSha256: bindings.delegationOutputSha256, purpose: bindings.purpose,
    schemaSha256: bindings.schemaSha256, unsignedCanonicalBytesBase64: Buffer.from(canonicalStringify(unsigned)).toString('base64') };
}

async function createPrivateProductionSigningAuthority({ repoRoot, loadedAuthority, conductorKey }) {
  const derived = deriveContinuityAuthority(conductorKey);
  if (derived.fingerprintSha256 !== loadedAuthority.delegation.delegate.authorityFingerprint
      || derived.publicKeySpkiDerBase64 !== loadedAuthority.delegation.delegate.publicKeySpkiDerBase64) fail('continuity record signer differs from delegated continuity authority');
  const schemaSha256ByPath = Object.fromEntries(await Promise.all(Object.values(PRIVATE_SIGNED_SCHEMA_BY_PURPOSE).map(async (schemaPath) => {
    const schema = JSON.parse((await readContainedFile(repoRoot, schemaPath)).toString('utf8')); const digest = sha256Canonical(schema);
    const binding = loadedAuthority.authority.schemaBindings.find((item) => item.path === schemaPath);
    if (!binding || binding.sha256 !== digest) fail(`${schemaPath} differs from terminal v5 protocol authority`);
    return [schemaPath, digest];
  })));
  const publicDer = derived.publicKey.export({ format: 'der', type: 'spki' });
  const authorityFingerprint = createHash('sha256').update(publicDer).digest('hex');
  const protocolAuthoritySha256 = loadedAuthority.authority.protocolAuthoritySha256;
  const delegationOutputSha256 = loadedAuthority.delegation.outputSha256;
  const authority = Object.freeze({
    finalize(core, schemaVersion) {
      const binding = PRIVATE_PURPOSE_BY_SCHEMA[schemaVersion]; const schemaSha256 = schemaSha256ByPath[binding?.schemaPath];
      if (!binding || !schemaSha256) fail(`terminal continuity record schema is not authorized: ${schemaVersion}`);
      const unsignedCore = { schemaVersion, ...core }; const unsigned = { ...unsignedCore, outputSha256: sha256Canonical(unsignedCore) };
      const publicSignature = { algorithm: 'Ed25519', authorityEpoch: 'continuity-authority-epoch-v1', authorityFingerprint,
        delegationOutputSha256, purpose: binding.purpose, schemaSha256,
        signatureBase64: sign(null, Buffer.from(canonicalStringify(privateSignaturePayload(unsigned,
          { protocolAuthoritySha256, delegationOutputSha256, purpose: binding.purpose, schemaSha256 }))), derived.privateKey).toString('base64') };
      const value = Object.freeze({ ...unsigned, publicSignature });
      if (!authority.verifyRecord(value)) fail('new terminal continuity record failed immediate public verification');
      return value;
    },
    verifyRecord(value) {
      const binding = PRIVATE_PURPOSE_BY_SCHEMA[value?.schemaVersion]; const signature = value?.publicSignature;
      const schemaSha256 = schemaSha256ByPath[binding?.schemaPath];
      if (!binding || !signature || signature.algorithm !== 'Ed25519' || signature.authorityEpoch !== 'continuity-authority-epoch-v1'
          || signature.authorityFingerprint !== authorityFingerprint || signature.delegationOutputSha256 !== delegationOutputSha256
          || signature.purpose !== binding.purpose || signature.schemaSha256 !== schemaSha256) return false;
      const unsigned = structuredClone(value); delete unsigned.publicSignature; const core = structuredClone(unsigned); delete core.outputSha256;
      if (unsigned.outputSha256 !== sha256Canonical(core)) return false;
      const bytes = Buffer.from(signature.signatureBase64, 'base64');
      return bytes.length === 64 && bytes.toString('base64') === signature.signatureBase64
        && verify(null, Buffer.from(canonicalStringify(privateSignaturePayload(unsigned,
          { protocolAuthoritySha256, delegationOutputSha256, purpose: binding.purpose, schemaSha256 }))), derived.publicKey, bytes);
    },
  });
  PRIVATE_PRODUCTION_SIGNING_AUTHORITIES.add(authority);
  return authority;
}

function createVerificationOnlyArtifactAuthority(authority) {
  return Object.freeze({
    verifyRecord(record) { return authority.verifyRecord(record); },
  });
}

export async function createG003V5ArtifactAuthority({ repoRoot, conductorKey, context }) {
  if (!PRODUCTION_CONTEXTS.has(context)) fail('production artifact authority requires a production-loaded v5 context');
  const authority = await createPrivateProductionSigningAuthority({ repoRoot,
    loadedAuthority: CONTEXT_LOADED_AUTHORITIES.get(context), conductorKey });
  const verifier = createVerificationOnlyArtifactAuthority(authority);
  ARTIFACT_AUTHORITIES.add(verifier);
  PRODUCTION_ARTIFACT_AUTHORITIES.add(verifier);
  PRODUCTION_SIGNING_AUTHORITIES.set(verifier, authority);
  return verifier;
}

export function createTestOnlyG003V5VerificationAuthority(recordAuthority) {
  if (process.env.NODE_ENV === 'production') fail('test-only verification authority is forbidden in production');
  if (!recordAuthority || typeof recordAuthority.verifyRecord !== 'function') fail('test verification authority requires concrete continuity record authority');
  const verifier = createVerificationOnlyArtifactAuthority(recordAuthority);
  ARTIFACT_AUTHORITIES.add(verifier);
  return verifier;
}

export function createTestOnlyG003V5ArtifactAuthority(recordAuthority) {
  if (process.env.NODE_ENV === 'production') fail('test-only artifact authority is forbidden in production');
  if (!recordAuthority || typeof recordAuthority.finalize !== 'function' || typeof recordAuthority.verifyRecord !== 'function') fail('test artifact authority requires concrete continuity record authority');
  ARTIFACT_AUTHORITIES.add(recordAuthority);
  return recordAuthority;
}

export function createG003V5ReviewerAssignment({ context, assignmentCore, artifactAuthority }) {
  if (PRODUCTION_ARTIFACT_AUTHORITIES.has(artifactAuthority)) fail('UNAVAILABLE_NO_VERIFIED_PACKAGE: production assignment signing requires verified v5 package derivation');
  const assignment = finalizeSigned(assignmentCore, G003_V5_ASSIGNMENT_SCHEMA, artifactAuthority);
  assertG003V5ReviewerAssignment(assignment, context, artifactAuthority);
  return assignment;
}

function packageContextFromAssignment(assignment) {
  return {
    opaqueCandidateId: assignment.opaqueCandidateId, generationRunId: assignment.generationRunId,
    packageManifestSha256: assignment.packageManifestSha256, materialBindingSha256: assignment.materialBindingSha256,
    inputAllowlistSha256: assignment.inputAllowlistSha256, promptSha256: assignment.promptSha256,
    inputAssetSha256s: assignment.inputAssetSha256s, requiredChildTaxonomy: assignment.requiredChildTaxonomy,
    ...structuredClone(assignment.reviewContext),
  };
}

export function createG003V5ReviewerEvidence({ context, assignment, assignmentBytes, verdict, now = Date.now(), artifactAuthority }) {
  assertG003V5ReviewerAssignment(assignment, context, artifactAuthority);
  if (sha256Bytes(assignmentBytes) !== verdict.assignmentRawSha256) fail('reviewer verdict does not bind exact v5 assignment bytes');
  const verified = assertReviewerAuthoredVerdictV2(verdict, {
    assignment, assignmentBytes, packageContext: packageContextFromAssignment(assignment), now,
  });
  if (canonicalStringify(verdict.requiredChildTaxonomy) !== canonicalStringify(assignment.requiredChildTaxonomy)) fail('reviewer verdict taxonomy differs from v5 assignment context');
  if (verified.verdict !== 'PASS') fail('PASS evidence path cannot accept a typed REJECT');
  const common = {
    reviewProtocol: G003_V5_PROTOCOL,
    protocolAuthoritySha256: context.protocolAuthoritySha256,
    terminalOutputSha256: context.terminalOutputSha256,
    signedObligationScopeSha256: context.signedObligationScopeSha256,
    obligationId: assignment.obligationId,
    assignmentId: assignment.assignmentId,
    assignmentRawSha256: verdict.assignmentRawSha256,
    reviewerInstanceId: assignment.reviewerInstanceId,
    agentTaskId: assignment.agentTaskId,
    voterReviewRunId: assignment.voterReviewRunId,
    passNumber: assignment.passNumber,
    reviewerVerdictSchema: 'continuity-g003-reviewer-verdict-v2',
    reviewerVerdictSha256: verified.observationSha256,
    fresh: true,
  };
  const vote = finalizeSigned(common, G003_V5_VOTE_SCHEMA, artifactAuthority);
  PURPOSE_ISSUED_VOTES.add(vote);
  return vote;
}

function assertV5Vote(vote, context, artifactAuthority) {
  if (!ARTIFACT_AUTHORITIES.has(artifactAuthority) || artifactAuthority.verifyRecord(vote) !== true) fail('coverage vote signature/output failed public verification');
  if (!PRODUCTION_ARTIFACT_AUTHORITIES.has(artifactAuthority) && !PURPOSE_ISSUED_VOTES.has(vote)) {
    fail('test vote lacks validated assignment/verdict issuance provenance');
  }
  if (vote?.schemaVersion !== G003_V5_VOTE_SCHEMA || vote.reviewProtocol !== G003_V5_PROTOCOL
      || vote.protocolAuthoritySha256 !== context.protocolAuthoritySha256
      || vote.terminalOutputSha256 !== context.terminalOutputSha256
      || vote.signedObligationScopeSha256 !== context.signedObligationScopeSha256
      || vote.reviewerVerdictSchema !== 'continuity-g003-reviewer-verdict-v2' || vote.fresh !== true) fail('coverage contains non-v5, stale, or unbound evidence');
  if (!context.obligationIds.includes(vote.obligationId) || ![1, 2].includes(vote.passNumber)) fail('coverage vote targets an invalid obligation/pass');
  for (const field of ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'reviewerVerdictSha256', 'outputSha256']) {
    if (!vote[field]) fail(`coverage vote ${field} is missing`);
  }
}

function assertIndependentPair(pair, obligationId) {
  if (pair.length !== 2 || canonicalStringify(pair.map((vote) => vote.passNumber).sort()) !== canonicalStringify([1, 2])) fail(`${obligationId} requires exactly pass 1 and pass 2`);
  for (const field of ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'assignmentId', 'reviewerVerdictSha256']) {
    if (new Set(pair.map((vote) => vote[field])).size !== 2) fail(`${obligationId} votes are not independently fresh by ${field}`);
  }
}

export function buildG003V5Coverage({ context, votes, v4HistoricalArtifacts = [], artifactAuthority }) {
  if (!Array.isArray(votes) || votes.length !== COUNTS.votes) fail('coverage requires exactly 674 fresh v5 votes');
  if (!Array.isArray(v4HistoricalArtifacts)) fail('v4 historical artifact inventory must be an array');
  const grouped = new Map(context.obligationIds.map((id) => [id, []]));
  for (const vote of votes) {
    assertV5Vote(vote, context, artifactAuthority);
    grouped.get(vote.obligationId).push(vote);
  }
  const obligations = context.obligationIds.map((obligationId) => {
    const pair = grouped.get(obligationId);
    assertIndependentPair(pair, obligationId);
    return { obligationId, voteOutputSha256s: pair.sort((a, b) => a.passNumber - b.passNumber).map((vote) => vote.outputSha256) };
  });
  const coverage = finalizeSigned({
    reviewProtocol: G003_V5_PROTOCOL,
    protocolAuthoritySha256: context.protocolAuthoritySha256,
    terminalOutputSha256: context.terminalOutputSha256,
    signedObligationScopeSha256: context.signedObligationScopeSha256,
    counts: { ...COUNTS },
    obligations,
    v4HistoricalAuditCount: v4HistoricalArtifacts.length,
    v4HistoricalVoteCredit: 0,
  }, G003_V5_COVERAGE_SCHEMA, artifactAuthority);
  PURPOSE_ISSUED_RECORDS.add(coverage);
  return coverage;
}

export function assembleG003V5PublicReview({ context, obligationId, votes, artifactAuthority }) {
  votes.forEach((vote) => assertV5Vote(vote, context, artifactAuthority));
  assertIndependentPair(votes, obligationId);
  const voteOutputSha256s = [...votes].sort((a, b) => a.passNumber - b.passNumber).map((vote) => vote.outputSha256);
  const review = finalizeSigned({ reviewProtocol: G003_V5_PROTOCOL, protocolAuthoritySha256: context.protocolAuthoritySha256,
    terminalOutputSha256: context.terminalOutputSha256, signedObligationScopeSha256: context.signedObligationScopeSha256,
    obligationId, voteOutputSha256s, verdict: 'PASS' }, 'continuity-g003-candidate-review-v5', artifactAuthority);
  const publicArtifact = finalizeSigned({ reviewProtocol: G003_V5_PROTOCOL, protocolAuthoritySha256: context.protocolAuthoritySha256,
    terminalOutputSha256: context.terminalOutputSha256, signedObligationScopeSha256: context.signedObligationScopeSha256,
    obligationId, reviewOutputSha256: review.outputSha256, voteOutputSha256s }, 'continuity-g003-public-review-artifact-v5', artifactAuthority);
  PURPOSE_ISSUED_RECORDS.add(review); PURPOSE_ISSUED_RECORDS.add(publicArtifact);
  return Object.freeze({ review, publicArtifact });
}

export function createG003V5RejectionArtifacts({ context, assignment, assignmentBytes, observation, now = Date.now(), material, artifactAuthority, rejectionAuthority, rejectedAt }) {
  assertG003V5ReviewerAssignment(assignment, context, artifactAuthority);
  const verified = assertRejectionObservationV2(observation, {
    assignment, assignmentBytes, packageContext: packageContextFromAssignment(assignment), now,
  });
  if (!material || material.candidateId !== assignment.obligationId || material.generationRunId !== assignment.generationRunId) fail('rejection material differs from the assignment');
  const materialSha256s = material.materialSha256s;
  if (canonicalStringify(materialSha256s) !== canonicalStringify(assignment.childMaterialSha256s)) fail('rejection material must equal exact assigned child master/runtime material');
  const tombstoneKey = materialWideTombstoneKey(materialSha256s);
  if (rejectionAuthority && rejectionAuthority !== artifactAuthority
      && (typeof rejectionAuthority.finalize !== 'function' || typeof rejectionAuthority.verify !== 'function')) fail('typed rejection requires terminal-v5 continuity record authority');
  const archive = finalizeSigned({ reviewProtocol: G003_V5_PROTOCOL, protocolAuthoritySha256: context.protocolAuthoritySha256,
    terminalOutputSha256: context.terminalOutputSha256, signedObligationScopeSha256: context.signedObligationScopeSha256,
    candidateId: material.candidateId, generationRunId: material.generationRunId, materialSha256s: [...materialSha256s].sort(),
    rejectionObservationSha256: verified.observationSha256, rejectionObservation: structuredClone(observation), rejectedAt,
  }, 'continuity-g003-rejection-archive-v5', artifactAuthority);
  const tombstone = finalizeSigned({ tombstoneKey, constituentIndexKeys: materialConstituentIndexKeys(materialSha256s),
    candidateId: material.candidateId, generationRunId: material.generationRunId, materialSha256s: [...materialSha256s].sort(),
    rejectionObservationSha256: verified.observationSha256, rejectionArchiveSha256: archive.outputSha256, rejectedAt,
  }, 'continuity-g003-rejection-tombstone-v2', artifactAuthority);
  PURPOSE_ISSUED_RECORDS.add(archive); PURPOSE_ISSUED_RECORDS.add(tombstone);
  return Object.freeze({ archive, tombstone });
}

function assertProductionPublicationAuthority(context, artifactAuthority) {
  if (!PRODUCTION_CONTEXTS.has(context) || !PRODUCTION_ARTIFACT_AUTHORITIES.has(artifactAuthority)) {
    fail('publication requires production-loaded context and pinned production artifact authority');
  }
  if (!PRIVATE_PRODUCTION_SIGNING_AUTHORITIES.has(PRODUCTION_SIGNING_AUTHORITIES.get(artifactAuthority))) fail('publication signer is not the private production capability');
}

async function publishVerifiedG003V5Records({ repoRoot, context, artifactAuthority, records, allowVote = false }) {
  if (!Array.isArray(records) || records.length === 0) fail('record publication requires at least one record');
  const prepared = records.map(({ relativePath, value }) => {
    assertCanonicalRelativePath(relativePath, 'v5 record path');
    if ([G003_V5_ASSIGNMENT_SCHEMA, G003_V5_VOTE_SCHEMA, G003_V5_COVERAGE_SCHEMA].includes(value?.schemaVersion)
        && !(allowVote && value.schemaVersion === G003_V5_VOTE_SCHEMA && PURPOSE_ISSUED_VOTES.has(value))) {
      fail(`generic publication forbids assignment/vote/coverage records: ${relativePath}`);
    }
    const purposeIssuedVote = allowVote && value?.schemaVersion === G003_V5_VOTE_SCHEMA && PURPOSE_ISSUED_VOTES.has(value);
    if (!purposeIssuedVote && !PURPOSE_ISSUED_RECORDS.has(value)) fail(`record lacks purpose-issued provenance: ${relativePath}`);
    if (artifactAuthority.verifyRecord(value) !== true) fail(`record failed terminal continuity verification: ${relativePath}`);
    return { relativePath, destination: path.resolve(repoRoot, relativePath), bytes: Buffer.from(canonicalStringify(value)) };
  });
  assertProductionPublicationAuthority(context, artifactAuthority);
  const repository = path.resolve(repoRoot);
  if (prepared.some((item) => path.relative(repository, item.destination).startsWith('..'))) fail('v5 record path escapes repository');
  return withG003TransitionLock(repository, async () => {
    const results = [];
    for (const item of prepared) results.push({ relativePath: item.relativePath,
      publication: await publishBytesNoReplace(repository, item.destination, item.bytes), fileSha256: sha256Bytes(item.bytes) });
    return Object.freeze(results);
  });
}

export async function publishG003V5Records(args) {
  return publishVerifiedG003V5Records(args);
}

export async function publishG003V5VoteRecord({ repoRoot, context, artifactAuthority, relativePath, vote }) {
  if (!PURPOSE_ISSUED_VOTES.has(vote)) fail('vote publication requires exact assignment bytes and validated reviewer verdict issuance');
  return publishVerifiedG003V5Records({ repoRoot, context, artifactAuthority,
    records: [{ relativePath, value: vote }], allowVote: true });
}

export async function publishG003V5Coverage({ repoRoot, stateRoot = 'production/reports/biological-continuity-v3/g003-terminal-v5/reviews', context, votes, v4HistoricalArtifacts = [], artifactAuthority }) {
  const coverage = buildG003V5Coverage({ context, votes, v4HistoricalArtifacts, artifactAuthority });
  assertProductionPublicationAuthority(context, artifactAuthority);
  assertCanonicalRelativePath(stateRoot, 'v5 review state root');
  const repository = path.resolve(repoRoot);
  const directory = path.resolve(repository, stateRoot);
  if (path.relative(repository, directory).startsWith('..')) fail('v5 review state root escapes repository');
  const destination = path.join(directory, 'coverage-v5.json');
  const bytes = Buffer.from(canonicalStringify(coverage));
  const publication = await withG003TransitionLock(repository, () => publishBytesNoReplace(repository, destination, bytes));
  return Object.freeze({ coverage, publication, relativePath: `${stateRoot}/coverage-v5.json`, fileSha256: sha256Bytes(bytes) });
}
