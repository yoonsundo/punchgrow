#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { buildEdgeCandidateDescriptorFixture, buildQueueCandidateDescriptor, buildQueueCandidateDescriptorFixture, parseHashBoundJsonBytes, verifyPinnedPublicManifestBytes } from './build-g003-candidate-descriptor.mjs';
import { prepare } from './conduct-g003-reviews.mjs';
import { verifyCandidateMaterializationAuthority } from './prepare-continuity-candidate-review.mjs';
import { canonicalStringify, sha256Bytes } from './lib/continuity-assignment/canonical-json.mjs';
import { stageCandidate } from './stage-continuity-candidate.mjs';
import { G003_AUTHORITY, G003_PROTOCOL_AUTHORITY_SHA256 } from './lib/g003-v4-authority.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G002_V1_EVIDENCE = 'production/reports/biological-continuity-v3/g002-evidence-v1';
const G002_V2_EVIDENCE = 'production/reports/biological-continuity-v3/g002-evidence-v2';
const DESCRIPTOR_ROOT = '.omx/evidence/continuity-candidates/descriptors';
const descriptorPath = (name) => `${DESCRIPTOR_ROOT}/${name}`;

function makePng(size, seed) {
  const data = Buffer.alloc(size * size * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = seed; data[index + 1] = (seed * 3) % 255; data[index + 2] = (seed * 7) % 255; data[index + 3] = 255;
  }
  return PNG.sync.write({ width: size, height: size, data }, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
}

async function stage(repoRoot, slotId, generationRunId, seed) {
  const inputRoot = path.join(repoRoot, 'fixture-inputs'); await mkdir(inputRoot, { recursive: true });
  const sourcePath = path.join(inputRoot, `${slotId}-${generationRunId}.png`); const promptPath = path.join(inputRoot, `${slotId}-${generationRunId}.txt`);
  await writeFile(sourcePath, makePng(1024, seed)); await writeFile(promptPath, `fixture prompt ${slotId} ${generationRunId}`);
  return stageCandidate({ slotId, generationRunId, promptPath, sourcePath, repoRoot });
}

async function fixtureSurface(repoRoot, relativePath, size, seed) {
  const bytes = makePng(size, seed); await mkdir(path.dirname(path.join(repoRoot, relativePath)), { recursive: true }); await writeFile(path.join(repoRoot, relativePath), bytes);
  return { path: relativePath, sha256: sha256Bytes(bytes) };
}

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-descriptor-')));
try {
  const rootRun = 'fixture-root-run'; const dependentRun = 'fixture-dependent-run'; const mixedRun = 'fixture-mixed-run';
  await stage(temporary, 'PG-005', rootRun, 17);
  await stage(temporary, 'PG-065', dependentRun, 31);
  await stage(temporary, 'PG-066', mixedRun, 37);
  await stage(temporary, 'PG-240', 'fixture-nonqueue-run', 47);

  const rootPrior = {
    pgId: 'PG-005', surfaces: {
      master: await fixtureSurface(temporary, 'fixture-pixels/PG-005/master.png', 1024, 61),
      runtime: await fixtureSurface(temporary, 'fixture-pixels/PG-005/runtime.png', 360, 63),
    },
  };
  const retainedPrior = {
    pgId: 'PG-006', surfaces: {
      master: await fixtureSurface(temporary, 'fixture-pixels/PG-006/master.png', 1024, 67),
      runtime: await fixtureSurface(temporary, 'fixture-pixels/PG-006/runtime.png', 360, 69),
    },
  };
  const retainedChildPrior = {
    pgId: 'PG-007', surfaces: {
      master: await fixtureSurface(temporary, 'fixture-pixels/PG-007/master.png', 1024, 71),
      runtime: await fixtureSurface(temporary, 'fixture-pixels/PG-007/runtime.png', 360, 73),
    },
  };
  const rootAnchors = ['body-silhouette', 'face-geometry', 'signature-organ'].map((anchorId) => ({
    anchorKey: `PG-005:${anchorId}`, parentRole: null, parentId: null, anchorId, description: `locked ${anchorId}`,
    sourceReviewId: 'review-root-fixture', sourceConfidence: 0.99, resolutionState: 'RESOLVED_AUTHENTICATED_PIXELS', dependencyCandidateId: null,
  }));
  const dependentAnchors = ['body-silhouette', 'face-geometry', 'signature-organ'].map((anchorId) => ({
    anchorKey: `PG-005:${anchorId}`, parentRole: 'parent-1', parentId: 'PG-005', anchorId, description: null,
    sourceReviewId: null, sourceConfidence: null, resolutionState: 'PENDING_APPROVED_PARENT_REVIEW', dependencyCandidateId: 'g003-candidate:PG-005',
  }));
  const mixedAnchors = [
    { ...dependentAnchors[0] },
    { ...dependentAnchors[1] },
    { ...rootAnchors[0], anchorKey: 'PG-006:body-silhouette', parentRole: 'parent-2', parentId: 'PG-006' },
    { ...rootAnchors[1], anchorKey: 'PG-006:face-geometry', parentRole: 'parent-2', parentId: 'PG-006' },
  ];
  const queueCandidates = [
    { candidateId: 'g003-candidate:PG-005', slotId: 'PG-005', requiredParentCandidateIds: [], allowedAnchors: rootAnchors },
    { candidateId: 'g003-candidate:PG-006', slotId: 'PG-006', requiredParentCandidateIds: [], allowedAnchors: rootAnchors.map((anchor) => ({ ...anchor, anchorKey: anchor.anchorKey.replace('PG-005', 'PG-006') })) },
    { candidateId: 'g003-candidate:PG-065', slotId: 'PG-065', requiredParentCandidateIds: ['g003-candidate:PG-005'], allowedAnchors: dependentAnchors },
    { candidateId: 'g003-candidate:PG-066', slotId: 'PG-066', requiredParentCandidateIds: ['g003-candidate:PG-005'], allowedAnchors: mixedAnchors },
  ];
  const edgeCandidates = [
    { edgeId: 'g003-edge:PG-007:PG-005', parentId: 'PG-007', childId: 'PG-005', allowedParentAnchors: [{ parentId: 'PG-007' }] },
    { edgeId: 'g003-edge:PG-005:PG-007', parentId: 'PG-005', childId: 'PG-007', allowedParentAnchors: [{ parentId: 'PG-005' }] },
  ];
  const gate = { schemaVersion: 'continuity-g003-review-gate-v2', state: 'PENDING_G003_REVIEW', completionAllowed: false, queueCandidates, edgeCandidates };
  const pixelClusters = { entries: [rootPrior, retainedPrior, retainedChildPrior] }; const emptyDiscovery = { tips: [] };
  const inputs = (discovered = emptyDiscovery) => ({ gate, pixelClusters, discovered });

  const activeSnapshot = { signedPublicEvidence: { fileSha256: G003_AUTHORITY.publicManifestFileSha256 } };
  const activeManifestBytes = await readFile(path.join(SOURCE_ROOT, `${G002_V2_EVIDENCE}/public-evidence-manifest.json`));
  const activeManifest = verifyPinnedPublicManifestBytes(activeManifestBytes, activeSnapshot);
  const replaySnapshot = structuredClone(activeSnapshot); replaySnapshot.signedPublicEvidence.fileSha256 = '0'.repeat(64);
  assert.throws(() => verifyPinnedPublicManifestBytes(activeManifestBytes, replaySnapshot), /active baseline file SHA/);
  const assignmentBinding = activeManifest.files.find((entry) => entry.path === `${G002_V2_EVIDENCE}/assignment-manifest.json`);
  const assignmentBytes = await readFile(path.join(SOURCE_ROOT, assignmentBinding.path));
  assert.doesNotThrow(() => parseHashBoundJsonBytes(assignmentBytes, assignmentBinding, 'signed assignment fixture'));
  const staleAssignmentBytes = Buffer.from(assignmentBytes); staleAssignmentBytes[staleAssignmentBytes.length - 2] ^= 1;
  assert.throws(() => parseHashBoundJsonBytes(staleAssignmentBytes, assignmentBinding, 'signed assignment fixture'), /differ from signed public evidence/);
  const baseManifest = JSON.parse(await readFile(path.join(SOURCE_ROOT, activeManifest.baseAuthority.publicManifestPath)));
  const pixelBinding = baseManifest.files.find((entry) => entry.path === `${G002_V1_EVIDENCE}/pixel-clusters.json`);
  const pixelBytes = await readFile(path.join(SOURCE_ROOT, pixelBinding.path)); const stalePixelBytes = Buffer.from(pixelBytes); stalePixelBytes[8] ^= 1;
  assert.throws(() => parseHashBoundJsonBytes(stalePixelBytes, pixelBinding, 'signed pixel fixture'), /differ from signed public evidence/);

  const rootOutput = descriptorPath('root.json');
  const root = await buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: rootOutput, repoRoot: temporary, verifiedInputs: inputs() });
  assert.equal(root.descriptor.schemaVersion, 'continuity-candidate-material-v4'); assert.equal(root.descriptor.protocolAuthoritySha256, G003_PROTOCOL_AUTHORITY_SHA256); assert.equal(root.descriptor.candidateId, 'g003-candidate:PG-005');
  assert.equal(root.descriptor.reviewKind, 'asset-reuse'); assert.deepEqual(root.descriptor.parents, [{ sourceSlotId: 'PG-005', ...rootPrior.surfaces }]);
  const rootBytes = await readFile(path.join(temporary, rootOutput)); assert.equal(rootBytes.toString('utf8'), canonicalStringify(root.descriptor));

  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: 'wrong-run', outputPath: descriptorPath('wrong-run.json'), repoRoot: temporary, verifiedInputs: inputs() }), /staged provenance is missing/);

  const rootProvenancePath = path.join(temporary, `assets/creatures/biological-continuity-v3/candidates/${rootRun}/PG-005/provenance.json`);
  const rootProvenanceBytes = await readFile(rootProvenancePath); const rootProvenance = JSON.parse(rootProvenanceBytes);
  const tamperedProvenance = structuredClone(rootProvenance); tamperedProvenance.runtime.sha256 = '0'.repeat(64);
  await writeFile(rootProvenancePath, canonicalStringify(tamperedProvenance));
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('tampered-provenance.json'), repoRoot: temporary, verifiedInputs: inputs() }), /bytes differ from staged provenance/);
  await writeFile(rootProvenancePath, rootProvenanceBytes);

  const runtimePath = path.join(temporary, rootProvenance.runtime.path); const runtimeBytes = await readFile(runtimePath);
  await writeFile(runtimePath, Buffer.from('stale runtime bytes'));
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('stale-runtime.json'), repoRoot: temporary, verifiedInputs: inputs() }), /bytes differ from staged provenance/);
  await writeFile(runtimePath, runtimeBytes);

  const wrongSlotRoot = path.join(temporary, `assets/creatures/biological-continuity-v3/candidates/${rootRun}/PG-006`); await mkdir(wrongSlotRoot, { recursive: true });
  await copyFile(rootProvenancePath, path.join(wrongSlotRoot, 'provenance.json'));
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-006', generationRunId: rootRun, outputPath: descriptorPath('wrong-slot.json'), repoRoot: temporary, verifiedInputs: inputs() }), /provenance identity/);

  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-240', generationRunId: 'fixture-nonqueue-run', outputPath: descriptorPath('nonqueue.json'), repoRoot: temporary, verifiedInputs: inputs() }), /retained, non-queue/);
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('../escape.json'), repoRoot: temporary, verifiedInputs: inputs() }), /not (?:a )?canonical/);
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: 'docs/out-of-scope-descriptor.json', repoRoot: temporary, verifiedInputs: inputs() }), /must be beneath.*descriptors/);
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: rootOutput, repoRoot: temporary, verifiedInputs: inputs() }), /refusing to overwrite/);

  const externalOutput = path.join(temporary, 'external-output.json'); await writeFile(externalOutput, 'external-safe');
  const linkedOutput = path.join(temporary, descriptorPath('linked-output.json')); await symlink(externalOutput, linkedOutput);
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('linked-output.json'), repoRoot: temporary, verifiedInputs: inputs() }), /refusing to overwrite/);
  assert.equal(await readFile(externalOutput, 'utf8'), 'external-safe');
  const hardlinkedOutput = path.join(temporary, descriptorPath('hardlinked-output.json')); await link(externalOutput, hardlinkedOutput);
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('hardlinked-output.json'), repoRoot: temporary, verifiedInputs: inputs() }), /refusing to overwrite/);
  assert.equal(await readFile(externalOutput, 'utf8'), 'external-safe');

  const swappedParent = path.join(temporary, descriptorPath('swapped-parent')); const swappedParentBackup = `${swappedParent}-backup`;
  const attackerParent = path.join(temporary, 'attacker-parent'); await mkdir(swappedParent); await mkdir(attackerParent); await writeFile(path.join(attackerParent, 'sentinel'), 'external-safe');
  await assert.rejects(buildQueueCandidateDescriptorFixture({
    slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('swapped-parent/descriptor.json'), repoRoot: temporary, verifiedInputs: inputs(),
    testBeforeDescriptorPublish: async () => { await rename(swappedParent, swappedParentBackup); await symlink(attackerParent, swappedParent); },
  }), /parent changed before publish/);
  await assert.rejects(access(path.join(attackerParent, 'descriptor.json'))); assert.equal(await readFile(path.join(attackerParent, 'sentinel'), 'utf8'), 'external-safe');

  const symlinkRun = 'fixture-symlink-run'; const symlinkRoot = path.join(temporary, `assets/creatures/biological-continuity-v3/candidates/${symlinkRun}/PG-005`);
  await mkdir(symlinkRoot, { recursive: true }); await symlink(rootProvenancePath, path.join(symlinkRoot, 'provenance.json'));
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: symlinkRun, outputPath: descriptorPath('symlink.json'), repoRoot: temporary, verifiedInputs: inputs() }), /symlink/);

  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-065', generationRunId: dependentRun, outputPath: descriptorPath('dependent-missing.json'), repoRoot: temporary, verifiedInputs: inputs() }), /requires current approved parent/);

  const acceptedMasterBytes = makePng(1024, 81); const acceptedRuntimeBytes = makePng(360, 83);
  const acceptedMasterSha = sha256Bytes(acceptedMasterBytes); const acceptedRuntimeSha = sha256Bytes(acceptedRuntimeBytes);
  const acceptedRoot = `production/reports/biological-continuity-v3/g003-evidence-v3/candidates/PG-005/approved-parent-run/blobs/sha256`;
  await mkdir(path.join(temporary, acceptedRoot), { recursive: true });
  const acceptedMaster = { surface: 'master', path: `${acceptedRoot}/${acceptedMasterSha}.png`, sha256: acceptedMasterSha };
  const acceptedRuntime = { surface: 'runtime', path: `${acceptedRoot}/${acceptedRuntimeSha}.png`, sha256: acceptedRuntimeSha };
  await writeFile(path.join(temporary, acceptedMaster.path), acceptedMasterBytes); await writeFile(path.join(temporary, acceptedRuntime.path), acceptedRuntimeBytes);
  const childPixels = [acceptedMaster, acceptedRuntime]; const reviewSha256 = 'a'.repeat(64);
  const currentParent = {
    requirementKind: 'queue', requirementId: 'g003-candidate:PG-005', generationRunId: 'approved-parent-run', reviewSha256, childPixels,
    artifact: { reviewKind: 'queue', requirementId: 'g003-candidate:PG-005', candidateId: 'g003-candidate:PG-005', review: { sha256: reviewSha256 }, childPixels },
  };
  const dependentOutput = path.join(temporary, descriptorPath('dependent-current.json'));
  const dependent = await buildQueueCandidateDescriptorFixture({ slotId: 'PG-065', generationRunId: dependentRun, outputPath: dependentOutput, repoRoot: temporary, verifiedInputs: inputs({ tips: [currentParent] }) });
  assert.deepEqual(dependent.descriptor.parents, [{ sourceSlotId: 'PG-005', master: { path: acceptedMaster.path, sha256: acceptedMaster.sha256 }, runtime: { path: acceptedRuntime.path, sha256: acceptedRuntime.sha256 } }]);

  const staleCurrentParent = structuredClone(currentParent); staleCurrentParent.reviewSha256 = 'b'.repeat(64);
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-065', generationRunId: dependentRun, outputPath: descriptorPath('dependent-stale-tip.json'), repoRoot: temporary, verifiedInputs: inputs({ tips: [staleCurrentParent] }) }), /requires current approved parent/);

  const mixed = await buildQueueCandidateDescriptorFixture({ slotId: 'PG-066', generationRunId: mixedRun, outputPath: descriptorPath('mixed-current-retained.json'), repoRoot: temporary, verifiedInputs: inputs({ tips: [currentParent] }) });
  assert.deepEqual(mixed.descriptor.parents, [
    { sourceSlotId: 'PG-005', master: { path: acceptedMaster.path, sha256: acceptedMaster.sha256 }, runtime: { path: acceptedRuntime.path, sha256: acceptedRuntime.sha256 } },
    { sourceSlotId: 'PG-006', ...retainedPrior.surfaces },
  ]);

  const generatedChildEdge = await buildEdgeCandidateDescriptorFixture({ edgeId: 'g003-edge:PG-007:PG-005', generationRunId: 'edge-generated-child', outputPath: descriptorPath('edge-generated-child.json'), repoRoot: temporary, verifiedInputs: inputs({ tips: [currentParent] }) });
  assert.deepEqual(generatedChildEdge.descriptor.child, { sourceSlotId: 'PG-005', master: { path: acceptedMaster.path, sha256: acceptedMaster.sha256 }, runtime: { path: acceptedRuntime.path, sha256: acceptedRuntime.sha256 } });
  assert.deepEqual(generatedChildEdge.descriptor.parents, [{ sourceSlotId: 'PG-007', ...retainedChildPrior.surfaces }]);
  const retainedChildEdge = await buildEdgeCandidateDescriptorFixture({ edgeId: 'g003-edge:PG-005:PG-007', generationRunId: 'edge-retained-child', outputPath: descriptorPath('edge-retained-child.json'), repoRoot: temporary, verifiedInputs: inputs({ tips: [currentParent] }) });
  assert.deepEqual(retainedChildEdge.descriptor.child, { sourceSlotId: 'PG-007', ...retainedChildPrior.surfaces });
  assert.deepEqual(retainedChildEdge.descriptor.parents, [{ sourceSlotId: 'PG-005', master: { path: acceptedMaster.path, sha256: acceptedMaster.sha256 }, runtime: { path: acceptedRuntime.path, sha256: acceptedRuntime.sha256 } }]);

  const finalizing = path.join(temporary, 'production/reports/biological-continuity-v3/g003-evidence-v3/finalization/finalizing.json');
  await mkdir(path.dirname(finalizing), { recursive: true }); await writeFile(finalizing, '{}');
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('finalizing.json'), repoRoot: temporary, verifiedInputs: inputs() }), /FINALIZING/);
  await unlink(finalizing);
  const terminal = path.join(temporary, 'production/reports/biological-continuity-v3/g003-evidence-v3/finalization/terminal.json'); await writeFile(terminal, '{}');
  await assert.rejects(buildQueueCandidateDescriptorFixture({ slotId: 'PG-005', generationRunId: rootRun, outputPath: descriptorPath('terminal.json'), repoRoot: temporary, verifiedInputs: inputs() }), /TERMINAL/);

} finally {
  await rm(temporary, { recursive: true, force: true });
}

