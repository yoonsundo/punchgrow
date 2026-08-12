#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { G003_FINALIZING_STATE, G003_TERMINAL_STATE, atomicPublishDirectory, assertAcceptedRecordBinding, assertBaselineSnapshotShape, assertCurrentGeneratedParentBinding, assertExactCoverageIds, assertG003ActiveBaseline, assertG003MutationOpen, assertNoMatchingRejectionTombstone, assertPublicParentEvidence, assertRejectionSource, assertReviewAuthorityTuple, assertTombstoneRejectionBinding, attestVote, createAtomicPublishTransaction, issueAssignment, publishArchiveThenTombstone, rejectionArchiveBinding, resolveVerifiedRecordChains, verifyRejectionArchivePayloads, withExclusiveG003Operation } from './conduct-g003-reviews.mjs';
import { sha256Bytes } from './lib/continuity-assignment/canonical-json.mjs';
import { assertGenerationRunId, validateCandidateObservationFixture, validateCandidateReview } from './prepare-continuity-candidate-review.mjs';
import { stageCandidate } from './stage-continuity-candidate.mjs';
import { assertCoverageCurrentTips, assertCoverageIdentity, assertCurrentParentArtifactBinding, assertExactPackInventory, assertPackComposition, assertReviewPolicyCoverage, assertTerminalTipBinding } from './verify-biological-continuity-v3-pack.mjs';
import { G002_V2_EFFECTIVE_ROOT_IDS, G002_V2_TARGET_SOURCE } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { G003_AUTHORITY, G003_COUNTS, G003_PROTOCOL_AUTHORITY_SHA256 } from './lib/g003-v4-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedBaseline = G003_AUTHORITY.publicManifestOutputSha256;
const conductorModuleUrl = new URL('./conduct-g003-reviews.mjs', import.meta.url).href;
const transitionIntegrityModuleUrl = new URL('./lib/g003-transition-integrity.mjs', import.meta.url).href;

function spawnModuleChild(source) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return { child, output };
}

