#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomicNoFollowForTest } from './build-continuity-assignment.mjs';
import { canonicalString } from './lib/continuity-assignment/compatibility.mjs';
import { assertLosslessSaveRevisionMap, buildSaveRevisionMap } from './lib/continuity-assignment/save-space.mjs';
import { solveContinuityAssignment } from './lib/continuity-assignment/solver.mjs';
import { projectG002CatalogEpoch } from './lib/continuity-assignment/g002-catalog-epoch.mjs';
import { assertAssignmentSafety, assertLedgerIntegrity, assertNoPass3SubstantiveOverride, assertSolutionProofs, deriveReviewCoverageState } from './verify-continuity-assignment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = 'production/reports/biological-continuity-v3/g002-evidence-v1';
const read = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative)));
const [currentCatalog, census, ledger, taxonomyConsensus, pixelClusters, anchorConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets, topologyBefore, pins] = await Promise.all([
  read('production/catalog/creatures.json'),
  read('production/reports/biological-continuity-v3/g001-unblinded-image-first-census-v1.json'),
  read('production/reports/biological-continuity-v3/g001-unblinded-conflict-ledger-v1.json'),
  read(`${PUBLIC}/asset-census.json`), read(`${PUBLIC}/pixel-clusters.json`), read('production/reports/biological-continuity-v3/g001-primary-pixel-anchor-consensus-v1.json'), read(`${PUBLIC}/taxonomy-reviews/consensus.json`), read(`${PUBLIC}/canonical-root-redesign-targets-v1.json`), read(`${PUBLIC}/topology-before.json`), read(`${PUBLIC}/pins.json`),
]);
const catalog = projectG002CatalogEpoch(currentCatalog).catalog;
const solverInputs = { catalog, census, conflictLedger: ledger, taxonomyConsensus, pixelClusters, anchorConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets, topologyContract: topologyBefore, pins };
const solution = solveContinuityAssignment(solverInputs);
const assertProofs = (candidate) => assertSolutionProofs(candidate, pins, anchorConsensus, { census, taxonomyConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets });
await assertProofs(solution);
assert.equal(solution.feasibility.incompatibleEdgeCount, 0);
assert.equal(solution.feasibility.pendingPixelTaxonomyFamilyCount, 0);
assert.equal(solution.feasibility.pendingPixelTaxonomySlotCount, 0);
assert.equal(solution.feasibility.pendingTaxonomyEdgeCount, 0);
assert.equal(solution.assignments.filter((entry) => entry.targetTaxonomy && Object.values(entry.targetTaxonomy).some((value) => /^(?:unknown(?:-|$)|designed-)/i.test(value))).length, 0);

const manifest = { assignments: solution.assignments };
const safetyArgs = { manifest, census, ledger, taxonomyConsensus, topology: solution.topology };
assert.equal(assertAssignmentSafety(safetyArgs), true);

// Review attack: a non-mixed assignment claims a target incompatible with its incident edge.
const retained = solution.assignments.filter((entry) => entry.sourceKind === 'existing');
const mismatched = structuredClone(safetyArgs);
const verifiedEdge = solution.topology.edges.find((edge) => edge.compatibilityStatus === 'VERIFIED_PIXEL_VOTE_TARGET');
const mismatchedParent = mismatched.manifest.assignments.find((entry) => entry.slotId === verifiedEdge.parentId);
mismatchedParent.targetTaxonomy = { ...mismatchedParent.targetTaxonomy, speciesFamily: `attacker-${verifiedEdge.parentId}` };
assert.throws(() => assertAssignmentSafety(mismatched), /incompatible target edge/);

// Review attacks: unproven cross-slot reuse and duplicate hash use.
const cross = structuredClone(safetyArgs);
cross.manifest.assignments.find((entry) => entry.slotId === retained[0].slotId).source = retained[1].slotId;
assert.throws(() => assertAssignmentSafety(cross), /unproven cross-slot reuse/);
const duplicate = structuredClone(safetyArgs);
duplicate.manifest.assignments.find((entry) => entry.slotId === retained[1].slotId).assetSha256 = retained[0].assetSha256;
assert.throws(() => assertAssignmentSafety(duplicate), /duplicate asset use/);

