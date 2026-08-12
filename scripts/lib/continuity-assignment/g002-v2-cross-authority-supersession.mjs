import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat } from 'node:fs/promises';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { readContainedFile, readJson } from './evidence.mjs';
import { G002_V2_EFFECTIVE_ROOT_IDS } from './canonical-root-redesign-authority-v2.mjs';
import { CONTINUITY_ROOT_DIRECTIVES } from './continuity-root-directives.mjs';
import {
  G003_V5_ASSIGNMENT_V3_SCHEMA_PATH, deriveG003V5AssignmentV3Binding,
} from './g003-v5-assignment.mjs';
import {
  CONTINUITY_SUPERSESSION_PURPOSE, G002_V2_IMMUTABLE_PREDECESSOR,
  signContinuityEvidence, validatePredecessorBinding, verifyContinuityEvidence,
} from '../continuity-public-authority.mjs';
import { assertG003TransitionSnapshot, loadVerifiedG003TransitionSnapshot } from '../g003-transition-snapshot.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from '../g003-transition-integrity.mjs';

export const CROSS_AUTHORITY_SUPERSESSION_SCHEMA_VERSION = 'continuity-g002-v2-supersession-v1';
export const CROSS_AUTHORITY_SUPERSESSION_INTENT_SCHEMA_VERSION = 'continuity-g002-v2-supersession-intent-v1';
export const CROSS_AUTHORITY_SUPERSESSION_PATH = 'production/reports/biological-continuity-v3/continuity-authority/g002-v2-supersession-v1.json';
export const CROSS_AUTHORITY_SUPERSESSION_SCHEMA_PATH = 'production/contracts/continuity-g002-v2-supersession-v1.schema.json';
export const CROSS_AUTHORITY_SUPERSESSION_INTENT_SCHEMA_PATH = 'production/contracts/continuity-g002-v2-supersession-intent-v1.schema.json';
export const G002_V2_TOPOLOGY_PATH = 'production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIXED_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => `PG-${String(196 + index).padStart(3, '0')}`));
const EFFECTIVE_ROOT_IDS = Object.freeze([...G002_V2_EFFECTIVE_ROOT_IDS, 'PG-005', 'PG-018'].sort());
const EXPECTED_COUNTS = Object.freeze({ queue: 167, retained: 73, ordinaryEdges: 170, obligations: 337, dependent: 113, generatedParentEdges: 113, generatedChildEdges: 128, retainedChildEdges: 42, votes: 674, effectiveRoots: 17 });

export { CONTINUITY_ROOT_DIRECTIVES } from './continuity-root-directives.mjs';

const fail = (message) => { throw new Error(`G002-v2 cross-authority supersession: ${message}`); };
const canonicalEqual = (left, right) => sha256Canonical(left) === sha256Canonical(right);
const SHA = /^[a-f0-9]{64}$/;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(`${label} fields mismatch`);
}

