#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { validateSignedCanonicalRootRedesignTargets } from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';
import { solveContinuityAssignment } from './lib/continuity-assignment/solver.mjs';
import {
  G002_V1_BASE, G002_V2_ADDITION_IDS, G002_V2_EFFECTIVE_ROOT_IDS, G002_V2_TARGET_SOURCE,
  assertV2OutputPath, validateG002V2SuccessorCore, validateSignedG002V2Successor, validateUnsignedG002V2Successor, verifyG002V1BaseAuthority,
} from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { assertG002V2Solution, V2_INPUTS } from './build-g002-v2-continuity-assignment.mjs';
import { buildG002V2CanonicalSuccessor } from './build-g002-v2-canonical-successor.mjs';
import { attestG002V2CanonicalSuccessor, attestG002V2CanonicalSuccessorValue } from './attest-g002-v2-canonical-successor.mjs';
import { assertG002V2AssignmentSemantics } from './lib/g002-v2-public-evidence.mjs';
import { validateG002V2ArchitectApprovalInput } from './attest-g002-v2-architect-approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V1_ROOT = path.join(ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v1');
const hex = (seed) => createHash('sha256').update(seed).digest('hex');
const json = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative)));

async function inventoryDigest(root) {
  const files = [];
  const walk = async (directory) => { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) entry.isDirectory() ? await walk(path.join(directory, entry.name)) : files.push(path.join(directory, entry.name)); };
  await walk(root); const hash = createHash('sha256');
  for (const file of files) { hash.update(path.relative(root, file)); hash.update('\0'); hash.update(await readFile(file)); hash.update('\0'); }
  return { count: files.length, sha256: hash.digest('hex') };
}

const before = await inventoryDigest(V1_ROOT);
assert.deepEqual(await verifyG002V1BaseAuthority(ROOT), await verifyG002V1BaseAuthority(ROOT));
const draft = await json('production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-redesign-targets-v2.draft.json');
const reviewProofs = G002_V2_ADDITION_IDS.map((rootId, rootIndex) => {
  const common = { packageManifestSha256: hex(`${rootId}:package`), materialBindingSha256: hex(`${rootId}:material`), promptSha256: hex(`${rootId}:prompt`), inputAllowlistSha256: hex(`${rootId}:allowlist`), observedSurfaces: { masterSha256: hex(`${rootId}:master`), runtimeSha256: hex(`${rootId}:runtime`) }, verdicts: { target: 'PASS', anchors: 'PASS', visibility: 'PASS', clarifications: 'PASS' }, blinded: true };
  const primaryReviews = [1, 2].map((passNumber) => ({ reviewerInstanceId: `reviewer-${rootIndex}-${passNumber}`, agentTaskId: `task-${rootIndex}-${passNumber}`, reviewRunId: `run-${rootIndex}-${passNumber}`, passNumber, assignmentSha256: hex(`${rootId}:assignment:${passNumber}`), ...common, rawVoteSha256: hex(`${rootId}:raw:${passNumber}`), reviewOutputSha256: hex(`${rootId}:output:${passNumber}`) }));
  return { rootId, targetSha256: sha256Canonical(draft.targets.find((target)=>target.rootId===rootId)), publicProofPath: `production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-reviews/proofs/${rootId}.json`, publicProofFileSha256: hex(`${rootId}:public-file`), publicProofOutputSha256: hex(`${rootId}:public-output`), publicProofSignatureSha256: hex(`${rootId}:public-signature`), primaryReviews, consensusSha256: sha256Canonical({ rootId, primaryReviews }) };
});
const evidence = { newTargetIds: draft.newTargetIds, targets: draft.targets, reviewProofs, visibilityPolicy: draft.visibilityPolicy };
const architectCore = { schemaVersion: 'g002-v2-canonical-architect-approval-v1', source: 'independent-architect-review', reviewerId: 'architect-independent', decision: 'APPROVE', approvedTargetIds: G002_V2_ADDITION_IDS, evidenceSha256: sha256Canonical(evidence), approvedAt: '2026-08-11T00:00:00.000Z' };
const core = { ...draft, state: 'APPROVED_FOR_REGENERATION_TARGETING', reviewProofs, architectApproval: { ...architectCore, outputSha256: sha256Canonical(architectCore), publicSignature: { algorithm: 'Ed25519', authorityFingerprint: '423f474c59667e5eabc13a703b8d7de4e97bcba33cdc22340873866db9d6a53f', signatureBase64: 'A'.repeat(88) } } };
const invalidArchitectDraft={schemaVersion:'g002-v2-canonical-architect-approval-v1',source:'independent-architect-review',reviewerId:'x',decision:'APPROVE',approvedTargetIds:G002_V2_ADDITION_IDS,approvedAt:'2026-8-11'};assert.throws(()=>validateG002V2ArchitectApprovalInput({approvalDraft:invalidArchitectDraft,draft,reviewProofs}),/identity\/decision\/time/);
const driftedDraft=structuredClone(draft);driftedDraft.targets[0].clarificationRequirements[0]+=' drift';assert.throws(()=>validateG002V2ArchitectApprovalInput({approvalDraft:{...invalidArchitectDraft,reviewerId:'architect-independent',approvedAt:new Date().toISOString()},draft:driftedDraft,reviewProofs}),/code-pinned/);
const additions = validateG002V2SuccessorCore(core);
const canonicalUnsigned=JSON.parse(canonicalStringify({...core,outputSha256:sha256Canonical(core)}));assert.equal(validateUnsignedG002V2Successor(canonicalUnsigned).outputSha256,canonicalUnsigned.outputSha256);assert.deepEqual(canonicalUnsigned.baseAuthority,JSON.parse(canonicalStringify(core.baseAuthority)));
assert.deepEqual([...additions.keys()].sort(), G002_V2_ADDITION_IDS);
assert.deepEqual(additions.get('PG-024').anchors.map((anchor) => anchor.anchorId), [
  'eight-separate-mechanical-walking-legs', 'four-pink-eyes-and-paired-gold-fangs', 'four-pink-rimmed-dorsal-ports-and-gold-braces',
]);
assert.ok(additions.get('PG-024').clarificationRequirements.some((entry) => /Reject extra eyes, extra fangs, extra dorsal ports/.test(entry)));
assert.deepEqual(additions.get('PG-052').anchors.map((anchor) => anchor.anchorId), [
  'eight-separate-spider-legs', 'two-huge-cyan-eyes-single-gold-forehead-horn', 'thin-gold-dorsal-stripe-over-rounded-black-abdomen',
]);
assert.ok(additions.get('PG-052').clarificationRequirements.some((entry) => /Reject extra eyes, fangs, additional horns/.test(entry)));
for (const rootId of G002_V2_ADDITION_IDS) assert.deepEqual(additions.get(rootId).anchors.map((anchor) => anchor.anchorId), draft.targets.find((target) => target.rootId === rootId).anchors.map((anchor) => anchor.anchorId));

