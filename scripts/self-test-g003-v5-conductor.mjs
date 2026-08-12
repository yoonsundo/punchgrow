import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { G003_V5_SCHEMA_PATHS, createTestOnlyG003V5ContinuityRecordAuthority, resolveEffectiveRejectionStateV5 } from './lib/g003-v5-authority.mjs';
import * as v5AuthorityExports from './lib/g003-v5-authority.mjs';
import { CONTINUITY_ROOT_DIRECTIVES, deriveCrossAuthorityObligationScope } from './lib/continuity-assignment/g002-v2-cross-authority-supersession.mjs';
import {
  G003_V5_CONDUCTOR_COUNTS,
  G003_V5_COVERAGE_SCHEMA,
  G003_V5_MIXED_SLOT_IDS,
  G003_V5_VOTE_SCHEMA,
  assembleG003V5PublicReview,
  assertG003V5ReviewerAssignment,
  buildG003V5Coverage,
  createG003V5ConductorContext,
  createG003V5ReviewerAssignment,
  createTestOnlyG003V5ArtifactAuthority,
  createTestOnlyG003V5VerificationAuthority,
  createTestOnlyG003V5VerifiedInputs,
  createG003V5RejectionArtifacts,
  createG003V5ReviewerEvidence,
  publishG003V5Coverage,
  publishG003V5Records,
  publishG003V5VoteRecord,
} from './lib/g003-v5-conductor.mjs';
import { loadPersistedVotes, readCanonicalJson } from './conduct-g003-v5-reviews.mjs';

const hex = (seed) => sha256Canonical({ seed });
const execFile = promisify(execFileCallback);
const continuitySchemaPaths = [
  'production/contracts/g003-reviewer-assignment-v5.schema.json',
  'production/contracts/g003-primary-vote-v5.schema.json',
  'production/contracts/continuity-candidate-review-v5.schema.json',
  'production/contracts/g003-public-review-artifact-v5.schema.json',
  'production/contracts/g003-review-coverage-v5.schema.json',
  'production/contracts/g003-review-invalidity-v1.schema.json',
  'production/contracts/g003-rejection-archive-v5.schema.json',
  'production/contracts/g003-rejection-tombstone-v2.schema.json',
  'production/contracts/g003-quarantine-assignment-v1.schema.json',
  'production/contracts/g003-quarantine-invalidity-attestation-v1.schema.json',
  'production/contracts/g003-rejection-tombstone-supersession-v1.schema.json',
];
const continuitySchemaSha256ByPath = Object.fromEntries(await Promise.all(continuitySchemaPaths.map(async (schemaPath) => [
  schemaPath, sha256Canonical(JSON.parse(await readFile(path.join(process.cwd(), schemaPath), 'utf8'))),
])));
const rejectionAuthority = createTestOnlyG003V5ContinuityRecordAuthority({ protocolAuthoritySha256: hex('protocol-record'),
  delegationOutputSha256: hex('delegation-record'), schemaSha256ByPath: continuitySchemaSha256ByPath });
const artifactAuthority = createTestOnlyG003V5ArtifactAuthority(rejectionAuthority);
const verificationOnlyAuthority = createTestOnlyG003V5VerificationAuthority(rejectionAuthority);
assert.equal('createG003V5ContinuityRecordAuthority' in v5AuthorityExports, false);
assert.equal('createG003V5ContinuityRecordCapabilities' in v5AuthorityExports, false);
assert.equal(Object.keys(v5AuthorityExports).some((name) => /^(sign|finalize).*G003V5/i.test(name)), false);
assert.equal(typeof verificationOnlyAuthority.verifyRecord, 'function');
assert.equal('finalize' in verificationOnlyAuthority, false);
assert.equal(typeof verificationOnlyAuthority.finalize, 'undefined');
const assignedAt = '2026-08-11T00:00:00.000Z';

function makeScope() {
  const queueSlotIds = Array.from({ length: 167 }, (_, index) => `PG-${String(index + 1).padStart(3, '0')}`);
  const ordinaryEdges = [{ parentId: 'PG-018', childId: 'PG-078' }, { parentId: 'PG-018', childId: 'PG-232' }, ...Array.from({ length: 168 }, (_, index) => ({
    parentId: `PG-${String(index + 1).padStart(3, '0')}`,
    childId: `PG-${String((index + 17) % 195 + 1).padStart(3, '0')}`,
  }))];
  return {
    schemaVersion: 'continuity-signed-obligation-scope-v1',
    authority: 'continuity-g002-v2-supersession-v1',
    exclusionPolicy: 'EXCLUDE_MIXED_CHILD_OBLIGATIONS_PRESERVE_FUSION_PROVENANCE',
    queueSlotIds,
    ordinaryEdges,
    excludedMixedSlotIds: [...G003_V5_MIXED_SLOT_IDS],
    excludedMixedIncidentEdges: Array.from({ length: 20 }, (_, index) => ({ parentId: 'PG-001', childId: `PG-${String(196 + index % 10).padStart(3, '0')}` })),
    fusionProvenance: Array.from({ length: 10 }, (_, index) => ({ mixedSlotId: G003_V5_MIXED_SLOT_IDS[index] })),
    effectiveRootIds: Array.from({ length: 17 }, (_, index) => `PG-${String(index + 1).padStart(3, '0')}`),
    counts: { queue: 167, retained: 73, ordinaryEdges: 170, obligations: 337, dependent: 113,
      generatedParentEdges: 113, generatedChildEdges: 128, retainedChildEdges: 42, votes: 674, effectiveRoots: 17 },
  };
}

