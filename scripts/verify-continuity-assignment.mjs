#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUTPUT_ROOT, INPUTS, OUTPUT_NAMES } from './build-continuity-assignment.mjs';
import { blockedEvidenceSets, canonicalString, edgeKey, stableJson } from './lib/continuity-assignment/compatibility.mjs';
import { assertLosslessSaveRevisionMap, buildSaveRevisionMap } from './lib/continuity-assignment/save-space.mjs';
import { assertFrozenTopology, solveContinuityAssignment, visualAnchors } from './lib/continuity-assignment/solver.mjs';
import { verifyPublicEvidence } from './lib/g002-public-authority.mjs';
import { validateSignedCanonicalRootRedesignTargets } from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';
import { assertGenerationRunId } from './prepare-continuity-candidate-review.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readContainedNoFollow(relativePath) {
  const absolute = path.resolve(REPO_ROOT, relativePath); const relation = path.relative(REPO_ROOT, absolute);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`${relativePath}: path escapes repository`);
  let cursor = REPO_ROOT;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component); const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`${relativePath}: symlink rejected`);
  }
  const [rootReal, targetReal] = await Promise.all([realpath(REPO_ROOT), realpath(absolute)]);
  if (path.relative(rootReal, targetReal).startsWith('..')) throw new Error(`${relativePath}: resolved path escapes repository`);
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${relativePath}: hardlink/non-file rejected`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export function assertNoPass3SubstantiveOverride(census, ledger) {
  const assets = new Map(census.assets.map((asset) => [asset.pgId, asset]));
  for (const conflict of ledger.conflicts.filter((item) => item.kind === 'asset')) {
    const substantive = conflict.reasonClasses.some((reason) => /substantive|required-anchor|continuity|locomotion|core-anatomy/.test(reason));
    if (substantive && assets.get(conflict.pgId)?.derived?.verdict !== 'BLOCKED') throw new Error(`pass3 substantive override: ${conflict.pgId}`);
  }
}

export function assertLedgerIntegrity(ledger) {
  if (ledger.schemaVersion !== 'g001-unblinded-conflict-ledger-v1' || ledger.runId !== 'g001-baseline-v1'
      || ledger.verdict !== 'BLOCKED' || ledger.counts?.blocked !== 115 || ledger.counts?.assets !== 83
      || ledger.counts?.edges !== 32 || ledger.conflicts?.length !== 115) throw new Error('attacker-controlled or incomplete G001 ledger');
  return true;
}

export function assertAssignmentSafety({ manifest, census, ledger, taxonomyConsensus, topology }) {
  const blocked = blockedEvidenceSets(census, ledger); const consensusById = new Map(taxonomyConsensus.assets.map((item) => [item.pgId, item]));
  const usedHashes = new Set(); const assignments = new Map(manifest.assignments.map((item) => [item.slotId, item]));
  for (const assignment of manifest.assignments) {
    if (assignment.targetStatus === 'exact') assert.ok(assignment.targetTaxonomy && Object.values(assignment.targetTaxonomy).every((value) => typeof value === 'string' && !/^(?:unknown(?:-|$)|designed-)/i.test(value)), `${assignment.slotId}: invalid exact target`);
    else if (assignment.targetStatus === 'pending-pixel-taxonomy') {
      if (assignment.targetTaxonomy !== null || assignment.sourceKind !== 'regenerate') throw new Error(`${assignment.slotId}: pending taxonomy must be null and regenerate`);
    } else throw new Error(`${assignment.slotId}: invalid target status`);
    if (assignment.sourceKind === 'existing') {
      if (blocked.blockedHashes.has(assignment.assetSha256)) throw new Error(`blocked hash reused: ${assignment.slotId}`);
      if (consensusById.get(assignment.slotId).disposition !== 'reusable') throw new Error(`unproven asset retained: ${assignment.slotId}`);
      if (usedHashes.has(assignment.assetSha256)) throw new Error(`duplicate asset use: ${assignment.assetSha256}`);
      usedHashes.add(assignment.assetSha256);
      assert.equal(assignment.source, assignment.slotId, `unproven cross-slot reuse: ${assignment.slotId}`);
    } else assert.equal(assignment.source, `REGEN(${assignment.slotId})`, `invalid regeneration source: ${assignment.slotId}`);
  }
  for (const edge of topology.edges) {
    const parentTarget = assignments.get(edge.parentId).targetTaxonomy; const childTarget = assignments.get(edge.childId).targetTaxonomy;
    if (edge.compatibilityStatus === 'VERIFIED_PIXEL_VOTE_TARGET') {
      if (!parentTarget || canonicalString(parentTarget) !== canonicalString(childTarget) || edge.targetCompatible !== true) throw new Error(`incompatible target edge: ${edge.parentId}=>${edge.childId}`);
    } else if (edge.compatibilityStatus === 'VERIFIED_MIXED_PARENT_ANCHOR_CONTRACT') {
      if (!parentTarget || !childTarget || edge.targetCompatible !== true) throw new Error(`incomplete mixed anchor edge: ${edge.parentId}=>${edge.childId}`);
    } else if (edge.compatibilityStatus === 'PENDING_PIXEL_TAXONOMY') {
      if (parentTarget && childTarget) throw new Error(`fake pending edge proof: ${edge.parentId}=>${edge.childId}`);
      if (edge.targetCompatible !== false) throw new Error(`fake compatible pending edge: ${edge.parentId}=>${edge.childId}`);
    } else throw new Error(`incompatible edge state: ${edge.parentId}=>${edge.childId}`);
    const key = edgeKey([edge.parentId], edge.childId);
    if (blocked.blockedEdges.has(key) && assignments.get(edge.childId).sourceKind !== 'regenerate') throw new Error(`blocked edge retained: ${key}`);
  }
  for (const conflict of ledger.conflicts.filter((item) => item.kind === 'edge')) {
    if (assignments.get(conflict.child.pgId).sourceKind !== 'regenerate') throw new Error(`blocked edge child retained: ${conflict.child.pgId}`);
  }
  return true;
}

const G003_PUBLIC_ROOT = 'production/reports/biological-continuity-v3/g003-evidence-v1/';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shaPattern = /^[a-f0-9]{64}$/;
const isSha256 = (value) => typeof value === 'string' && shaPattern.test(value);
const canonicalSha256 = (value) => sha256(Buffer.from(canonicalString(value)));

function assertG003PublicPath(relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith(G003_PUBLIC_ROOT)
      || relativePath.includes('\\') || path.posix.normalize(relativePath) !== relativePath
      || relativePath.split('/').includes('..')) throw new Error(`${label}: G003 artifact path is not public, versioned, and canonical`);
}

async function readG003File(relativePath, expectedByteSha256, label) {
  assertG003PublicPath(relativePath, label);
  if (!isSha256(expectedByteSha256)) throw new Error(`${label}: missing persisted artifact SHA-256`);
  let bytes;
  try { bytes = await readContainedNoFollow(relativePath); } catch (error) { throw new Error(`${label}: persisted artifact is missing or unsafe (${error.message})`); }
  if (sha256(bytes) !== expectedByteSha256) throw new Error(`${label}: persisted artifact byte hash mismatch`);
  return bytes;
}

function verifySignedDocument(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: signed JSON object required`);
  const unsigned = structuredClone(value); delete unsigned.publicSignature;
  verifyPublicEvidence(unsigned, value.publicSignature);
  if (!isSha256(unsigned.outputSha256)) throw new Error(`${label}: signed output hash missing`);
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (unsigned.outputSha256 !== canonicalSha256(core)) throw new Error(`${label}: signed output hash mismatch`);
  return { unsigned, signatureSha256: canonicalSha256(value.publicSignature) };
}

