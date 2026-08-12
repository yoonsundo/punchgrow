#!/usr/bin/env node

import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertAdjudicationCannotOverride,
  assertExactCoverage,
  assertVoteAuthorizationBinding,
  validateVoteIdentity,
  writeAtomicNoFollowForTest,
} from './build-g001-unblinded-census.mjs';
import {
  assertExactEvidenceFileSet,
  assertTrustedDirectoryRoot,
  finalizeVote,
  sha256Canonical,
  validateVoteAuthenticity,
} from './verify-blinded-visual-review.mjs';

const conductorKey = Buffer.from('g001-hostile-self-test-conductor-key-material-0001');

assert.throws(() => assertExactCoverage(['asset-a'], ['asset-a', 'asset-b'], 'synthetic'), /coverage mismatch.*asset-b/i);
assert.throws(() => assertExactCoverage(['asset-a', 'asset-a'], ['asset-a'], 'synthetic'), /duplicate/i);
assert.throws(() => assertExactEvidenceFileSet(['pass-1/batch-1.json'], ['pass-1/batch-1.json', 'pass-2/batch-2.json'], 'authorization'), /exact file set/i, 'missing authorization must fail');
assert.throws(() => assertExactEvidenceFileSet(['pass-1/batch-1.json', 'extra.json'], ['pass-1/batch-1.json'], 'authorization'), /exact file set/i, 'extra authorization must fail');

const signedVote = finalizeVote({
  schemaVersion: 'visual-review-v1', reviewId: 'review-hostile-0001',
  reviewTarget: { kind: 'asset', opaqueInputId: 'asset-hostile-0001' },
  reviewer: { reviewerInstanceId: 'reviewer-hostile-0001', agentTaskId: 'task-hostile-0001', role: 'primary' },
  voterReviewRunId: 'run-hostile-0001', confidence: 0.99,
  provenance: {
    bundleGenerationRunId: 'g001-baseline-v1', authorizationId: 'auth-hostile-0001',
    batchPackageManifestSha256: '1'.repeat(64), fileSetSha256: '2'.repeat(64), bundleManifestSha256: '3'.repeat(64),
  },
  assetObservation: { biologicalClass: 'mammal' },
}, conductorKey);
const staleDigest = structuredClone(signedVote);
staleDigest.confidence = 0.1;
assert.throws(() => validateVoteAuthenticity(staleDigest, conductorKey), /output hash drift/i, 'tampered payload with stale digest/HMAC must fail');
const forgedDigest = structuredClone(staleDigest);
const withoutSignatures = structuredClone(forgedDigest);
delete withoutSignatures.outputSha256;
delete withoutSignatures.conductorHmacSha256;
forgedDigest.outputSha256 = sha256Canonical(withoutSignatures);
assert.throws(() => validateVoteAuthenticity(forgedDigest, conductorKey), /HMAC verification failed/i, 'forged digest with stale HMAC must fail');

const authorization = {
  authorizationId: 'auth-hostile-0001', bundleGenerationRunId: 'g001-baseline-v1',
  passId: 'pass-1', batchId: 'pass-1-batch-001', role: 'primary',
  reviewerInstanceId: 'reviewer-hostile-0001', agentTaskId: 'task-hostile-0001', voterReviewRunId: 'run-hostile-0001',
  assignedOpaqueInputIds: ['asset-hostile-0001'], batchPackageManifestSha256: '1'.repeat(64), fileSetSha256: '2'.repeat(64),
  targetManifestSha256s: { 'asset-hostile-0001': '3'.repeat(64) },
};
assert.doesNotThrow(() => assertVoteAuthorizationBinding(signedVote, authorization, {
  passId: 'pass-1', batchId: 'pass-1-batch-001', opaqueInputId: 'asset-hostile-0001', targetKind: 'asset',
}));
assert.throws(() => assertVoteAuthorizationBinding({ ...signedVote, voterReviewRunId: 'run-forged-0001' }, authorization, {
  passId: 'pass-1', batchId: 'pass-1-batch-001', opaqueInputId: 'asset-hostile-0001', targetKind: 'asset',
}), /identity does not match/i, 'vote/authorization identity mismatch must fail');

