#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import {
  G003_AUTHORITY, G003_COUNTS, G003_EDGE_CHILD_COUNTS, G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256,
  assertG003V3BaselineShape, g003V3OpaqueId, verifyG003V3Authority,
} from './lib/g003-v3-authority.mjs';
import { validateCandidateReview } from './prepare-continuity-candidate-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verified = await verifyG003V3Authority(ROOT);
assert.equal(verified.gate.queueCandidates.length, G003_COUNTS.regenerate);
assert.equal(verified.gate.edgeCandidates.length, G003_COUNTS.edges);
assert.equal(verified.effectiveRootIds.length, G003_COUNTS.effectiveRoots);
for (const rootId of verified.effectiveRootIds) {
  const assignment = verified.assignment.assignments.find((entry) => entry.slotId === rootId);
  assert.equal(assignment?.targetEvidence?.targetSource, verified.targetSource, `${rootId} did not inherit the v2 successor target source`);
  assert.equal(assignment?.targetEvidence?.canonicalContractOutputSha256, G003_AUTHORITY.successorOutputSha256, `${rootId} did not bind the v2 successor output`);
}
const generatedSlots = new Set(verified.gate.queueCandidates.map((item) => item.slotId));
const generatedEdgeChildren = verified.gate.edgeCandidates.filter((item) => generatedSlots.has(item.childId));
const retainedEdgeChildren = verified.gate.edgeCandidates.filter((item) => !generatedSlots.has(item.childId));
assert.equal(generatedEdgeChildren.length, G003_EDGE_CHILD_COUNTS.generated);
assert.equal(retainedEdgeChildren.length, G003_EDGE_CHILD_COUNTS.retained);
assert.equal(generatedEdgeChildren.length + retainedEdgeChildren.length, G003_COUNTS.edges);

assert.throws(() => assertG003V3BaselineShape({ ...verified.baseline, schemaVersion: 'continuity-g003-active-baseline-v1' }), /baseline shape/);
assert.throws(() => assertG003V3BaselineShape({ ...verified.baseline, protocolAuthoritySha256: '0'.repeat(64) }), /baseline shape/);
assert.throws(() => assertG003V3BaselineShape({ ...verified.baseline, authority: { ...G003_AUTHORITY, assignmentSha256: '0'.repeat(64) } }), /baseline shape/);

const material = { descriptorSha256: 'a'.repeat(64) };
const opaque = g003V3OpaqueId('candidate', material);
const legacyOpaque = `candidate-${sha256Canonical({ descriptorSha256: material.descriptorSha256, reviewProtocol: 'continuity-g003-review-protocol-v2' }).slice(0, 24)}`;
assert.notEqual(opaque, legacyOpaque);
assert.equal(opaque, g003V3OpaqueId('candidate', material));

await assert.rejects(validateCandidateReview({
  schemaVersion: 'continuity-candidate-review-v3', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
  opaqueCandidateId: opaque, generationRunId: 'legacy-v3', reviewKind: 'asset-reuse',
  packageManifestSha256: 'a'.repeat(64), materialBindingSha256: 'b'.repeat(64), inputAllowlistSha256: 'c'.repeat(64),
  promptSha256: 'd'.repeat(64), votes: [],
}, { repoRoot: ROOT, packageRelative: '.omx/evidence/continuity-candidates/legacy-v3', conductorKey: Buffer.alloc(32, 1) }), /review protocol v4/);

console.log(JSON.stringify({ status: 'PASS', protocol: G003_PROTOCOL, protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
  queueCandidates: G003_COUNTS.regenerate, edgeCandidates: G003_COUNTS.edges,
  generatedEdgeChildren: generatedEdgeChildren.length, retainedEdgeChildren: retainedEdgeChildren.length,
  obligations: G003_COUNTS.obligations, primaryVotes: G003_COUNTS.primaryVotes }));