// Every one of the 17 blocked mixed conflict records remains forced to REGEN.
const assignmentById = new Map(solution.assignments.map((entry) => [entry.slotId, entry]));
const blockedMixed = ledger.conflicts.filter((item) => item.kind === 'edge' && Object.keys(item.parentSlots ?? {}).length === 2);
assert.equal(blockedMixed.length, 17);
for (const conflict of blockedMixed) assert.equal(assignmentById.get(conflict.child.pgId).sourceKind, 'regenerate');

// Fake Eilu / empty proofs / pass-3 substantive override are rejected.
const fakePins = structuredClone(pins); fakePins.positiveControl.slotIds = ['PG-002', 'PG-062', 'PG-182'];
assert.throws(() => solveContinuityAssignment({ ...solverInputs, pins: fakePins }), /Eilu positive-control/);
const emptyProof = structuredClone(solution); emptyProof.familyProofs = [];
await assert.rejects(assertProofs(emptyProof), /empty, flipped, or incompatible root-frozen family proof/);
const fakeEiluComparison = structuredClone(solution); fakeEiluComparison.pinsProof.eiluBenchmark.comparisonRequirements.compareAgainstBenchmark = false;
await assert.rejects(assertProofs(fakeEiluComparison), /fake Eilu/);
const incompleteCoverage = structuredClone(solution); incompleteCoverage.reviewCoverage.queueCandidates.pop();
await assert.rejects(assertProofs(incompleteCoverage), /incomplete or falsely passing/);
const rootTaxonomyFlip = structuredClone(solution); rootTaxonomyFlip.familyProofs[0].targetTaxonomy.speciesFamily = 'frog';
for (const slot of rootTaxonomyFlip.familyProofs[0].slots) slot.targetTaxonomy.speciesFamily = 'frog';
await assert.rejects(assertProofs(rootTaxonomyFlip), /root taxonomy flip/);
const pixelAOverride = structuredClone(solution); const canonicalFamily = pixelAOverride.familyProofs.find((proof) => proof.rootId === 'PG-016');
canonicalFamily.targetTaxonomy = taxonomyConsensus.assets.find((asset) => asset.pgId === 'PG-016').taxonomy;
for (const slot of canonicalFamily.slots) slot.targetTaxonomy = canonicalFamily.targetTaxonomy;
await assert.rejects(assertProofs(pixelAOverride), /root taxonomy flip/);
const oldDescendantTaxonomy = structuredClone(solution); const canonicalDescendant = oldDescendantTaxonomy.familyProofs.find((proof) => proof.rootId === 'PG-022').slots.find((slot) => slot.slotId !== 'PG-022');
oldDescendantTaxonomy.assignments.find((assignment) => assignment.slotId === canonicalDescendant.slotId).targetTaxonomy = { biologicalClass: 'mammalia', speciesFamily: 'mustelid', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' };
await assert.rejects(assertProofs(oldDescendantTaxonomy), /canonical redesign descendant retained or relabeled/);
for (const target of canonicalRootRedesignTargets.targets) {
  const rootQueue = solution.queue.find((entry) => entry.slotId === target.rootId);
  assert.equal(rootQueue.designAnchors.every((anchor) => anchor.sourceKind === 'signed-canonical-root-redesign-contract'
    && anchor.resolutionState === 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET'), true);
}
const falseCanonicalPixelConsensus = structuredClone(solution);
falseCanonicalPixelConsensus.queue.find((entry) => entry.slotId === canonicalRootRedesignTargets.targets[0].rootId).designAnchors[0].resolutionState = 'RESOLVED_AUTHENTICATED_PIXELS';
await assert.rejects(assertProofs(falseCanonicalPixelConsensus), /canonical redesign anchors\/visibility mismatch/);
const arbitraryAnchor = structuredClone(solution); arbitraryAnchor.reviewCoverage.queueCandidates[0].allowedAnchorIds = [...arbitraryAnchor.reviewCoverage.queueCandidates[0].allowedAnchorIds, 'reviewer-invented-anchor'];
await assert.rejects(assertProofs(arbitraryAnchor), /arbitrary reviewer anchors/);
const arbitraryAnchorDescription = structuredClone(solution); arbitraryAnchorDescription.reviewCoverage.queueCandidates[0].allowedAnchors[0].description = 'reviewer invented description';
await assert.rejects(assertProofs(arbitraryAnchorDescription), /arbitrary reviewer anchors|stale-parent/);
const arbitraryParentAnchor = structuredClone(solution); arbitraryParentAnchor.reviewCoverage.edgeCandidates[0].allowedParentAnchors[0].anchors[0].description = 'reviewer invented parent description';
await assert.rejects(assertProofs(arbitraryParentAnchor), /arbitrary or unqualified parent review anchors|old-slot anchor leakage|retained parent anchor mismatch/);
const falseVisualPass = structuredClone(solution); falseVisualPass.reviewCoverage.state = 'PASS'; falseVisualPass.reviewCoverage.completionAllowed = true;
await assert.rejects(assertProofs(falseVisualPass), /incomplete or falsely passing/);
const fakeCompleteEvidence = structuredClone(solution);
fakeCompleteEvidence.reviewCoverage.state = 'PASS'; fakeCompleteEvidence.reviewCoverage.completionAllowed = true;
fakeCompleteEvidence.reviewCoverage.coverage.passedQueueCandidates = fakeCompleteEvidence.queue.length;
fakeCompleteEvidence.reviewCoverage.coverage.passedFinalEdges = 190; fakeCompleteEvidence.reviewCoverage.coverage.missingCoverage = 0;
await assert.rejects(assertProofs(fakeCompleteEvidence), /PASS lacks persisted public review evidence|incomplete or falsely passing/);
const publicReviewTestRoot = `production/reports/biological-continuity-v3/g003-evidence-v1/self-test-${process.pid}`;
await mkdir(path.join(ROOT, publicReviewTestRoot), { recursive: true });
try {
  const coverageAttack = structuredClone(solution.reviewCoverage); const attacked = coverageAttack.queueCandidates[0];
  const lockedEiluHashes = coverageAttack.eiluBenchmark.pixelBindings.flatMap((entry) => [entry.masterSha256, entry.runtimeSha256]);
  const baseReviewEvidence = {
    candidateId: attacked.candidateId, reviewArtifactPath: `${publicReviewTestRoot}/missing.json`, reviewArtifactSha256: 'a'.repeat(64),
    packageManifestSha256: 'b'.repeat(64), materialBindingSha256: 'c'.repeat(64), inputAllowlistSha256: 'd'.repeat(64), promptSha256: 'e'.repeat(64),
    approvedChildPixelSha256s: ['1'.repeat(64), '2'.repeat(64)], sourceReviewIds: ['review-one', 'review-two'],
    sourceReviewOutputSha256s: ['3'.repeat(64), '4'.repeat(64)], sourceReviewSignatureSha256s: ['5'.repeat(64), '6'.repeat(64)],
    eiluEvidence: { benchmarkId: coverageAttack.eiluBenchmark.benchmarkId, passed: true, inputAssetSha256s: lockedEiluHashes, perStageScores: [0.97, 0.98, 0.99], minimumScore: 0.97 },
  };
  attacked.status = 'PASS'; attacked.reviewEvidence = baseReviewEvidence;
  await assert.rejects(deriveReviewCoverageState(coverageAttack), /persisted artifact is missing or unsafe/i);

  const fakeEiluCoverage = structuredClone(coverageAttack);
  fakeEiluCoverage.queueCandidates[0].reviewEvidence.eiluEvidence.inputAssetSha256s = Array.from({ length: 6 }, (_, index) => `${index + 1}`.repeat(64));
  await assert.rejects(deriveReviewCoverageState(fakeEiluCoverage), /fake or incomplete locked Eilu evidence/i);

  const unsignedPath = `${publicReviewTestRoot}/unsigned.json`; const unsignedBytes = Buffer.from(JSON.stringify({ schemaVersion: 'continuity-g003-public-review-artifact-v1' }));
  await writeFile(path.join(ROOT, unsignedPath), unsignedBytes);
  const unsignedCoverage = structuredClone(coverageAttack);
  unsignedCoverage.queueCandidates[0].reviewEvidence.reviewArtifactPath = unsignedPath;
  unsignedCoverage.queueCandidates[0].reviewEvidence.reviewArtifactSha256 = createHash('sha256').update(unsignedBytes).digest('hex');
  await assert.rejects(deriveReviewCoverageState(unsignedCoverage), /public evidence signature authority is invalid/i);

  const tamperedPath = `${publicReviewTestRoot}/tampered.json`; const originalBytes = Buffer.from('{"signed":"original"}');
  const originalSha256 = createHash('sha256').update(originalBytes).digest('hex');
  await writeFile(path.join(ROOT, tamperedPath), Buffer.from('{"signed":"tampered"}'));
  const tamperedCoverage = structuredClone(coverageAttack);
  tamperedCoverage.queueCandidates[0].reviewEvidence.reviewArtifactPath = tamperedPath;
  tamperedCoverage.queueCandidates[0].reviewEvidence.reviewArtifactSha256 = originalSha256;
  await assert.rejects(deriveReviewCoverageState(tamperedCoverage), /persisted artifact byte hash mismatch/i);
} finally { await rm(path.join(ROOT, publicReviewTestRoot), { recursive: true, force: true }); }
const falseArtCompletion = structuredClone(solution); falseArtCompletion.feasibility.artVerificationState = 'PASS';
await assert.rejects(assertProofs(falseArtCompletion), /false art verification completion|incomplete or falsely passing global review coverage gate/);
const staleGeneratedParent = structuredClone(solution); const dependent = staleGeneratedParent.queue.find((entry) => entry.parentReferences.some((reference) => reference.sourceKind === 'generated-parent-candidate'));
dependent.inheritedAnchorContracts[0].description = 'old G001 slot description leaked into generated parent dependency';
await assert.rejects(assertProofs(staleGeneratedParent), /stale-parent regeneration proof/);
const duplicateMixedAnchor = structuredClone(solution); const mixedQueue = duplicateMixedAnchor.queue.find((entry) => entry.frozen.category === 'mixed');
mixedQueue.inheritedAnchorContracts.find((anchor) => anchor.parentRole === 'parent-2').anchorKey = mixedQueue.inheritedAnchorContracts.find((anchor) => anchor.parentRole === 'parent-1').anchorKey;
await assert.rejects(assertProofs(duplicateMixedAnchor), /stale-parent regeneration proof/);
const overridden = structuredClone(census);
const substantive = ledger.conflicts.find((item) => item.kind === 'asset' && item.reasonClasses.includes('substantive-biological-dissent'));
overridden.assets.find((item) => item.pgId === substantive.pgId).derived.verdict = 'PASS';
assert.throws(() => assertNoPass3SubstantiveOverride(overridden, ledger), /pass3 substantive override/);
const attackerLedger = structuredClone(ledger); attackerLedger.conflicts = [];
assert.throws(() => assertLedgerIntegrity(attackerLedger), /attacker-controlled/);

// Pixel evidence is a hard authenticated solver input; removal/tamper fails closed.
const missingPixel = structuredClone(pixelClusters); missingPixel.entries.pop();
assert.throws(() => solveContinuityAssignment({ ...solverInputs, pixelClusters: missingPixel }), /pixel evidence input/);
const tamperedPixel = structuredClone(pixelClusters); tamperedPixel.entries[0].surfaces.master.sha256 = '0'.repeat(64);
assert.throws(() => solveContinuityAssignment({ ...solverInputs, pixelClusters: tamperedPixel }), /pixel master binding/);
const missingAnchorConsensus = structuredClone(anchorConsensus); missingAnchorConsensus.assets.pop();
assert.throws(() => solveContinuityAssignment({ ...solverInputs, anchorConsensus: missingAnchorConsensus }), /pixel-anchor consensus input/);
const tamperedAnchorConsensus = structuredClone(anchorConsensus); tamperedAnchorConsensus.assets[0].anchors[0].sources[0].description = 'catalog-only invented anchor';
assert.throws(() => solveContinuityAssignment({ ...solverInputs, anchorConsensus: tamperedAnchorConsensus }), /output hash mismatch|not present in authenticated visual vote/);
const missingLockedTaxonomy = structuredClone(lockedTaxonomyConsensus); missingLockedTaxonomy.assets.pop();
assert.throws(() => solveContinuityAssignment({ ...solverInputs, lockedTaxonomyConsensus: missingLockedTaxonomy }), /taxonomy consensus is missing or incomplete/);
const tamperedLockedTaxonomy = structuredClone(lockedTaxonomyConsensus); tamperedLockedTaxonomy.assets[0].taxonomy.speciesFamily = 'designed-attacker-family';
assert.throws(() => solveContinuityAssignment({ ...solverInputs, lockedTaxonomyConsensus: tamperedLockedTaxonomy }), /output hash mismatch|proof is incomplete/);

// Catalog prose/name/body-form/palette cannot influence anchors or prompts.
const poisonedCatalog = structuredClone(catalog);
for (const slot of poisonedCatalog) {
  slot.enName = 'CATALOG-NAME-ATTACK'; slot.koName = 'CATALOG-NAME-ATTACK'; slot.bodyForm = 'CATALOG-BODY-ATTACK';
  slot.shapeDNA = ['CATALOG-SHAPE-ATTACK']; slot.palette = { primary: 'CATALOG-PALETTE-ATTACK' };
}
const poisoned = solveContinuityAssignment({ ...solverInputs, catalog: poisonedCatalog, baselineCatalog: catalog });
assert.equal(canonicalString(poisoned.queue), canonicalString(solution.queue));
assert.equal(solution.queue.some((entry) => /CATALOG-(?:NAME|BODY|SHAPE|PALETTE)-ATTACK/.test(entry.deterministicPrompt)), false);

// Synthesized designed-* labels are rejected even if an attacker edits an exact assignment.
const designedTarget = structuredClone(safetyArgs);
const exactAssignment = designedTarget.manifest.assignments.find((entry) => entry.targetStatus === 'exact');
exactAssignment.targetTaxonomy.speciesFamily = 'designed-attacker-family';
assert.throws(() => assertAssignmentSafety(designedTarget), /invalid exact target/);

// Save map covers all ten mixed old/new ancestry domains and rejects each induced gap.
const saveMap = buildSaveRevisionMap(catalog, topologyBefore, solution.topology);
assert.equal(new Set(saveMap.mixedOrigins.map((item) => item.speciesId)).size, 10);
for (const speciesId of [...new Set(saveMap.mixedOrigins.map((item) => item.speciesId))]) {
  const gap = structuredClone(saveMap);
  const removed = gap.owned.findIndex((entry) => entry.from.speciesId === speciesId && entry.from.originKind === 'valid-root');
  gap.owned.splice(removed, 1);
  assert.throws(() => assertLosslessSaveRevisionMap(gap, { catalog, topologyBefore, topologyAfter: solution.topology }), /domain gap|coverage mismatch/);
}
const lossy = structuredClone(saveMap); lossy.owned[1].to = lossy.owned[0].to;
assert.throws(() => assertLosslessSaveRevisionMap(lossy), /duplicate owned reverse key/);

// Output destination symlink substitution is rejected before publication.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'continuity-output-test-'));
try {
  const output = path.join(temporary, 'output');
  await writeAtomicNoFollowForTest({ containmentRoot: temporary, outputRoot: output, name: 'proof.json', document: { safe: true }, beforeCommit: async ({ destination }) => symlink(path.join(temporary, 'attacker.json'), destination) })
    .then(() => assert.fail('symlink attack unexpectedly published'), (error) => assert.match(error.message, /symlinked/));
} finally { await rm(temporary, { recursive: true, force: true }); }

console.log(JSON.stringify({ status: 'ok-assignment-ready-art-pending', regenerationCount: solution.feasibility.regenerationCount, retainedCount: solution.feasibility.retainedCount, reviewedTaxonomyRoots: lockedTaxonomyConsensus.assets.length, pendingPixelTaxonomyFamilies: 0, pendingPixelTaxonomySlots: 0, pendingTaxonomyEdges: 0, incompatibleEdges: 0, blockedMixedConflicts: blockedMixed.length, visualReviewGate: solution.reviewCoverage.state }));