async function readJsonArtifact(reference, label) {
  const bytes = await readG003File(reference?.path, reference?.sha256, label);
  let value;
  try { value = JSON.parse(bytes); } catch { throw new Error(`${label}: persisted artifact is not JSON`); }
  return { bytes, value };
}

function exactSet(actual, expected) {
  return canonicalString([...actual].sort()) === canonicalString([...expected].sort());
}

async function verifyPersistedCandidateEvidence(candidate, reviewCoverage) {
  const evidence = candidate.reviewEvidence;
  if (!evidence || !isSha256(evidence.reviewArtifactSha256)) throw new Error(`${candidate.candidateId ?? candidate.edgeId}: PASS lacks persisted public review evidence`);
  const lockedEilu = reviewCoverage.eiluBenchmark;
  const expectedEiluHashes = lockedEilu.pixelBindings.flatMap((entry) => [entry.masterSha256, entry.runtimeSha256]);
  if (evidence.eiluEvidence?.benchmarkId !== lockedEilu.benchmarkId || evidence.eiluEvidence.passed !== true
      || !exactSet(evidence.eiluEvidence.inputAssetSha256s ?? [], expectedEiluHashes)) throw new Error(`${candidate.candidateId ?? candidate.edgeId}: fake or incomplete locked Eilu evidence`);
  const { value: artifact } = await readJsonArtifact({ path: evidence.reviewArtifactPath, sha256: evidence.reviewArtifactSha256 }, `${candidate.candidateId ?? candidate.edgeId} review artifact`);
  verifySignedDocument(artifact, `${candidate.candidateId ?? candidate.edgeId} review artifact`);
  assertGenerationRunId(artifact?.generationRunId, `${candidate.candidateId ?? candidate.edgeId} review artifact generationRunId`);
  const expectedCandidateId = candidate.candidateId ?? `g003-candidate:${candidate.childId}`;
  const expectedRequirementId = candidate.candidateId ?? candidate.edgeId;
  const expectedKind = candidate.candidateId ? 'queue' : 'edge';
  if (artifact.schemaVersion !== 'continuity-g003-public-review-artifact-v1' || artifact.candidateId !== expectedCandidateId
      || artifact.reviewKind !== expectedKind || artifact.edgeId !== (candidate.edgeId ?? null)) throw new Error(`${expectedCandidateId}: public review artifact identity mismatch`);

  const [{ value: manifest }, { value: binding }, { value: allowlist }, promptBytes] = await Promise.all([
    readJsonArtifact(artifact.packageManifest, `${expectedCandidateId} package manifest`),
    readJsonArtifact(artifact.materialBinding, `${expectedCandidateId} material binding`),
    readJsonArtifact(artifact.inputAllowlist, `${expectedCandidateId} input allowlist`),
    readG003File(artifact.prompt?.path, artifact.prompt?.sha256, `${expectedCandidateId} prompt`),
  ]);
  const packageManifestSha256 = canonicalSha256(manifest); const materialBindingSha256 = canonicalSha256(binding);
  const inputAllowlistSha256 = canonicalSha256(allowlist); const promptSha256 = sha256(promptBytes);
  assertGenerationRunId(manifest?.generationRunId, `${expectedCandidateId} package generationRunId`);
  assertGenerationRunId(binding?.generationRunId, `${expectedCandidateId} binding generationRunId`);
  if (manifest.generationRunId !== artifact.generationRunId || binding.generationRunId !== artifact.generationRunId
      || packageManifestSha256 !== evidence.packageManifestSha256 || materialBindingSha256 !== evidence.materialBindingSha256
      || inputAllowlistSha256 !== evidence.inputAllowlistSha256 || promptSha256 !== evidence.promptSha256
      || binding.candidateId !== expectedRequirementId || binding.packageManifestSha256 !== packageManifestSha256
      || binding.allowlistSha256 !== inputAllowlistSha256 || binding.promptSha256 !== promptSha256
      || manifest.allowlistSha256 !== inputAllowlistSha256 || manifest.promptSha256 !== promptSha256) throw new Error(`${expectedCandidateId}: package/material/allowlist/prompt binding mismatch`);

  if (!Array.isArray(artifact.childPixels) || artifact.childPixels.length !== 2) throw new Error(`${expectedCandidateId}: candidate master/runtime pixels missing`);
  const childHashes = [];
  for (const surface of ['master', 'runtime']) {
    const pixel = artifact.childPixels.find((entry) => entry.surface === surface);
    if (!pixel) throw new Error(`${expectedCandidateId}: ${surface} candidate pixel missing`);
    const bytes = await readG003File(pixel.path, pixel.sha256, `${expectedCandidateId} ${surface} pixel`);
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error(`${expectedCandidateId}: ${surface} candidate material is not PNG`);
    childHashes.push(pixel.sha256);
  }
  if (!exactSet(childHashes, evidence.approvedChildPixelSha256s)) throw new Error(`${expectedCandidateId}: approved candidate pixel hashes mismatch`);
  const allowlistedFiles = new Map(allowlist.files?.map((file) => [file.path, file.sha256]) ?? []);
  if (!Array.isArray(allowlist.files) || allowlistedFiles.size !== allowlist.files.length) throw new Error(`${expectedCandidateId}: locked allowlist is missing or duplicated`);
  for (const file of allowlist.files) await readG003File(file.path, file.sha256, `${expectedCandidateId} allowlisted material`);
  for (const pixel of artifact.childPixels) if (allowlistedFiles.get(pixel.path) !== pixel.sha256) throw new Error(`${expectedCandidateId}: candidate pixel is absent from locked allowlist`);

  if (!Array.isArray(artifact.eiluPixels) || artifact.eiluPixels.length !== 6) throw new Error(`${expectedCandidateId}: fake or incomplete locked Eilu evidence`);
  for (const bindingEntry of lockedEilu.pixelBindings) {
    for (const surface of ['master', 'runtime']) {
      const expectedHash = bindingEntry[`${surface}Sha256`];
      const pixel = artifact.eiluPixels.find((entry) => entry.pgId === bindingEntry.pgId && entry.surface === surface);
      if (!pixel || pixel.sha256 !== expectedHash || allowlistedFiles.get(pixel.path) !== expectedHash) throw new Error(`${expectedCandidateId}: Eilu pixel binding mismatch`);
      const bytes = await readG003File(pixel.path, pixel.sha256, `${expectedCandidateId} Eilu ${bindingEntry.pgId} ${surface}`);
      if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error(`${expectedCandidateId}: Eilu material is not PNG`);
    }
  }
  const scores = evidence.eiluEvidence.perStageScores;
  if (!Array.isArray(scores) || scores.length !== 3 || scores.some((score) => score < lockedEilu.minimumConfidence)
      || evidence.eiluEvidence.minimumScore !== Math.min(...scores)
      || canonicalString(artifact.comparisonThresholds) !== canonicalString(candidate.comparisonThresholds)
      || artifact.comparisonThresholds.minimumConfidence !== lockedEilu.minimumConfidence
      || artifact.comparisonThresholds.minimumAnchorRetentionRatio !== lockedEilu.minimumAnchorRetentionRatio) throw new Error(`${expectedCandidateId}: Eilu thresholds or scores are not locked`);

  if (!Array.isArray(artifact.votes) || artifact.votes.length !== 2) throw new Error(`${expectedCandidateId}: exactly two public vote artifacts required`);
  const reviews = []; const signedEiluComparisons = [];
  for (const reference of artifact.votes) {
    const { value: vote } = await readJsonArtifact(reference, `${expectedCandidateId} vote`);
    const signed = verifySignedDocument(vote, `${expectedCandidateId} vote`);
    assertGenerationRunId(vote?.generationRunId, `${expectedCandidateId} vote generationRunId`);
    if (vote.schemaVersion !== 'continuity-candidate-primary-vote-v1' || vote.role !== 'primary' || vote.fresh !== true || vote.blinded !== true
        || vote.generationRunId !== artifact.generationRunId || vote.confidence < lockedEilu.minimumConfidence
        || vote.opaqueCandidateId !== artifact.opaqueCandidateId || vote.packageManifestSha256 !== packageManifestSha256
        || vote.materialBindingSha256 !== materialBindingSha256 || vote.inputAllowlistSha256 !== inputAllowlistSha256
        || vote.promptSha256 !== promptSha256 || !exactSet(vote.inputAssetSha256s ?? [], [...allowlistedFiles.values()])) throw new Error(`${expectedCandidateId}: signed vote provenance mismatch`);
    const comparison = vote.observation?.eiluComparison;
    const expectedStagePairs = lockedEilu.pixelBindings.map((entry) => `${entry.masterSha256}:${entry.runtimeSha256}`);
    const actualStagePairs = comparison?.stageObservations?.map((entry) => `${entry.masterSha256}:${entry.runtimeSha256}`) ?? [];
    if (comparison?.benchmarkId !== lockedEilu.benchmarkId || comparison.sameCreatureGrownUp !== 'yes'
        || comparison.candidateContinuityScore < lockedEilu.minimumConfidence || comparison.retainedAnchorCount < lockedEilu.minimumRetainedAnchorCount
        || comparison.anchorRetentionRatio < lockedEilu.minimumAnchorRetentionRatio || !exactSet(actualStagePairs, expectedStagePairs)
        || comparison.stageObservations.some((stage) => stage.continuityScore < lockedEilu.minimumConfidence || typeof stage.observation !== 'string' || !stage.observation.trim())) throw new Error(`${expectedCandidateId}: signed vote does not pass locked Eilu pixels/thresholds`);
    signedEiluComparisons.push(comparison);
    reviews.push({ reviewId: vote.reviewId, reviewerInstanceId: vote.reviewerInstanceId, agentTaskId: vote.agentTaskId,
      voterReviewRunId: vote.voterReviewRunId, passNumber: vote.passNumber, outputSha256: vote.outputSha256, signatureSha256: signed.signatureSha256 });
  }
  for (const field of ['reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber']) {
    if (new Set(reviews.map((review) => review[field])).size !== 2) throw new Error(`${expectedCandidateId}: public votes are not independent`);
  }
  if (!exactSet(reviews.map((review) => review.reviewId), evidence.sourceReviewIds)
      || !exactSet(reviews.map((review) => review.outputSha256), evidence.sourceReviewOutputSha256s)
      || !exactSet(reviews.map((review) => review.signatureSha256), evidence.sourceReviewSignatureSha256s)) throw new Error(`${expectedCandidateId}: vote output/signature summary mismatch`);
  if (canonicalString(signedEiluComparisons[0]) !== canonicalString(signedEiluComparisons[1])
      || !exactSet(signedEiluComparisons[0].stageObservations.map((stage) => stage.continuityScore), scores)) throw new Error(`${expectedCandidateId}: Eilu evidence is not derived from agreeing signed votes`);
  return { artifact, artifactByteSha256: evidence.reviewArtifactSha256, reviewSha256: artifact.review.sha256, childHashes };
}