async function waitForChildOutput(harness, expected, timeoutMs = 10_000) {
  if (harness.output.stdout.includes(expected)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child output timeout: ${harness.output.stderr}`)); }, timeoutMs);
    const check = () => { if (harness.output.stdout.includes(expected)) { cleanup(); resolve(); } };
    const exited = (code, signal) => { cleanup(); reject(new Error(`child exited before ${expected}: code=${code} signal=${signal} stderr=${harness.output.stderr}`)); };
    const errored = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer); harness.child.stdout.off('data', check); harness.child.off('exit', exited); harness.child.off('error', errored);
    };
    harness.child.stdout.on('data', check); harness.child.once('exit', exited); harness.child.once('error', errored);
  });
}

async function waitForChildExit(harness, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.child.kill('SIGKILL'); reject(new Error(`child exit timeout: ${harness.output.stderr}`)); }, timeoutMs);
    harness.child.once('error', (error) => { clearTimeout(timer); reject(error); });
    harness.child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ...harness.output }); });
  });
}

function kernelLockChildSource({ repoRoot, label, markerPath = null, hold = false, throwMessage = null }) {
  return `
    import { writeFile } from 'node:fs/promises';
    import { withExclusiveG003Operation } from ${JSON.stringify(conductorModuleUrl)};
    try {
      await withExclusiveG003Operation(${JSON.stringify(label)}, async () => {
        ${markerPath ? `await writeFile(${JSON.stringify(markerPath)}, 'executed');` : ''}
        process.stdout.write('CALLBACK\\n');
        ${throwMessage ? `throw new Error(${JSON.stringify(throwMessage)});` : ''}
        ${hold ? 'await new Promise(() => {});' : ''}
      }, { repoRoot: ${JSON.stringify(repoRoot)} });
      process.stdout.write('DONE\\n');
    } catch (error) {
      process.stdout.write('BLOCKED:' + (error.code ?? 'NO_CODE') + ':' + (error.cause?.code ?? 'NO_CAUSE') + ':' + error.message + '\\n');
    }
  `;
}

function transitionLockHolderChildSource({ repoRoot }) {
  return `
    import { acquireG003TransitionLock } from ${JSON.stringify(transitionIntegrityModuleUrl)};
    try {
      await acquireG003TransitionLock(${JSON.stringify(repoRoot)});
      process.stdout.write('LOCKED\\n');
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    } catch (error) {
      process.stdout.write('BLOCKED:' + (error.code ?? 'NO_CODE') + ':' + (error.cause?.code ?? 'NO_CAUSE') + ':' + error.message + '\\n');
    }
  `;
}

function schemaPointer(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference: ${reference}`);
  return reference.slice(2).split('/').reduce((value, token) => value[token.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function schemaTypeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateSchemaInstance(root, schema, value, label = '$') {
  if (schema.$ref) return validateSchemaInstance(root, schemaPointer(root, schema.$ref), value, label);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => { try { validateSchemaInstance(root, branch, value, label); return true; } catch { return false; } });
    if (matches.length !== 1) throw new Error(`${label}: oneOf matched ${matches.length}`);
  }
  if (schema.anyOf && !schema.anyOf.some((branch) => { try { validateSchemaInstance(root, branch, value, label); return true; } catch { return false; } })) throw new Error(`${label}: anyOf did not match`);
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) throw new Error(`${label}: const mismatch`);
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) throw new Error(`${label}: enum mismatch`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(type, value))) throw new Error(`${label}: type mismatch`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${label}: minLength`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) throw new Error(`${label}: pattern`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${label}: minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label}: maxItems`);
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) throw new Error(`${label}: uniqueItems`);
    if (schema.items) value.forEach((entry, index) => validateSchemaInstance(root, schema.items, entry, `${label}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) if (!(required in value)) throw new Error(`${label}: missing ${required}`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) throw new Error(`${label}: extra ${key}`);
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) if (key in value) validateSchemaInstance(root, childSchema, value[key], `${label}.${key}`);
  }
  return true;
}

// Small synthetic coverage fixture: omissions, duplicates, and extras all fail.
assert.doesNotThrow(() => assertExactCoverageIds(['a', 'b'], ['b', 'a'], 'fixture'));
assert.throws(() => assertExactCoverageIds(['a', 'b'], ['a'], 'fixture'), /exact locked ID set/);
assert.throws(() => assertExactCoverageIds(['a', 'b'], ['a', 'a'], 'fixture'), /exact locked ID set/);
assert.throws(() => assertExactCoverageIds(['a', 'b'], ['a', 'c'], 'fixture'), /exact locked ID set/);

assert.doesNotThrow(() => assertRejectionSource('assets/creatures/biological-continuity-v3/candidates/run/PG-001/master.png'));
assert.throws(() => assertRejectionSource('assets/creatures/generated/PG-001.png'), /outside isolated candidate evidence/);
assert.throws(() => assertRejectionSource('config/creature-assets.json'), /outside isolated candidate evidence/);
assert.throws(() => assertRejectionSource('assets/creatures/biological-continuity-v3/candidates/../../generated/PG-001.png'), /non-canonical/);
assert.throws(() => assertRejectionSource('.omx/evidence/continuity-candidates/../../../config/creature-assets.json'), /non-canonical/);

const tinyPack = [
  { id: 'PG-001', sourceKind: 'g003-approved-candidate' },
  { id: 'PG-002', sourceKind: 'g003-approved-candidate' },
  { id: 'PG-003', sourceKind: 'retained-cute-redesign-v2' },
];
assert.doesNotThrow(() => assertPackComposition(tinyPack, { total: 3, replacements: 2, retained: 1 }));
assert.throws(() => assertPackComposition(tinyPack.slice(0, 2), { total: 3, replacements: 2, retained: 1 }), /pack composition/);
assert.doesNotThrow(() => assertExactPackInventory(['PG-001.png'], ['PG-001.png'], ['PG-001.png']));
assert.throws(() => assertExactPackInventory(['PG-001.png'], ['PG-001.png', '.DS_Store'], ['PG-001.png']), /unmanifested/);
const lockedCoverageIdentity = {
  queueCandidates: [{ candidateId: 'g003-candidate:PG-001', slotId: 'PG-001' }],
  edgeCandidates: [{ edgeId: 'g003-edge:PG-001:PG-061', parentId: 'PG-001', childId: 'PG-061' }],
  eiluBenchmark: { pixelBindings: [{ pgId: 'PG-001', masterSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) }] },
};
assert.doesNotThrow(() => assertCoverageIdentity(structuredClone(lockedCoverageIdentity), lockedCoverageIdentity));
const swappedCoverageSlot = structuredClone(lockedCoverageIdentity); swappedCoverageSlot.queueCandidates[0].slotId = 'PG-002';
assert.throws(() => assertCoverageIdentity(swappedCoverageSlot, lockedCoverageIdentity), /signed G002 assignment/);

const baseline = JSON.parse(await readFile(path.join(ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v2/public-evidence-manifest.json')));
assert.equal(baseline.outputSha256, expectedBaseline);
assert.equal((await assertG003ActiveBaseline()).signedPublicEvidence.outputSha256, expectedBaseline);
const baselineSnapshot = JSON.parse(await readFile(path.join(ROOT, 'production/reports/biological-continuity-v3/g003-evidence-v3/active-baseline.json')));
assert.doesNotThrow(() => assertBaselineSnapshotShape(baselineSnapshot));
const reorderedBaseline = structuredClone(baselineSnapshot); reorderedBaseline.protectedFiles.reverse();
assert.throws(() => assertBaselineSnapshotShape(reorderedBaseline), /baseline shape/);
const substitutedBaseline = structuredClone(baselineSnapshot); substitutedBaseline.protectedFiles[0].path = 'config/other.json';
assert.throws(() => assertBaselineSnapshotShape(substitutedBaseline), /baseline shape/);

const observation = { childTaxonomy: {}, parentObservations: [], requiredAnchorEvidence: [], eiluComparison: {} };
const raw = { assignmentId: 'assignment-1', reviewerInstanceId: 'reviewer-1', agentTaskId: 'agent-task-1', voterReviewRunId: 'review-run-1', passNumber: 1, observation, confidence: 0.97, observedAt: '2026-08-11T00:00:00.000Z' };
const rawSha = (await import('./lib/continuity-assignment/canonical-json.mjs')).sha256Canonical(raw);
const assignment = { assignmentId: raw.assignmentId, reviewerInstanceId: raw.reviewerInstanceId, agentTaskId: raw.agentTaskId, voterReviewRunId: raw.voterReviewRunId, passNumber: 1 };
const run = { ...assignment, assignmentManifestSha256: 'a'.repeat(64), rawObservationSha256: rawSha };
const vote = { ...assignment, assignmentManifestSha256: 'a'.repeat(64), reviewerRunAttestationSha256: 'b'.repeat(64), rawObservationSha256: rawSha, observation, confidence: 0.97 };
assert.doesNotThrow(() => assertReviewAuthorityTuple(vote, assignment, run, raw, { assignmentSha256: 'a'.repeat(64), runSha256: 'b'.repeat(64) }));
assert.throws(() => assertReviewAuthorityTuple({ ...vote, reviewerInstanceId: 'renamed-reviewer' }, assignment, run, raw, { assignmentSha256: 'a'.repeat(64), runSha256: 'b'.repeat(64) }), /borrowed or renamed/);
assert.throws(() => assertReviewAuthorityTuple(vote, null, run, raw, { assignmentSha256: 'a'.repeat(64), runSha256: 'b'.repeat(64) }), /lacks exact assignment/);

const signedArtifact = { candidateId: 'g003-candidate:PG-001', edgeId: null, childPixels: [{ surface: 'master', path: 'signed/master', sha256: '1'.repeat(64) }, { surface: 'runtime', path: 'signed/runtime', sha256: '2'.repeat(64) }] };
const artifactRawSha256 = '3'.repeat(64);
const acceptedRecord = { requirementKind: 'queue', requirementId: signedArtifact.candidateId, artifactSha256: artifactRawSha256, reviewSha256: '4'.repeat(64), childPixels: signedArtifact.childPixels };
assert.doesNotThrow(() => assertAcceptedRecordBinding(acceptedRecord, signedArtifact, artifactRawSha256, '4'.repeat(64)));
const pixelSwap = structuredClone(acceptedRecord); pixelSwap.childPixels[0] = { surface: 'master', path: 'mutable/swap', sha256: '9'.repeat(64) };
assert.throws(() => assertAcceptedRecordBinding(pixelSwap, signedArtifact, artifactRawSha256, '4'.repeat(64)), /child pixel binding mismatch/);
const rootRecord = { requirementId: 'g003-candidate:PG-001', generationRunId: 'run-1', artifactSha256: '1'.repeat(64), reviewSha256: '2'.repeat(64), supersession: null };
const successorRecord = { requirementId: rootRecord.requirementId, generationRunId: 'run-2', artifactSha256: '3'.repeat(64), reviewSha256: '4'.repeat(64), supersession: { priorArtifactSha256: rootRecord.artifactSha256, value: { requirementId: rootRecord.requirementId, newGenerationRunId: 'run-2', priorArtifactSha256: rootRecord.artifactSha256, priorReviewSha256: rootRecord.reviewSha256, issuedAt: '2026-08-11T00:00:00.000Z' } } };
assert.equal(resolveVerifiedRecordChains([successorRecord, rootRecord])[0].artifactSha256, successorRecord.artifactSha256, 'old record rollback must not become current');
const splicedSuccessor = structuredClone(successorRecord); splicedSuccessor.supersession.value.priorReviewSha256 = '9'.repeat(64);
assert.throws(() => resolveVerifiedRecordChains([rootRecord, splicedSuccessor]), /invalid supersession chain binding/);
assert.throws(() => resolveVerifiedRecordChains([{ ...rootRecord, generationRunId: '../escape' }]), /must match/);
const parentRecord = { reviewSha256: '5'.repeat(64) }; const parentArtifact = { review: { sha256: parentRecord.reviewSha256 }, childPixels: [{ sha256: '6'.repeat(64) }, { sha256: '7'.repeat(64) }] };
const publishedParent = { approvedParentCandidateId: 'g003-candidate:PG-001', approvedParentReviewSha256: parentArtifact.review.sha256, pixelSha256s: parentArtifact.childPixels.map((pixel) => pixel.sha256) };
assert.doesNotThrow(() => assertCurrentGeneratedParentBinding('edge-1', 'PG-001', publishedParent, parentRecord, parentArtifact));
assert.throws(() => assertCurrentGeneratedParentBinding('edge-1', 'PG-001', { ...publishedParent, approvedParentReviewSha256: '8'.repeat(64) }, parentRecord, parentArtifact), /current signed queue artifact/);

const coverageRequirements = [{ id: rootRecord.requirementId, evidence: { reviewArtifactPath: 'old/artifact.json', reviewArtifactSha256: rootRecord.artifactSha256 } }];
assert.doesNotThrow(() => assertCoverageCurrentTips(coverageRequirements, [{ ...rootRecord, artifactPath: 'old/artifact.json' }]));
assert.throws(() => assertCoverageCurrentTips(coverageRequirements, [{ ...successorRecord, artifactPath: 'new/artifact.json' }]), /stale\/non-tip/);
const supersededParentArtifact = { review: { sha256: '8'.repeat(64) }, childPixels: [{ sha256: '9'.repeat(64) }, { sha256: 'a'.repeat(64) }] };
assert.throws(() => assertCurrentParentArtifactBinding('g003-candidate:PG-065', 'PG-001', publishedParent, supersededParentArtifact), /current signed parent chain tip/);
const terminalTipSha = 'b'.repeat(64); const finalizingSha = 'c'.repeat(64); const packLockSha = 'd'.repeat(64);
const terminalCompletedAt = '2026-08-11T00:00:00.000Z';
const terminalFinalizing = { acceptedTipSetSha256: terminalTipSha, terminalCompletedAt };
const terminalLock = { finalization: { statePath: G003_FINALIZING_STATE, stateSha256: finalizingSha, acceptedTipSetSha256: terminalTipSha, acceptedTipCount: G003_COUNTS.obligations, terminalStatePath: G003_TERMINAL_STATE } };
const terminalState = { state: 'TERMINAL', finalizingState: { path: G003_FINALIZING_STATE, sha256: finalizingSha }, packLock: { path: 'production/manifests/creature-asset-packs/biological-continuity-v3.lock.json', sha256: packLockSha }, acceptedTipSetSha256: terminalTipSha, acceptedTipCount: G003_COUNTS.obligations, completedAt: terminalCompletedAt };
assert.doesNotThrow(() => assertTerminalTipBinding({ lock: terminalLock, terminal: terminalState, finalizing: terminalFinalizing, finalizingSha256: finalizingSha, lockSha256: packLockSha, currentTipSetSha256: terminalTipSha }));
assert.throws(() => assertTerminalTipBinding({ lock: terminalLock, terminal: terminalState, finalizing: terminalFinalizing, finalizingSha256: finalizingSha, lockSha256: packLockSha, currentTipSetSha256: 'e'.repeat(64) }), /exact current accepted tip set/);
assert.throws(() => assertTerminalTipBinding({ lock: terminalLock, terminal: { ...terminalState, completedAt: '2026-08-11T00:00:01.000Z' }, finalizing: terminalFinalizing, finalizingSha256: finalizingSha, lockSha256: packLockSha, currentTipSetSha256: terminalTipSha }), /exact current accepted tip set/);

for (const validRunId of ['run-1', 'G003.wave_0', `a${'b'.repeat(127)}`]) assert.equal(assertGenerationRunId(validRunId), validRunId);
for (const hostileRunId of ['../escape', 'run/child', 'run\\child', '/absolute', '.hidden', '', `a${'b'.repeat(128)}`]) assert.throws(() => assertGenerationRunId(hostileRunId), /must match/);

const publicParentBinding = {
  parents: [{ sourceSlotId: 'PG-001', surfaces: { master: { sha256: '1'.repeat(64) }, runtime: { sha256: '2'.repeat(64) } } }],
  reviewContract: { reviewPolicy: { assessmentMode: 'same-creature-continuity' }, anchorSets: [{ role: 'parent-1', approvedParentCandidateId: 'g003-candidate:PG-001', approvedParentReviewSha256: '3'.repeat(64), anchors: [
    { anchorKey: 'parent-1-aaaaaaaaaaaaaaaaaaaa:body', anchorId: 'body', description: 'same body silhouette' },
    { anchorKey: 'parent-1-aaaaaaaaaaaaaaaaaaaa:face', anchorId: 'face', description: 'same face geometry' },
  ] }] },
};
const validPublicParentEvidence = [{
  evidenceRole: 'continuity-parent', parentRole: 'parent-1', parentId: 'PG-001', pixelSha256s: ['1'.repeat(64), '2'.repeat(64)],
  approvedParentCandidateId: 'g003-candidate:PG-001', approvedParentReviewSha256: '3'.repeat(64),
  anchors: publicParentBinding.reviewContract.anchorSets[0].anchors.map((anchor) => ({
    anchorKey: `PG-001:${anchor.anchorId}`, parentRole: 'parent-1', parentId: 'PG-001', anchorId: anchor.anchorId,
    description: anchor.description, sourceReviewId: 'review-source-1', sourceConfidence: 0.99,
    resolutionState: 'RESOLVED_AUTHENTICATED_PIXELS', dependencyCandidateId: 'g003-candidate:PG-001',
  })),
}];
assert.doesNotThrow(() => assertPublicParentEvidence(validPublicParentEvidence, publicParentBinding));
assert.throws(() => assertPublicParentEvidence([{ ...validPublicParentEvidence[0], unexpected: true }], publicParentBinding), /fields mismatch/);
assert.throws(() => assertPublicParentEvidence([{ ...validPublicParentEvidence[0], pixelSha256s: ['1'.repeat(64)] }], publicParentBinding), /exact master\/runtime/);
assert.throws(() => assertPublicParentEvidence([{ ...validPublicParentEvidence[0], approvedParentReviewSha256: null }], publicParentBinding), /approved-parent bindings/);
const duplicateBodyMissingFace = structuredClone(validPublicParentEvidence);
duplicateBodyMissingFace[0].anchors[1] = { ...duplicateBodyMissingFace[0].anchors[0], sourceReviewId: 'review-source-2' };
assert.throws(() => assertPublicParentEvidence(duplicateBodyMissingFace, publicParentBinding), /exactly and uniquely cover/);
const canonicalParentBinding = {
  parents: [{ sourceSlotId: 'PG-016', surfaces: { master: { sha256: '8'.repeat(64) }, runtime: { sha256: '9'.repeat(64) } } }],
  reviewContract: { reviewPolicy: { assessmentMode: 'canonical-root-replacement' }, anchorSets: [{ role: 'child', anchors: [{ anchorId: 'signed-anchor' }] }] },
};
const canonicalParentEvidence = [{
  evidenceRole: 'historical-reference-only', parentRole: 'parent-1', parentId: 'PG-016', pixelSha256s: ['8'.repeat(64), '9'.repeat(64)],
  approvedParentCandidateId: null, approvedParentReviewSha256: null, anchors: [],
}];
assert.doesNotThrow(() => assertPublicParentEvidence(canonicalParentEvidence, canonicalParentBinding));
assert.throws(() => assertPublicParentEvidence([{ ...canonicalParentEvidence[0], evidenceRole: 'continuity-parent' }], canonicalParentBinding), /evidence role/);
assert.throws(() => assertPublicParentEvidence([{ ...canonicalParentEvidence[0], anchors: validPublicParentEvidence[0].anchors }], canonicalParentBinding), /anchors differ|historical reference/);

const canonicalRootIds = G002_V2_EFFECTIVE_ROOT_IDS;
const canonicalPolicy = {
  assessmentMode: 'canonical-root-replacement', continuitySubject: 'signed-canonical-root-contract', taxonomyTargetSource: G002_V2_TARGET_SOURCE,
  requiredChildTaxonomy: { biologicalClass: 'mammalia', speciesFamily: 'family', coreAnatomy: 'anatomy', locomotionPlan: 'locomotion' },
  canonicalContractOutputSha256: G003_AUTHORITY.successorOutputSha256, canonicalEffectiveAuthoritySha256: G003_AUTHORITY.effectiveAuthoritySha256, historicalParentPixelsOnly: true,
  visibilityPolicy: {
    surfaceRequirement: 'master-and-runtime-independently-satisfy-canonical-tuple-and-all-three-anchors', appendageCountingRule: 'count-visible-appendages-only',
    ambiguityRule: 'hidden-merged-or-double-readable-is-block', preservationRule: 'preserve-anchor-shape-relative-placement-and-color-role',
  },
  clarificationRequirements: ['clarification requirement one', 'clarification requirement two'],
};
const strictPolicy = {
  assessmentMode: 'same-creature-continuity', continuitySubject: 'prior-parent-pixels', taxonomyTargetSource: 'authenticated-stage-1-root-pixels',
  requiredChildTaxonomy: { biologicalClass: 'mammalia', speciesFamily: 'family', coreAnatomy: 'anatomy', locomotionPlan: 'locomotion' },
  canonicalContractOutputSha256: null, canonicalEffectiveAuthoritySha256: null, historicalParentPixelsOnly: false, visibilityPolicy: null, clarificationRequirements: [],
};
const policyRequirements = canonicalRootIds.map((id) => ({ kind: 'queue', id: `g003-candidate:${id}`, evidence: { reviewPolicy: canonicalPolicy } }));
policyRequirements.push({ kind: 'edge', id: 'g003-edge:PG-016:PG-076', evidence: { reviewPolicy: strictPolicy } });
const policyArtifacts = new Map(policyRequirements.map((requirement) => [requirement.id, {
  reviewPolicy: requirement.evidence.reviewPolicy,
  parentEvidence: [{ evidenceRole: requirement.kind === 'queue' ? 'historical-reference-only' : 'continuity-parent' }],
}]));
assert.doesNotThrow(() => assertReviewPolicyCoverage(policyRequirements, policyArtifacts));
const weakenedEdgeArtifacts = new Map(policyArtifacts); weakenedEdgeArtifacts.set('g003-edge:PG-016:PG-076', { reviewPolicy: canonicalPolicy, parentEvidence: [{ evidenceRole: 'historical-reference-only' }] });
assert.throws(() => assertReviewPolicyCoverage(policyRequirements, weakenedEdgeArtifacts), /differs|invalid canonical-root|weakened/);
const missingCanonicalPolicy = policyRequirements.slice(1);
assert.throws(() => assertReviewPolicyCoverage(missingCanonicalPolicy, policyArtifacts), /canonical-root replacement/);
const canonicalAnchorIds = ['anchor-a', 'anchor-b', 'anchor-c'];
const canonicalBindingFixture = {
  parents: [{ opaqueInputId: 'parent-1-aaaaaaaaaaaaaaaaaaaa' }],
  reviewContract: {
    reviewPolicy: canonicalPolicy,
    anchorSets: [{ opaqueInputId: 'child-aaaaaaaaaaaaaaaaaaaa', role: 'child', anchors: canonicalAnchorIds.map((anchorId) => ({ anchorKey: `child-aaaaaaaaaaaaaaaaaaaa:${anchorId}`, anchorId, description: `required ${anchorId}` })) }],
    eiluBenchmark: {
      benchmarkId: 'eilu-comparative-visual-v1', minimumConfidence: 0.96, minimumRetainedAnchorCount: 3, minimumAnchorRetentionRatio: 1,
      pixelBindings: [1, 2, 3].map((index) => ({ opaqueBenchmarkId: `benchmark-${String(index).repeat(20)}`, masterSha256: String(index).repeat(64), runtimeSha256: String(index + 3).repeat(64) })),
    },
  },
};
const canonicalSurface = (surface) => ({
  surface, matchesRequiredTaxonomy: 'yes', visibleAppendageCountsComply: true, hiddenMergedOrDoubleReadableAmbiguity: false,
  satisfiedClarificationRequirements: [...canonicalPolicy.clarificationRequirements],
  anchorAssessments: canonicalAnchorIds.map((anchorId) => ({ anchorId, shapeRelativePlacementAndColorRolePreserved: 'yes', observation: `${surface} visibly preserves ${anchorId}` })),
});
const canonicalObservation = {
  assessmentMode: 'canonical-root-replacement', childTaxonomy: canonicalPolicy.requiredChildTaxonomy, parentObservations: [],
  canonicalAssessment: { matchesRequiredCanonicalTarget: 'yes', historicalParentComparisonRequired: false, surfaceAssessments: [canonicalSurface('master'), canonicalSurface('runtime')] },
  requiredAnchorEvidence: [{ opaqueInputId: 'child-aaaaaaaaaaaaaaaaaaaa', anchors: canonicalAnchorIds.map((anchorId) => ({ anchorKey: `child-aaaaaaaaaaaaaaaaaaaa:${anchorId}`, anchorId, requiredDescription: `required ${anchorId}`, observation: `visible ${anchorId}` })) }],
  eiluComparison: {
    benchmarkId: 'eilu-comparative-visual-v1', sameCreatureGrownUp: 'yes', candidateContinuityScore: 0.99, retainedAnchorCount: 3, anchorRetentionRatio: 1,
    stageObservations: canonicalBindingFixture.reviewContract.eiluBenchmark.pixelBindings.map((entry) => ({ ...entry, continuityScore: 0.99, observation: 'positive control continuity retained' })),
  },
};
assert.doesNotThrow(() => validateCandidateObservationFixture(canonicalObservation, 0.99, canonicalBindingFixture));
const missingRuntime = structuredClone(canonicalObservation); missingRuntime.canonicalAssessment.surfaceAssessments.pop();
assert.throws(() => validateCandidateObservationFixture(missingRuntime, 0.99, canonicalBindingFixture), /master and runtime/);
const missingAnchor = structuredClone(canonicalObservation); missingAnchor.canonicalAssessment.surfaceAssessments[1].anchorAssessments.pop();
assert.throws(() => validateCandidateObservationFixture(missingAnchor, 0.99, canonicalBindingFixture), /visibility\/clarification/);
const missingClarification = structuredClone(canonicalObservation); missingClarification.canonicalAssessment.surfaceAssessments[0].satisfiedClarificationRequirements.pop();
assert.throws(() => validateCandidateObservationFixture(missingClarification, 0.99, canonicalBindingFixture), /visibility\/clarification/);
const badAppendageCount = structuredClone(canonicalObservation); badAppendageCount.canonicalAssessment.surfaceAssessments[0].visibleAppendageCountsComply = false;
assert.throws(() => validateCandidateObservationFixture(badAppendageCount, 0.99, canonicalBindingFixture), /visibility\/clarification/);
const ambiguousAppendage = structuredClone(canonicalObservation); ambiguousAppendage.canonicalAssessment.surfaceAssessments[1].hiddenMergedOrDoubleReadableAmbiguity = true;
assert.throws(() => validateCandidateObservationFixture(ambiguousAppendage, 0.99, canonicalBindingFixture), /visibility\/clarification/);
const taxonomyForgery = structuredClone(canonicalObservation); taxonomyForgery.childTaxonomy.speciesFamily = 'forged-family';
assert.throws(() => validateCandidateObservationFixture(taxonomyForgery, 0.99, canonicalBindingFixture), /signed review policy/);

await assert.rejects(() => validateCandidateReview({
  schemaVersion: 'continuity-candidate-review-v2', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, opaqueCandidateId: 'candidate-' + 'a'.repeat(24), generationRunId: 'old-v1', reviewKind: 'asset-reuse',
  packageManifestSha256: 'a'.repeat(64), materialBindingSha256: 'b'.repeat(64), inputAllowlistSha256: 'c'.repeat(64), promptSha256: 'd'.repeat(64), votes: [],
}, { packageRelative: '.omx/evidence/continuity-candidates/old-v1', conductorKey: Buffer.alloc(32, 1) }), /review protocol v4/);
const authorityNegativeBase = path.join(ROOT, '.omx/evidence/continuity-candidates'); await mkdir(authorityNegativeBase, { recursive: true });
const authorityNegativeRoot = await mkdtemp(path.join(authorityNegativeBase, 'authority-negative-'));
try {
  const packageRelative = path.relative(ROOT, authorityNegativeRoot).split(path.sep).join('/');
  const identityRelative = `${packageRelative}/identity.json`;
  const malformedBinding = {
    schemaVersion: 'continuity-candidate-material-binding-v2', candidateId: 'g003-candidate:PG-005', opaqueCandidateId: 'candidate-' + 'a'.repeat(24),
    generationRunId: 'authority-negative', reviewKind: 'asset-reuse', descriptorSha256: 'a'.repeat(64), packageManifestSha256: 'b'.repeat(64),
    allowlistSha256: 'c'.repeat(64), promptSha256: 'd'.repeat(64), child: {}, parents: [], reviewContract: {}, conductorHmacSha256: '0'.repeat(64),
  };
  await writeFile(path.join(authorityNegativeRoot, 'private-binding.json'), JSON.stringify(malformedBinding));
  await writeFile(path.join(authorityNegativeRoot, 'identity.json'), JSON.stringify({
    reviewerInstanceId: 'reviewer-negative', agentTaskId: 'agent-task-negative', voterReviewRunId: 'review-run-negative', passNumber: 1, assignedAt: '2026-08-11T00:00:00.000Z',
  }));
  await assert.rejects(
    () => issueAssignment(identityRelative, packageRelative, Buffer.alloc(32, 7)),
    /hard-pinned G003 public authority and commitment/,
  );
  const rawRelative = `${packageRelative}/invalid-raw.json`;
  await writeFile(path.join(authorityNegativeRoot, 'invalid-raw.json'), JSON.stringify({
    assignmentId: 'g003-assignment-negative', reviewerInstanceId: 'reviewer-negative', agentTaskId: 'agent-task-negative', voterReviewRunId: 'review-run-negative',
    passNumber: 1, observation: canonicalObservation, confidence: 0.99, observedAt: '2026-08-11T00:00:00.000Z',
  }));
  await assert.rejects(
    () => attestVote(rawRelative, `${packageRelative}/review-authority/nonexistent-assignment.json`, packageRelative, Buffer.alloc(32, 7)),
    /hard-pinned G003 public authority and commitment/,
  );
  await assert.rejects(access(path.join(authorityNegativeRoot, 'review-authority/assignment-pass-1.json')));
  await assert.rejects(access(path.join(authorityNegativeRoot, 'review-authority/run-attestation-pass-1.json')));
  await assert.rejects(access(path.join(authorityNegativeRoot, 'review-authority/raw-observation-pass-1.json')));
  await assert.rejects(access(path.join(authorityNegativeRoot, 'review-authority/vote-pass-1.json')));
} finally {
  await rm(authorityNegativeRoot, { recursive: true, force: true });
}
const publicReviewSchema = JSON.parse(await readFile(path.join(ROOT, 'production/contracts/g003-public-review-artifact-v4.schema.json')));
assert.doesNotThrow(() => validateSchemaInstance(publicReviewSchema, publicReviewSchema.$defs.parentEvidence, validPublicParentEvidence[0]));
assert.throws(() => validateSchemaInstance(publicReviewSchema, publicReviewSchema.$defs.parentEvidence, { ...validPublicParentEvidence[0], unexpected: true }), /extra unexpected/);
assert.throws(() => validateSchemaInstance(publicReviewSchema, publicReviewSchema.$defs.parentEvidence, { ...validPublicParentEvidence[0], pixelSha256s: ['1'.repeat(64)] }), /minItems/);
assert.throws(() => validateSchemaInstance(publicReviewSchema, publicReviewSchema.$defs.parentEvidence, { ...validPublicParentEvidence[0], approvedParentReviewSha256: null }), /oneOf/);
assert.throws(() => validateSchemaInstance(publicReviewSchema, publicReviewSchema.$defs.parentEvidence, { ...validPublicParentEvidence[0], anchors: [{ ...validPublicParentEvidence[0].anchors[0], extra: true }] }), /extra extra/);
assert.throws(() => validateSchemaInstance(publicReviewSchema, publicReviewSchema.$defs.parentEvidence, { ...validPublicParentEvidence[0], anchors: [validPublicParentEvidence[0].anchors[0], validPublicParentEvidence[0].anchors[0]] }), /uniqueItems/);
for (const schemaPath of [
  'production/contracts/continuity-candidate-provenance-v1.schema.json',
  'production/contracts/continuity-candidate-review-v4.schema.json',
  'production/contracts/continuity-rejected-candidate-v1.schema.json',
  'production/contracts/g003-public-review-artifact-v4.schema.json',
  'production/contracts/g003-rejection-tombstone-v1.schema.json',
  'production/contracts/g003-reviewer-authority-v1.schema.json',
]) {
  const schema = JSON.parse(await readFile(path.join(ROOT, schemaPath)));
  const generationRunSchema = schema.$defs?.generationRunId ?? schema.properties?.generationRunId;
  assert.doesNotThrow(() => validateSchemaInstance(schema, generationRunSchema, 'g003-safe.run-1'));
  assert.throws(() => validateSchemaInstance(schema, generationRunSchema, '../escape'), /pattern/);
}

const materialSha256s = ['b'.repeat(64), 'c'.repeat(64)];
const rejectionRequest = { candidateId: 'g003-candidate:PG-001', generationRunId: 'run-1', materialSha256s, reasonCodes: ['visual-fail'], associatedReviewSha256s: ['a'.repeat(64)], rejectedAt: '2026-08-11T00:00:00.000Z', nonce: 'nonce-0000000001' };
const rejectionFiles = [{ path: 'candidate/master.png', sha256: materialSha256s[0] }, { path: 'candidate/runtime.png', sha256: materialSha256s[1] }];
const rejectionBinding = rejectionArchiveBinding(rejectionRequest, rejectionFiles);
assert.notEqual(JSON.stringify(rejectionBinding), JSON.stringify(rejectionArchiveBinding({ ...rejectionRequest, associatedReviewSha256s: ['c'.repeat(64)] }, rejectionFiles)));
assert.notEqual(JSON.stringify(rejectionBinding), JSON.stringify(rejectionArchiveBinding({ ...rejectionRequest, rejectedAt: '2026-08-11T00:00:01.000Z' }, rejectionFiles)));
const syntheticRejectionBytes = Buffer.from('{"synthetic":"rejection"}');
const syntheticRejection = { archiveId: 'd'.repeat(64), candidateId: rejectionRequest.candidateId, generationRunId: rejectionRequest.generationRunId, rejectedAt: rejectionRequest.rejectedAt, materialSha256s };
const syntheticTombstone = { rejectionArchiveId: syntheticRejection.archiveId, candidateId: syntheticRejection.candidateId, generationRunId: syntheticRejection.generationRunId, rejectedAt: syntheticRejection.rejectedAt, materialSha256s, rejectionSha256: sha256Bytes(syntheticRejectionBytes) };
assert.doesNotThrow(() => assertTombstoneRejectionBinding(syntheticTombstone, syntheticRejection, syntheticRejectionBytes));
assert.throws(() => assertTombstoneRejectionBinding(syntheticTombstone, syntheticRejection, Buffer.from('changed')), /changed rejection bytes/);
const rejectedDescriptor = { candidateId: rejectionRequest.candidateId, generationRunId: rejectionRequest.generationRunId, child: { master: { sha256: materialSha256s[0] }, runtime: { sha256: materialSha256s[1] } } };
const tombstoneIdentity = assertNoMatchingRejectionTombstone(rejectedDescriptor, new Map()); const tombstones = new Map([[tombstoneIdentity.tombstoneKey, {}]]);
assert.throws(() => assertNoMatchingRejectionTombstone(rejectedDescriptor, tombstones), /permanently rejected/);
const rejectedBinding = { ...rejectedDescriptor, child: { surfaces: rejectedDescriptor.child } };
assert.throws(() => assertNoMatchingRejectionTombstone(rejectedBinding, tombstones), /permanently rejected/);
assert.doesNotThrow(() => assertNoMatchingRejectionTombstone({ ...rejectedDescriptor, generationRunId: 'run-2' }, tombstones));
assert.throws(() => rejectionArchiveBinding({ ...rejectionRequest, generationRunId: '../escape' }, rejectionFiles), /must match/);

let archivePublished = false; let tombstonePublished = false;
await assert.rejects(publishArchiveThenTombstone(async () => { throw new Error('archive failed'); }, async () => { tombstonePublished = true; }), /archive failed/);
assert.equal(tombstonePublished, false, 'archive failure must never publish an irreversible tombstone');
await assert.rejects(publishArchiveThenTombstone(async () => { archivePublished = true; }, async () => { throw new Error('index failed'); }), /index failed/);
assert.equal(archivePublished, true); assert.equal(tombstonePublished, false);
await publishArchiveThenTombstone(async () => { assert.equal(archivePublished, true); }, async () => { tombstonePublished = true; });
assert.equal(tombstonePublished, true, 'a durable archive without an index must be recoverable on retry');

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-self-test-')));
try {
  const sourcePath = path.join(temporary, 'source.png'); const promptPath = path.join(temporary, 'prompt.txt');
  const source = PNG.sync.write({ width: 1024, height: 1024, data: Buffer.alloc(1024 * 1024 * 4, 127) }, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  await writeFile(sourcePath, source); await writeFile(promptPath, 'synthetic prompt');
  const payloadGenerationRunId = 'reject-payload-run'; const payloadArchiveId = 'f'.repeat(64);
  const payloadArchiveRoot = `assets/creatures/biological-continuity-v3/rejected/${payloadGenerationRunId}/${payloadArchiveId}`;
  const payloadBytes = [Buffer.from('master payload'), Buffer.from('runtime payload')];
  const originalPayloads = [
    { path: 'assets/creatures/biological-continuity-v3/candidates/run/PG-001/master.png', sha256: sha256Bytes(payloadBytes[0]) },
    { path: 'assets/creatures/biological-continuity-v3/candidates/run/PG-001/runtime.png', sha256: sha256Bytes(payloadBytes[1]) },
  ];
  const archivedPayloads = originalPayloads.map((entry, index) => ({ path: `${payloadArchiveRoot}/${String(index + 1).padStart(2, '0')}-${path.basename(entry.path)}`, sha256: entry.sha256 }));
  await mkdir(path.join(temporary, payloadArchiveRoot), { recursive: true });
  for (const [index, entry] of archivedPayloads.entries()) await writeFile(path.join(temporary, entry.path), payloadBytes[index]);
  const payloadRejection = { generationRunId: payloadGenerationRunId, archiveId: payloadArchiveId, sourceFiles: archivedPayloads, archiveBinding: { sourceFiles: originalPayloads } };
  await assert.doesNotReject(verifyRejectionArchivePayloads(payloadRejection, { repoRoot: temporary }));
  await rm(path.join(temporary, archivedPayloads[0].path));
  await assert.rejects(verifyRejectionArchivePayloads(payloadRejection, { repoRoot: temporary }), /missing|ENOENT|does not exist/);
  await writeFile(path.join(temporary, archivedPayloads[0].path), Buffer.from('mutated payload'));
  await assert.rejects(verifyRejectionArchivePayloads(payloadRejection, { repoRoot: temporary }), /changed or is missing/);
  await writeFile(path.join(temporary, archivedPayloads[0].path), payloadBytes[0]);
  const first = await stageCandidate({ slotId: 'PG-001', generationRunId: 'run-a', promptPath, sourcePath, repoRoot: temporary });
  const second = await stageCandidate({ slotId: 'PG-001', generationRunId: 'run-b', promptPath, sourcePath, repoRoot: temporary });
  assert.equal(first.runtimeSha256, second.runtimeSha256);
  const runtime = await readFile(path.join(temporary, first.provenance.replace('/provenance.json', '/runtime.png')));
  const decoded = PNG.sync.read(runtime, { checkCRC: true }); assert.deepEqual([decoded.width, decoded.height], [360, 360]); assert.equal(runtime[25], 6); assert.ok(runtime.includes(Buffer.from('sRGB')));
  const sourceLink = path.join(temporary, 'source-link.png'); await symlink(sourcePath, sourceLink);
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-symlink', promptPath, sourcePath: sourceLink, repoRoot: temporary }), /symlink ancestor/);
  const hardlinkPath = path.join(temporary, 'source-hardlink.png'); await link(sourcePath, hardlinkPath);
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-hardlink', promptPath, sourcePath: hardlinkPath, repoRoot: temporary }), /independent regular file/);
  const corruptPath = path.join(temporary, 'corrupt.png'); const corrupt = Buffer.from(source); corrupt[Math.floor(corrupt.length / 2)] ^= 0xff; await writeFile(corruptPath, corrupt);
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-corrupt', promptPath, sourcePath: corruptPath, repoRoot: temporary }), /invalid PNG\/CRC/);
  const realAncestor = path.join(temporary, 'real-ancestor'); const linkedAncestor = path.join(temporary, 'linked-ancestor'); await mkdir(realAncestor); await symlink(realAncestor, linkedAncestor);
  const ancestorSource = path.join(realAncestor, 'source.png'); await writeFile(ancestorSource, source);
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-ancestor-link', promptPath, sourcePath: path.join(linkedAncestor, 'source.png'), repoRoot: temporary }), /symlink ancestor/);
  const swapSource = path.join(temporary, 'swap-source.png'); await writeFile(swapSource, source);
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-swap', promptPath, sourcePath: swapSource, repoRoot: temporary,
    testBeforeSourceOpen: async () => { await rename(swapSource, `${swapSource}.old`); await writeFile(swapSource, source); } }), /changed during intake/);
  const mutateSource = path.join(temporary, 'mutate-source.png'); await writeFile(mutateSource, source);
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-mutate', promptPath, sourcePath: mutateSource, repoRoot: temporary,
    testBeforeSourceOpen: async () => { const changed = Buffer.from(source); changed[changed.length - 16] ^= 0xff; await writeFile(mutateSource, changed); } }), /changed during intake/);
  const hostileRoot = path.join(temporary, 'hostile-output-root'); const realOutputAncestor = path.join(temporary, 'real-output-ancestor');
  const hostileSource = path.join(temporary, 'hostile-output-source.png'); await writeFile(hostileSource, source);
  await mkdir(path.join(hostileRoot, 'assets'), { recursive: true }); await mkdir(realOutputAncestor); await symlink(realOutputAncestor, path.join(hostileRoot, 'assets/creatures'));
  await assert.rejects(stageCandidate({ slotId: 'PG-001', generationRunId: 'run-output-link', promptPath, sourcePath: hostileSource, repoRoot: hostileRoot }), /symlink ancestor/);
  const finalRun = path.join(temporary, 'public', 'run-1'); const failedPublish = await createAtomicPublishTransaction(finalRun, { containmentRoot: temporary });
  await writeFile(path.join(failedPublish.transactionRoot, 'artifact.json'), '{}');
  await assert.rejects(atomicPublishDirectory(failedPublish.transactionRoot, finalRun, { containmentRoot: temporary, parentIdentity: failedPublish.parentIdentity, beforePublish: async () => { throw new Error('injected validation failure'); } }), /injected validation failure/);
  await assert.rejects(access(finalRun)); await access(failedPublish.transactionRoot);
  const swappedFinal = path.join(temporary, 'swap-public', 'run-1'); const swappedPublish = await createAtomicPublishTransaction(swappedFinal, { containmentRoot: temporary });
  await writeFile(path.join(swappedPublish.transactionRoot, 'artifact.json'), '{}'); const swappedParentBackup = `${swappedPublish.parentIdentity.parent}-old`; const attackerParent = path.join(temporary, 'attacker-parent'); await mkdir(attackerParent);
  await assert.rejects(atomicPublishDirectory(swappedPublish.transactionRoot, swappedFinal, { containmentRoot: temporary, parentIdentity: swappedPublish.parentIdentity,
    beforePublish: async () => { await rename(swappedPublish.parentIdentity.parent, swappedParentBackup); await symlink(attackerParent, swappedPublish.parentIdentity.parent); } }), /parent changed before commit/);
  await assert.rejects(access(swappedFinal)); await access(path.join(swappedParentBackup, path.basename(swappedPublish.transactionRoot)));
  let gateRoot = path.join(temporary, 'terminal-gate'); const gateEvidenceRoot = 'g003-evidence';
  const gateFinalizingPath = `${gateEvidenceRoot}/finalization/finalizing.json`; const gateTerminalPath = `${gateEvidenceRoot}/finalization/terminal.json`;
  await mkdir(gateRoot);
  const holder = spawnModuleChild(transitionLockHolderChildSource({ repoRoot: gateRoot }));
  const holderExit = waitForChildExit(holder, 20_000);
  await waitForChildOutput(holder, 'LOCKED\n');
  const concurrentMarker = path.join(gateRoot, 'concurrent-callback-ran');
  const contender = spawnModuleChild(kernelLockChildSource({ repoRoot: gateRoot, label: 'child-contender', markerPath: concurrentMarker }));
  const contenderResult = await waitForChildExit(contender);
  assert.equal(contenderResult.code, 0); assert.match(contenderResult.stdout, /BLOCKED:NO_CODE:NO_CAUSE:G003 transition integrity: another transition writer holds the shared lock/);
  assert.doesNotMatch(contenderResult.stdout, /CALLBACK/); await assert.rejects(access(concurrentMarker));
  const renamedGateRoot = `${gateRoot}-renamed`; await rename(gateRoot, renamedGateRoot); gateRoot = renamedGateRoot;
  const legacyLock = path.join(gateRoot, gateEvidenceRoot, '.operation-lock'); const renamedLegacyLock = `${legacyLock}-renamed`;
  await mkdir(path.dirname(legacyLock), { recursive: true }); await mkdir(legacyLock); await rename(legacyLock, renamedLegacyLock); await mkdir(legacyLock);
  const replacedPathMarker = path.join(gateRoot, 'replaced-path-callback-ran');
  const afterPathReplacement = spawnModuleChild(kernelLockChildSource({ repoRoot: gateRoot, label: 'child-after-path-replacement', markerPath: replacedPathMarker }));
  const afterPathReplacementResult = await waitForChildExit(afterPathReplacement);
  assert.equal(afterPathReplacementResult.code, 0); assert.match(afterPathReplacementResult.stdout, /BLOCKED:NO_CODE:NO_CAUSE:G003 transition integrity: another transition writer holds the shared lock/);
  assert.doesNotMatch(afterPathReplacementResult.stdout, /CALLBACK/); await assert.rejects(access(replacedPathMarker));
  assert.equal(holder.child.kill('SIGKILL'), true); const killedHolder = await holderExit; assert.equal(killedHolder.signal, 'SIGKILL');
  const throwMarker = path.join(gateRoot, 'throwing-callback-ran');
  const throwing = spawnModuleChild(kernelLockChildSource({ repoRoot: gateRoot, label: 'child-throwing-operation', markerPath: throwMarker, throwMessage: 'injected operation failure' }));
  const throwingResult = await waitForChildExit(throwing);
  assert.equal(throwingResult.code, 0); assert.match(throwingResult.stdout, /CALLBACK\nBLOCKED:NO_CODE:NO_CAUSE:injected operation failure\n/); await access(throwMarker);
  const retryMarker = path.join(gateRoot, 'post-crash-retry-ran');
  const retry = spawnModuleChild(kernelLockChildSource({ repoRoot: gateRoot, label: 'child-post-crash-retry', markerPath: retryMarker }));
  const retryResult = await waitForChildExit(retry);
  assert.equal(retryResult.code, 0); assert.match(retryResult.stdout, /CALLBACK\nDONE\n/); await access(retryMarker);
  await mkdir(path.join(gateRoot, gateEvidenceRoot, 'finalization'), { recursive: true });
  await writeFile(path.join(gateRoot, gateFinalizingPath), '{}');
  await assert.rejects(withExclusiveG003Operation('post-finalizing-test', async () => true, {
    repoRoot: gateRoot, finalizingPath: gateFinalizingPath, terminalPath: gateTerminalPath,
  }), /FINALIZING/);
  await writeFile(path.join(gateRoot, gateTerminalPath), '{}');
  await assert.rejects(withExclusiveG003Operation('post-terminal-test', async () => true, {
    repoRoot: gateRoot, finalizingPath: gateFinalizingPath, terminalPath: gateTerminalPath,
  }), /TERMINAL/);
  await assert.rejects(assertG003MutationOpen({ repoRoot: gateRoot, finalizingPath: gateFinalizingPath, terminalPath: gateTerminalPath }), /TERMINAL/);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'PASS', hostileCases: 88, addedHostileCases: 52, activeBaseline: expectedBaseline }));
