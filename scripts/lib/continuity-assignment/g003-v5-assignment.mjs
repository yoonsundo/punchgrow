import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { CONTINUITY_ROOT_DIRECTIVES } from './continuity-root-directives.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from '../g003-transition-integrity.mjs';
import { assertG003TransitionSnapshot, loadVerifiedG003TransitionSnapshot } from '../g003-transition-snapshot.mjs';
import { CONTINUITY_ASSIGNMENT_V3_PURPOSE, signContinuityEvidence, verifyContinuityEvidence } from '../continuity-public-authority.mjs';
import { readContainedFile } from './evidence.mjs';

export const G003_V5_ASSIGNMENT_V3_SCHEMA = 'continuity-assignment-v3';
export const G003_V5_ASSIGNMENT_V3_PATH = 'production/reports/biological-continuity-v3/continuity-authority/continuity-assignment-v3.json';
export const G003_V5_ASSIGNMENT_V3_SCHEMA_PATH = 'production/contracts/continuity-assignment-v3.schema.json';
export const G003_V5_ASSIGNMENT_V3_PURPOSE = CONTINUITY_ASSIGNMENT_V3_PURPOSE;
export const G003_V5_ASSIGNMENT_V3_COUNTS = Object.freeze({
  queue: 167,
  retained: 73,
  ordinaryEdges: 170,
  obligations: 337,
  dependent: 113,
  generatedParentEdges: 113,
  generatedChildEdges: 128,
  retainedChildEdges: 42,
  votes: 674,
  effectiveRoots: 17,
});

const MIXED_IDS = new Set(Array.from({ length: 10 }, (_, index) => `PG-${String(196 + index).padStart(3, '0')}`));
const PG_ID = /^PG-[0-9]{3}$/;
const SHA = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(`G003-v5 assignment-v3: ${message}`); };
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const clone = (value) => structuredClone(value);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (canonicalStringify(actual) !== canonicalStringify(expected)) fail(`${label} fields mismatch`);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}

function assertTaxonomy(value, label) {
  exactKeys(value, ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'], label);
  for (const [key, entry] of Object.entries(value)) if (typeof entry !== 'string' || !entry) fail(`${label}.${key} is empty`);
}

function retainedSurfaces(assignmentsById, slotId) {
  const entry = assignmentsById.get(slotId);
  if (!entry || entry.sourceKind !== 'existing' || entry.targetEvidence?.pixelEntryPgId !== slotId
      || !SHA.test(entry.targetEvidence.masterSha256 ?? '') || !SHA.test(entry.targetEvidence.runtimeSha256 ?? '')
      || entry.assetSha256 !== entry.targetEvidence.masterSha256) fail(`${slotId}: retained surfaces are not authenticated by immutable G002-v2 assignment`);
  return { masterSha256: entry.targetEvidence.masterSha256, runtimeSha256: entry.targetEvidence.runtimeSha256 };
}

function directiveByRoot(rootDirectives) {
  if (canonicalStringify(rootDirectives) !== canonicalStringify(CONTINUITY_ROOT_DIRECTIVES)) fail('root directives differ from the canonical continuity supersession intent');
  return new Map(rootDirectives.map((directive) => [directive.rootId, directive]));
}

function deriveOvineReachability(scope) {
  const reachable = new Set(['PG-018']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of scope.ordinaryEdges) {
      if (reachable.has(edge.parentId) && !reachable.has(edge.childId)) {
        reachable.add(edge.childId);
        changed = true;
      }
    }
  }
  if (!reachable.has('PG-078') || !reachable.has('PG-232')) fail('PG-018 ovine correction does not reach PG-078 and PG-232');
  if (reachable.has('PG-197') || [...reachable].some((slotId) => MIXED_IDS.has(slotId))) fail('fusion-only PG-197 or another mixed slot entered ordinary ovine propagation');
  return reachable;
}