export async function deriveReviewCoverageState(reviewCoverage) {
  const queueResults = new Map(); let queuePassed = 0;
  for (const candidate of reviewCoverage.queueCandidates) {
    if (candidate.status !== 'PASS') continue;
    if (!candidate.allowedAnchors.every((anchor) => typeof anchor.description === 'string' && anchor.description.length >= 3 && anchor.sourceReviewId)) throw new Error(`${candidate.candidateId}: PASS retains unresolved anchors`);
    queueResults.set(candidate.candidateId, await verifyPersistedCandidateEvidence(candidate, reviewCoverage)); queuePassed += 1;
  }
  let edgePassed = 0;
  for (const candidate of reviewCoverage.edgeCandidates) {
    if (candidate.status !== 'PASS') continue;
    const evidence = candidate.reviewEvidence;
    const result = await verifyPersistedCandidateEvidence(candidate, reviewCoverage);
    if (evidence.edgeId !== candidate.edgeId || !Array.isArray(evidence.parentEvidence)
        || evidence.parentEvidence.length !== candidate.allowedParentAnchors.length) throw new Error(`${candidate.edgeId}: parent evidence coverage mismatch`);
    for (const requiredParent of candidate.allowedParentAnchors) {
      const actual = evidence.parentEvidence.find((parent) => parent.parentId === requiredParent.parentId && parent.parentRole === requiredParent.parentRole);
      if (!actual || !Array.isArray(actual.parentPixelSha256s) || actual.parentPixelSha256s.length !== 2) throw new Error(`${candidate.edgeId}: parent pixels missing`);
      if (requiredParent.sourceKind === 'generated-parent-candidate') {
        const approved = queueResults.get(requiredParent.approvedParentCandidateId);
        if (!approved || actual.approvedParentCandidateId !== requiredParent.approvedParentCandidateId
            || actual.approvedParentReviewSha256 !== approved.reviewSha256
            || !exactSet(actual.parentPixelSha256s, approved.childHashes)) throw new Error(`${candidate.edgeId}: generated parent is not bound to an approved persisted candidate`);
      } else if (actual.approvedParentCandidateId !== null || actual.approvedParentReviewSha256 !== null) throw new Error(`${candidate.edgeId}: retained parent claims generated evidence`);
      if (!actual.anchors?.every((anchor) => anchor.anchorKey === `${actual.parentId}:${anchor.anchorId}` && anchor.parentRole === actual.parentRole
        && typeof anchor.description === 'string' && anchor.description.length >= 3 && anchor.sourceReviewId)) throw new Error(`${candidate.edgeId}: parent anchors are incomplete`);
    }
    if (canonicalString(result.artifact.parentEvidence) !== canonicalString(evidence.parentEvidence)) throw new Error(`${candidate.edgeId}: signed artifact parent evidence mismatch`);
    edgePassed += 1;
  }
  const requiredQueueCandidates = reviewCoverage.queueCandidates.length; const requiredFinalEdges = reviewCoverage.edgeCandidates.length;
  const missingCoverage = requiredQueueCandidates + requiredFinalEdges - queuePassed - edgePassed;
  return {
    state: missingCoverage === 0 ? 'PASS' : 'PENDING_G003_REVIEW', completionAllowed: missingCoverage === 0,
    coverage: { requiredQueueCandidates, passedQueueCandidates: queuePassed, requiredFinalEdges, passedFinalEdges: edgePassed, missingCoverage },
  };
}