const primary = (reviewId, continuity = 'yes') => ({
  reviewId, reviewTarget: { kind: 'asset', opaqueInputId: 'asset-a' },
  assetObservation: { biologicalClass: 'mammal', speciesFamily: 'fox', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal', masterRuntimeContinuity: continuity },
  confidence: 0.99,
});
const adjudication = {
  ...primary('review-adjudicator'), schemaVersion: 'visual-review-v1', voterReviewRunId: 'vision-run-pass3-batch001',
  reviewer: { role: 'adjudicator', reviewerInstanceId: 'vision-adjudicator-pass3-batch001' },
  provenance: { bundleGenerationRunId: 'g001-baseline-v1' },
};
assert.throws(() => assertAdjudicationCannotOverride({
  primaryVotes: [primary('review-1', 'no'), primary('review-2')], adjudication,
  derivedTarget: { verdict: 'PASS', reasons: [] },
}), /substantive dissent/i, 'pass3 cannot erase substantive dissent');
assert.throws(() => validateVoteIdentity(adjudication, { passNumber: 3, batchNumber: 1, opaqueInputId: 'asset-a', targetKind: 'edge' }), /target mismatch|taxonomy assets only/i);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'g001-census-hostile-'));
try {
  const realEvidence = path.join(temporary, 'real-evidence');
  const realSource = path.join(temporary, 'real-source');
  await mkdir(realEvidence); await mkdir(realSource);
  const evidenceLink = path.join(temporary, 'evidence-link');
  const sourceLink = path.join(temporary, 'source-link');
  await symlink(realEvidence, evidenceLink); await symlink(realSource, sourceLink);
  await assert.rejects(assertTrustedDirectoryRoot(evidenceLink, 'evidence root'), /non-symlink directory/i, 'symlinked evidence root must fail');
  await assert.rejects(assertTrustedDirectoryRoot(sourceLink, 'source root'), /non-symlink directory/i, 'symlinked source root must fail');

  const symlinkOutputRoot = path.join(temporary, 'symlink-output'); await mkdir(symlinkOutputRoot);
  const symlinkExternal = path.join(temporary, 'symlink-external.txt'); await writeFile(symlinkExternal, 'external-safe');
  await symlink(symlinkExternal, path.join(symlinkOutputRoot, 'approved.json'));
  await assert.rejects(
    writeAtomicNoFollowForTest({ containmentRoot: symlinkOutputRoot, relativePath: 'approved.json', bytes: 'replacement' }),
    /symlink/i,
    'symlinked output destination must fail',
  );
  assert.equal(await readFile(symlinkExternal, 'utf8'), 'external-safe', 'symlink target must remain unchanged');

  const hardlinkOutputRoot = path.join(temporary, 'hardlink-output'); await mkdir(hardlinkOutputRoot);
  const hardlinkExternal = path.join(temporary, 'hardlink-external.txt'); await writeFile(hardlinkExternal, 'external-safe');
  await link(hardlinkExternal, path.join(hardlinkOutputRoot, 'approved.json'));
  await assert.rejects(
    writeAtomicNoFollowForTest({ containmentRoot: hardlinkOutputRoot, relativePath: 'approved.json', bytes: 'replacement' }),
    /hard-linked/i,
    'hard-linked output destination must fail',
  );
  assert.equal(await readFile(hardlinkExternal, 'utf8'), 'external-safe', 'hard-link peer must remain unchanged');

  const raceRoot = path.join(temporary, 'race-output'); await mkdir(raceRoot);
  const raceBackup = path.join(temporary, 'race-output-backup');
  const raceExternal = path.join(temporary, 'race-external'); await mkdir(raceExternal);
  await writeFile(path.join(raceExternal, 'approved.json'), 'external-safe');
  await assert.rejects(
    writeAtomicNoFollowForTest({
      containmentRoot: raceRoot, relativePath: 'approved.json', bytes: 'replacement',
      beforeCommit: async () => { await rename(raceRoot, raceBackup); await symlink(raceExternal, raceRoot); },
    }),
    /ancestor is symlinked|containment root is substituted/i,
    'ancestor swap before commit must fail',
  );
  assert.equal(await readFile(path.join(raceExternal, 'approved.json'), 'utf8'), 'external-safe', 'ancestor swap target must remain unchanged');

  const normalOutputRoot = path.join(temporary, 'normal-output'); await mkdir(normalOutputRoot);
  assert.equal((await writeAtomicNoFollowForTest({ containmentRoot: normalOutputRoot, relativePath: 'approved.json', bytes: 'first' })).changed, true);
  assert.equal((await writeAtomicNoFollowForTest({ containmentRoot: normalOutputRoot, relativePath: 'approved.json', bytes: 'first' })).changed, false, 'byte-identical rerun must be stable');
  assert.equal((await writeAtomicNoFollowForTest({ containmentRoot: normalOutputRoot, relativePath: 'approved.json', bytes: 'second' })).changed, true, 'legitimate output update must succeed');
  const normalInfo = await lstat(path.join(normalOutputRoot, 'approved.json'));
  assert.ok(normalInfo.isFile() && !normalInfo.isSymbolicLink() && normalInfo.nlink === 1);
  assert.equal(await readFile(path.join(normalOutputRoot, 'approved.json'), 'utf8'), 'second');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(JSON.stringify({ tests: 16, status: 'PASS' }));
