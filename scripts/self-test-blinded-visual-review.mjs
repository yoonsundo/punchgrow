#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pngjs from 'pngjs';

import {
  deriveBlindedVisualReview,
  verifyBlindedReviewBundle,
  verifyIsolatedPackageFileSet,
  verifyMaterializedAssignmentPixels,
  validateAuthorizationIdentityConstraints,
  assertNoAggregateInputs,
  assertExactEvidenceFileSet,
  listPackageFiles,
  writeAtomicApproved,
} from './verify-blinded-visual-review.mjs';

const { PNG } = pngjs;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

assert.throws(
  () => verifyBlindedReviewBundle({ manifest: { inputs: [{ surfaces: { master: { path: '/no/such.png' } } }] }, allowlist: {} }),
  /legacy in-memory bundle verification is disabled/i,
  'hostile nonexistent/outside pixels cannot pass a legacy export',
);

const identityAuth = { passId: 'pass-1', batchId: 'pass-1-batch-001', role: 'primary', attempt: 1, reviewerInstanceId: 'reviewer-fixed-001', agentTaskId: 'task-fixed-001', voterReviewRunId: 'run-fixed-001' };
assert.throws(() => validateAuthorizationIdentityConstraints([identityAuth, { ...identityAuth, batchId: 'pass-1-batch-002', agentTaskId: 'task-fixed-002', voterReviewRunId: 'run-fixed-002' }]), /reviewerInstanceId may belong to exactly one batch/i);
assert.throws(() => assertNoAggregateInputs({ votes: '/tmp/forged-valid-aggregate.json' }), /aggregate inputs are forbidden/i);
assert.throws(() => assertExactEvidenceFileSet(['pass-1/batch/a.json'], ['pass-1/batch/a.json', 'pass-1/batch/b.json'], 'raw votes'), /partial|exact file set/i);
assert.throws(() => assertExactEvidenceFileSet(['pass-1/batch/a.json', 'pass-1/batch/b.json'], ['pass-1/batch/a.json'], 'raw votes'), /extra|exact file set/i);
assert.throws(() => assertExactEvidenceFileSet(['pass-1/batch/a.json'], ['pass-1/batch/a.json', 'pass-1/batch/a.json'], 'raw votes'), /replay|duplicate/i);
assert.throws(
  () => deriveBlindedVisualReview({ manifest: {}, allowlist: {}, votes: [] }),
  /legacy in-memory verdict derivation is disabled/i,
  'legacy verdict derivation cannot bypass graph, sidecar, package, or attestation checks',
);

const root = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-verifier-'));
try {
  const bytes = PNG.sync.write(new PNG({ width: 3, height: 2 }));
  const surface = { sha256: sha256(bytes), bytes: bytes.length, width: 3, height: 2 };
  const manifest = {
    assignmentId: 'assignment-test-001',
    input: { opaqueInputId: 'opaque-test-asset', targetKind: 'asset', surfaces: {
      master: { path: 'inputs/asset/master.png', ...surface }, runtime: { path: 'inputs/asset/runtime.png', ...surface },
    } },
  };
  await mkdir(path.join(root, 'inputs/asset'), { recursive: true });
  await writeFile(path.join(root, 'inputs/asset/master.png'), bytes);
  await writeFile(path.join(root, 'inputs/asset/runtime.png'), bytes);
  assert.equal(await verifyMaterializedAssignmentPixels({ manifest, bundleRoot: root }), 2);

  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  await writeFile(path.join(root, 'inputs/asset/master.png'), changed);
  await assert.rejects(verifyMaterializedAssignmentPixels({ manifest, bundleRoot: root }), /pixel hash drift/i, 'changed pixel must fail');
  await writeFile(path.join(root, 'inputs/asset/master.png'), bytes);

  const traversal = structuredClone(manifest); traversal.input.surfaces.master.path = '../../outside-pixel.png';
  await assert.rejects(verifyMaterializedAssignmentPixels({ manifest: traversal, bundleRoot: root }), /non-canonical pixel path|traversal/i);

  for (const filename of ['REVIEW_PROMPT.md', 'bundle-manifest.json', 'input-allowlist.json', 'review-contract.schema.json', 'vote-template.json']) await writeFile(path.join(root, filename), 'fixture');
  await writeFile(path.join(root, 'graph.json'), '{}');
  await assert.rejects(verifyIsolatedPackageFileSet(root, { kind: 'asset', assignmentId: 'assignment-test-001', assets: [{ slot: 'asset' }] }), /extra files|global context/i, 'injected graph/context must fail');
  await rm(path.join(root, 'graph.json'));

  const symlinkRoot = path.join(root, 'symlink-case'); await mkdir(symlinkRoot);
  await symlink(path.join(root, 'inputs'), path.join(symlinkRoot, 'inputs'));
  await assert.rejects(verifyMaterializedAssignmentPixels({ manifest, bundleRoot: symlinkRoot }), /symlink/i);

  const hardlinkRoot = path.join(root, 'hardlink-case'); await mkdir(path.join(hardlinkRoot, 'inputs/asset'), { recursive: true });
  await link(path.join(root, 'inputs/asset/master.png'), path.join(hardlinkRoot, 'inputs/asset/master.png'));
  await link(path.join(root, 'inputs/asset/runtime.png'), path.join(hardlinkRoot, 'inputs/asset/runtime.png'));
  await assert.rejects(verifyMaterializedAssignmentPixels({ manifest, bundleRoot: hardlinkRoot }), /hard link|independent file/i);

  await assert.rejects(writeAtomicApproved(root, 'test-run-001', path.join(root, 'outside.json'), '{}\n'), /approved run evidence/i);
  const outputRepo = path.join(root, 'output-repo'); await mkdir(path.join(outputRepo, '.omx'), { recursive: true });
  await symlink(root, path.join(outputRepo, '.omx/evidence'));
  await assert.rejects(writeAtomicApproved(outputRepo, 'test-run-001', path.join(outputRepo, '.omx/evidence/visual-census/test-run-001/derived-verdict.json'), '{}\n'), /symlinked verifier output ancestor/i);

  const forgedEvidence = path.join(root, 'forged-external-evidence'); await mkdir(forgedEvidence); await writeFile(path.join(forgedEvidence, 'forged.json'), '{}\n');
  const authorizationRoot = path.join(root, 'authorizations-root'); await symlink(forgedEvidence, authorizationRoot);
  await assert.rejects(listPackageFiles(authorizationRoot), /root must be a real non-symlink directory/i, 'authorization root symlink to forged tree must fail');
  const rawVoteRoot = path.join(root, 'raw-votes-root'); await symlink(forgedEvidence, rawVoteRoot);
  await assert.rejects(listPackageFiles(rawVoteRoot), /root must be a real non-symlink directory/i, 'raw-vote root symlink to forged tree must fail');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ tests: 17, status: 'PASS' }));
