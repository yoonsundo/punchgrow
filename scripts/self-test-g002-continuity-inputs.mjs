#!/usr/bin/env node

import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { buildG002ContinuityInputs, classificationOf, assertUniqueSurfaceHash } from './build-g002-continuity-inputs.mjs';
import { canonicalStringify, sha256Bytes } from './lib/continuity-assignment/canonical-json.mjs';
import { assertHash, readContainedFile, writeAtomicNoFollowForTest, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { buildTopology } from './lib/continuity-assignment/topology.mjs';
import {
  candidateMaterialBindingSha256, finalizeCandidateVote, materializeCandidatePackageFixture, validateCandidateReview,
} from './prepare-continuity-candidate-review.mjs';

assert.equal(canonicalStringify({ z: 1, a: { y: 2, x: 3 } }), '{\n  "a": {\n    "x": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');
assert.throws(() => canonicalStringify({ unsafe: undefined }), /non-JSON value.*unsafe/i);

const knownPass = { pgId: 'PG-001', derived: { verdict: 'PASS' }, selectedTaxonomy: { speciesFamily: 'canid' } };
const unknownPass = { pgId: 'PG-007', derived: { verdict: 'PASS' }, selectedTaxonomy: { speciesFamily: 'unknown-family' } };
const blocked = { pgId: 'PG-099', derived: { verdict: 'BLOCKED' } };
assert.deepEqual(classificationOf(knownPass, new Map()), { disposition: 'reusable', dispositionReason: 'two-primary-known-consensus' });
assert.deepEqual(classificationOf(unknownPass, new Map()), { disposition: 'review-required', dispositionReason: 'pass-unknown-family' });
assert.deepEqual(classificationOf(blocked, new Map([['PG-099', { reasonClasses: ['substantive-biological-dissent'] }]])), { disposition: 'regenerate-required', dispositionReason: 'substantive-biological-dissent' });
assert.deepEqual(classificationOf(blocked, new Map([['PG-099', { reasonClasses: ['low-confidence'] }]])), { disposition: 'review-required', dispositionReason: 'evidence-only-conflict' });

const seen = new Map(); assert.doesNotThrow(() => assertUniqueSurfaceHash(seen, 'a'.repeat(64), 'PG-001', 'master'));
assert.throws(() => assertUniqueSurfaceHash(seen, 'a'.repeat(64), 'PG-002', 'master'), /duplicate master PNG/i);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const catalog = JSON.parse(await readFileSafe(path.join(repoRoot, 'production/catalog/creatures.json')));
const topology = buildTopology(catalog);
assert.deepEqual(topology.counts.categories, { start: 60, normal_evolution: 121, branch: 14, mixed: 10, special: 10, mutant: 25 });
assert.deepEqual(topology.counts.choiceProfile, { noChoice: 32, stageOneChoice: 10, stageTwoChoice: 18 });
assert.equal(topology.rootSlotIds.length, 60); assert.equal(topology.edges.length, 190);
const brokenParent = structuredClone(catalog); brokenParent.find((item) => item.id === 'PG-061').evolutionFrom = 'PG-240';
assert.throws(() => buildTopology(brokenParent), /previous stage/i);
const duplicateId = structuredClone(catalog); duplicateId[1].id = duplicateId[0].id;
assert.throws(() => buildTopology(duplicateId), /duplicate IDs|coverage mismatch/i);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'g002-input-hostile-'));
try {
  const outside = path.join(temporary, 'outside'); const root = path.join(temporary, 'root');
  await mkdir(outside); await mkdir(root); await writeFile(path.join(outside, 'secret'), 'no-follow'); await symlink(path.join(outside, 'secret'), path.join(root, 'linked'));
  await assert.rejects(readContainedFile(root, 'linked'), /symlink/i);
  await assert.rejects(readContainedFile(root, '../outside/secret'), /canonical contained path|escapes/i);
  await writeFile(path.join(root, 'stale'), 'current-bytes');
  await assert.rejects(assertHash(root, { path: 'stale', sha256: '0'.repeat(64) }), /hash is stale/i);
  await assert.rejects(writeCanonicalFile(path.join(root, '../escape.json'), {}, { containmentRoot: root }), /escapes/i);
  await assert.rejects(writeCanonicalFile(path.join(root, 'linked'), {}, { containmentRoot: root }), /symlinked/i);

  const hardlinkPeer = path.join(outside, 'hardlink-peer'); await writeFile(hardlinkPeer, 'external-safe'); await link(hardlinkPeer, path.join(root, 'hardlinked'));
  await assert.rejects(writeCanonicalFile(path.join(root, 'hardlinked'), {}, { containmentRoot: root }), /hard-linked/i);
  assert.equal(await readFile(hardlinkPeer, 'utf8'), 'external-safe');

  const raceRoot = path.join(root, 'race'); await mkdir(raceRoot); const raceBackup = path.join(root, 'race-backup');
  await assert.rejects(writeAtomicNoFollowForTest({
    destination: path.join(raceRoot, 'approved.json'), containmentRoot: root, bytes: 'replacement',
    beforeCommit: async () => { await rename(raceRoot, raceBackup); await symlink(outside, raceRoot); },
  }), /symlinked|non-directory|resolves outside/i);
  assert.equal(await readFile(hardlinkPeer, 'utf8'), 'external-safe');

  const materialRoot = path.join(root, 'materials'); await mkdir(materialRoot);
  const materialSpecs = [
    ['child-master.png', 1], ['child-runtime.png', 2], ['parent-master.png', 3], ['parent-runtime.png', 4],
    ['eilu-1-master.png', 11], ['eilu-1-runtime.png', 12], ['eilu-2-master.png', 13], ['eilu-2-runtime.png', 14], ['eilu-3-master.png', 15], ['eilu-3-runtime.png', 16],
  ];
  for (const [filename, seed] of materialSpecs) await writeFile(path.join(materialRoot, filename), makePng(seed));
  const surface = async (filename) => ({ path: `materials/${filename}`, sha256: sha256Bytes(await readFile(path.join(materialRoot, filename))) });
  const candidate = {
    schemaVersion: 'continuity-candidate-material-v1', candidateId: 'g003-edge:PG-001:PG-061', generationRunId: 'candidate-generation-fresh-0001', reviewKind: 'new-edge',
    child: { sourceSlotId: 'PG-061', master: await surface('child-master.png'), runtime: await surface('child-runtime.png') },
    parents: [{ sourceSlotId: 'PG-001', master: await surface('parent-master.png'), runtime: await surface('parent-runtime.png') }],
  };
  const requiredAnchors = [
    { anchorId: 'face-geometry', description: 'locked narrow muzzle and large pointed ears' },
    { anchorId: 'body-silhouette', description: 'locked slender four-legged canid body' },
    { anchorId: 'signature-organ', description: 'locked luminous branching tail lattice' },
  ];
  const benchmarkSpecs = [
    ['PG-001', 'eilu-1-master.png', 'eilu-1-runtime.png'], ['PG-061', 'eilu-2-master.png', 'eilu-2-runtime.png'], ['PG-181', 'eilu-3-master.png', 'eilu-3-runtime.png'],
  ];
  const pixelEntries = [];
  for (const [pgId, masterName, runtimeName] of benchmarkSpecs) pixelEntries.push({
    pgId, surfaces: {
      master: { path: `materials/${masterName}`, sha256: sha256Bytes(await readFile(path.join(materialRoot, masterName))) },
      runtime: { path: `materials/${runtimeName}`, sha256: sha256Bytes(await readFile(path.join(materialRoot, runtimeName))) },
    },
  });
  const pixelRoot = path.join(root, 'production/reports/biological-continuity-v3/g002-evidence-v1'); await mkdir(pixelRoot, { recursive: true });
  await writeFile(path.join(pixelRoot, 'pixel-clusters.json'), canonicalStringify({ entries: pixelEntries }));
  const reviewGate = {
    schemaVersion: 'continuity-g003-review-gate-v1', state: 'PENDING_G003_REVIEW', completionAllowed: false,
    eiluBenchmark: {
      benchmarkId: 'eilu-comparative-visual-v1', minimumConfidence: 0.96, minimumRetainedAnchorCount: 3, minimumAnchorRetentionRatio: 1,
      comparisonRequirements: { sameCreatureGrownUp: 'yes', compareAgainstBenchmark: true, candidateConfidenceAtLeastBenchmark: true },
      pixelBindings: pixelEntries.map((entry) => ({ pgId: entry.pgId, masterSha256: entry.surfaces.master.sha256, runtimeSha256: entry.surfaces.runtime.sha256 })),
    },
    queueCandidates: [],
    edgeCandidates: [{
      edgeId: candidate.candidateId, parentId: 'PG-001', childId: 'PG-061', status: 'PENDING_COMPARATIVE_VISUAL_REVIEW',
      allowedParentAnchorIds: [{ parentId: 'PG-001', anchorIds: requiredAnchors.map((anchor) => anchor.anchorId) }],
      allowedParentAnchors: [{ parentId: 'PG-001', anchors: requiredAnchors.map((anchor) => ({ ...anchor, sourceReviewId: 'review-source', sourceConfidence: 0.99 })) }],
      eiluBenchmarkId: 'eilu-comparative-visual-v1', comparisonThresholds: { minimumConfidence: 0.96, minimumAnchorRetentionRatio: 1, sameCreatureGrownUp: 'yes' },
    }],
  };
  const conductorKey = Buffer.from('g002-candidate-hostile-conductor-key-material-0001');
  const prepared = await materializeCandidatePackageFixture(candidate, { repoRoot: root, conductorKey, reviewGate });
  assert.doesNotMatch(JSON.stringify(prepared.packageManifest), /PG-[0-9]{3}/, 'reviewer manifest must remain blinded');
  assert.doesNotMatch(JSON.stringify(prepared.allowlist), /PG-[0-9]{3}/, 'reviewer allowlist must remain blinded');
  const bindingSha256 = candidateMaterialBindingSha256(prepared.binding);
  const taxonomy = { speciesFamily: 'canid', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' };
  const makeVote = (passNumber, anchors = ['face-geometry', 'body-silhouette', 'signature-organ'], overrides = {}) => finalizeCandidateVote({
    schemaVersion: 'continuity-candidate-primary-vote-v1', reviewId: `review-pass-${passNumber}`, reviewerInstanceId: `reviewer-pass-${passNumber}`,
    agentTaskId: `task-pass-${passNumber}`, voterReviewRunId: `run-pass-${passNumber}`, passNumber, role: 'primary', fresh: true, blinded: true,
    opaqueCandidateId: prepared.binding.opaqueCandidateId, generationRunId: prepared.binding.generationRunId,
    packageManifestSha256: prepared.binding.packageManifestSha256, materialBindingSha256: bindingSha256,
    inputAllowlistSha256: prepared.binding.allowlistSha256, promptSha256: prepared.binding.promptSha256,
    assignmentManifestSha256: sha256Bytes(Buffer.from(`assignment-pass-${passNumber}`)),
    reviewerRunAttestationSha256: sha256Bytes(Buffer.from(`run-attestation-pass-${passNumber}`)),
    rawObservationSha256: sha256Bytes(Buffer.from(`raw-observation-pass-${passNumber}`)),
    inputAssetSha256s: prepared.allowlist.files.map((file) => file.sha256),
    observation: { childTaxonomy: taxonomy, parentObservations: prepared.binding.parents.map((parent) => ({
      opaqueParentId: parent.opaqueInputId, taxonomy, sameCreatureGrownUp: 'yes', inheritedAnchorIds: anchors.map((anchorId) => `${parent.opaqueInputId}:${anchorId}`),
      perAnchorEvidence: anchors.map((anchorId) => ({ anchorKey: `${parent.opaqueInputId}:${anchorId}`, anchorId, observation: `${anchorId} visibly persists` })),
    })), requiredAnchorEvidence: prepared.binding.reviewContract.anchorSets.map((set) => ({
      opaqueInputId: set.opaqueInputId,
      anchors: set.anchors.map((anchor) => ({ anchorKey: anchor.anchorKey, anchorId: anchor.anchorId, requiredDescription: anchor.description, observation: `${anchor.anchorId} visibly persists in the candidate` })),
    })), eiluComparison: {
      benchmarkId: 'eilu-comparative-visual-v1', sameCreatureGrownUp: 'yes', candidateContinuityScore: 0.98,
      stageObservations: prepared.binding.reviewContract.eiluBenchmark.pixelBindings.map((binding) => ({ ...binding, continuityScore: 0.98, observation: 'candidate continuity meets or exceeds this supplied positive-control stage' })),
      retainedAnchorCount: 3, anchorRetentionRatio: 1,
    } }, confidence: 0.97, ...overrides,
  }, conductorKey);
  const reviewBase = {
    schemaVersion: 'continuity-candidate-review-v1', opaqueCandidateId: prepared.binding.opaqueCandidateId, generationRunId: prepared.binding.generationRunId,
    reviewKind: prepared.binding.reviewKind, packageManifestSha256: prepared.binding.packageManifestSha256, materialBindingSha256: bindingSha256,
    inputAllowlistSha256: prepared.binding.allowlistSha256, promptSha256: prepared.binding.promptSha256,
  };
  const validReview = { ...reviewBase, votes: [makeVote(1), makeVote(2)] };
  await assert.doesNotReject(validateCandidateReview(validReview, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }));
  const persistedReviewRelative = `${prepared.outputRelative}/approved-review.json`;
  await writeFile(path.join(root, persistedReviewRelative), canonicalStringify(validReview));
  const persistedValidation = await validateCandidateReview(validReview, {
    repoRoot: root, packageRelative: prepared.outputRelative, conductorKey, persistedReviewRelative,
  });
  assert.equal(persistedValidation.trustedDependency.parentId, 'PG-061');
  assert.equal(persistedValidation.trustedDependency.reviewPath, persistedReviewRelative);
  assert.throws(() => { persistedValidation.trustedDependency.anchors[0].description = 'mutated after verification'; }, TypeError);

  const acceptedParent = { sourceSlotId: 'PG-061' }; const acceptedRun = 'validated-parent-run';
  for (const surfaceName of ['master', 'runtime']) {
    const source = candidate.child[surfaceName]; const bytes = await readFile(path.join(root, source.path));
    const acceptedRelative = `production/reports/biological-continuity-v3/g003-evidence-v1/candidates/PG-061/${acceptedRun}/blobs/sha256/${source.sha256}.png`;
    await mkdir(path.dirname(path.join(root, acceptedRelative)), { recursive: true }); await writeFile(path.join(root, acceptedRelative), bytes);
    acceptedParent[surfaceName] = { path: acceptedRelative, sha256: source.sha256 };
  }
  const dependentCandidate = {
    schemaVersion: 'continuity-candidate-material-v1', candidateId: 'g003-candidate:PG-062', generationRunId: 'dependent-candidate-run', reviewKind: 'asset-reuse',
    child: { sourceSlotId: 'PG-062', master: structuredClone(candidate.parents[0].master), runtime: structuredClone(candidate.parents[0].runtime) },
    parents: [acceptedParent],
  };
  const dependentGate = structuredClone(reviewGate); dependentGate.edgeCandidates = [];
  dependentGate.queueCandidates = [{
    candidateId: dependentCandidate.candidateId, slotId: 'PG-062', requiredParentCandidateIds: [persistedValidation.trustedDependency.candidateId],
    allowedAnchors: persistedValidation.trustedDependency.anchors.map((anchor) => ({ ...anchor })),
    comparisonThresholds: reviewGate.edgeCandidates[0].comparisonThresholds,
  }];
  const trustedDependencies = { 'PG-061': persistedValidation.trustedDependency };
  await assert.doesNotReject(materializeCandidatePackageFixture(dependentCandidate, { repoRoot: root, conductorKey, reviewGate: dependentGate, approvedDependencies: trustedDependencies }));
  const wrongPublicPath = structuredClone(dependentCandidate); wrongPublicPath.parents[0].master = structuredClone(candidate.child.master);
  await assert.rejects(materializeCandidatePackageFixture(wrongPublicPath, { repoRoot: root, conductorKey, reviewGate: dependentGate, approvedDependencies: trustedDependencies }), /approved public parent pixels/);
  const mismatchedBytes = makePng(99); const mismatchedSha = sha256Bytes(mismatchedBytes);
  const mismatchedRelative = `production/reports/biological-continuity-v3/g003-evidence-v1/candidates/PG-061/${acceptedRun}/blobs/sha256/${mismatchedSha}.png`;
  await writeFile(path.join(root, mismatchedRelative), mismatchedBytes);
  const mismatchedParent = structuredClone(dependentCandidate); mismatchedParent.parents[0].master = { path: mismatchedRelative, sha256: mismatchedSha };
  await assert.rejects(materializeCandidatePackageFixture(mismatchedParent, { repoRoot: root, conductorKey, reviewGate: dependentGate, approvedDependencies: trustedDependencies }), /approved public parent pixels/);

  const dependencyGate = structuredClone(reviewGate);
  dependencyGate.queueCandidates = [{ candidateId: 'g003-candidate:PG-001', slotId: 'PG-001' }];
  const injectedDependency = {
    parentId: 'PG-001', candidateId: 'g003-candidate:PG-001', reviewPath: persistedReviewRelative,
    reviewSha256: persistedValidation.trustedDependency.reviewSha256, pixelSurfaces: structuredClone(candidate.parents[0]),
    anchors: requiredAnchors.map((anchor) => ({ anchorKey: `PG-001:${anchor.anchorId}`, parentId: 'PG-001', anchorId: anchor.anchorId, description: anchor.description, sourceReviewId: 'attacker-review' })),
  };
  await assert.rejects(materializeCandidatePackageFixture(candidate, {
    repoRoot: root, conductorKey, reviewGate: dependencyGate, approvedDependencies: { 'PG-001': injectedDependency },
  }), /not produced by persisted candidate review verification/i);

  const inventedDescription = structuredClone(validReview);
  inventedDescription.votes[0].observation.requiredAnchorEvidence[0].anchors[0].requiredDescription = 'invented weaker description';
  inventedDescription.votes[0] = finalizeCandidateVote(inventedDescription.votes[0], conductorKey);
  await assert.rejects(validateCandidateReview(inventedDescription, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /tuple\/description\/evidence differs from locked queue/i);
  const weakenedEilu = structuredClone(validReview);
  weakenedEilu.votes[0].observation.eiluComparison.anchorRetentionRatio = 0.5;
  weakenedEilu.votes[0] = finalizeCandidateVote(weakenedEilu.votes[0], conductorKey);
  await assert.rejects(validateCandidateReview(weakenedEilu, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /locked Eilu benchmark thresholds/i);
  const missingEiluStage = structuredClone(validReview);
  missingEiluStage.votes[0].observation.eiluComparison.stageObservations.pop();
  missingEiluStage.votes[0] = finalizeCandidateVote(missingEiluStage.votes[0], conductorKey);
  await assert.rejects(validateCandidateReview(missingEiluStage, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /Eilu.*stage|stage.*coverage/i);
  const unqualifiedParentAnchor = structuredClone(validReview);
  unqualifiedParentAnchor.votes[0].observation.parentObservations[0].inheritedAnchorIds[0] = 'face-geometry';
  unqualifiedParentAnchor.votes[0] = finalizeCandidateVote(unqualifiedParentAnchor.votes[0], conductorKey);
  await assert.rejects(validateCandidateReview(unqualifiedParentAnchor, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /anchor/i);

  const forgedHash = structuredClone(validReview); forgedHash.votes[0].inputAssetSha256s[0] = 'f'.repeat(64);
  const forgedUnsigned = structuredClone(forgedHash.votes[0]); delete forgedUnsigned.outputSha256; delete forgedUnsigned.conductorHmacSha256;
  forgedHash.votes[0].outputSha256 = sha256Bytes(Buffer.from(canonicalStringify(forgedUnsigned)));
  await assert.rejects(validateCandidateReview(forgedHash, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /asset hash set|HMAC/i);
  const forgedProvenance = structuredClone(validReview); forgedProvenance.packageManifestSha256 = 'e'.repeat(64);
  await assert.rejects(validateCandidateReview(forgedProvenance, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /differs from material binding/i);
  const sharedTask = { ...reviewBase, votes: [makeVote(1), makeVote(2, undefined, { agentTaskId: 'task-pass-1' })] };
  await assert.rejects(validateCandidateReview(sharedTask, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /shares agentTaskId/i);
  const disjointAnchors = { ...reviewBase, votes: [makeVote(1), makeVote(2, ['ear', 'paw', 'tail'])] };
  await assert.rejects(validateCandidateReview(disjointAnchors, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /disagree.*anchor/i);
  const missingProvenance = structuredClone(validReview); delete missingProvenance.votes[0].voterReviewRunId;
  await assert.rejects(validateCandidateReview(missingProvenance, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /fields mismatch.*voterReviewRunId/i);
  const passThree = { ...reviewBase, votes: [makeVote(1), makeVote(3, undefined, { passNumber: 3 })] };
  await assert.rejects(validateCandidateReview(passThree, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /role\/freshness|pass 1 and pass 2/i);
  const bindingPath = path.join(root, prepared.outputRelative, 'private-binding.json');
  const forgedBinding = structuredClone(prepared.binding); forgedBinding.child.sourceSlotId = 'PG-999';
  await writeFile(bindingPath, canonicalStringify(forgedBinding));
  await assert.rejects(validateCandidateReview(validReview, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /binding HMAC/i);
  await writeFile(bindingPath, canonicalStringify(prepared.binding));
  const promptPath = path.join(root, prepared.outputRelative, 'reviewer-package', 'prompt.txt'); const promptBackup = await readFile(promptPath);
  await writeFile(promptPath, Buffer.concat([promptBackup, Buffer.from('forged prompt')]));
  await assert.rejects(validateCandidateReview(validReview, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /prompt hash drift/i);
  await writeFile(promptPath, promptBackup);
  const materialPath = path.join(root, prepared.outputRelative, 'reviewer-package', prepared.allowlist.files[0].path); const materialBackup = await readFile(materialPath);
  await writeFile(materialPath, Buffer.concat([materialBackup, Buffer.from('forged pixels')]));
  await assert.rejects(validateCandidateReview(validReview, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /material hash drift/i);
  await writeFile(materialPath, materialBackup);
  await writeFile(path.join(root, prepared.outputRelative, 'reviewer-package', 'unexpected.txt'), 'not allowlisted');
  await assert.rejects(validateCandidateReview(validReview, { repoRoot: root, packageRelative: prepared.outputRelative, conductorKey }), /package files.*coverage mismatch/i);
} finally { await rm(temporary, { recursive: true, force: true }); }

const built = await buildG002ContinuityInputs({ write: false });
assert.deepEqual(built['asset-census.json'].counts, { reusable: 145, reviewRequired: 33, reviewEvidenceOnly: 21, reviewPassUnknown: 12, regenerateRequired: 62 });
assert.equal(built['pins.json'].fixtures.length, 6);
assert.equal(built['inputs.lock.json'].generatedArtifacts.length, 4);
assert.ok(built['inputs.lock.json'].inputs.every((binding) => !binding.path.startsWith('.omx/')), 'public lock must not depend on private OMX evidence');
for (const fixture of built['pins.json'].fixtures) assert.match(fixture.screenshotPath, /^production\/reports\/biological-continuity-v3\/g002-evidence-v1\/screenshots\//);
const publicFiles = ['inputs.lock.json', 'asset-census.json', 'pixel-clusters.json', 'pins.json', 'topology-before.json', ...['norzed', 'conipo', 'tirsha', 'danjuri', 'kirikong', 'ritoni'].map((name) => `screenshots/${name}.png`)];
publicFiles.push('canonical-root-redesign-targets-v1.json', 'canonical-root-redesign-targets-v1.unsigned.json');
for (const filename of publicFiles) {
  const relative = `production/reports/biological-continuity-v3/g002-evidence-v1/${filename}`;
  assert.notEqual(spawnSync('git', ['check-ignore', '-q', relative], { cwd: repoRoot }).status, 0, `${relative} must be public in a clean clone`);
}
assert.notEqual(spawnSync('git', ['check-ignore', '-q', 'production/reports/biological-continuity-v3/g001-primary-pixel-anchor-consensus-v1.json'], { cwd: repoRoot }).status, 0, 'public G001 pixel anchor consensus must exist in a clean clone');
assert.notEqual(spawnSync('git', ['check-ignore', '-q', 'production/reports/biological-continuity-v3/g002-evidence-v1/taxonomy-reviews/consensus.json'], { cwd: repoRoot }).status, 0, 'public G002 taxonomy consensus must exist in a clean clone');
assert.equal(spawnSync('git', ['check-ignore', '-q', '.omx/evidence/continuity-candidates/private'], { cwd: repoRoot }).status, 0, 'private candidate evidence must remain ignored');

console.log(JSON.stringify({ tests: 53, status: 'PASS' }));

async function readFileSafe(filename) {
  const { readFile } = await import('node:fs/promises'); return readFile(filename, 'utf8');
}

function makePng(seed) {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = seed * 31; png.data[index + 1] = seed * 47; png.data[index + 2] = seed * 61; png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}
