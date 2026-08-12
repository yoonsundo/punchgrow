#!/usr/bin/env node

import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pngjs from 'pngjs';

import { appendAdjudication, buildAdjudicationAssignments, partitionBundle } from './partition-blinded-visual-review.mjs';
import { assertAdjudicationTargetSet, deriveTarget, deriveTaxonomyAdjudicationTargetIds, finalizeAdjudicationTargets, validateVoteAuthenticity } from './verify-blinded-visual-review.mjs';
import { canonicalize, recordBatch, verifyReviewerPackage, verifyReviewerPackageSources } from './record-blinded-visual-review-batch.mjs';
import { canonicalize as canonicalizeAttestation, createAttestation, sha256 as sha256Attestation } from './attest-blinded-visual-review-run.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { PNG } = pngjs;

async function createSyntheticBundle(bundleRoot) {
  await mkdir(bundleRoot, { recursive: true });
  const writeSurface = async (opaqueInputId, slot, surface) => {
    const relativePath = `inputs/${opaqueInputId}/${slot}/${surface}.png`;
    const size = surface === 'master' ? 2 : 1;
    const image = new PNG({ width: size, height: size });
    image.data.fill(Number.parseInt(sha256Attestation(`${opaqueInputId}:${slot}:${surface}`).slice(0, 2), 16));
    const bytes = PNG.sync.write(image);
    const absolutePath = path.join(bundleRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    return { path: relativePath, sha256: sha256Attestation(bytes), bytes: bytes.length, width: size, height: size };
  };
  const pair = async (id, slot) => ({ master: await writeSurface(id, slot, 'master'), runtime: await writeSurface(id, slot, 'runtime') });
  const inputs = [];
  for (let index = 1; index <= 240; index += 1) {
    const opaqueInputId = `asset-test-${String(index).padStart(4, '0')}`;
    inputs.push({ opaqueInputId, targetKind: 'asset', surfaces: await pair(opaqueInputId, 'asset') });
  }
  for (let index = 1; index <= 190; index += 1) {
    const opaqueInputId = `edge-test-${String(index).padStart(4, '0')}`;
    inputs.push({
      opaqueInputId,
      targetKind: 'edge',
      focusParentSlot: 'parent-a',
      parents: [{ slot: 'parent-a', surfaces: await pair(opaqueInputId, 'parent-a') }],
      child: { slot: 'child', surfaces: await pair(opaqueInputId, 'child') },
      stageOrder: ['parent-a', 'child'],
    });
  }
  const promptBytes = Buffer.from('# Isolated reviewer prompt\n');
  const contractBytes = await readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-v1.schema.json'));
  const allowlist = { schemaVersion: 'blinded-input-allowlist-v1', bundleGenerationRunId: 'synthetic-bundle-run-001', inputs: [] };
  const allowlistBytes = Buffer.from(`${JSON.stringify(allowlist, null, 2)}\n`);
  const assignments = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const assignmentId = `assignment-test-${String(index + 1).padStart(4, '0')}`;
    const packageRoot = path.join(bundleRoot, 'assignments', assignmentId);
    const filePaths = input.targetKind === 'asset'
      ? [input.surfaces.master.path, input.surfaces.runtime.path]
      : [...input.parents.flatMap((parent) => [parent.surfaces.master.path, parent.surfaces.runtime.path]), input.child.surfaces.master.path, input.child.surfaces.runtime.path];
    for (const relativePath of filePaths) {
      const destination = path.join(packageRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(bundleRoot, relativePath)));
    }
    const targetAllowlistBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 'blinded-input-allowlist-v1', bundleGenerationRunId: 'synthetic-bundle-run-001', assignmentId, inputs: [] }, null, 2)}\n`);
    const templateBytes = Buffer.from('{}\n');
    const assignmentManifest = {
      schemaVersion: 'blinded-visual-assignment-v1',
      bundleGenerationRunId: 'synthetic-bundle-run-001',
      assignmentId,
      reviewTarget: { kind: input.targetKind, opaqueInputId: input.opaqueInputId },
      privateSidecarSha256: '2'.repeat(64),
      promptSha256: sha256Attestation(promptBytes),
      allowlistSha256: sha256Attestation(targetAllowlistBytes),
      templateSha256: sha256Attestation(templateBytes),
      input,
    };
    const assignmentManifestBytes = Buffer.from(`${JSON.stringify(assignmentManifest, null, 2)}\n`);
    await writeFile(path.join(packageRoot, 'REVIEW_PROMPT.md'), promptBytes);
    await writeFile(path.join(packageRoot, 'review-contract.schema.json'), contractBytes);
    await writeFile(path.join(packageRoot, 'input-allowlist.json'), targetAllowlistBytes);
    await writeFile(path.join(packageRoot, 'vote-template.json'), templateBytes);
    await writeFile(path.join(packageRoot, 'bundle-manifest.json'), assignmentManifestBytes);
    assignments.push({ assignmentId, relativePackagePath: `assignments/${assignmentId}`, bundleManifestSha256: sha256Attestation(assignmentManifestBytes) });
  }
  const orchestration = { schemaVersion: 'blinded-review-orchestration-v1', bundleGenerationRunId: 'synthetic-bundle-run-001', counts: { assets: 240, edges: 190, assignments: 430 }, assignments };
  await writeFile(path.join(bundleRoot, 'orchestration-index.json'), `${JSON.stringify(orchestration, null, 2)}\n`);
  return orchestration;
}

function assetObservation(opaqueInputId) {
  return {
    opaqueInputId,
    confidence: 0.91,
    assetObservation: {
      biologicalClass: 'unknown',
      speciesFamily: 'unknown-family',
      coreAnatomy: 'unknown',
      locomotionPlan: 'unknown',
      faceAnchors: [{ anchorId: 'face-geometry', visible: true, observation: 'Visible face shape in both surfaces.' }],
      bodyAnchors: [
        { anchorId: 'body-silhouette', visible: true, observation: 'Visible body outline in both surfaces.' },
        { anchorId: 'signature-organ', visible: true, observation: 'Visible signature organ in both surfaces.' },
      ],
      developmentalDeltas: [],
      masterRuntimeContinuity: 'yes',
    },
  };
}

function edgeObservation(input) {
  const mixed = input.parents.length === 2;
  const inheritedAnchors = mixed
    ? [
        { anchorId: 'parent-a-face', sourceSlots: ['parent-a'], visibleInChild: true, observation: 'Parent A face feature remains visible.' },
        { anchorId: 'parent-a-body', sourceSlots: ['parent-a'], visibleInChild: true, observation: 'Parent A body feature remains visible.' },
        { anchorId: 'parent-b-face', sourceSlots: ['parent-b'], visibleInChild: true, observation: 'Parent B face feature remains visible.' },
        { anchorId: 'parent-b-body', sourceSlots: ['parent-b'], visibleInChild: true, observation: 'Parent B body feature remains visible.' },
      ]
    : [
        { anchorId: 'ancestry-face', sourceSlots: [input.focusParentSlot], visibleInChild: true, observation: 'Parent face shape remains visible.' },
        { anchorId: 'ancestry-body', sourceSlots: [input.focusParentSlot], visibleInChild: true, observation: 'Parent body outline remains visible.' },
        { anchorId: 'ancestry-signature', sourceSlots: [input.focusParentSlot], visibleInChild: true, observation: 'Parent signature organ remains visible.' },
      ];
  return {
    opaqueInputId: input.opaqueInputId,
    confidence: 0.91,
    edgeObservation: {
      sameCreatureContinuity: 'yes',
      coreAnatomyAgreement: 'yes',
      locomotionAgreement: 'yes',
      inheritedAnchors,
      developmentalDeltas: [],
    },
  };
}

async function expectRejected(label, action, pattern) {
  await assert.rejects(action, pattern, label);
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-blinded-batches-'));
try {
  const BUNDLE_ROOT = path.join(temporaryRoot, 'synthetic-bundle');
  await createSyntheticBundle(BUNDLE_ROOT);
  const assignmentRoot = path.join(BUNDLE_ROOT, 'review-batches');
  await expectRejected('output outside approved root', () => partitionBundle({ bundleRoot: BUNDLE_ROOT, outputRoot: path.join(temporaryRoot, 'outside-batches'), batchSize: 24 }), /approved bundle review-batches root/i);
  await symlink(temporaryRoot, assignmentRoot);
  await expectRejected('precreated output symlink', () => partitionBundle({ bundleRoot: BUNDLE_ROOT, batchSize: 24 }), /symlink/i);
  await rm(assignmentRoot);
  await mkdir(assignmentRoot);
  await link(path.join(BUNDLE_ROOT, 'orchestration-index.json'), path.join(assignmentRoot, 'precreated-hardlink'));
  await expectRejected('precreated output hardlink', () => partitionBundle({ bundleRoot: BUNDLE_ROOT, batchSize: 24 }), /already exists/i);
  await rm(assignmentRoot, { recursive: true, force: true });
  const orchestrationBeforePartition = JSON.parse(await readFile(path.join(BUNDLE_ROOT, 'orchestration-index.json'), 'utf8'));
  const symlinkSourceRoot = path.join(BUNDLE_ROOT, orchestrationBeforePartition.assignments[0].relativePackagePath);
  const outsideAssignmentRoot = path.join(temporaryRoot, 'outside-assignment-package');
  await rename(symlinkSourceRoot, outsideAssignmentRoot);
  await symlink(outsideAssignmentRoot, symlinkSourceRoot);
  await expectRejected('assignment package directory symlink substitution', () => partitionBundle({ bundleRoot: BUNDLE_ROOT, batchSize: 24 }), /assignment package path contains symlinked component/i);
  await rm(symlinkSourceRoot); await rename(outsideAssignmentRoot, symlinkSourceRoot);
  const outsideInputs = path.join(temporaryRoot, 'outside-assignment-inputs');
  await rename(path.join(symlinkSourceRoot, 'inputs'), outsideInputs);
  await symlink(outsideInputs, path.join(symlinkSourceRoot, 'inputs'));
  await expectRejected('source directory symlink outside assignment', () => partitionBundle({ bundleRoot: BUNDLE_ROOT, batchSize: 24 }), /symlinked path component|source contains symlink/i);
  await rm(path.join(symlinkSourceRoot, 'inputs')); await rename(outsideInputs, path.join(symlinkSourceRoot, 'inputs'));
  const [passOne, passTwo] = await partitionBundle({ bundleRoot: BUNDLE_ROOT, outputRoot: assignmentRoot, batchSize: 24 });
  assert.equal(passOne.targetCount, 430);
  assert.equal(passTwo.targetCount, 430);
  assert.equal(passOne.batches.length, 18);
  assert.equal(passTwo.batches.length, 18);
  assert.notEqual(passOne.shuffleSha256, passTwo.shuffleSha256);
  assert.notEqual(passOne.assignmentSha256, passTwo.assignmentSha256);
  for (const assignment of [passOne, passTwo]) {
    const ids = assignment.batches.flatMap((batch) => batch.opaqueInputIds);
    assert.equal(ids.length, 430);
    assert.equal(new Set(ids).size, 430);
    assert.ok(assignment.batches.every((batch) => batch.targetCount <= 24));
    assert.ok(assignment.batches.slice(0, -1).every((batch) => batch.targetCount === 24));
  }

  const orchestration = JSON.parse(await readFile(path.join(BUNDLE_ROOT, 'orchestration-index.json'), 'utf8'));
  const sourceManifests = await Promise.all(orchestration.assignments.map(async (entry) => JSON.parse(await readFile(path.join(BUNDLE_ROOT, entry.relativePackagePath, 'bundle-manifest.json'), 'utf8'))));
  const manifest = { inputs: sourceManifests.map((entry) => entry.input) };
  assert.throws(() => buildAdjudicationAssignments({ ...manifest, bundleGenerationRunId: 'synthetic-bundle-run-001' }, 'a'.repeat(64), ['edge-test-0001']), /assets only/i);
  const inputById = new Map(manifest.inputs.map((input) => [input.opaqueInputId, input]));
  const sourceById = new Map(sourceManifests.map((entry) => [entry.input.opaqueInputId, entry]));
  const primaryVote = (number, mutate = () => {}) => {
    const observation = assetObservation('asset-test-0001'); mutate(observation);
    return { reviewTarget: { kind: 'asset', opaqueInputId: 'asset-test-0001' }, reviewer: { role: 'primary' }, confidence: observation.confidence, assetObservation: observation.assetObservation };
  };
  const taxonomyVotes = [primaryVote(1), primaryVote(2, (vote) => { vote.assetObservation.speciesFamily = 'construct'; })];
  const taxonomyRecords = [{ target: { kind: 'asset', opaqueInputId: 'asset-test-0001' } }];
  assert.deepEqual(deriveTaxonomyAdjudicationTargetIds(taxonomyRecords, taxonomyVotes), ['asset-test-0001']);
  assert.deepEqual(deriveTaxonomyAdjudicationTargetIds(taxonomyRecords, [taxonomyVotes[0], primaryVote(2, (vote) => { vote.assetObservation.speciesFamily = 'construct'; vote.assetObservation.developmentalDeltas = ['size-increase']; })]), ['asset-test-0001'], 'developmental delta differences must not suppress taxonomy-only adjudication');
  assert.deepEqual(deriveTaxonomyAdjudicationTargetIds(taxonomyRecords, [taxonomyVotes[0], primaryVote(2, (vote) => { vote.confidence = 0.5; vote.assetObservation.speciesFamily = 'construct'; })]), [], 'low confidence must not enter adjudication');
  assert.deepEqual(deriveTaxonomyAdjudicationTargetIds(taxonomyRecords, [taxonomyVotes[0], primaryVote(2, (vote) => { vote.assetObservation.speciesFamily = 'construct'; vote.assetObservation.coreAnatomy = 'biped'; })]), [], 'substantive dissent must not enter adjudication');
  assert.deepEqual(deriveTaxonomyAdjudicationTargetIds([{ target: { kind: 'edge', opaqueInputId: 'edge-test-0001' } }], taxonomyVotes), [], 'edges must not enter taxonomy adjudication');
  assert.throws(() => assertAdjudicationTargetSet([], ['asset-test-0001']), /exactly match/i, 'omitted adjudication target must fail');
  assert.throws(() => assertAdjudicationTargetSet(['asset-test-0001', 'asset-test-0002'], ['asset-test-0001']), /exactly match/i, 'extra adjudication target must fail');
  const firstBatch = passOne.batches[0];
  const observations = firstBatch.opaqueInputIds.map((id) => {
    const input = inputById.get(id);
    return input.targetKind === 'asset' ? assetObservation(id) : edgeObservation(input);
  });
  const observationPath = path.join(temporaryRoot, 'observations.json');
  const assignmentPath = path.join(assignmentRoot, 'pass-1', `${firstBatch.batchId}.json`);
  const packageRoot = path.join(assignmentRoot, 'pass-1', 'reviewer-packages', firstBatch.batchId);
  const packageManifestPath = path.join(packageRoot, 'package-manifest.json');
  const attestationPath = path.join(temporaryRoot, 'attestations', 'pass-1-batch-001.json');
  const outputRoot = path.join(temporaryRoot, 'raw-votes');
  const keyPath = path.join(temporaryRoot, 'conductor.key');
  const wrongKeyPath = path.join(temporaryRoot, 'wrong.key');
  await writeFile(keyPath, 'synthetic-conductor-key-with-enough-entropy');
  await writeFile(wrongKeyPath, 'wrong-conductor-key-with-enough-entropy');
  await writeFile(observationPath, `${JSON.stringify(observations, null, 2)}\n`);
  const chronologyVotes = [];
  for (const [set, number, speciesFamily] of [[passOne, 1, 'unknown-family'], [passTwo, 2, 'construct']]) {
    const batch = set.batches.find((entry) => entry.opaqueInputIds.includes('asset-test-0001'));
    const batchObservations = batch.opaqueInputIds.map((id) => {
      const input = inputById.get(id); const observation = input.targetKind === 'asset' ? assetObservation(id) : edgeObservation(input);
      if (id === 'asset-test-0001') observation.assetObservation.speciesFamily = speciesFamily;
      return observation;
    });
    const observationsFile = path.join(temporaryRoot, `chronology-${set.passId}-observations.json`); await writeFile(observationsFile, `${JSON.stringify(batchObservations, null, 2)}\n`);
    const packageManifest = path.join(assignmentRoot, set.passId, 'reviewer-packages', batch.batchId, 'package-manifest.json');
    const authorizationFile = path.join(temporaryRoot, 'attestations', `chronology-${set.passId}.json`);
    await createAttestation({ packageManifest, assignmentManifest: path.join(assignmentRoot, set.passId, 'assignment-manifest.json'), batchId: batch.batchId,
      output: authorizationFile, testOnlyAllowOutput: true, keyFile: keyPath, reviewerInstanceId: `chronology-reviewer-${number}`, agentTaskId: `chronology-task-${number}`,
      voterReviewRunId: `chronology-voter-run-${number}`, role: 'primary', attempt: 1, createdAt: `2026-08-10T11:5${number}:00.000Z` });
    chronologyVotes.push(...await recordBatch({ bundleRoot: BUNDLE_ROOT, assignment: path.join(assignmentRoot, set.passId, `${batch.batchId}.json`), packageManifest,
      attestation: authorizationFile, keyFile: keyPath, observations: observationsFile, outputRoot: path.join(temporaryRoot, 'chronology-raw-votes'), testOnlyAllowOutputRoot: true,
      submittedAt: `2026-08-10T12:0${number}:00.000Z` }));
  }
  const recordedTaxonomyVotes = chronologyVotes.filter((vote) => vote.reviewTarget.opaqueInputId === 'asset-test-0001');
  assert.deepEqual(deriveTaxonomyAdjudicationTargetIds(taxonomyRecords, recordedTaxonomyVotes), ['asset-test-0001']);
  const assetDeltaVotes = structuredClone(recordedTaxonomyVotes);
  assetDeltaVotes[1].assetObservation.biologicalClass = assetDeltaVotes[0].assetObservation.biologicalClass;
  assetDeltaVotes[1].assetObservation.speciesFamily = assetDeltaVotes[0].assetObservation.speciesFamily;
  assetDeltaVotes[1].assetObservation.developmentalDeltas = ['size-increase'];
  const assetTarget = { kind: 'asset', opaqueInputId: 'asset-test-0001' };
  assert.equal(deriveTarget(assetTarget, assetDeltaVotes).verdict, 'PASS', 'differing valid asset developmental deltas are descriptive and must not create substantive disagreement');
  for (const [label, mutate] of [
    ['core anatomy', (vote) => { vote.assetObservation.coreAnatomy = 'biped'; }],
    ['locomotion', (vote) => { vote.assetObservation.locomotionPlan = 'bipedal'; }],
    ['anchor visibility', (vote) => { vote.assetObservation.faceAnchors[0].visible = false; }],
    ['continuity', (vote) => { vote.assetObservation.masterRuntimeContinuity = 'no'; }],
  ]) {
    const changed = structuredClone(assetDeltaVotes); mutate(changed[1]);
    assert.equal(deriveTarget(assetTarget, changed).verdict, 'BLOCKED', `${label} disagreement must remain substantive`);
  }
  const edgeInput = inputById.get('edge-test-0001');
  const edgeTarget = {
    kind: 'edge', opaqueInputId: edgeInput.opaqueInputId,
    assets: [...edgeInput.parents.map((parent) => ({ slot: parent.slot })), { slot: 'child' }],
  };
  const edgeVerdictVote = (number) => {
    const observation = edgeObservation(edgeInput);
    return {
      reviewId: `edge-delta-review-${number}`, voterReviewRunId: `edge-delta-run-${number}`,
      reviewer: { reviewerInstanceId: `edge-delta-reviewer-${number}`, agentTaskId: `edge-delta-task-${number}`, role: 'primary' },
      confidence: observation.confidence, edgeObservation: observation.edgeObservation,
    };
  };
  const edgeDeltaVotes = [edgeVerdictVote(1), edgeVerdictVote(2)]; edgeDeltaVotes[1].edgeObservation.developmentalDeltas = ['limb-development'];
  assert.equal(deriveTarget(edgeTarget, edgeDeltaVotes).verdict, 'PASS', 'differing valid edge developmental deltas are descriptive and must not create substantive disagreement');
  for (const [label, mutate] of [
    ['edge anatomy', (vote) => { vote.edgeObservation.coreAnatomyAgreement = 'no'; }],
    ['edge locomotion', (vote) => { vote.edgeObservation.locomotionAgreement = 'no'; }],
    ['edge anchor', (vote) => { vote.edgeObservation.inheritedAnchors[0].visibleInChild = false; }],
    ['edge continuity', (vote) => { vote.edgeObservation.sameCreatureContinuity = 'no'; }],
  ]) {
    const changed = structuredClone(edgeDeltaVotes); mutate(changed[1]);
    assert.equal(deriveTarget(edgeTarget, changed).verdict, 'BLOCKED', `${label} disagreement must remain substantive`);
  }
  const primaryBefore = await Promise.all(['pass-1', 'pass-2'].map(async (pass) => sha256Attestation(await readFile(path.join(assignmentRoot, pass, 'assignment-manifest.json')))));
  const adjudicationEvidenceRoot = path.join(REPO_ROOT, '.omx/evidence/visual-census/synthetic-bundle-run-001');
  const adjudicationTargetsPath = path.join(adjudicationEvidenceRoot, 'adjudication-targets.json');
  await mkdir(adjudicationEvidenceRoot, { recursive: true });
  const targetCore = { schemaVersion: 'blinded-visual-adjudication-targets-v1', bundleGenerationRunId: 'synthetic-bundle-run-001', orchestrationIndexSha256: sha256Attestation(await readFile(path.join(BUNDLE_ROOT, 'orchestration-index.json'))), targets: deriveTaxonomyAdjudicationTargetIds(taxonomyRecords, recordedTaxonomyVotes) };
  const signedTargets = finalizeAdjudicationTargets(targetCore, await readFile(keyPath));
  const signedOmission = finalizeAdjudicationTargets({ ...targetCore, targets: [] }, await readFile(keyPath));
  await writeFile(adjudicationTargetsPath, `${JSON.stringify(signedOmission, null, 2)}\n`);
  await expectRejected('signed omitted adjudication target list', () => appendAdjudication({ bundleRoot: BUNDLE_ROOT, adjudicationTargetsFile: adjudicationTargetsPath, batchSize: 24, keyFile: keyPath }), /non-empty/i);
  await writeFile(adjudicationTargetsPath, `${JSON.stringify({ ...signedTargets, targets: ['asset-test-0001', 'asset-test-0002'] }, null, 2)}\n`);
  await expectRejected('forged extra adjudication target list', () => appendAdjudication({ bundleRoot: BUNDLE_ROOT, adjudicationTargetsFile: adjudicationTargetsPath, batchSize: 24, keyFile: keyPath }), /output hash drift|HMAC/i);
  await writeFile(adjudicationTargetsPath, `${JSON.stringify(signedTargets, null, 2)}\n`);
  const outsideReviewBatches = path.join(temporaryRoot, 'outside-review-batches-root');
  await rename(assignmentRoot, outsideReviewBatches); await symlink(outsideReviewBatches, assignmentRoot);
  await expectRejected('append review-batches root symlink substitution', () => appendAdjudication({ bundleRoot: BUNDLE_ROOT, adjudicationTargetsFile: adjudicationTargetsPath, batchSize: 24, keyFile: keyPath }), /review-batches.*symlink|directory root contains symlink/i);
  await rm(assignmentRoot); await rename(outsideReviewBatches, assignmentRoot);
  const passThree = await appendAdjudication({ bundleRoot: BUNDLE_ROOT, adjudicationTargetsFile: adjudicationTargetsPath, batchSize: 24, keyFile: keyPath });
  assert.equal(passThree.passId, 'pass-3'); assert.deepEqual(passThree.batches.flatMap((batch) => batch.opaqueInputIds), ['asset-test-0001']);
  const primaryAfter = await Promise.all(['pass-1', 'pass-2'].map(async (pass) => sha256Attestation(await readFile(path.join(assignmentRoot, pass, 'assignment-manifest.json')))));
  assert.deepEqual(primaryAfter, primaryBefore, 'append must preserve pass-1/pass-2 byte-for-byte');
  await expectRejected('repeated pass-3 append', () => appendAdjudication({ bundleRoot: BUNDLE_ROOT, adjudicationTargetsFile: adjudicationTargetsPath, batchSize: 24, keyFile: keyPath }), /already exists|repeated append/i);
  const passThreeBatch = passThree.batches[0];
  const passThreePackageManifest = path.join(assignmentRoot, 'pass-3', 'reviewer-packages', passThreeBatch.batchId, 'package-manifest.json');
  const passThreeAttestationPath = path.join(temporaryRoot, 'attestations', 'pass-3-batch-001.json');
  const passThreeObservationPath = path.join(temporaryRoot, 'pass-3-observations.json');
  await writeFile(passThreeObservationPath, `${JSON.stringify([assetObservation('asset-test-0001')], null, 2)}\n`);
  const passThreeAttestation = await createAttestation({
    packageManifest: passThreePackageManifest, assignmentManifest: path.join(assignmentRoot, 'pass-3', 'assignment-manifest.json'), batchId: passThreeBatch.batchId,
    output: passThreeAttestationPath, testOnlyAllowOutput: true, keyFile: keyPath,
    reviewerInstanceId: 'reviewer-pass-three-001', agentTaskId: 'agent-task-pass-three-001', voterReviewRunId: 'voter-run-pass-three-001', role: 'adjudicator', attempt: 1,
    createdAt: '2026-08-10T11:58:00.000Z',
  });
  assert.equal(passThreeAttestation.role, 'adjudicator');
  await expectRejected('pass-3 primary role forbidden', () => createAttestation({
    packageManifest: passThreePackageManifest, assignmentManifest: path.join(assignmentRoot, 'pass-3', 'assignment-manifest.json'), batchId: passThreeBatch.batchId,
    output: path.join(temporaryRoot, 'attestations', 'invalid-pass-3.json'), testOnlyAllowOutput: true, keyFile: keyPath,
    reviewerInstanceId: 'reviewer-pass-three-002', agentTaskId: 'agent-task-pass-three-002', voterReviewRunId: 'voter-run-pass-three-002', role: 'primary', attempt: 1,
  }), /require adjudicator role/i);
  const passThreeVotes = await recordBatch({
    bundleRoot: BUNDLE_ROOT, assignment: path.join(assignmentRoot, 'pass-3', `${passThreeBatch.batchId}.json`), packageManifest: passThreePackageManifest,
    attestation: passThreeAttestationPath, keyFile: keyPath, observations: passThreeObservationPath, outputRoot: path.join(temporaryRoot, 'raw-votes'), testOnlyAllowOutputRoot: true,
    submittedAt: '2026-08-10T12:00:00.000Z',
  });
  assert.equal(passThreeVotes.length, 1); assert.equal(passThreeVotes[0].reviewer.role, 'adjudicator');
  assert.equal(validateVoteAuthenticity(passThreeVotes[0], await readFile(keyPath)), passThreeVotes[0], 'pass-3 adjudicator vote must be conductor authenticated');
  assert.equal(deriveTarget({ kind: 'asset', opaqueInputId: 'asset-test-0001' }, [...recordedTaxonomyVotes, passThreeVotes[0]]).verdict, 'PASS', 'fresh pass-3 adjudicator must resolve taxonomy-only mismatch');
  const attestation = await createAttestation({
    packageManifest: packageManifestPath,
    assignmentManifest: path.join(assignmentRoot, 'pass-1', 'assignment-manifest.json'),
    batchId: firstBatch.batchId,
    output: attestationPath,
    testOnlyAllowOutput: true,
    keyFile: keyPath,
    reviewerInstanceId: 'reviewer-pass-one-001', agentTaskId: 'agent-task-pass-one-001', voterReviewRunId: 'voter-run-pass-one-001', role: 'primary', attempt: 1,
    createdAt: '2026-08-10T11:59:00.000Z',
  });
  await expectRejected('authorization arbitrary output path', () => createAttestation({
    packageManifest: packageManifestPath, assignmentManifest: path.join(assignmentRoot, 'pass-1', 'assignment-manifest.json'), batchId: firstBatch.batchId,
    output: path.join(temporaryRoot, 'forbidden-authorization.json'), keyFile: keyPath,
    reviewerInstanceId: 'reviewer-pass-one-001', agentTaskId: 'agent-task-pass-one-001', voterReviewRunId: 'voter-run-pass-one-001', role: 'primary', attempt: 1,
    createdAt: '2026-08-10T11:59:00.000Z',
  }), /approved run\/pass\/batch evidence path/i);
  const syntheticEvidenceRoot = path.join(REPO_ROOT, '.omx/evidence/visual-census/synthetic-bundle-run-001');
  await mkdir(syntheticEvidenceRoot, { recursive: true });
  await symlink(temporaryRoot, path.join(syntheticEvidenceRoot, 'authorizations'));
  await expectRejected('authorization symlink ancestor', () => createAttestation({
    packageManifest: packageManifestPath, assignmentManifest: path.join(assignmentRoot, 'pass-1', 'assignment-manifest.json'), batchId: firstBatch.batchId,
    output: path.join(syntheticEvidenceRoot, 'authorizations/pass-1', `${firstBatch.batchId}.json`), keyFile: keyPath,
    reviewerInstanceId: 'reviewer-pass-one-001', agentTaskId: 'agent-task-pass-one-001', voterReviewRunId: 'voter-run-pass-one-001', role: 'primary', attempt: 1,
    createdAt: '2026-08-10T11:59:00.000Z',
  }), /symlinked authorization output ancestor/i);
  await rm(syntheticEvidenceRoot, { recursive: true, force: true });
  const baseArgs = {
    bundleRoot: BUNDLE_ROOT,
    assignment: assignmentPath,
    packageManifest: packageManifestPath,
    attestation: attestationPath,
    keyFile: keyPath,
    observations: observationPath,
    outputRoot,
    testOnlyAllowOutputRoot: true,
    submittedAt: '2026-08-10T12:00:00.000Z',
  };
  const votes = await recordBatch(baseArgs);
  assert.equal(votes.length, firstBatch.targetCount);
  assert.ok(votes.every((vote) => Object.values(attestation.targetManifestSha256s).includes(vote.provenance.bundleManifestSha256)));
  assert.ok(votes.every((vote) => vote.provenance.authorizationId === attestation.authorizationId && vote.provenance.batchPackageManifestSha256 === attestation.batchPackageManifestSha256 && vote.provenance.fileSetSha256 === attestation.fileSetSha256));
  assert.ok(votes.every((vote) => !('assignmentSha256' in vote)));
  const conductorKey = await readFile(keyPath);
  const wrongConductorKey = await readFile(wrongKeyPath);
  assert.ok(votes.every((vote) => validateVoteAuthenticity(vote, conductorKey) === vote), 'clean recorded votes must pass conductor authentication');
  assert.throws(() => validateVoteAuthenticity(votes[0], wrongConductorKey), /conductor HMAC verification failed/i, 'wrong conductor key must reject a clean vote');
  const recomputeOutputSha = (vote) => {
    const withoutHmac = structuredClone(vote); delete withoutHmac.conductorHmacSha256;
    const withoutDigest = structuredClone(withoutHmac); delete withoutDigest.outputSha256;
    vote.outputSha256 = sha256Attestation(canonicalize(withoutDigest));
  };
  const assetVote = votes.find((vote) => vote.reviewTarget.kind === 'asset');
  const edgeVote = votes.find((vote) => vote.reviewTarget.kind === 'edge');
  const changedObservation = structuredClone(assetVote);
  changedObservation.assetObservation.faceAnchors[0].observation = `${changedObservation.assetObservation.faceAnchors[0].observation} forged`;
  recomputeOutputSha(changedObservation);
  assert.throws(() => validateVoteAuthenticity(changedObservation, conductorKey), /conductor HMAC verification failed/i, 'observation mutation with recomputed output hash must fail');
  const changedConfidence = structuredClone(assetVote);
  changedConfidence.confidence = changedConfidence.confidence === 0.5 ? 0.6 : 0.5;
  recomputeOutputSha(changedConfidence); changedConfidence.conductorHmacSha256 = '0'.repeat(64);
  assert.throws(() => validateVoteAuthenticity(changedConfidence, conductorKey), /conductor HMAC verification failed/i, 'confidence mutation with forged HMAC must fail');
  const changedContinuity = structuredClone(edgeVote);
  changedContinuity.edgeObservation.sameCreatureContinuity = changedContinuity.edgeObservation.sameCreatureContinuity === 'yes' ? 'no' : 'yes';
  recomputeOutputSha(changedContinuity);
  assert.throws(() => validateVoteAuthenticity(changedContinuity, conductorKey), /conductor HMAC verification failed/i, 'continuity mutation with recomputed output hash must fail');
  await recordBatch(baseArgs);
  await expectRejected('raw vote output outside approved evidence root', () => recordBatch({ ...baseArgs, testOnlyAllowOutputRoot: false }), /approved run evidence raw-votes root/i);

  const packageManifestText = await readFile(packageManifestPath, 'utf8');
  const parsedPackageManifest = JSON.parse(packageManifestText);
  const packagePromptText = await readFile(path.join(packageRoot, parsedPackageManifest.targets[0].relativePackagePath, 'REVIEW_PROMPT.md'), 'utf8');
  assert.ok(!packageManifestText.includes(BUNDLE_ROOT), 'reviewer package must not expose global bundle path');
  assert.ok(!packagePromptText.includes(BUNDLE_ROOT), 'reviewer prompt must not expose global bundle path');
  assert.ok(!packageManifestText.includes('"total": 430'), 'reviewer package must not expose global target count');
  assert.equal(parsedPackageManifest.targetCount, firstBatch.targetCount);

  const writeMutation = async (name, mutate) => {
    const value = structuredClone(observations);
    mutate(value);
    const file = path.join(temporaryRoot, `${name}.json`);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };

  const outsideId = manifest.inputs.find((input) => !firstBatch.opaqueInputIds.includes(input.opaqueInputId)).opaqueInputId;
  await expectRejected('outside target', async () => recordBatch({ ...baseArgs, observations: await writeMutation('outside', (value) => { value[0] = inputById.get(outsideId).targetKind === 'asset' ? assetObservation(outsideId) : edgeObservation(inputById.get(outsideId)); }) }), /outside assigned batch/i);
  await expectRejected('duplicate target', async () => recordBatch({ ...baseArgs, observations: await writeMutation('duplicate', (value) => { value[1] = structuredClone(value[0]); }) }), /duplicate observation target/i);
  await expectRejected('missing target', async () => recordBatch({ ...baseArgs, observations: await writeMutation('missing', (value) => { value.pop(); }) }), /missing assigned target/i);
  await expectRejected('forbidden identity', async () => recordBatch({ ...baseArgs, observations: await writeMutation('identity', (value) => { value[0].name = 'hidden-name'; }) }), /forbidden context field name/i);
  await expectRejected('forbidden provenance', async () => recordBatch({ ...baseArgs, observations: await writeMutation('hash', (value) => { value[0].sha256 = 'a'.repeat(64); }) }), /forbidden context field sha256/i);
  await expectRejected('wrong observation kind', async () => recordBatch({ ...baseArgs, observations: await writeMutation('wrong-kind', (value) => {
    const input = inputById.get(value[0].opaqueInputId);
    if (input.targetKind === 'asset') {
      delete value[0].assetObservation;
      value[0].edgeObservation = edgeObservation({ ...input, targetKind: 'edge', parents: [{ slot: 'parent-a' }], focusParentSlot: 'parent-a' }).edgeObservation;
    } else {
      delete value[0].edgeObservation;
      value[0].assetObservation = assetObservation(value[0].opaqueInputId).assetObservation;
    }
  }) }), /wrong observation kind/i);

  const forgedAssignmentPath = path.join(assignmentRoot, 'pass-1', 'forged.json');
  const assignmentDocument = JSON.parse(await readFile(assignmentPath, 'utf8'));
  assignmentDocument.opaqueInputIds[0] = outsideId;
  await writeFile(forgedAssignmentPath, `${JSON.stringify(assignmentDocument, null, 2)}\n`);
  await expectRejected('forged assignment batch', () => recordBatch({ ...baseArgs, assignment: forgedAssignmentPath }), /targets differ from trusted assignment set/i);

  const writeAttestationMutation = async (name, mutate, recompute = true) => {
    const value = JSON.parse(await readFile(attestationPath, 'utf8'));
    mutate(value);
    if (recompute) {
      delete value.outputSha256;
      delete value.conductorHmacSha256;
      value.outputSha256 = sha256Attestation(canonicalizeAttestation(value));
      value.conductorHmacSha256 = '0'.repeat(64);
    }
    const file = path.join(temporaryRoot, 'attestations', `${name}.json`);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };
  await expectRejected('wrong HMAC key', () => recordBatch({ ...baseArgs, keyFile: wrongKeyPath }), /HMAC verification failed/i);
  await expectRejected('unsigned attestation', async () => recordBatch({ ...baseArgs, attestation: await writeAttestationMutation('unsigned', (value) => { delete value.conductorHmacSha256; }, false) }), /conductorHmacSha256|unexpected|invalid/i);
  await expectRejected('forged target', async () => recordBatch({ ...baseArgs, attestation: await writeAttestationMutation('outside-target', (value) => { value.assignedOpaqueInputIds[0] = outsideId; }) }), /HMAC verification failed|coverage/i);
  await expectRejected('pass mismatch', async () => recordBatch({ ...baseArgs, attestation: await writeAttestationMutation('pass-mismatch', (value) => { value.passId = 'pass-2'; }) }), /HMAC verification failed|pass mismatch/i);
  await expectRejected('attestation hash drift', async () => recordBatch({ ...baseArgs, attestation: await writeAttestationMutation('hash-drift', (value) => { value.attempt = 2; }, false) }), /attestation output hash drift/i);

  const secondBatch = passOne.batches[1];
  await expectRejected('cross-batch reuse', () => recordBatch({ ...baseArgs,
    assignment: path.join(assignmentRoot, 'pass-1', `${secondBatch.batchId}.json`),
    packageManifest: path.join(assignmentRoot, 'pass-1', 'reviewer-packages', secondBatch.batchId, 'package-manifest.json'),
  }), /attestation batch mismatch|target coverage mismatch/i);
  const passTwoBatch = passTwo.batches.find((batch) => batch.opaqueInputIds.includes(firstBatch.opaqueInputIds[0]));
  await expectRejected('cross-pass reuse', () => recordBatch({ ...baseArgs,
    assignment: path.join(assignmentRoot, 'pass-2', `${passTwoBatch.batchId}.json`),
    packageManifest: path.join(assignmentRoot, 'pass-2', 'reviewer-packages', passTwoBatch.batchId, 'package-manifest.json'),
  }), /attestation pass mismatch|target coverage mismatch/i);

  const changedObservationsPath = await writeMutation('changed-overwrite', (value) => { value[0].confidence = 0.5; });
  await expectRejected('non-identical overwrite', () => recordBatch({ ...baseArgs, observations: changedObservationsPath }), /immutable raw vote differs/i);

  const batchSchema = JSON.parse(await readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-batch-v1.schema.json'), 'utf8'));
  assert.deepEqual(Object.keys(batchSchema.items.properties).sort(), ['assetObservation', 'confidence', 'edgeObservation', 'opaqueInputId']);
  assert.equal(batchSchema.items.additionalProperties, false);
  const dependency = JSON.parse(await readFile(path.join(packageRoot, 'visual-review-v1.schema.json'), 'utf8'));
  assert.equal(dependency.$id, 'https://punchgrow.local/contracts/visual-review-v1.schema.json');
  assert.ok(dependency.required.includes('conductorHmacSha256'));
  assert.equal(batchSchema.items.properties.assetObservation.$ref, 'visual-review-v1.schema.json#/$defs/assetObservation');

  const targetPixel = parsedPackageManifest.files.find((file) => file.path.endsWith('.png'));
  const targetPixelPath = path.join(packageRoot, targetPixel.path);
  const targetPixelBytes = await readFile(targetPixelPath);
  const changedPixel = Buffer.from(targetPixelBytes); changedPixel[changedPixel.length - 1] ^= 1;
  await writeFile(targetPixelPath, changedPixel);
  await expectRejected('changed reviewer pixel', () => recordBatch(baseArgs), /file hash\/length drift/i);
  await writeFile(targetPixelPath, targetPixelBytes);
  await writeFile(path.join(packageRoot, 'graph.json'), '{}');
  await expectRejected('injected graph/context file', () => recordBatch(baseArgs), /exact file set mismatch/i);
  await rm(path.join(packageRoot, 'graph.json'));

  const sourceRecordsForPackage = new Map();
  for (const target of parsedPackageManifest.targets) {
    const sourceRoot = path.join(BUNDLE_ROOT, 'assignments', target.assignmentId);
    const sourceManifestBytes = await readFile(path.join(sourceRoot, 'bundle-manifest.json'));
    sourceRecordsForPackage.set(target.opaqueInputId, {
      sourceRoot, sourceManifestBytes, sourceManifest: JSON.parse(sourceManifestBytes),
      promptBytes: await readFile(path.join(sourceRoot, 'REVIEW_PROMPT.md')),
      allowlistBytes: await readFile(path.join(sourceRoot, 'input-allowlist.json')),
      templateBytes: await readFile(path.join(sourceRoot, 'vote-template.json')),
      contractBytes: await readFile(path.join(sourceRoot, 'review-contract.schema.json')),
    });
  }
  const sameDimensionPngs = parsedPackageManifest.files.filter((file) => file.path.endsWith('/master.png'));
  const victim = sameDimensionPngs[0]; const donor = sameDimensionPngs.find((file) => file.path !== victim.path);
  const victimPath = path.join(packageRoot, victim.path); const originalVictim = await readFile(victimPath); const donorBytes = await readFile(path.join(packageRoot, donor.path));
  const originalPackageManifestBytes = await readFile(packageManifestPath);
  await writeFile(victimPath, donorBytes);
  victim.sha256 = sha256Attestation(donorBytes); victim.bytes = donorBytes.length;
  const substitutedManifestBytes = Buffer.from(`${JSON.stringify(parsedPackageManifest, null, 2)}\n`);
  await writeFile(packageManifestPath, substitutedManifestBytes);
  await verifyReviewerPackage(packageManifestPath, parsedPackageManifest, substitutedManifestBytes);
  await expectRejected('valid PNG substitution with recomputed package manifest', () => verifyReviewerPackageSources(packageRoot, parsedPackageManifest, sourceRecordsForPackage), /differs from trusted source|metadata differs/i);
  await writeFile(victimPath, originalVictim); await writeFile(packageManifestPath, originalPackageManifestBytes);
  assert.ok(!canonicalize(passOne).match(/PG-|lineage|evolutionFrom|creatureName/i));

  console.log(JSON.stringify({ suite: 'blinded-review-batch-hostile', status: 'PASS', targetsPerPass: 430, batchesPerPass: 18 }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