const missing = structuredClone(core); missing.targets.pop(); assert.throws(() => validateG002V2SuccessorCore(missing), /six successor targets|coverage/);
const identityDrift = structuredClone(core); identityDrift.targets.find((target) => target.rootId === 'PG-024').anchors[1].anchorId = 'generic-spider-face'; assert.throws(() => validateG002V2SuccessorCore(identityDrift), /candidate identity anchors/);
for (const rootId of ['PG-029', 'PG-047', 'PG-053', 'PG-056']) { const drift = structuredClone(core); drift.targets.find((target) => target.rootId === rootId).anchors[0].anchorId = 'generic-creature'; assert.throws(() => validateG002V2SuccessorCore(drift), /candidate identity anchors/); }
const extra = structuredClone(core); extra.newTargetIds.push('PG-999'); assert.throws(() => validateG002V2SuccessorCore(extra), /new target IDs/);
const overlap = structuredClone(core); overlap.newTargetIds[0] = 'PG-016'; assert.throws(() => validateG002V2SuccessorCore(overlap), /new target IDs|overlap/);
const forgedBase = structuredClone(core); forgedBase.baseAuthority.publicManifestFileSha256 = '0'.repeat(64); assert.throws(() => validateG002V2SuccessorCore(forgedBase), /base authority/);
const missingReview = structuredClone(core); missingReview.reviewProofs.pop(); assert.throws(() => validateG002V2SuccessorCore(missingReview), /six review/);
const duplicateReviewer = structuredClone(core); duplicateReviewer.reviewProofs[0].primaryReviews[1].reviewerInstanceId = duplicateReviewer.reviewProofs[0].primaryReviews[0].reviewerInstanceId; assert.throws(() => validateG002V2SuccessorCore(duplicateReviewer), /not independent/);
const badSignatureShape = { ...core, outputSha256: sha256Canonical(core) }; assert.equal('publicSignature' in badSignatureShape, false);
const borrowedSignature = (await json(G002_V1_BASE.canonicalContractPath)).publicSignature;
assert.throws(() => validateSignedG002V2Successor({ ...badSignatureShape, publicSignature: borrowedSignature }), /signature/i);
const persistedSigned=await json('production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-redesign-targets-v2.json');const persistedUnsigned=structuredClone(persistedSigned);delete persistedUnsigned.publicSignature;let materialSignerCalls=0;const corruptedProofBinding=structuredClone(persistedUnsigned);corruptedProofBinding.reviewProofs[0].publicProofFileSha256='0'.repeat(64);{const materialCore=structuredClone(corruptedProofBinding);delete materialCore.outputSha256;corruptedProofBinding.outputSha256=sha256Canonical(materialCore);}await assert.rejects(attestG002V2CanonicalSuccessorValue({unsigned:corruptedProofBinding,repoRoot:ROOT,conductorKey:Buffer.alloc(32),signer:()=>{materialSignerCalls+=1;return{};}}),/architect evidence hash mismatch|public proof binding|summary differs/);assert.equal(materialSignerCalls,0);const badArchitectSignature=structuredClone(persistedUnsigned);badArchitectSignature.architectApproval.publicSignature.signatureBase64=Buffer.alloc(64).toString('base64');{const materialCore=structuredClone(badArchitectSignature);delete materialCore.outputSha256;badArchitectSignature.outputSha256=sha256Canonical(materialCore);}await assert.rejects(attestG002V2CanonicalSuccessorValue({unsigned:badArchitectSignature,repoRoot:ROOT,conductorKey:Buffer.alloc(32),signer:()=>{materialSignerCalls+=1;return{};}}),/signature/);assert.equal(materialSignerCalls,0);
const noApproval = structuredClone(core); noApproval.architectApproval = null; assert.throws(() => validateG002V2SuccessorCore(noApproval), /architect approval/);
assert.throws(() => assertV2OutputPath('production/reports/biological-continuity-v3/g002-evidence-v1/assignment-manifest.json', new Set(['assignment-manifest.json'])), /not confined/);
assert.throws(() => assertV2OutputPath('../g002-evidence-v2/assignment-manifest.json', new Set(['assignment-manifest.json'])), /not confined/);
const inventedRoot = await mkdtemp(path.join(ROOT, '.omx/evidence/.g002-v2-invented-proof-'));
try {
  const fakePaths = [];
  for (const rootId of G002_V2_ADDITION_IDS) { const file = path.join(inventedRoot, `${rootId}.json`); await writeFile(file, JSON.stringify(reviewProofs.find((entry) => entry.rootId === rootId))); fakePaths.push(path.relative(ROOT, file)); }
  await assert.rejects(buildG002V2CanonicalSuccessor({ repoRoot: ROOT, reviewProofPaths: fakePaths, architectApprovalPath: 'production/reports/biological-continuity-v3/g002-evidence-v2/architect-approval.template.json', write: false }), /public proof.*fields mismatch|signature/i);
} finally { await rm(inventedRoot, { recursive: true, force: true }); }