function makeContext(scope = makeScope(), historicalCount = 81, rootDirectives = [{ rootId: 'PG-018', directive: 'CORRECT_SPECIES_FAMILY',
  canonicalTarget: { biologicalClass: 'mammal', speciesFamily: 'ovine', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' } }]) {
  const authorityCore = { protocol: 'continuity-g003-review-protocol-v5', priorProtocolAuthoritySha256: hex('prior-protocol'),
    continuityAuthority: { delegationOutputSha256: hex('delegation-output'), delegationFileSha256: hex('delegation-file'),
      supersessionOutputSha256: hex('supersession-output'), supersessionFileSha256: hex('supersession-file'),
      freezeOutputSha256: hex('freeze-output'), freezeFileSha256: hex('freeze-file'), freezeTreeSha256: hex('freeze-tree') },
    schemaBindings: G003_V5_SCHEMA_PATHS.map((schemaPath) => ({ path: schemaPath, sha256: hex(schemaPath) })) };
  const terminalAuthority = {
    state: 'TERMINAL_V5', reviewProtocol: 'continuity-g003-review-protocol-v5',
    priorProtocolAuthoritySha256: authorityCore.priorProtocolAuthoritySha256, continuityAuthority: authorityCore.continuityAuthority,
    schemaBindings: authorityCore.schemaBindings, protocolAuthoritySha256: sha256Canonical(authorityCore),
    terminalOutputSha256: hex('terminal-output'), terminalFileSha256: hex('terminal-file'),
    rootDirectives,
  };
  return createG003V5ConductorContext({
    verifiedInputs: createTestOnlyG003V5VerifiedInputs({ terminalAuthority, signedObligationScope: scope }),
    v4HistoricalArtifacts: Array.from({ length: historicalCount }, (_, index) => `v4-${index}`),
  });
}

function makePackageContext(requiredChildTaxonomy = { biologicalClass: 'mammal', speciesFamily: 'felidae', coreAnatomy: 'quadruped', locomotionPlan: 'terrestrial' }) {
  return {
    opaqueCandidateId: 'candidate-0123456789abcdef01234567', generationRunId: 'generation-run-v5',
    packageManifestSha256: hex('package'), materialBindingSha256: hex('material'), inputAllowlistSha256: hex('allowlist'),
    promptSha256: hex('prompt'), inputAssetSha256s: [hex('asset-master'), hex('asset-runtime')],
    requiredChildTaxonomy,
    parentRoles: ['parent-1'], requiredAnchors: [{ parentRole: 'parent-1', anchorId: 'ears', description: 'paired triangular ears' }],
    eiluBenchmarkId: 'eilu-comparative-visual-v1', canonicalMode: false,
  };
}

function makeAssignment(context, obligationId, passNumber, serial) {
  const packageContext = makePackageContext();
  return createG003V5ReviewerAssignment({ context, artifactAuthority, assignmentCore: {
    assignmentId: `assignment-v5-${serial}-${passNumber}`,
    obligationId, opaqueCandidateId: packageContext.opaqueCandidateId, generationRunId: packageContext.generationRunId,
    passNumber, reviewerInstanceId: `reviewer-${serial}-${passNumber}`, agentTaskId: `agent-task-${serial}-${passNumber}`,
    voterReviewRunId: `review-run-${serial}-${passNumber}`, packageManifestSha256: packageContext.packageManifestSha256,
    materialBindingSha256: packageContext.materialBindingSha256, inputAllowlistSha256: packageContext.inputAllowlistSha256,
    promptSha256: packageContext.promptSha256, inputAssetSha256s: packageContext.inputAssetSha256s,
    childMaterialSha256s: packageContext.inputAssetSha256s,
    signedObligationScope: { schemaVersion: 'continuity-signed-obligation-scope-binding-v1',
      scopeSha256: context.signedObligationScopeSha256, protocolAuthoritySha256: context.protocolAuthoritySha256,
      terminalOutputSha256: context.terminalOutputSha256 },
    assignedAt, requiredChildTaxonomy: context.ordinaryTaxonomy.byObligation[obligationId] ?? packageContext.requiredChildTaxonomy,
    reviewContext: { parentRoles: packageContext.parentRoles, requiredAnchors: packageContext.requiredAnchors,
      eiluBenchmarkId: packageContext.eiluBenchmarkId, canonicalMode: packageContext.canonicalMode },
  } });
}

function makePassVerdict(assignment, assignmentBytes) {
  const packageContext = makePackageContext(assignment.requiredChildTaxonomy);
  return {
    schemaVersion: 'continuity-g003-reviewer-verdict-v2', assignmentId: assignment.assignmentId,
    assignmentRawSha256: sha256Bytes(assignmentBytes), reviewerInstanceId: assignment.reviewerInstanceId,
    agentTaskId: assignment.agentTaskId, voterReviewRunId: assignment.voterReviewRunId, passNumber: assignment.passNumber,
    opaqueCandidateId: assignment.opaqueCandidateId, generationRunId: assignment.generationRunId,
    packageManifestSha256: assignment.packageManifestSha256, materialBindingSha256: assignment.materialBindingSha256,
    inputAllowlistSha256: assignment.inputAllowlistSha256, promptSha256: assignment.promptSha256,
    inputAssetSha256s: assignment.inputAssetSha256s, requiredChildTaxonomy: packageContext.requiredChildTaxonomy,
    verdict: 'PASS', passEvidence: {
      childTaxonomy: packageContext.requiredChildTaxonomy,
      sameCreatureObservations: [{ parentRole: 'parent-1', sameCreatureGrownUp: 'yes', observation: 'same family morphology retained' }],
      anchorObservations: [{ parentRole: 'parent-1', anchorId: 'ears', requiredDescription: 'paired triangular ears', satisfied: true, observation: 'ears retained' }],
      eiluObservation: { benchmarkId: 'eilu-comparative-visual-v1', continuityScore: 0.99, anchorRetentionRatio: 1, retainedAnchorCount: 3, observation: 'benchmark passed' },
      canonicalSurfaceObservations: [],
    }, failureFindings: [], explanation: 'independent structured review passed', confidence: 0.99, observedAt: assignedAt,
  };
}

function makeRejectVerdict(assignment, assignmentBytes) {
  const packageContext = makePackageContext();
  return {
    ...makePassVerdict(assignment, assignmentBytes), schemaVersion: 'continuity-g003-rejection-observation-v2', verdict: 'REJECT',
    passEvidence: null, failureFindings: [{ type: 'taxonomy-mismatch', field: 'speciesFamily', expected: 'felidae',
      observed: 'mustelidae', surfaces: ['master', 'runtime'], explanation: 'material visibly changes species family' }],
    explanation: 'typed material rejection', confidence: 0.99, requiredChildTaxonomy: packageContext.requiredChildTaxonomy,
  };
}

function makeVote(context, obligationId, passNumber, serial) {
  const assignment = makeAssignment(context, obligationId, passNumber, serial);
  const assignmentBytes = Buffer.from(canonicalStringify(assignment));
  const verdict = makePassVerdict(assignment, assignmentBytes);
  return createG003V5ReviewerEvidence({ context, assignment, assignmentBytes, verdict,
    now: Date.parse(assignedAt), artifactAuthority });
}

function resignTestRecord(value, mutate) {
  const schemaVersion = value.schemaVersion;
  const core = structuredClone(value);
  delete core.schemaVersion; delete core.outputSha256; delete core.publicSignature;
  mutate(core);
  return artifactAuthority.finalize(core, schemaVersion);
}

async function expectMissing(target) {
  await assert.rejects(access(target), (error) => error.code === 'ENOENT');
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-conductor-'));
try {
  await assert.rejects(execFile(process.execPath, ['scripts/conduct-g003-v5-reviews.mjs', 'issue-assignment'], { cwd: process.cwd() }),
    /UNAVAILABLE_NO_VERIFIED_PACKAGE/);
  const scope = makeScope();
  const context = makeContext(scope);
  assert.equal(context.obligationIds.length, G003_V5_CONDUCTOR_COUNTS.obligations);
  assert.equal(context.v4HistoricalAuditCount, 81);
  assert.equal(context.v4HistoricalVoteCredit, 0);
  assert.ok(context.ordinaryTaxonomy.reachableSlotIds.includes('PG-078'));
  assert.ok(context.ordinaryTaxonomy.reachableSlotIds.includes('PG-232'));
  assert.ok(!context.ordinaryTaxonomy.reachableSlotIds.includes('PG-197'));
  assert.equal(context.ordinaryTaxonomy.byObligation['g003-candidate:PG-078'].speciesFamily, 'ovine');
  assert.equal(context.ordinaryTaxonomy.byObligation['g003-edge:PG-018:PG-232'].speciesFamily, 'ovine');
  assert.equal(context.obligationIds.includes('g003-candidate:PG-197'), false);
  assert.equal(context.obligationIds.some((id) => id.includes(':PG-197')), false);

  const [realAssignment, realTopology] = await Promise.all([
    readFile(path.join(process.cwd(), 'production/reports/biological-continuity-v3/g002-evidence-v2/assignment-manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(process.cwd(), 'production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json'), 'utf8').then(JSON.parse),
  ]);
  const realSignedScope = deriveCrossAuthorityObligationScope(realAssignment, realTopology);
  const realContext = makeContext(realSignedScope, 81, CONTINUITY_ROOT_DIRECTIVES);
  assert.equal(realContext.ordinaryTaxonomy.byObligation['g003-candidate:PG-078'].speciesFamily, 'ovine');
  assert.equal(realContext.ordinaryTaxonomy.byObligation['g003-edge:PG-018:PG-078'].speciesFamily, 'ovine');
  assert.equal(realContext.ordinaryTaxonomy.byObligation['g003-edge:PG-018:PG-232'].speciesFamily, 'ovine');
  assert.equal(realContext.obligationIds.some((id) => id.includes('PG-197')), false);
  assert.equal(realContext.ordinaryTaxonomy.reachableSlotIds.includes('PG-197'), false);

  const staleTerminalScope = structuredClone(scope);
  const staleAuthorityCore = { protocol: 'continuity-g003-review-protocol-v5', priorProtocolAuthoritySha256: hex('stale-prior'),
    continuityAuthority: { delegationOutputSha256: hex('sd1'), delegationFileSha256: hex('sd2'), supersessionOutputSha256: hex('ss1'),
      supersessionFileSha256: hex('ss2'), freezeOutputSha256: hex('sf1'), freezeFileSha256: hex('sf2'), freezeTreeSha256: hex('sf3') },
    schemaBindings: G003_V5_SCHEMA_PATHS.map((schemaPath) => ({ path: schemaPath, sha256: hex(`stale-${schemaPath}`) })) };
  const staleTerminal = {
    state: 'TERMINAL_V5', reviewProtocol: staleAuthorityCore.protocol, priorProtocolAuthoritySha256: staleAuthorityCore.priorProtocolAuthoritySha256,
    continuityAuthority: staleAuthorityCore.continuityAuthority, schemaBindings: staleAuthorityCore.schemaBindings,
    protocolAuthoritySha256: sha256Canonical(staleAuthorityCore), terminalOutputSha256: hex('stale-output'), terminalFileSha256: hex('stale-file'),
    rootDirectives: [{ rootId: 'PG-018', directive: 'CORRECT_SPECIES_FAMILY',
      canonicalTarget: { biologicalClass: 'mammal', speciesFamily: 'bovine', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' } }],
  };
  assert.throws(() => createG003V5ConductorContext({ verifiedInputs: createTestOnlyG003V5VerifiedInputs({
    terminalAuthority: staleTerminal, signedObligationScope: staleTerminalScope }) }), /ovine correction is missing or stale/);
  const substitutedTerminal = structuredClone(staleTerminal);
  substitutedTerminal.rootDirectives[0].canonicalTarget.speciesFamily = 'ovine';
  substitutedTerminal.schemaBindings[2].sha256 = hex('substituted-schema');
  assert.throws(() => createG003V5ConductorContext({ verifiedInputs: createTestOnlyG003V5VerifiedInputs({
    terminalAuthority: substitutedTerminal, signedObligationScope: staleTerminalScope }) }), /does not bind exact schema bytes/);

  const mixedQueue = structuredClone(scope); mixedQueue.queueSlotIds[0] = 'PG-196';
  assert.throws(() => makeContext(mixedQueue), /mixed PG-196\.\.PG-205 queue obligations/);
  const mixedEdge = structuredClone(scope); mixedEdge.ordinaryEdges[0].childId = 'PG-205';
  assert.throws(() => makeContext(mixedEdge), /mixed PG-196\.\.PG-205 ordinary obligations/);

  const missingBinding = structuredClone(makeAssignment(context, context.obligationIds[0], 1, 0)); delete missingBinding.signedObligationScope;
  assert.throws(() => createG003V5ReviewerEvidence({ context, assignment: missingBinding, assignmentBytes: Buffer.from('{}'), verdict: {}, verdictContext: {}, artifactAuthority }), /missing=signedObligationScope/);
  const staleOvine = structuredClone(makeAssignment(context, 'g003-candidate:PG-078', 1, 1));
  staleOvine.requiredChildTaxonomy = { ...staleOvine.requiredChildTaxonomy, speciesFamily: 'bovine' };
  assert.throws(() => createG003V5ReviewerEvidence({ context, assignment: staleOvine, assignmentBytes: Buffer.from('{}'), verdict: {}, verdictContext: {}, artifactAuthority }), /requires ovine/);

  const schemaAssignment = makeAssignment(context, context.obligationIds[0], 1, 777);
  const invalidAssignmentCases = [
    ['packageManifestSha256', (core) => { core.packageManifestSha256 = 'bad'; }, /packageManifestSha256.*SHA-256/],
    ['materialBindingSha256', (core) => { core.materialBindingSha256 = 'bad'; }, /materialBindingSha256.*SHA-256/],
    ['inputAllowlistSha256', (core) => { core.inputAllowlistSha256 = 'bad'; }, /inputAllowlistSha256.*SHA-256/],
    ['promptSha256', (core) => { core.promptSha256 = 'bad'; }, /promptSha256.*SHA-256/],
    ['empty input assets', (core) => { core.inputAssetSha256s = []; }, /inputAssetSha256s must contain unique/],
    ['duplicate input assets', (core) => { core.inputAssetSha256s = [hex('dup'), hex('dup')]; }, /inputAssetSha256s must contain unique/],
    ['invalid input asset', (core) => { core.inputAssetSha256s = ['bad']; }, /inputAssetSha256s.*SHA-256/],
    ['assignedAt', (core) => { core.assignedAt = 'tomorrow'; }, /assignedAt must be a true UTC ISO timestamp/],
    ['opaqueCandidateId', (core) => { core.opaqueCandidateId = 'candidate-nope'; }, /opaqueCandidateId is invalid/],
    ['generationRunId', (core) => { core.generationRunId = '../bad'; }, /generationRunId is invalid/],
    ['parent role', (core) => { core.reviewContext.parentRoles = ['parent-3']; }, /reviewContext is invalid/],
    ['parent role order', (core) => { core.reviewContext.parentRoles = ['parent-2', 'parent-1']; }, /reviewContext is invalid/],
    ['duplicate parent roles', (core) => { core.reviewContext.parentRoles = ['parent-1', 'parent-1']; }, /reviewContext is invalid/],
    ['wrong anchor role', (core) => { core.reviewContext.requiredAnchors[0].parentRole = 'parent-2'; }, /required anchor is invalid/],
    ['empty anchor id', (core) => { core.reviewContext.requiredAnchors[0].anchorId = ''; }, /required anchor is invalid/],
    ['empty anchor description', (core) => { core.reviewContext.requiredAnchors[0].description = ''; }, /required anchor is invalid/],
    ['benchmark id', (core) => { core.reviewContext.eiluBenchmarkId = 'alternate-benchmark'; }, /reviewContext is invalid/],
  ];
  for (const [, mutate, expected] of invalidAssignmentCases) {
    assert.throws(() => assertG003V5ReviewerAssignment(resignTestRecord(schemaAssignment, mutate), context, artifactAuthority), expected);
  }
  for (const field of ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']) {
    assert.throws(() => assertG003V5ReviewerAssignment(resignTestRecord(schemaAssignment,
      (core) => { delete core.requiredChildTaxonomy[field]; }), context, artifactAuthority), /requiredChildTaxonomy fields mismatch/);
  }
  assert.throws(() => assertG003V5ReviewerAssignment(resignTestRecord(schemaAssignment,
    (core) => { core.requiredChildTaxonomy.speciesFamily = ''; }), context, artifactAuthority), /speciesFamily is invalid/);

  const schemaAssignmentBytes = Buffer.from(canonicalStringify(schemaAssignment));
  const schemaVerdict = makePassVerdict(schemaAssignment, schemaAssignmentBytes);
  const invalidVerdictCases = [
    [(value) => { value.packageManifestSha256 = 'bad'; }, /packageManifestSha256.*SHA-256/],
    [(value) => { value.materialBindingSha256 = 'bad'; }, /materialBindingSha256.*SHA-256/],
    [(value) => { value.inputAllowlistSha256 = 'bad'; }, /inputAllowlistSha256.*SHA-256/],
    [(value) => { value.promptSha256 = 'bad'; }, /promptSha256.*SHA-256/],
    [(value) => { value.inputAssetSha256s = []; }, /inputAssetSha256s must contain unique/],
    [(value) => { value.inputAssetSha256s = [hex('dup-v'), hex('dup-v')]; }, /inputAssetSha256s must contain unique/],
    [(value) => { value.inputAssetSha256s = ['bad']; }, /inputAssetSha256s.*SHA-256/],
    [(value) => { value.explanation = 42; }, /explanation must be a string/],
    [(value) => { value.opaqueCandidateId = 'candidate-nope'; }, /opaqueCandidateId is invalid/],
    [(value) => { value.generationRunId = '../bad'; }, /generationRunId is invalid/],
    [(value) => { value.passEvidence.eiluObservation.continuityScore = 1.01; }, /PASS Eilu observation is invalid/],
    [(value) => { value.passEvidence.eiluObservation.continuityScore = Number.NaN; }, /PASS Eilu observation is invalid/],
    [(value) => { value.passEvidence.eiluObservation.anchorRetentionRatio = Number.NaN; }, /PASS Eilu observation is invalid/],
    [(value) => { value.passEvidence.eiluObservation.retainedAnchorCount = 3.5; }, /PASS Eilu observation is invalid/],
  ];
  for (const [mutate, expected] of invalidVerdictCases) {
    const verdict = structuredClone(schemaVerdict); mutate(verdict);
    assert.throws(() => createG003V5ReviewerEvidence({ context, assignment: schemaAssignment,
      assignmentBytes: schemaAssignmentBytes, verdict, now: Date.parse(assignedAt), artifactAuthority }), expected);
  }
  for (const field of ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']) {
    const verdict = structuredClone(schemaVerdict); delete verdict.requiredChildTaxonomy[field];
    assert.throws(() => createG003V5ReviewerEvidence({ context, assignment: schemaAssignment,
      assignmentBytes: schemaAssignmentBytes, verdict, now: Date.parse(assignedAt), artifactAuthority }), /requiredChildTaxonomy fields mismatch/);
  }

  for (const mutate of [
    (core) => { core.reviewContext.parentRoles = ['parent-3']; },
    (core) => { core.reviewContext.eiluBenchmarkId = 'alternate-benchmark'; },
  ]) {
    const invalid = resignTestRecord(schemaAssignment, mutate); const invalidBytes = Buffer.from(canonicalStringify(invalid));
    assert.throws(() => createG003V5ReviewerEvidence({ context, assignment: invalid, assignmentBytes: invalidBytes,
      verdict: makePassVerdict(invalid, invalidBytes), now: Date.parse(assignedAt), artifactAuthority }), /reviewContext is invalid/);
    assert.throws(() => createG003V5RejectionArtifacts({ context, assignment: invalid, assignmentBytes: invalidBytes,
      observation: makeRejectVerdict(invalid, invalidBytes), now: Date.parse(assignedAt),
      material: { candidateId: invalid.obligationId, generationRunId: invalid.generationRunId, materialSha256s: invalid.childMaterialSha256s },
      artifactAuthority, rejectionAuthority, rejectedAt: assignedAt }), /reviewContext is invalid/);
  }

  const votes = context.obligationIds.flatMap((obligationId, serial) => [
    makeVote(context, obligationId, 1, serial), makeVote(context, obligationId, 2, serial),
  ]);
  assert.equal(votes.length, 674);
  assert.ok(votes.every((vote) => vote.schemaVersion === G003_V5_VOTE_SCHEMA && vote.fresh === true));

  const coverage = buildG003V5Coverage({ context, votes, v4HistoricalArtifacts: Array.from({ length: 81 }, (_, index) => index), artifactAuthority });
  assert.equal(coverage.schemaVersion, G003_V5_COVERAGE_SCHEMA);
  assert.deepEqual(coverage.counts, G003_V5_CONDUCTOR_COUNTS);
  assert.equal(coverage.obligations.length, 337);
  assert.equal(coverage.v4HistoricalAuditCount, 81);
  assert.equal(coverage.v4HistoricalVoteCredit, 0);

  const rawVoteRoot = 'raw-votes'; await mkdir(path.join(tempRoot, rawVoteRoot));
  await Promise.all(votes.map((vote) => writeFile(path.join(tempRoot, rawVoteRoot, `vote-${vote.outputSha256}.json`), canonicalStringify(vote))));
  assert.equal((await loadPersistedVotes(rawVoteRoot, tempRoot)).length, 674);
  const hostileVotePath = path.join(tempRoot, rawVoteRoot, `vote-${votes[0].outputSha256}.json`);
  await writeFile(hostileVotePath, `${JSON.stringify(votes[0], null, 2)}\n`);
  await assert.rejects(loadPersistedVotes(rawVoteRoot, tempRoot), /exact canonical JSON bytes/);

  const duplicatedIdentity = structuredClone(votes);
  const duplicateUnsigned = { ...duplicatedIdentity[1], reviewerInstanceId: duplicatedIdentity[0].reviewerInstanceId };
  const duplicateSchemaVersion = duplicateUnsigned.schemaVersion;
  delete duplicateUnsigned.schemaVersion; delete duplicateUnsigned.outputSha256; delete duplicateUnsigned.publicSignature;
  duplicatedIdentity[1] = artifactAuthority.finalize(duplicateUnsigned, duplicateSchemaVersion);
  assert.throws(() => buildG003V5Coverage({ context, votes: duplicatedIdentity, artifactAuthority }), /lacks validated assignment\/verdict issuance provenance/);
  assert.throws(() => buildG003V5Coverage({ context, votes: [], v4HistoricalArtifacts: Array.from({ length: 81 }), artifactAuthority }), /exactly 674 fresh v5 votes/);

  const fabricatedVotes = votes.map((vote, index) => {
    const core = { ...vote, reviewerVerdictSha256: hex(`fabricated-verdict-${index}`) };
    const schemaVersion = core.schemaVersion;
    delete core.schemaVersion; delete core.outputSha256; delete core.publicSignature;
    return artifactAuthority.finalize(core, schemaVersion);
  });
  assert.throws(() => buildG003V5Coverage({ context, votes: fabricatedVotes, artifactAuthority }), /lacks validated assignment\/verdict issuance provenance/);
  const persistedFabricatedRoot = 'persisted-fabricated-votes';
  await mkdir(path.join(tempRoot, persistedFabricatedRoot));
  await Promise.all(fabricatedVotes.map((vote) => writeFile(
    path.join(tempRoot, persistedFabricatedRoot, `vote-${vote.outputSha256}.json`), canonicalStringify(vote),
  )));
  const reloadedFabricatedVotes = await loadPersistedVotes(persistedFabricatedRoot, tempRoot);
  assert.equal(reloadedFabricatedVotes.length, 674);
  assert.throws(() => buildG003V5Coverage({ context, votes: reloadedFabricatedVotes, artifactAuthority }), /lacks validated assignment\/verdict issuance provenance/);
  const fabricatedVoteRoot = 'state/fabricated-votes-forbidden';
  await assert.rejects(publishG003V5VoteRecord({ repoRoot: tempRoot, context, artifactAuthority,
    relativePath: `${fabricatedVoteRoot}/vote.json`, vote: fabricatedVotes[0] }), /exact assignment bytes and validated reviewer verdict issuance/);
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: `${fabricatedVoteRoot}/vote-generic.json`, value: votes[0] },
  ] }), /generic publication forbids assignment\/vote\/coverage records/);
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: `${fabricatedVoteRoot}/assignment-generic.json`, value: makeAssignment(context, context.obligationIds[0], 1, 12345) },
  ] }), /generic publication forbids assignment\/vote\/coverage records/);
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: `${fabricatedVoteRoot}/coverage-generic.json`, value: coverage },
  ] }), /generic publication forbids assignment\/vote\/coverage records/);
  const fabricatedCoverageCore = { ...coverage, v4HistoricalVoteCredit: 674 };
  delete fabricatedCoverageCore.schemaVersion; delete fabricatedCoverageCore.outputSha256; delete fabricatedCoverageCore.publicSignature;
  const fabricatedCoverage = artifactAuthority.finalize(fabricatedCoverageCore, G003_V5_COVERAGE_SCHEMA);
  await writeFile(path.join(tempRoot, 'persisted-fabricated-coverage.json'), canonicalStringify(fabricatedCoverage));
  const reloadedFabricatedCoverage = (await readCanonicalJson('persisted-fabricated-coverage.json', 'fabricated coverage', tempRoot)).value;
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: `${fabricatedVoteRoot}/coverage-reloaded.json`, value: reloadedFabricatedCoverage },
  ] }), /generic publication forbids assignment\/vote\/coverage records/);
  await expectMissing(path.join(tempRoot, fabricatedVoteRoot));

  const publicReview = assembleG003V5PublicReview({ context, obligationId: context.obligationIds[0], votes: votes.slice(0, 2), artifactAuthority });
  assert.equal(publicReview.review.schemaVersion, 'continuity-g003-candidate-review-v5');
  assert.equal(publicReview.publicArtifact.schemaVersion, 'continuity-g003-public-review-artifact-v5');
  const forbiddenReviewRoot = 'state/test-review-write-forbidden';
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: `${forbiddenReviewRoot}/review.json`, value: publicReview.review },
    { relativePath: `${forbiddenReviewRoot}/public.json`, value: publicReview.publicArtifact },
  ] }), /production-loaded context and pinned production artifact authority/);
  await expectMissing(path.join(tempRoot, forbiddenReviewRoot));
  const fabricatedPublicCore = { ...publicReview.publicArtifact, reviewOutputSha256: hex('fabricated-public-review') };
  delete fabricatedPublicCore.schemaVersion; delete fabricatedPublicCore.outputSha256; delete fabricatedPublicCore.publicSignature;
  const fabricatedPublic = artifactAuthority.finalize(fabricatedPublicCore, 'continuity-g003-public-review-artifact-v5');
  const persistedFabricatedPublicPath = path.join(tempRoot, 'persisted-fabricated-public.json');
  await writeFile(persistedFabricatedPublicPath, canonicalStringify(fabricatedPublic));
  const reloadedFabricatedPublic = (await readCanonicalJson('persisted-fabricated-public.json', 'fabricated public', tempRoot)).value;
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: 'state/fabricated-public.json', value: reloadedFabricatedPublic },
  ] }), /lacks purpose-issued provenance/);
  await expectMissing(path.join(tempRoot, 'state/fabricated-public.json'));

  const rejectAssignment = makeAssignment(context, context.obligationIds[0], 1, 999);
  const rejectAssignmentBytes = Buffer.from(canonicalStringify(rejectAssignment));
  const rejection = createG003V5RejectionArtifacts({ context, assignment: rejectAssignment, assignmentBytes: rejectAssignmentBytes,
    observation: makeRejectVerdict(rejectAssignment, rejectAssignmentBytes), now: Date.parse(assignedAt),
    material: { candidateId: rejectAssignment.obligationId, generationRunId: rejectAssignment.generationRunId,
      materialSha256s: rejectAssignment.childMaterialSha256s }, artifactAuthority, rejectionAuthority, rejectedAt: assignedAt });
  assert.equal(rejection.tombstone.schemaVersion, 'continuity-g003-rejection-tombstone-v2');
  assert.equal(rejection.tombstone.constituentIndexKeys.length, 2);
  assert.equal(rejection.archive.schemaVersion, 'continuity-g003-rejection-archive-v5');
  const fabricatedRejectionCore = { ...rejection.archive, rejectionObservationSha256: hex('fabricated-rejection') };
  delete fabricatedRejectionCore.schemaVersion; delete fabricatedRejectionCore.outputSha256; delete fabricatedRejectionCore.publicSignature;
  const fabricatedRejection = artifactAuthority.finalize(fabricatedRejectionCore, 'continuity-g003-rejection-archive-v5');
  await writeFile(path.join(tempRoot, 'persisted-fabricated-rejection.json'), canonicalStringify(fabricatedRejection));
  const reloadedFabricatedRejection = (await readCanonicalJson('persisted-fabricated-rejection.json', 'fabricated rejection', tempRoot)).value;
  await assert.rejects(publishG003V5Records({ repoRoot: tempRoot, context, artifactAuthority, records: [
    { relativePath: 'state/fabricated-rejection.json', value: reloadedFabricatedRejection },
  ] }), /lacks purpose-issued provenance/);
  await expectMissing(path.join(tempRoot, 'state/fabricated-rejection.json'));
  assert.throws(() => createG003V5RejectionArtifacts({ context, assignment: rejectAssignment, assignmentBytes: rejectAssignmentBytes,
    observation: makeRejectVerdict(rejectAssignment, rejectAssignmentBytes), now: Date.parse(assignedAt),
    material: { candidateId: rejectAssignment.obligationId, generationRunId: rejectAssignment.generationRunId,
      materialSha256s: [hex('parent-master'), hex('parent-runtime')] }, artifactAuthority, rejectionAuthority, rejectedAt: assignedAt }), /exact assigned child/);
  assert.equal(rejection.tombstone.publicSignature.purpose, 'continuity:g003-rejection-tombstone-v2');
  assert.equal(rejection.tombstone.publicSignature.authorityEpoch, 'continuity-authority-epoch-v1');
  const persistedTombstonePath = path.join(tempRoot, 'persisted-tombstone.json');
  const persistedTombstoneBytes = Buffer.from(canonicalStringify(rejection.tombstone));
  await writeFile(persistedTombstonePath, persistedTombstoneBytes);
  const persistedTombstone = JSON.parse(await readFile(persistedTombstonePath));
  const rejectionState = resolveEffectiveRejectionStateV5({ recordAuthority: rejectionAuthority,
    tombstones: [{ value: persistedTombstone, fileSha256: sha256Bytes(persistedTombstoneBytes) }] });
  assert.equal(rejectionState.effectiveTombstones.length, 1);
  assert.equal(rejectionState.effectiveMaterialKeys[0], rejection.tombstone.tombstoneKey);

  const incompleteState = 'state/incomplete';
  await assert.rejects(publishG003V5Coverage({ repoRoot: tempRoot, stateRoot: incompleteState, context,
    votes: votes.slice(0, -1), artifactAuthority }), /exactly 674 fresh v5 votes/);
  await expectMissing(path.join(tempRoot, incompleteState));

  const forbiddenState = 'state/test-only-forbidden';
  let externalWriteCallbacks = 0;
  await assert.rejects(publishG003V5Coverage({ repoRoot: tempRoot, stateRoot: forbiddenState, context, votes,
    v4HistoricalArtifacts: Array.from({ length: 81 }), artifactAuthority,
    onWrite: () => { externalWriteCallbacks += 1; } }), /production-loaded context and pinned production artifact authority/);
  assert.equal(externalWriteCallbacks, 0);
  await expectMissing(path.join(tempRoot, forbiddenState));
  console.log('G003-v5 conductor self-test passed: 167 queue + 170 ordinary = 337 obligations, 674 fresh votes, typed rejection, and fail-before-write coverage.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