export async function assertSolutionProofs(solution, pins, anchorConsensus, { census, taxonomyConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets }) {
  if (solution.feasibility?.assignmentReadiness !== 'ASSIGNMENT_READY_PENDING_VISUAL_REVIEW'
      || !['PENDING_G003_REVIEW', 'PASS'].includes(solution.feasibility?.artVerificationState)) throw new Error('false art verification completion claim');
  if (solution.familyProofs.length !== 60 || solution.familyProofs.some((proof) => !proof.slots.length || !proof.exactCompatible
      || !['TARGET_FROZEN_FROM_LOCKED_STAGE_1_ROOT_PIXELS', 'TARGET_FROZEN_FROM_AUTHENTICATED_STAGE_1_ROOT_PIXELS', 'TARGET_FROM_SIGNED_CANONICAL_ROOT_REDESIGN_CONTRACT'].includes(proof.proofStatus)
      || proof.slots.some((slot) => canonicalString(slot.targetTaxonomy) !== canonicalString(proof.targetTaxonomy)))) throw new Error('empty, flipped, or incompatible root-frozen family proof');
  const lockedTaxonomyById = new Map(lockedTaxonomyConsensus.assets.map((asset) => [asset.pgId, asset.taxonomy]));
  const taxonomyById = new Map(taxonomyConsensus.assets.map((asset) => [asset.pgId, asset.taxonomy]));
  const censusByPgId = new Map(census.assets.map((asset) => [asset.pgId, asset]));
  const canonicalTargets = validateSignedCanonicalRootRedesignTargets(canonicalRootRedesignTargets);
  const concrete = (taxonomy) => taxonomy && ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'].every((field) => typeof taxonomy[field] === 'string' && !/^(?:unknown|designed-)/i.test(taxonomy[field]));
  for (const proof of solution.familyProofs) {
    const canonicalContract = canonicalTargets.byRootId.get(proof.rootId);
    let expected = canonicalContract?.canonicalTarget ?? lockedTaxonomyById.get(proof.rootId) ?? taxonomyById.get(proof.rootId);
    if (!concrete(expected)) expected = censusByPgId.get(proof.rootId).primaryObservations
      .filter((review) => concrete(review.observation)).sort((a, b) => b.confidence - a.confidence
        || canonicalString(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'].map((field) => a.observation[field]))
          .localeCompare(canonicalString(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'].map((field) => b.observation[field]))))[0]?.observation;
    const expectedTuple = expected && Object.fromEntries(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'].map((field) => [field, expected[field]]));
    if (!expectedTuple || canonicalString(proof.targetTaxonomy) !== canonicalString(expectedTuple)) throw new Error(`root taxonomy flip: ${proof.rootId}`);
    if (canonicalContract && (proof.proofStatus !== 'TARGET_FROM_SIGNED_CANONICAL_ROOT_REDESIGN_CONTRACT'
        || proof.canonicalRedesignEvidence?.contractOutputSha256 !== canonicalTargets.outputSha256
        || proof.canonicalRedesignEvidence.currentPixelAssessment !== 'DISPUTED_OR_AMBIGUOUS')) throw new Error(`canonical redesign proof missing: ${proof.rootId}`);
  }
  if (solution.topology.edges.length !== 190 || solution.topology.edges.some((edge) => !['VERIFIED_PIXEL_VOTE_TARGET', 'VERIFIED_MIXED_PARENT_ANCHOR_CONTRACT', 'PENDING_PIXEL_TAXONOMY'].includes(edge.compatibilityStatus))) throw new Error('empty or incompatible edge proof');
  if (solution.assignments.some((assignment) => assignment.targetStatus !== 'exact' || !assignment.targetTaxonomy)
      || solution.topology.edges.some((edge) => !['VERIFIED_PIXEL_VOTE_TARGET', 'VERIFIED_MIXED_PARENT_ANCHOR_CONTRACT'].includes(edge.compatibilityStatus) || edge.targetCompatible !== true)
      || solution.feasibility.pendingPixelTaxonomyFamilyCount !== 0 || solution.feasibility.pendingPixelTaxonomySlotCount !== 0
      || solution.feasibility.pendingTaxonomyEdgeCount !== 0) throw new Error('reviewed taxonomy consensus was not fully integrated');
  if (canonicalString(solution.pinsProof.positiveControl) !== canonicalString(pins.positiveControl)
      || canonicalString(solution.pinsProof.fixtures) !== canonicalString(pins.fixtures)
      || solution.pinsProof.eiluBenchmark?.comparisonRequirements?.compareAgainstBenchmark !== true
      || solution.pinsProof.eiluBenchmark?.minimumConfidence < 0.85) throw new Error('fake Eilu or diagnostic pin proof');
  const orderBySlot = new Map(solution.queue.map((entry) => [entry.slotId, entry.generationOrder]));
  const assignmentBySlot = new Map(solution.assignments.map((entry) => [entry.slotId, entry]));
  for (const [rootId, contract] of canonicalTargets.byRootId) {
    const proof = solution.familyProofs.find((entry) => entry.rootId === rootId);
    for (const slot of proof.slots) {
      const assignment = assignmentBySlot.get(slot.slotId); const queueEntry = solution.queue.find((entry) => entry.slotId === slot.slotId);
      if (assignment.sourceKind !== 'regenerate' || canonicalString(assignment.targetTaxonomy) !== canonicalString(contract.canonicalTarget)
          || assignment.targetEvidence.targetSource !== 'signed-canonical-root-redesign-contract'
          || assignment.targetEvidence.canonicalContractOutputSha256 !== canonicalTargets.outputSha256
          || !queueEntry || queueEntry.taxonomyTargetSource !== 'signed-canonical-root-redesign-contract'
          || canonicalString(queueEntry.exactTaxonomyTarget) !== canonicalString(contract.canonicalTarget)) throw new Error(`canonical redesign descendant retained or relabeled: ${slot.slotId}`);
    }
    const rootQueue = solution.queue.find((entry) => entry.slotId === rootId);
    if (canonicalString(rootQueue.designAnchors.map(({ anchorId, description }) => ({ anchorId, description }))) !== canonicalString(contract.anchors)
        || rootQueue.designAnchors.some((anchor) => anchor.sourceKind !== 'signed-canonical-root-redesign-contract'
          || anchor.resolutionState !== 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET')
        || contract.clarificationRequirements.some((requirement) => !rootQueue.visibilityClarificationRequirements.includes(requirement))) throw new Error(`canonical redesign anchors/visibility mismatch: ${rootId}`);
  }
  if (solution.queue.some((entry) => entry.targetStatus !== 'exact' || !entry.exactTaxonomyTarget
      || entry.parentReferences.length !== entry.parentIds.length
      || (entry.parentIds.length === 0 ? entry.designAnchors.length < 3 : entry.designAnchors.length !== 0)
      || (entry.parentIds.length > 0 && entry.parentIds.some((id) => entry.inheritedAnchorContracts.filter((anchor) => anchor.parentId === id).length < (entry.frozen.category === 'mixed' ? 2 : 3)))
      || entry.parentIds.length === 2 && new Set(entry.inheritedAnchorContracts.map((anchor) => anchor.anchorKey)).size !== entry.inheritedAnchorContracts.length
      || entry.allowedReviewerAnchorIds.length !== new Set(entry.allowedReviewerAnchorIds).size
      || entry.parentReferences.some((reference) => {
        const contracts = entry.inheritedAnchorContracts.filter((anchor) => anchor.parentId === reference.parentId);
        if (reference.sourceKind === 'existing-image') return !reference.imagePath || !/^[a-f0-9]{64}$/.test(reference.imageSha256)
          || contracts.some((anchor) => anchor.sourceKind !== 'retained-parent-pixels' || !anchor.description || !anchor.sourceReviewId || anchor.resolutionState !== 'RESOLVED_AUTHENTICATED_PIXELS');
        return reference.sourceKind !== 'generated-parent-candidate' || reference.dependencySlotId !== reference.parentId
          || reference.dependencyCandidateId !== `g003-candidate:${reference.parentId}` || reference.requiredCandidateReviewState !== 'PASS'
          || reference.requiredParentCandidateId !== reference.dependencyCandidateId
          || reference.approvedParentReviewSha256 !== null || reference.approvedParentPixelSha256s !== null
          || !orderBySlot.has(reference.dependencySlotId) || orderBySlot.get(reference.dependencySlotId) >= entry.generationOrder
          || contracts.some((anchor) => anchor.sourceKind !== 'generated-parent-candidate' || anchor.description !== null
            || anchor.sourceReviewId !== null || anchor.sourceConfidence !== null || anchor.resolutionState !== 'PENDING_APPROVED_PARENT_REVIEW'
            || anchor.dependencyCandidateId !== reference.dependencyCandidateId);
      })
      || (entry.parentReferences.some((reference) => reference.sourceKind === 'generated-parent-candidate')
        ? entry.generationState !== 'BLOCKED_PENDING_PARENT_CANDIDATE_APPROVAL'
        : entry.generationState !== 'READY_FOR_GENERATION'))) throw new Error('non-executable or stale-parent regeneration proof');
  const derivedCoverage = await deriveReviewCoverageState(solution.reviewCoverage);
  if (solution.reviewCoverage?.state !== derivedCoverage.state || solution.reviewCoverage?.completionAllowed !== derivedCoverage.completionAllowed
      || canonicalString(solution.reviewCoverage?.coverage) !== canonicalString(derivedCoverage.coverage)
      || solution.feasibility.artVerificationState !== (derivedCoverage.completionAllowed ? 'PASS' : 'PENDING_G003_REVIEW')
      || solution.reviewCoverage?.coverage?.requiredQueueCandidates !== solution.queue.length
      || solution.reviewCoverage?.coverage?.requiredFinalEdges !== 190 || solution.reviewCoverage.queueCandidates?.length !== solution.queue.length
      || solution.reviewCoverage.edgeCandidates?.length !== 190) throw new Error('incomplete or falsely passing global review coverage gate');
  const queueBySlot = new Map(solution.queue.map((entry) => [entry.slotId, entry]));
  const censusById = new Map(anchorConsensus.assets.map((asset) => [asset.pgId, asset]));
  for (const candidate of solution.reviewCoverage.queueCandidates) {
    const queueEntry = queueBySlot.get(candidate.slotId);
    const queueAnchors = queueEntry.parentIds.length ? queueEntry.inheritedAnchorContracts : queueEntry.designAnchors;
    const expectedAnchors = queueAnchors.map((anchor) => ({
      anchorKey: anchor.anchorKey, parentRole: anchor.parentRole ?? null, parentId: anchor.parentId ?? null,
      anchorId: anchor.anchorId, description: anchor.description, sourceReviewId: anchor.sourceReviewId,
      sourceConfidence: anchor.sourceConfidence, resolutionState: anchor.resolutionState,
      dependencyCandidateId: anchor.dependencyCandidateId ?? null,
    }));
    if (canonicalString(candidate.allowedAnchorIds) !== canonicalString(expectedAnchors.map((anchor) => anchor.anchorKey).sort())
        || canonicalString(candidate.allowedAnchors) !== canonicalString(expectedAnchors)) throw new Error(`arbitrary reviewer anchors: ${candidate.slotId}`);
  }
  const edgesById = new Map(solution.topology.edges.map((edge) => [`g003-edge:${edge.parentId}:${edge.childId}`, edge]));
  for (const candidate of solution.reviewCoverage.edgeCandidates) {
    const edge = edgesById.get(candidate.edgeId);
    if (!edge || edge.parentId !== candidate.parentId || edge.childId !== candidate.childId) throw new Error(`arbitrary review edge: ${candidate.edgeId}`);
    const childParents = solution.topology.slots.find((slot) => slot.id === candidate.childId).parentIds;
    const requiredParentIds = edge.category === 'mixed' ? childParents : [candidate.parentId];
    if (canonicalString(candidate.allowedParentAnchors.map((parent) => parent.parentId)) !== canonicalString(requiredParentIds)) throw new Error(`mixed parent evidence coverage mismatch: ${candidate.edgeId}`);
    for (const parent of candidate.allowedParentAnchors) {
      const parentRole = `parent-${childParents.indexOf(parent.parentId) + 1}`;
      if (parent.parentRole !== parentRole || parent.anchors.length < 2
          || new Set(parent.anchors.map((anchor) => anchor.anchorKey)).size !== parent.anchors.length
          || parent.anchors.some((anchor) => anchor.anchorKey !== `${parent.parentId}:${anchor.anchorId}` || anchor.parentRole !== parentRole || anchor.parentId !== parent.parentId)) throw new Error(`arbitrary or unqualified parent review anchors: ${candidate.edgeId}`);
      const parentAssignment = solution.assignments.find((assignment) => assignment.slotId === parent.parentId);
      if (parentAssignment.sourceKind === 'regenerate') {
        if (parent.sourceKind !== 'generated-parent-candidate' || parent.approvedParentCandidateId !== `g003-candidate:${parent.parentId}`
            || parent.parentPixelSha256s !== null || parent.anchors.some((anchor) => anchor.description !== null || anchor.resolutionState !== 'PENDING_APPROVED_PARENT_REVIEW')) throw new Error(`old-slot anchor leakage: ${candidate.edgeId}`);
      } else {
        const anchors = visualAnchors(censusById.get(parent.parentId));
        if (parent.sourceKind !== 'retained-parent-pixels' || canonicalString(parent.parentPixelSha256s) !== canonicalString([censusById.get(parent.parentId).surfaces.master.sha256, censusById.get(parent.parentId).surfaces.runtime.sha256])
            || canonicalString(parent.anchors.map((anchor) => [anchor.anchorId, anchor.description])) !== canonicalString(anchors.map((anchor) => [anchor.anchorId, anchor.description]))) throw new Error(`retained parent anchor mismatch: ${candidate.edgeId}`);
      }
    }
    if (canonicalString(candidate.allowedParentAnchorIds) !== canonicalString(candidate.allowedParentAnchors.map((parent) => ({ parentRole: parent.parentRole, parentId: parent.parentId, anchorIds: parent.anchors.map((anchor) => anchor.anchorKey) })))) throw new Error(`arbitrary parent anchor IDs: ${candidate.edgeId}`);
  }
  return true;
}

function expectedDocuments(solution, saveMap, census, ledger) {
  const blocked = blockedEvidenceSets(census, ledger);
  return {
    'compatibility-ledger.json': {
      schemaVersion: 'continuity-compatibility-ledger-g002-v1', policy: 'fail-closed-root-frozen-family-and-mixed-anchor-contract',
      blockedAssetIds: [...blocked.blockedAssetIds].sort(), blockedAssetHashes: [...blocked.blockedHashes].sort(), blockedEdges: [...blocked.blockedEdges].sort(),
      familyProofs: solution.familyProofs, pinsProof: solution.pinsProof,
      edgeProofs: solution.topology.edges.map((edge) => ({ parentId: edge.parentId, childId: edge.childId, targetCompatible: edge.targetCompatible, compatibilityStatus: edge.compatibilityStatus })),
      decisions: solution.assignments.map((entry) => ({ slotId: entry.slotId, disposition: entry.sourceKind, source: entry.source, targetTaxonomy: entry.targetTaxonomy })),
    },
    'topology-after.json': solution.topology,
    'assignment-manifest.json': { schemaVersion: 'continuity-assignment-v1', runId: 'g002-v1', verdict: solution.feasibility.verdict, reviewCoverageManifest: solution.reviewCoverage, assignments: solution.assignments },
    'save-revision-map.json': saveMap,
    'regeneration-queue.json': { schemaVersion: 'continuity-regeneration-queue-g002-v1', runId: 'g002-v1', entries: solution.queue },
    'feasibility-report.json': { schemaVersion: 'continuity-feasibility-g002-v1', runId: 'g002-v1', ...solution.feasibility },
  };
}

export async function verifyContinuityAssignment() {
  const rawInputs = {};
  for (const [key, inputPath] of Object.entries(INPUTS)) {
    const bytes = await readContainedNoFollow(inputPath);
    rawInputs[key] = { bytes, json: JSON.parse(bytes), sha256: sha256(bytes), path: inputPath };
  }
  const { catalog, census, conflictLedger: ledger, inputLock: lock, taxonomyConsensus, pixelClusters, anchorConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets, topologyContract, pins } = Object.fromEntries(Object.entries(rawInputs).map(([key, value]) => [key, value.json]));
  assertFrozenTopology(catalog);
  assertLedgerIntegrity(ledger);
  assertNoPass3SubstantiveOverride(census, ledger);
  if (canonicalString(taxonomyConsensus.counts) !== canonicalString({ reusable: 145, reviewRequired: 33, reviewEvidenceOnly: 21, reviewPassUnknown: 12, regenerateRequired: 62 })) throw new Error('taxonomy consensus count drift');
  for (const binding of lock.inputs) assert.equal(sha256(await readContainedNoFollow(binding.path)), binding.sha256, `locked input stale: ${binding.path}`);
  assert.deepEqual(lock.inputs.find((entry) => entry.path === INPUTS.anchorConsensus), { path: INPUTS.anchorConsensus, sha256: rawInputs.anchorConsensus.sha256 }, 'G001 pixel-anchor consensus is not locked');
  assert.deepEqual(lock.inputs.find((entry) => entry.path === INPUTS.lockedTaxonomyConsensus), { path: INPUTS.lockedTaxonomyConsensus, sha256: rawInputs.lockedTaxonomyConsensus.sha256 }, 'reviewed G002 taxonomy consensus is not locked');
  assert.deepEqual(lock.inputs.find((entry) => entry.path === INPUTS.canonicalRootRedesignTargets), { path: INPUTS.canonicalRootRedesignTargets, sha256: rawInputs.canonicalRootRedesignTargets.sha256 }, 'signed canonical root redesign targets are not locked');
  assert.equal(anchorConsensus.sourceCensusSha256, rawInputs.census.sha256, 'G001 pixel-anchor consensus census binding is stale');
  const generated = new Map(lock.generatedArtifacts.map((item) => [item.path, item.sha256]));
  for (const [name, key] of [['asset-census.json', 'taxonomyConsensus'], ['pixel-clusters.json', 'pixelClusters'], ['topology-before.json', 'topologyContract'], ['pins.json', 'pins']]) assert.equal(generated.get(name), rawInputs[key].sha256, `${name}: lock mismatch`);
  for (const fixture of pins.fixtures) assert.equal(sha256(await readContainedNoFollow(fixture.screenshotPath)), fixture.screenshotSha256, `${fixture.fixtureId}: screenshot stale`);

  const solution = solveContinuityAssignment({ catalog, census, conflictLedger: ledger, taxonomyConsensus, pixelClusters, anchorConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets, topologyContract, pins });
  await assertSolutionProofs(solution, pins, anchorConsensus, { census, taxonomyConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets });
  const expectedSave = buildSaveRevisionMap(catalog, topologyContract, solution.topology);
  const expected = expectedDocuments(solution, expectedSave, census, ledger);
  const outputs = {};
  for (const name of OUTPUT_NAMES) {
    const relative = `${DEFAULT_OUTPUT_ROOT}/${name}`; const bytes = await readContainedNoFollow(relative);
    outputs[name] = { bytes, json: JSON.parse(bytes) };
  }
  const attestation = outputs['output-attestation.json'].json;
  for (const [key, input] of Object.entries(rawInputs)) assert.deepEqual(attestation.inputHashes[key], { path: input.path, sha256: input.sha256 }, `stale input attestation: ${key}`);
  for (const [name, document] of Object.entries(expected)) {
    assert.deepEqual(outputs[name].json, document, `${name}: differs from independent reconstruction`);
    assert.equal(attestation.outputHashes[name], sha256(stableJson(document)), `${name}: self-authored hash tampering`);
  }
  assert.equal(attestation.declaredVerdict, solution.feasibility.verdict, 'declared verdict mismatch');
  assert.notEqual(attestation.declaredVerdict, 'PASS', 'G002 may not self-declare PASS');
  assertAssignmentSafety({ manifest: expected['assignment-manifest.json'], census, ledger, taxonomyConsensus, topology: solution.topology });
  assertLosslessSaveRevisionMap(expectedSave, { catalog, topologyBefore: topologyContract, topologyAfter: solution.topology });
  if (solution.feasibility.incompatibleEdgeCount !== 0 || solution.feasibility.exactCompatibleEdgeCount + solution.feasibility.pendingTaxonomyEdgeCount !== 190
      || solution.feasibility.visualReviewGate.completionAllowed !== false) throw new Error('feasibility/pending proof counts are inconsistent');
  return { status: 'verified-assignment-ready-art-pending', feasibility: solution.feasibility.verdict, assignmentReadiness: solution.feasibility.assignmentReadiness, artVerificationState: solution.feasibility.artVerificationState, regenerationCount: solution.feasibility.regenerationCount, retainedCount: solution.feasibility.retainedCount, pendingPixelTaxonomySlots: 0, pendingTaxonomyEdges: 0, reviewedTaxonomyRoots: solution.feasibility.reviewedTaxonomyRootCount, visualReviewGate: 'PENDING_G003_REVIEW' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyContinuityAssignment()));