function assertNoReservedNamespace(value, pointer = '$') {
  if (typeof value === 'string' && /^(?:g002|g003):/.test(value)) fail(`reserved namespace at ${pointer}`);
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoReservedNamespace(entry, `${pointer}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) assertNoReservedNamespace(entry, `${pointer}.${key}`);
}

export function deriveCrossAuthorityObligationScope(assignment, topology) {
  const gate = assignment?.reviewCoverageManifest;
  if (assignment?.schemaVersion !== 'continuity-assignment-v2' || assignment.effectiveAuthoritySha256 !== G002_V2_IMMUTABLE_PREDECESSOR.effectiveAuthoritySha256
      || gate?.schemaVersion !== 'continuity-g003-review-gate-v2') fail('immutable predecessor assignment authority mismatch');
  const excluded = new Set(MIXED_IDS);
  const includedQueue = gate.queueCandidates.filter((candidate) => !excluded.has(candidate.slotId));
  const ordinary = gate.edgeCandidates.filter((edge) => !excluded.has(edge.childId));
  const mixedEdges = gate.edgeCandidates.filter((edge) => excluded.has(edge.childId));
  const generatedSlots = new Set(includedQueue.map((candidate) => candidate.slotId));
  const scope = {
    schemaVersion: 'continuity-signed-obligation-scope-v1', authority: CROSS_AUTHORITY_SUPERSESSION_SCHEMA_VERSION,
    exclusionPolicy: 'EXCLUDE_MIXED_CHILD_OBLIGATIONS_PRESERVE_FUSION_PROVENANCE',
    queueSlotIds: includedQueue.map((candidate) => candidate.slotId),
    ordinaryEdges: ordinary.map(({ parentId, childId }) => ({ parentId, childId })),
    excludedMixedSlotIds: [...MIXED_IDS],
    excludedMixedIncidentEdges: mixedEdges.map(({ parentId, childId }) => ({ parentId, childId })),
    fusionProvenance: structuredClone(topology.mixedProof),
    effectiveRootIds: [...EFFECTIVE_ROOT_IDS],
    counts: {
      queue: includedQueue.length, retained: 240 - includedQueue.length, ordinaryEdges: ordinary.length,
      obligations: includedQueue.length + ordinary.length,
      dependent: includedQueue.filter((candidate) => candidate.requiredParentCandidateIds.length > 0).length,
      generatedParentEdges: ordinary.filter((edge) => edge.allowedParentAnchors.some((parent) => parent.sourceKind === 'generated-parent-candidate')).length,
      generatedChildEdges: ordinary.filter((edge) => generatedSlots.has(edge.childId)).length,
      retainedChildEdges: ordinary.filter((edge) => !generatedSlots.has(edge.childId)).length,
      votes: (includedQueue.length + ordinary.length) * 2, effectiveRoots: EFFECTIVE_ROOT_IDS.length,
    },
  };
  if (!canonicalEqual(scope.counts, EXPECTED_COUNTS) || scope.excludedMixedIncidentEdges.length !== 20
      || scope.fusionProvenance.length !== 10 || !canonicalEqual(scope.fusionProvenance.map((item) => item.slotId), MIXED_IDS)) fail('mixed exclusion set or obligation counts drifted');
  assertNoReservedNamespace(scope);
  return scope;
}

export function validateG003V5AssignmentBinding(binding) {
  exactKeys(binding, ['fixedPath', 'schemaSha256', 'coreSha256'], 'assignment-v3 binding');
  if (binding.fixedPath !== 'production/reports/biological-continuity-v3/continuity-authority/continuity-assignment-v3.json'
      || !SHA.test(binding.schemaSha256 ?? '') || !SHA.test(binding.coreSha256 ?? '')) fail('assignment-v3 binding mismatch');
  return binding;
}

export async function deriveCrossAuthorityAssignmentV3Binding(repoRoot, snapshot, obligationScope) {
  const schemaBytes = await readContainedFile(repoRoot, G003_V5_ASSIGNMENT_V3_SCHEMA_PATH);
  return deriveG003V5AssignmentV3Binding({
    assignment: snapshot.assignment, topology: snapshot.topology, obligationScope,
    schemaSha256: sha256Bytes(schemaBytes),
  });
}

export function supersessionIntentV1(obligationScope, assignmentV3) {
  const intent = {
    schemaVersion: CROSS_AUTHORITY_SUPERSESSION_SCHEMA_VERSION,
    contractKind: 'CROSS_AUTHORITY_SUCCESSOR',
    authorityTransition: { predecessorImmutable: true, nativeG002V3: false, nativeG002SignatureClaim: false },
    predecessor: G002_V2_IMMUTABLE_PREDECESSOR,
    rootDirectives: CONTINUITY_ROOT_DIRECTIVES,
    obligationScope,
    assignmentV3: validateG003V5AssignmentBinding(assignmentV3),
  };
  validateSupersessionIntentV1(intent);
  return intent;
}

export function validateSupersessionIntentV1(intent) {
  exactKeys(intent, ['schemaVersion', 'contractKind', 'authorityTransition', 'predecessor', 'rootDirectives', 'obligationScope', 'assignmentV3'], 'supersession intent');
  if (intent.schemaVersion !== CROSS_AUTHORITY_SUPERSESSION_SCHEMA_VERSION || intent.contractKind !== 'CROSS_AUTHORITY_SUCCESSOR'
      || !canonicalEqual(intent.authorityTransition, { predecessorImmutable: true, nativeG002V3: false, nativeG002SignatureClaim: false })) fail('intent identity or authority transition mismatch');
  validatePredecessorBinding(intent.predecessor);
  if (!canonicalEqual(intent.predecessor, G002_V2_IMMUTABLE_PREDECESSOR) || !canonicalEqual(intent.rootDirectives, CONTINUITY_ROOT_DIRECTIVES)) fail('intent predecessor or root directives changed');
  if (!canonicalEqual(intent.obligationScope.counts, EXPECTED_COUNTS)
      || !canonicalEqual(intent.obligationScope.effectiveRootIds, EFFECTIVE_ROOT_IDS)
      || !canonicalEqual(intent.obligationScope.excludedMixedSlotIds, MIXED_IDS)
      || intent.obligationScope.excludedMixedIncidentEdges.length !== 20 || intent.obligationScope.fusionProvenance.length !== 10) fail('intent obligation scope mismatch');
  validateG003V5AssignmentBinding(intent.assignmentV3);
  assertNoReservedNamespace(intent);
  return intent;
}

export function projectSupersessionIntentV1(value) {
  const projected = structuredClone(value);
  delete projected.delegationOutputSha256;
  delete projected.outputSha256;
  delete projected.publicSignature;
  return validateSupersessionIntentV1(projected);
}

export function validateCrossAuthoritySupersession(value, { delegation, schemaSha256, expectedIntent } = {}) {
  exactKeys(value, ['schemaVersion', 'contractKind', 'authorityTransition', 'predecessor', 'rootDirectives', 'obligationScope', 'assignmentV3', 'delegationOutputSha256', 'outputSha256', 'publicSignature'], 'successor');
  const projected = projectSupersessionIntentV1(value);
  if (!expectedIntent || !canonicalEqual(projected, expectedIntent)) fail('successor projection differs from canonical delegated intent');
  if (!delegation || value.delegationOutputSha256 !== delegation.outputSha256
      || delegation.successorIntentSha256 !== sha256Canonical(expectedIntent)
      || delegation.grant.successorPath !== CROSS_AUTHORITY_SUPERSESSION_PATH
      || !canonicalEqual(delegation.grant.assignmentV3, expectedIntent.assignmentV3)) fail('delegation intent or fixed-tip binding mismatch');
  const unsigned = structuredClone(value); delete unsigned.publicSignature;
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (value.outputSha256 !== sha256Canonical(core)) fail('output hash mismatch');
  verifyContinuityEvidence(unsigned, value.publicSignature, delegation, { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaSha256 });
  return value;
}

export async function assertCrossAuthoritySupersessionTipAvailable(repoRoot = ROOT) {
  try {
    await lstat(path.join(repoRoot, CROSS_AUTHORITY_SUPERSESSION_PATH));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  throw new Error('cross-authority successor fixed tip already exists; second tip is forbidden');
}

export async function verifyCrossAuthoritySupersession({ repoRoot = ROOT, value: suppliedValue, delegation: suppliedDelegation, transitionSnapshot, testOnlyVerifiedDelegation } = {}) {
  const snapshot = transitionSnapshot ?? await loadVerifiedG003TransitionSnapshot(repoRoot);
  assertG003TransitionSnapshot(snapshot);
  if (testOnlyVerifiedDelegation && snapshot.freeze?.testOnly !== true) fail('test-only verified delegation requires a test-only branded snapshot');
  const verified = testOnlyVerifiedDelegation ?? await (await import('../../verify-continuity-authority-delegation.mjs')).verifyContinuityAuthorityDelegation({ repoRoot, delegation: suppliedDelegation, transitionSnapshot: snapshot });
  const [schema, value] = await Promise.all([
    readJson(repoRoot, CROSS_AUTHORITY_SUPERSESSION_SCHEMA_PATH), suppliedValue ? Promise.resolve(suppliedValue) : readJson(repoRoot, CROSS_AUTHORITY_SUPERSESSION_PATH),
  ]);
  const scope = deriveCrossAuthorityObligationScope(snapshot.assignment, snapshot.topology);
  const assignmentV3 = await deriveCrossAuthorityAssignmentV3Binding(repoRoot, snapshot, scope);
  const expectedIntent = supersessionIntentV1(scope, assignmentV3);
  validateCrossAuthoritySupersession(value, { delegation: verified.delegation, schemaSha256: sha256Canonical(schema), expectedIntent });
  return { status: 'PASS', value, delegation: verified.delegation, intent: expectedIntent };
}

export async function attestCrossAuthoritySupersession({
  repoRoot = ROOT, g003RootKey, delegation: suppliedDelegation, write = false,
  testOnlyTransitionSnapshot, testOnlyVerifiedDelegation, signer = signContinuityEvidence,
} = {}) {
  if ((testOnlyTransitionSnapshot || testOnlyVerifiedDelegation) && write) fail('test-only transition inputs cannot publish');
  return withG003TransitionLock(repoRoot, async () => {
  const snapshot = testOnlyTransitionSnapshot ?? await loadVerifiedG003TransitionSnapshot(repoRoot);
  assertG003TransitionSnapshot(snapshot, { production: write });
  if (testOnlyVerifiedDelegation && snapshot.freeze?.testOnly !== true) fail('test-only verified delegation requires a test-only branded snapshot');
  const verified = testOnlyVerifiedDelegation ?? await (await import('../../verify-continuity-authority-delegation.mjs')).verifyContinuityAuthorityDelegation({ repoRoot, delegation: suppliedDelegation, transitionSnapshot: snapshot });
  const delegation = verified.delegation;
  const schema = await readJson(repoRoot, CROSS_AUTHORITY_SUPERSESSION_SCHEMA_PATH);
  const scope = deriveCrossAuthorityObligationScope(snapshot.assignment, snapshot.topology);
  const assignmentV3 = await deriveCrossAuthorityAssignmentV3Binding(repoRoot, snapshot, scope);
  const intent = supersessionIntentV1(scope, assignmentV3);
  if (delegation.successorIntentSha256 !== sha256Canonical(intent)) fail('verified delegation does not authorize canonical successor intent');
  const core = { ...intent, delegationOutputSha256: delegation.outputSha256 };
  const unsigned = { ...core, outputSha256: sha256Canonical(core) };
  const schemaSha256 = sha256Canonical(schema);
  const value = { ...unsigned, publicSignature: signer(unsigned, g003RootKey, delegation, { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaSha256 }) };
  validateCrossAuthoritySupersession(value, { delegation, schemaSha256, expectedIntent: intent });
  const publication = write ? await publishBytesNoReplace(repoRoot, path.join(repoRoot, CROSS_AUTHORITY_SUPERSESSION_PATH), Buffer.from(canonicalStringify(value))) : null;
  return { status: write ? publication : 'VALID', output: CROSS_AUTHORITY_SUPERSESSION_PATH, outputSha256: value.outputSha256, intent, value };
  });
}