const productionDescriptorRoot = path.join(SOURCE_ROOT, DESCRIPTOR_ROOT); await mkdir(productionDescriptorRoot, { recursive: true });
const integrityRoot = await mkdtemp(path.join(productionDescriptorRoot, 'prepare-integrity-'));
try {
  const integrityRelative = path.relative(SOURCE_ROOT, integrityRoot).split(path.sep).join('/');
  const builtRelative = `${integrityRelative}/built.json`;
  const built = await buildQueueCandidateDescriptor({ slotId: 'PG-005', generationRunId: 'g003-w0-pg005-r3', outputPath: builtRelative });
  const descriptor = JSON.parse(await readFile(path.join(SOURCE_ROOT, builtRelative))); const conductorKey = Buffer.from('g003-descriptor-integrity-self-test-conductor-key-0001');
  const materialAuthority = await verifyCandidateMaterializationAuthority(descriptor, { repoRoot: SOURCE_ROOT });
  assert.equal(materialAuthority.lockedGate.queueCandidates.length, 177);
  const childTamper = structuredClone(descriptor); childTamper.child.master = structuredClone(descriptor.parents[0].master);
  const childTamperRelative = `${integrityRelative}/tampered-child.json`; await writeFile(path.join(SOURCE_ROOT, childTamperRelative), canonicalStringify(childTamper));
  await assert.rejects(prepare(childTamperRelative, conductorKey), /hard-pinned G003 public authority and commitment/);
  const parentTamper = structuredClone(descriptor); parentTamper.parents[0].runtime = structuredClone(descriptor.child.runtime);
  const parentTamperRelative = `${integrityRelative}/tampered-root-parent.json`; await writeFile(path.join(SOURCE_ROOT, parentTamperRelative), canonicalStringify(parentTamper));
  await assert.rejects(prepare(parentTamperRelative, conductorKey), /hard-pinned G003 public authority and commitment/);
  assert.equal(built.descriptorSha256, sha256Bytes(Buffer.from(canonicalStringify(descriptor))));
} finally {
  await rm(integrityRoot, { recursive: true, force: true });
}

const directPrepare = spawnSync(process.execPath, ['scripts/prepare-continuity-candidate-review.mjs', 'prepare', 'forbidden.json', '--conductor-key-stdin'], { cwd: SOURCE_ROOT, encoding: 'utf8' });
assert.equal(directPrepare.status, 2); assert.match(directPrepare.stderr, /Direct prepare is disabled/);

console.log(JSON.stringify({ status: 'PASS', cases: 23, root: 'PG-005', dependent: 'PG-065', mixed: 'PG-066', prepareTamperRejections: 2 }));