const invalidAttestRoot = await mkdtemp(path.join(ROOT, '.omx/evidence/.g002-v2-invalid-attest-'));
try {
  const unsignedPath = path.join(invalidAttestRoot, 'production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-redesign-targets-v2.unsigned.json');
  await mkdir(path.dirname(unsignedPath), { recursive: true }); await writeFile(unsignedPath, JSON.stringify({ schemaVersion: 'tampered' }));
  let signerCalls = 0;
  await assert.rejects(attestG002V2CanonicalSuccessor({ repoRoot: invalidAttestRoot, conductorKey: Buffer.alloc(32), signer: () => { signerCalls += 1; return {}; } }), /fields mismatch/);
  assert.equal(signerCalls, 0, 'invalid unsigned core reached the signer');
  await assert.rejects(readFile(path.join(invalidAttestRoot, 'production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-redesign-targets-v2.json')), /ENOENT/);
} finally { await rm(invalidAttestRoot, { recursive: true, force: true }); }

const v1Contract = await json(G002_V1_BASE.canonicalContractPath); const v1 = validateSignedCanonicalRootRedesignTargets(v1Contract);
const effective = new Map([...v1.byRootId, ...additions]); assert.deepEqual([...effective.keys()].sort(), G002_V2_EFFECTIVE_ROOT_IDS);
const inputKeys = ['catalog', 'census', 'conflictLedger', 'taxonomyConsensus', 'pixelClusters', 'anchorConsensus', 'lockedTaxonomyConsensus', 'topologyContract', 'pins'];
const inputs = Object.fromEntries(await Promise.all(inputKeys.map(async (key) => [key, await json(V2_INPUTS[key])])));
const authority = { byRootId: effective, outputSha256: hex('test-successor'), targetSource: G002_V2_TARGET_SOURCE, visibilityPolicy: core.visibilityPolicy, reviewerProvenanceIds: reviewProofs.flatMap((proof) => proof.primaryReviews.map((review) => review.reviewerInstanceId)), architectApprovalSource: core.architectApproval.reviewerId };
const solution = solveContinuityAssignment({ ...inputs, canonicalRootRedesignTargets: core, canonicalAuthorityResolver: () => authority });
assertG002V2Solution(solution);
const vacuousDependency = structuredClone(solution); const dependent = vacuousDependency.queue.find((entry) => entry.slotId === 'PG-145'); dependent.inheritedAnchorContracts = dependent.inheritedAnchorContracts.filter((entry) => entry.parentId !== 'PG-053'); assert.throws(() => assertG002V2Solution(vacuousDependency), /exact three strict inherited parent anchors/);
const assignmentFixture = { schemaVersion: 'continuity-assignment-v2', runId: 'g002-v2', verdict: 'FEASIBLE_WITH_REGENERATION', effectiveAuthoritySha256: hex('authority'), assignments: Array(240).fill({}), reviewCoverageManifest: { ...solution.reviewCoverage, authority: { effectiveAuthoritySha256: hex('authority'), canonicalSuccessorOutputSha256: hex('successor') } } };
assignmentFixture.reviewCoverageManifest = { ...assignmentFixture.reviewCoverageManifest, schemaVersion: 'continuity-g003-review-gate-v2' };
const semanticFixture = { assignment: assignmentFixture, queue: { schemaVersion: 'continuity-regeneration-queue-g002-v2', runId: 'g002-v2', effectiveAuthoritySha256: hex('authority'), entries: solution.queue }, feasibility: { schemaVersion: 'continuity-feasibility-g002-v2', runId: 'g002-v2', effectiveAuthoritySha256: hex('authority'), ...solution.feasibility }, topology: { ...solution.topology, schemaVersion: 'continuity-topology-after-v2', runId: 'g002-v2' }, attestation: { schemaVersion: 'continuity-output-attestation-g002-v2', runId: 'g002-v2', effectiveAuthoritySha256: hex('authority'), declaredVerdict: 'FEASIBLE_WITH_REGENERATION', generationPolicy: 'deterministic-fail-closed-public-atomic-no-active-mutation-no-v1-fallback' } };
assert.equal(assertG002V2AssignmentSemantics(semanticFixture), true);
const relaxedGate = structuredClone(semanticFixture); relaxedGate.assignment.reviewCoverageManifest.completionAllowed = true; assert.throws(() => assertG002V2AssignmentSemantics(relaxedGate), /gate relaxed/);
const relaxedThreshold = structuredClone(semanticFixture); relaxedThreshold.assignment.reviewCoverageManifest.edgeCandidates[0].comparisonThresholds.minimumAnchorRetentionRatio = 0.5; assert.throws(() => assertG002V2AssignmentSemantics(relaxedThreshold), /threshold relaxed/);
assert.equal(solution.queue.length + solution.topology.edges.length, 367);
assert.equal(solution.reviewCoverage.edgeCandidates.every((edge) => edge.comparisonThresholds.sameCreatureGrownUp === 'yes' && edge.comparisonThresholds.minimumAnchorRetentionRatio === 1), true);
for (const edgeId of ['PG-053:PG-145', 'PG-047:PG-155']) assert.ok(solution.reviewCoverage.edgeCandidates.find((entry) => `${entry.parentId}:${entry.childId}` === edgeId));
const after = await inventoryDigest(V1_ROOT); assert.deepEqual(after, before, 'g002-evidence-v1 inventory or bytes changed');
assert.equal(before.count, 95);
console.log(JSON.stringify({ status: 'PASS', checks: 18, v1InventoryFiles: before.count, v1InventorySha256: before.sha256, canonicalRoots: 15, regenerationCount: 177, edges: 190, obligations: 367 }));