function assertAcyclicQueue(queueSlotIds, ordinaryEdges) {
  const queue = new Set(queueSlotIds);
  const indegree = new Map(queueSlotIds.map((slotId) => [slotId, 0]));
  const children = new Map(queueSlotIds.map((slotId) => [slotId, []]));
  for (const edge of ordinaryEdges) {
    if (queue.has(edge.parentId) && queue.has(edge.childId)) {
      indegree.set(edge.childId, indegree.get(edge.childId) + 1);
      children.get(edge.parentId).push(edge.childId);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([slotId]) => slotId).sort(compareText);
  let visited = 0;
  while (ready.length) {
    const slotId = ready.shift(); visited += 1;
    for (const childId of children.get(slotId).sort(compareText)) {
      const next = indegree.get(childId) - 1; indegree.set(childId, next);
      if (next === 0) ready.push(childId), ready.sort(compareText);
    }
  }
  if (visited !== queueSlotIds.length) fail('generated candidate dependency graph contains a cycle');
}

function sourcePolicy(queue, slotId, { child = false, kind } = {}) {
  if (kind === 'QUEUE' && child) return 'STAGED_GENERATION';
  return queue.has(slotId) ? 'APPROVED_MATERIAL_V5' : 'SIGNED_RETAINED_G002';
}

function anchorDescriptions(gate) {
  const descriptions = new Map();
  const byAnchorId = new Map();
  const remember = (anchor) => {
    if (!anchor.description) return;
    descriptions.set(anchor.anchorKey, anchor.description);
    const previous = byAnchorId.get(anchor.anchorId);
    if (previous === undefined) byAnchorId.set(anchor.anchorId, anchor.description);
    else if (previous !== anchor.description) byAnchorId.set(anchor.anchorId, null);
  };
  for (const candidate of gate.queueCandidates) {
    for (const anchor of candidate.allowedAnchors) remember(anchor);
  }
  for (const edge of gate.edgeCandidates) {
    for (const parent of edge.allowedParentAnchors) for (const anchor of parent.anchors) remember(anchor);
  }
  const queueById = new Map(gate.queueCandidates.map((candidate) => [candidate.slotId, candidate]));
  const resolve = (anchor, seen = new Set()) => {
    const direct = anchor.description ?? descriptions.get(anchor.anchorKey) ?? byAnchorId.get(anchor.anchorId);
    if (direct) return direct;
    const slotId = anchor.parentId ?? anchor.anchorKey.split(':', 1)[0];
    const key = `${slotId}\0${anchor.anchorId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const prior = queueById.get(slotId)?.allowedAnchors.find((entry) => entry.anchorId === anchor.anchorId);
    return prior ? resolve(prior, seen) : null;
  };
  return { resolve };
}

function ordinaryQueueParents(slotId, scope, queue, assignmentsById) {
  return scope.ordinaryEdges.filter((edge) => edge.childId === slotId)
    .sort((left, right) => compareText(left.parentId, right.parentId))
    .map((edge, index) => {
      const policy = sourcePolicy(queue, edge.parentId);
      return {
        parentRole: `parent-${index + 1}`,
        parentSlotId: edge.parentId,
        sourcePolicy: policy,
        sourceObligationId: policy === 'APPROVED_MATERIAL_V5' ? `g003-candidate:${edge.parentId}` : null,
        retainedSurfaces: policy === 'SIGNED_RETAINED_G002' ? retainedSurfaces(assignmentsById, edge.parentId) : null,
      };
    });
}

function normalizedAnchors({ anchors, parentRoleBySlot, descriptions }) {
  return anchors.map((anchor) => {
    const parentSlotId = anchor.parentId ?? null;
    const parentRole = parentSlotId ? parentRoleBySlot.get(parentSlotId) : null;
    if (parentSlotId && !parentRole) fail(`${anchor.anchorKey}: anchor parent has no unambiguous ordinary parent role`);
    const description = descriptions.resolve(anchor);
    if (!description) fail(`${anchor.anchorKey}: anchor description is unresolved`);
    return {
      requirementType: 'VISUAL_ANCHOR',
      parentRole,
      parentSlotId,
      anchorId: anchor.anchorKey,
      description,
      sourcePolicy: anchor.resolutionState === 'PENDING_APPROVED_PARENT_REVIEW' ? 'APPROVED_MATERIAL_V5' : 'SIGNED_RETAINED_G002',
    };
  }).sort((left, right) => compareText(`${left.parentRole ?? ''}\0${left.anchorId}`, `${right.parentRole ?? ''}\0${right.anchorId}`));
}

function rootDirectiveAnchors(directive) {
  const requirements = directive.anchors.map((description) => ({
    requirementType: 'VISUAL_ANCHOR', parentRole: null, parentSlotId: null,
    anchorId: `directive:${description}`, description, sourcePolicy: 'SIGNED_ROOT_DIRECTIVE',
  }));
  for (const visibility of directive.visibilityRequirements ?? []) requirements.push({
    requirementType: 'VISIBILITY', parentRole: null, parentSlotId: null,
    anchorId: `visibility:${visibility}`, description: visibility, sourcePolicy: 'SIGNED_ROOT_DIRECTIVE',
  });
  return requirements.sort((left, right) => compareText(left.anchorId, right.anchorId));
}

function retainedBindingsFor(parents, childSlotId, childPolicy, assignmentsById) {
  const bindings = parents.filter((parent) => parent.sourcePolicy === 'SIGNED_RETAINED_G002').map((parent) => ({
    role: parent.parentRole, slotId: parent.parentSlotId, ...parent.retainedSurfaces,
  }));
  if (childPolicy === 'SIGNED_RETAINED_G002') bindings.push({ role: 'child', slotId: childSlotId, ...retainedSurfaces(assignmentsById, childSlotId) });
  return bindings.sort((left, right) => compareText(`${left.role}\0${left.slotId}`, `${right.role}\0${right.slotId}`));
}

function benchmarkCore(gate) {
  const benchmark = clone(gate.eiluBenchmark);
  exactKeys(benchmark, ['benchmarkId', 'assetIds', 'minimumConfidence', 'minimumRetainedAnchorCount', 'minimumAnchorRetentionRatio', 'comparisonRequirements', 'pixelBindings'], 'benchmark');
  if (benchmark.benchmarkId !== 'eilu-comparative-visual-v1' || benchmark.assetIds.length !== 3 || benchmark.pixelBindings.length !== 3
      || benchmark.minimumConfidence !== 0.96 || benchmark.minimumRetainedAnchorCount !== 3 || benchmark.minimumAnchorRetentionRatio !== 1) fail('Eilu benchmark binding drifted');
  for (const binding of benchmark.pixelBindings) if (!PG_ID.test(binding.pgId ?? '') || !SHA.test(binding.masterSha256 ?? '') || !SHA.test(binding.runtimeSha256 ?? '')) fail('Eilu benchmark surface binding is malformed');
  return benchmark;
}

function benchmarkBinding(benchmark) {
  return { benchmarkId: benchmark.benchmarkId, benchmarkSha256: sha256Canonical(benchmark) };
}

function taxonomyFor(slotId, assignmentsById, ovineReachable, ovineTarget) {
  const assignment = assignmentsById.get(slotId);
  if (!assignment) fail(`${slotId}: immutable assignment entry is missing`);
  const taxonomy = ovineReachable.has(slotId) ? clone(ovineTarget) : clone(assignment.targetTaxonomy);
  assertTaxonomy(taxonomy, `${slotId} taxonomy`);
  return taxonomy;
}

function assertScope(assignment, topology, supersession) {
  if (assignment?.schemaVersion !== 'continuity-assignment-v2' || assignment.reviewCoverageManifest?.schemaVersion !== 'continuity-g003-review-gate-v2') fail('immutable G002-v2 assignment is invalid');
  if (topology?.schemaVersion !== 'continuity-topology-after-v2' || topology.runId !== 'g002-v2') fail('immutable G002-v2 topology is invalid');
  const scope = supersession?.obligationScope;
  if (scope?.schemaVersion !== 'continuity-signed-obligation-scope-v1' || scope.authority !== 'continuity-g002-v2-supersession-v1') fail('continuity supersession scope is invalid');
  if (canonicalStringify(scope.counts) !== canonicalStringify(G003_V5_ASSIGNMENT_V3_COUNTS)) fail('continuity scope counts drifted');
  if (scope.queueSlotIds.length !== 167 || scope.ordinaryEdges.length !== 170) fail('continuity scope cardinality drifted');
  assertUnique(scope.queueSlotIds, 'queue slots');
  assertUnique(scope.ordinaryEdges.map((edge) => `${edge.parentId}->${edge.childId}`), 'ordinary edges');
  if (scope.queueSlotIds.some((slotId) => MIXED_IDS.has(slotId)) || scope.ordinaryEdges.some((edge) => MIXED_IDS.has(edge.parentId) || MIXED_IDS.has(edge.childId))) fail('mixed PG-196..PG-205 entered ordinary assignment scope');
  if (!scope.excludedMixedSlotIds?.includes('PG-197')) fail('fusion-only PG-197 exclusion is missing');
  const expectedEdges = assignment.reviewCoverageManifest.edgeCandidates
    .filter((edge) => !MIXED_IDS.has(edge.parentId) && !MIXED_IDS.has(edge.childId))
    .map(({ parentId, childId }) => ({ parentId, childId }));
  if (canonicalStringify(scope.ordinaryEdges) !== canonicalStringify(expectedEdges)) fail('ordinary scope does not exactly match immutable G002-v2 review edges');
  const expectedQueue = assignment.reviewCoverageManifest.queueCandidates.filter((candidate) => !MIXED_IDS.has(candidate.slotId)).map((candidate) => candidate.slotId);
  if (canonicalStringify(scope.queueSlotIds) !== canonicalStringify(expectedQueue)) fail('queue scope does not exactly match immutable G002-v2 review queue');
  if (topology.edges.length !== 190 || canonicalStringify(topology.edges.map(({ parentId, childId }) => ({ parentId, childId })))
      !== canonicalStringify(assignment.reviewCoverageManifest.edgeCandidates.map(({ parentId, childId }) => ({ parentId, childId })))) fail('immutable topology and assignment edges disagree');
  assertAcyclicQueue(scope.queueSlotIds, scope.ordinaryEdges);
  return scope;
}

export function buildG003V5AssignmentV3({ assignment, topology, supersession }) {
  const scope = assertScope(assignment, topology, supersession);
  const directives = directiveByRoot(supersession.rootDirectives);
  const pg005 = directives.get('PG-005'); const pg018 = directives.get('PG-018');
  if (pg005?.canonicalTarget?.biologicalClass !== 'construct' || pg005.canonicalTarget.coreAnatomy !== 'hexapod'
      || canonicalStringify(pg005.visibilityRequirements) !== canonicalStringify(['exactly-six-visible-walking-legs', 'all-six-legs-separately-readable'])) fail('PG-005 six-visible-leg construct directive is missing');
  if (pg018?.canonicalTarget?.speciesFamily !== 'ovine') fail('PG-018 ovine directive is missing');
  const gate = assignment.reviewCoverageManifest;
  const queue = new Set(scope.queueSlotIds);
  const assignmentsById = new Map(assignment.assignments.map((entry) => [entry.slotId, entry]));
  if (assignmentsById.size !== 240) fail('immutable assignment must contain 240 unique slots');
  const ovineReachable = deriveOvineReachability(scope);
  const descriptions = anchorDescriptions(gate);
  const benchmark = benchmarkCore(gate);
  const perObligationBenchmark = benchmarkBinding(benchmark);
  const queueById = new Map(gate.queueCandidates.map((candidate) => [candidate.slotId, candidate]));
  const edgeById = new Map(gate.edgeCandidates.map((edge) => [edge.edgeId, edge]));
  const obligations = [];

  for (const childSlotId of scope.queueSlotIds) {
    const source = queueById.get(childSlotId);
    if (!source) fail(`${childSlotId}: queue source is missing`);
    const parents = ordinaryQueueParents(childSlotId, scope, queue, assignmentsById);
    const parentRoleBySlot = new Map(parents.map((parent) => [parent.parentSlotId, parent.parentRole]));
    const directive = directives.get(childSlotId);
    const requiredAnchors = directive ? rootDirectiveAnchors(directive)
      : normalizedAnchors({ anchors: source.allowedAnchors, parentRoleBySlot, descriptions });
    const requiredParentObligationIds = parents.filter((parent) => parent.sourceObligationId).map((parent) => parent.sourceObligationId).sort(compareText);
    if (canonicalStringify(requiredParentObligationIds) !== canonicalStringify([...source.requiredParentCandidateIds].sort(compareText))) fail(`${childSlotId}: generated parent dependency is ambiguous or drifted`);
    obligations.push({
      obligationId: `g003-candidate:${childSlotId}`,
      kind: 'QUEUE', childSlotId, childSourcePolicy: 'STAGED_GENERATION', parents,
      requiredParentObligationIds,
      requiredChildTaxonomy: taxonomyFor(childSlotId, assignmentsById, ovineReachable, pg018.canonicalTarget),
      requiredAnchors,
      assessmentMode: scope.effectiveRootIds.includes(childSlotId) ? 'canonical-root-replacement' : 'same-creature-continuity',
      benchmarkBinding: clone(perObligationBenchmark),
      retainedSurfaceBindings: retainedBindingsFor(parents, childSlotId, 'STAGED_GENERATION', assignmentsById),
    });
  }

  for (const edge of scope.ordinaryEdges) {
    const obligationId = `g003-edge:${edge.parentId}:${edge.childId}`;
    const source = edgeById.get(obligationId);
    if (!source || source.allowedParentAnchors.length !== 1 || source.allowedParentAnchors[0].parentId !== edge.parentId) fail(`${obligationId}: ordinary edge source is ambiguous`);
    const parentPolicy = sourcePolicy(queue, edge.parentId);
    const childPolicy = sourcePolicy(queue, edge.childId, { child: true, kind: 'EDGE' });
    const parents = [{
      parentRole: 'parent-1', parentSlotId: edge.parentId, sourcePolicy: parentPolicy,
      sourceObligationId: parentPolicy === 'APPROVED_MATERIAL_V5' ? `g003-candidate:${edge.parentId}` : null,
      retainedSurfaces: parentPolicy === 'SIGNED_RETAINED_G002' ? retainedSurfaces(assignmentsById, edge.parentId) : null,
    }];
    const requiredParentObligationIds = [
      ...(parentPolicy === 'APPROVED_MATERIAL_V5' ? [`g003-candidate:${edge.parentId}`] : []),
      ...(childPolicy === 'APPROVED_MATERIAL_V5' ? [`g003-candidate:${edge.childId}`] : []),
    ].sort(compareText);
    const parentRoleBySlot = new Map([[edge.parentId, 'parent-1']]);
    obligations.push({
      obligationId, kind: 'EDGE', childSlotId: edge.childId, childSourcePolicy: childPolicy, parents,
      requiredParentObligationIds,
      requiredChildTaxonomy: taxonomyFor(edge.childId, assignmentsById, ovineReachable, pg018.canonicalTarget),
      requiredAnchors: normalizedAnchors({ anchors: source.allowedParentAnchors[0].anchors, parentRoleBySlot, descriptions }),
      assessmentMode: 'same-creature-continuity', benchmarkBinding: clone(perObligationBenchmark),
      retainedSurfaceBindings: retainedBindingsFor(parents, edge.childId, childPolicy, assignmentsById),
    });
  }

  obligations.sort((left, right) => compareText(left.obligationId, right.obligationId));
  const core = {
    schemaVersion: G003_V5_ASSIGNMENT_V3_SCHEMA,
    contractKind: 'UNSIGNED_CANONICAL_OBLIGATION_ASSIGNMENT',
    counts: clone(G003_V5_ASSIGNMENT_V3_COUNTS),
    benchmark,
    obligations,
  };
  assertG003V5AssignmentV3Core(core);
  return core;
}

export function deriveG003V5AssignmentV3Binding({ assignment, topology, obligationScope, schemaSha256 }) {
  if (!SHA.test(schemaSha256 ?? '')) fail('assignment schema byte fingerprint is invalid');
  const core = buildG003V5AssignmentV3({
    assignment, topology,
    supersession: { rootDirectives: CONTINUITY_ROOT_DIRECTIVES, obligationScope },
  });
  return {
    fixedPath: G003_V5_ASSIGNMENT_V3_PATH,
    schemaSha256,
    coreSha256: sha256Canonical(core),
  };
}

export function assertG003V5AssignmentV3Core(core) {
  exactKeys(core, ['schemaVersion', 'contractKind', 'counts', 'benchmark', 'obligations'], 'assignment core');
  if (core.schemaVersion !== G003_V5_ASSIGNMENT_V3_SCHEMA || core.contractKind !== 'UNSIGNED_CANONICAL_OBLIGATION_ASSIGNMENT') fail('assignment identity is invalid');
  if (canonicalStringify(core.counts) !== canonicalStringify(G003_V5_ASSIGNMENT_V3_COUNTS)) fail('assignment counts are invalid');
  const benchmark = benchmarkCore({ eiluBenchmark: core.benchmark });
  const expectedBenchmark = benchmarkBinding(benchmark);
  if (!Array.isArray(core.obligations) || core.obligations.length !== 337) fail('assignment must contain exactly 337 obligations');
  assertUnique(core.obligations.map((entry) => entry.obligationId), 'obligation IDs');
  if (canonicalStringify(core.obligations.map((entry) => entry.obligationId)) !== canonicalStringify(core.obligations.map((entry) => entry.obligationId).sort(compareText))) fail('obligations are not canonically ordered');
  const ids = new Set(core.obligations.map((entry) => entry.obligationId));
  for (const obligation of core.obligations) {
    exactKeys(obligation, ['obligationId', 'kind', 'childSlotId', 'childSourcePolicy', 'parents', 'requiredParentObligationIds', 'requiredChildTaxonomy', 'requiredAnchors', 'assessmentMode', 'benchmarkBinding', 'retainedSurfaceBindings'], obligation.obligationId ?? 'obligation');
    if (!['QUEUE', 'EDGE'].includes(obligation.kind) || !PG_ID.test(obligation.childSlotId ?? '') || MIXED_IDS.has(obligation.childSlotId)) fail(`${obligation.obligationId}: invalid kind or child`);
    const expectedId = obligation.kind === 'QUEUE' ? `g003-candidate:${obligation.childSlotId}` : null;
    if ((expectedId && obligation.obligationId !== expectedId) || (!expectedId && !obligation.obligationId.endsWith(`:${obligation.childSlotId}`))) fail(`${obligation.obligationId}: obligation ID and child differ`);
    if (!['STAGED_GENERATION', 'APPROVED_MATERIAL_V5', 'SIGNED_RETAINED_G002'].includes(obligation.childSourcePolicy)) fail(`${obligation.obligationId}: invalid child source policy`);
    if (!['same-creature-continuity', 'canonical-root-replacement'].includes(obligation.assessmentMode)) fail(`${obligation.obligationId}: assessment mode is invalid`);
    if (canonicalStringify(obligation.benchmarkBinding) !== canonicalStringify(expectedBenchmark)) fail(`${obligation.obligationId}: benchmark binding changed`);
    assertTaxonomy(obligation.requiredChildTaxonomy, `${obligation.obligationId} taxonomy`);
    if (!Array.isArray(obligation.parents) || !Array.isArray(obligation.requiredAnchors) || !obligation.requiredAnchors.length
        || !Array.isArray(obligation.requiredParentObligationIds) || !Array.isArray(obligation.retainedSurfaceBindings)) fail(`${obligation.obligationId}: obligation collections are invalid`);
    assertUnique(obligation.parents.map((parent) => parent.parentRole), `${obligation.obligationId} parent roles`);
    if (canonicalStringify(obligation.parents.map((parent) => parent.parentRole)) !== canonicalStringify(obligation.parents.map((_, index) => `parent-${index + 1}`))) fail(`${obligation.obligationId}: parent roles are not canonically ordered`);
    assertUnique(obligation.requiredAnchors.map((anchor) => `${anchor.parentRole ?? ''}\0${anchor.anchorId}`), `${obligation.obligationId} anchors`);
    assertUnique(obligation.requiredParentObligationIds, `${obligation.obligationId} dependencies`);
    for (const dependency of obligation.requiredParentObligationIds) if (!ids.has(dependency) || dependency === obligation.obligationId) fail(`${obligation.obligationId}: unresolved or cyclic direct dependency`);
    for (const parent of obligation.parents) {
      exactKeys(parent, ['parentRole', 'parentSlotId', 'sourcePolicy', 'sourceObligationId', 'retainedSurfaces'], `${obligation.obligationId} parent`);
      if (!/^parent-[1-9][0-9]*$/.test(parent.parentRole ?? '') || !PG_ID.test(parent.parentSlotId ?? '') || MIXED_IDS.has(parent.parentSlotId)
          || !['APPROVED_MATERIAL_V5', 'SIGNED_RETAINED_G002'].includes(parent.sourcePolicy)) fail(`${obligation.obligationId}: parent source is invalid`);
      if (parent.sourcePolicy === 'APPROVED_MATERIAL_V5') {
        if (parent.sourceObligationId !== `g003-candidate:${parent.parentSlotId}` || parent.retainedSurfaces !== null) fail(`${obligation.obligationId}: generated parent binding is invalid`);
      } else if (parent.sourceObligationId !== null || !parent.retainedSurfaces || !SHA.test(parent.retainedSurfaces.masterSha256 ?? '') || !SHA.test(parent.retainedSurfaces.runtimeSha256 ?? '')) fail(`${obligation.obligationId}: retained parent binding is invalid`);
    }
    for (const anchor of obligation.requiredAnchors) {
      exactKeys(anchor, ['requirementType', 'parentRole', 'parentSlotId', 'anchorId', 'description', 'sourcePolicy'], `${obligation.obligationId} anchor`);
      if (!['VISUAL_ANCHOR', 'VISIBILITY'].includes(anchor.requirementType) || typeof anchor.anchorId !== 'string' || !anchor.anchorId
          || typeof anchor.description !== 'string' || !anchor.description || !['SIGNED_ROOT_DIRECTIVE', 'APPROVED_MATERIAL_V5', 'SIGNED_RETAINED_G002'].includes(anchor.sourcePolicy)) fail(`${obligation.obligationId}: anchor is invalid`);
    }
    const bindingKeys = new Set();
    for (const binding of obligation.retainedSurfaceBindings) {
      exactKeys(binding, ['role', 'slotId', 'masterSha256', 'runtimeSha256'], `${obligation.obligationId} retained binding`);
      if (!SHA.test(binding.masterSha256 ?? '') || !SHA.test(binding.runtimeSha256 ?? '') || !PG_ID.test(binding.slotId ?? '')) fail(`${obligation.obligationId}: retained surface binding is malformed`);
      const key = `${binding.role}\0${binding.slotId}`; if (bindingKeys.has(key)) fail(`${obligation.obligationId}: retained surface binding is duplicated`); bindingKeys.add(key);
    }
    for (const parent of obligation.parents) {
      const binding = obligation.retainedSurfaceBindings.find((entry) => entry.role === parent.parentRole && entry.slotId === parent.parentSlotId);
      if (parent.sourcePolicy === 'SIGNED_RETAINED_G002' && (!binding || canonicalStringify({ masterSha256: binding.masterSha256, runtimeSha256: binding.runtimeSha256 }) !== canonicalStringify(parent.retainedSurfaces))) fail(`${obligation.obligationId}: retained parent surface binding is incomplete`);
      if (parent.sourcePolicy !== 'SIGNED_RETAINED_G002' && binding) fail(`${obligation.obligationId}: generated parent has a retained surface binding`);
    }
    const childBinding = obligation.retainedSurfaceBindings.find((entry) => entry.role === 'child');
    if ((obligation.childSourcePolicy === 'SIGNED_RETAINED_G002') !== Boolean(childBinding)) fail(`${obligation.obligationId}: retained child surface binding is incomplete`);
  }
  const queues = core.obligations.filter((entry) => entry.kind === 'QUEUE');
  const edges = core.obligations.filter((entry) => entry.kind === 'EDGE');
  if (queues.length !== 167 || edges.length !== 170) fail('queue/edge obligation counts are invalid');
  if (queues.filter((entry) => entry.requiredParentObligationIds.length > 0).length !== 113
      || edges.filter((entry) => entry.parents[0]?.sourcePolicy === 'APPROVED_MATERIAL_V5').length !== 113
      || edges.filter((entry) => entry.childSourcePolicy === 'APPROVED_MATERIAL_V5').length !== 128
      || edges.filter((entry) => entry.childSourcePolicy === 'SIGNED_RETAINED_G002').length !== 42) fail('derived dependency/source-policy counts are invalid');
  const candidateIndegree = new Map(queues.map((entry) => [entry.obligationId, 0]));
  const candidateChildren = new Map(queues.map((entry) => [entry.obligationId, []]));
  for (const entry of queues) for (const dependency of entry.requiredParentObligationIds) {
    if (!candidateIndegree.has(dependency)) fail(`${entry.obligationId}: queue dependency is not a candidate obligation`);
    candidateIndegree.set(entry.obligationId, candidateIndegree.get(entry.obligationId) + 1);
    candidateChildren.get(dependency).push(entry.obligationId);
  }
  const ready = [...candidateIndegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop(); visited += 1;
    for (const child of candidateChildren.get(id)) {
      const next = candidateIndegree.get(child) - 1; candidateIndegree.set(child, next); if (next === 0) ready.push(child);
    }
  }
  if (visited !== queues.length) fail('candidate obligation dependency graph contains a cycle');
  const pg005 = core.obligations.find((entry) => entry.obligationId === 'g003-candidate:PG-005');
  if (pg005?.assessmentMode !== 'canonical-root-replacement' || pg005.requiredChildTaxonomy.biologicalClass !== 'construct'
      || pg005.requiredChildTaxonomy.coreAnatomy !== 'hexapod'
      || !pg005.requiredAnchors.some((anchor) => anchor.anchorId === 'visibility:exactly-six-visible-walking-legs')
      || !pg005.requiredAnchors.some((anchor) => anchor.anchorId === 'visibility:all-six-legs-separately-readable')) fail('PG-005 exact six-visible-leg canonical directive is absent');
  for (const slotId of ['PG-018', 'PG-078', 'PG-232']) {
    const relevant = core.obligations.filter((entry) => entry.childSlotId === slotId);
    if (!relevant.length || relevant.some((entry) => entry.requiredChildTaxonomy.speciesFamily !== 'ovine')) fail(`${slotId}: ovine correction is not transitive`);
  }
  if (core.obligations.some((entry) => entry.childSlotId === 'PG-197' || entry.parents.some((parent) => parent.parentSlotId === 'PG-197'))) fail('fusion-only PG-197 entered ordinary obligations');
  return core;
}

export function validateG003V5AssignmentV3(core, inputs) {
  assertG003V5AssignmentV3Core(core);
  const expected = buildG003V5AssignmentV3(inputs);
  if (canonicalStringify(core) !== canonicalStringify(expected)) fail('assignment differs from deterministic immutable-input derivation');
  return core;
}

export function projectG003V5AssignmentV3Core(value) {
  const core = clone(value);
  delete core.delegationOutputSha256;
  delete core.successorOutputSha256;
  delete core.outputSha256;
  delete core.publicSignature;
  return assertG003V5AssignmentV3Core(core);
}

export function validateSignedG003V5AssignmentV3(value, {
  delegation, successor, schemaSha256, expectedCore,
} = {}) {
  exactKeys(value, [
    'schemaVersion', 'contractKind', 'counts', 'benchmark', 'obligations',
    'delegationOutputSha256', 'successorOutputSha256', 'outputSha256', 'publicSignature',
  ], 'signed assignment-v3 envelope');
  const core = projectG003V5AssignmentV3Core(value);
  if (!expectedCore || canonicalStringify(core) !== canonicalStringify(expectedCore)) fail('signed assignment core differs from deterministic immutable-input derivation');
  if (!delegation || !successor || value.delegationOutputSha256 !== delegation.outputSha256
      || value.successorOutputSha256 !== successor.outputSha256) fail('signed assignment predecessor envelope binding mismatch');
  const expectedBinding = {
    fixedPath: G003_V5_ASSIGNMENT_V3_PATH,
    schemaSha256,
    coreSha256: sha256Canonical(core),
  };
  if (canonicalStringify(successor.assignmentV3) !== canonicalStringify(expectedBinding)
      || canonicalStringify(delegation.grant?.assignmentV3) !== canonicalStringify(expectedBinding)) fail('signed assignment fixed path/schema/core binding mismatch');
  const unsigned = clone(value); delete unsigned.publicSignature;
  const outputCore = clone(unsigned); delete outputCore.outputSha256;
  if (value.outputSha256 !== sha256Canonical(outputCore)) fail('signed assignment output hash mismatch');
  verifyContinuityEvidence(unsigned, value.publicSignature, delegation, {
    purpose: CONTINUITY_ASSIGNMENT_V3_PURPOSE, schemaSha256,
  });
  return value;
}

export async function assertG003V5AssignmentV3TipAvailable(repoRoot = ROOT) {
  try {
    await lstat(path.join(repoRoot, G003_V5_ASSIGNMENT_V3_PATH));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  fail('assignment-v3 fixed tip already exists; second tip is forbidden');
}

async function assignmentVerificationContext({ repoRoot, transitionSnapshot, delegation, successor, testOnlyVerifiedDelegation }) {
  const snapshot = transitionSnapshot ?? await loadVerifiedG003TransitionSnapshot(repoRoot);
  assertG003TransitionSnapshot(snapshot);
  if (testOnlyVerifiedDelegation && snapshot.freeze?.testOnly !== true) fail('test-only verified delegation requires a test-only branded snapshot');
  const verifiedDelegation = testOnlyVerifiedDelegation
    ?? await (await import('../../verify-continuity-authority-delegation.mjs')).verifyContinuityAuthorityDelegation({ repoRoot, delegation, transitionSnapshot: snapshot });
  const verifiedSuccessor = await (await import('./g002-v2-cross-authority-supersession.mjs')).verifyCrossAuthoritySupersession({
    repoRoot, value: successor, delegation: verifiedDelegation.delegation, transitionSnapshot: snapshot,
    testOnlyVerifiedDelegation: testOnlyVerifiedDelegation ? { delegation: verifiedDelegation.delegation } : undefined,
  });
  const schemaBytes = await readContainedFile(repoRoot, G003_V5_ASSIGNMENT_V3_SCHEMA_PATH);
  try { JSON.parse(schemaBytes); } catch { fail('assignment-v3 schema bytes are not valid JSON'); }
  const schemaSha256 = sha256Bytes(schemaBytes);
  const expectedCore = buildG003V5AssignmentV3({ assignment: snapshot.assignment, topology: snapshot.topology, supersession: verifiedSuccessor.value });
  const binding = deriveG003V5AssignmentV3Binding({
    assignment: snapshot.assignment, topology: snapshot.topology,
    obligationScope: verifiedSuccessor.value.obligationScope, schemaSha256,
  });
  if (canonicalStringify(binding) !== canonicalStringify(verifiedSuccessor.value.assignmentV3)) fail('successor assignment-v3 binding differs from exact schema bytes and immutable inputs');
  return { snapshot, delegation: verifiedDelegation.delegation, successor: verifiedSuccessor.value, schemaSha256, expectedCore };
}

export async function verifySignedG003V5AssignmentV3({
  repoRoot = ROOT, value: suppliedValue, delegation, successor, transitionSnapshot, testOnlyVerifiedDelegation,
} = {}) {
  const context = await assignmentVerificationContext({ repoRoot, transitionSnapshot, delegation, successor, testOnlyVerifiedDelegation });
  let value = suppliedValue;
  if (!value) {
    const bytes = await readContainedFile(repoRoot, G003_V5_ASSIGNMENT_V3_PATH);
    try { value = JSON.parse(bytes); } catch { fail('assignment-v3 fixed tip is not valid JSON'); }
  }
  validateSignedG003V5AssignmentV3(value, context);
  return { status: 'PASS', value, ...context };
}

export async function attestSignedG003V5AssignmentV3({
  repoRoot = ROOT, g003RootKey, delegation, successor, write = false,
  testOnlyTransitionSnapshot, testOnlyVerifiedDelegation, signer = signContinuityEvidence,
} = {}) {
  if ((testOnlyTransitionSnapshot || testOnlyVerifiedDelegation) && write) fail('test-only transition inputs cannot publish');
  return withG003TransitionLock(repoRoot, async () => {
    const context = await assignmentVerificationContext({
      repoRoot, transitionSnapshot: testOnlyTransitionSnapshot, delegation, successor, testOnlyVerifiedDelegation,
    });
    assertG003TransitionSnapshot(context.snapshot, { production: write });
    const envelopeCore = {
      ...context.expectedCore,
      delegationOutputSha256: context.delegation.outputSha256,
      // This is acyclic: the successor binds only the assignment core/path/schema,
      // while this later companion envelope binds the already-final successor tip.
      successorOutputSha256: context.successor.outputSha256,
    };
    const unsigned = { ...envelopeCore, outputSha256: sha256Canonical(envelopeCore) };
    const value = {
      ...unsigned,
      publicSignature: signer(unsigned, g003RootKey, context.delegation, {
        purpose: CONTINUITY_ASSIGNMENT_V3_PURPOSE, schemaSha256: context.schemaSha256,
      }),
    };
    validateSignedG003V5AssignmentV3(value, context);
    const publication = write
      ? await publishBytesNoReplace(repoRoot, path.join(repoRoot, G003_V5_ASSIGNMENT_V3_PATH), Buffer.from(canonicalStringify(value)))
      : null;
    return { status: write ? publication : 'VALID', output: G003_V5_ASSIGNMENT_V3_PATH, outputSha256: value.outputSha256, value };
  });
}
