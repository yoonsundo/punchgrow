#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import {
  CONTINUITY_AUTHORITY_EPOCH, CONTINUITY_SUPERSESSION_PURPOSE, G002_V2_IMMUTABLE_PREDECESSOR,
  assertSingleContinuityDelegationTip, deriveContinuityAuthority, signContinuityEvidenceWithAuthority,
  validateContinuityDelegation, verifyContinuityEvidence,
} from './lib/continuity-public-authority.mjs';
import { assertContinuityDelegationTipAvailable, attestContinuityAuthorityDelegation } from './attest-continuity-authority-delegation.mjs';
import { verifyImmutableG002V2Predecessor } from './verify-continuity-authority-delegation.mjs';
import {
  CONTINUITY_ROOT_DIRECTIVES, assertCrossAuthoritySupersessionTipAvailable, attestCrossAuthoritySupersession, deriveCrossAuthorityObligationScope,
  deriveCrossAuthorityAssignmentV3Binding, supersessionIntentV1, validateCrossAuthoritySupersession, validateSupersessionIntentV1, verifyCrossAuthoritySupersession,
} from './lib/continuity-assignment/g002-v2-cross-authority-supersession.mjs';
import {
  G003_V5_ASSIGNMENT_V3_PATH, assertG003V5AssignmentV3TipAvailable,
  attestSignedG003V5AssignmentV3, validateSignedG003V5AssignmentV3,
  projectG003V5AssignmentV3Core, verifySignedG003V5AssignmentV3,
} from './lib/continuity-assignment/g003-v5-assignment.mjs';
import { buildG002V2ContinuityAssignment, V2_OUTPUT_NAMES } from './build-g002-v2-continuity-assignment.mjs';
import { stableJson } from './lib/continuity-assignment/compatibility.mjs';
import { buildSignedObligationScope } from './lib/continuity-assignment/solver.mjs';
import { createG003TransitionSnapshotForTest, loadVerifiedG003TransitionSnapshot } from './lib/g003-transition-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative)));
for (const schemaPath of [
  'production/contracts/continuity-public-authority-v1.schema.json',
  'production/contracts/continuity-authority-delegation-v1.schema.json',
  'production/contracts/continuity-signed-obligation-scope-v1.schema.json',
  'production/contracts/continuity-g002-v2-supersession-intent-v1.schema.json',
  'production/contracts/continuity-g002-v2-supersession-v1.schema.json',
]) assert.equal((await json(schemaPath)).additionalProperties, false, `${schemaPath}: contract must be closed`);
const schemaSha256 = sha256Canonical(await json('production/contracts/continuity-g002-v2-supersession-v1.schema.json'));
const assignment = await json(G002_V2_IMMUTABLE_PREDECESSOR.assignmentPath);
const topology = await json('production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json');
const scope = deriveCrossAuthorityObligationScope(assignment, topology);
const testOnlyTransitionSnapshot = createG003TransitionSnapshotForTest({ assignment, topology });
const assignmentSchemaSha256 = sha256Bytes(await readFile(path.join(ROOT, 'production/contracts/continuity-assignment-v3.schema.json')));
const assignmentV3 = await deriveCrossAuthorityAssignmentV3Binding(ROOT, testOnlyTransitionSnapshot, scope);
assert.equal(assignmentV3.schemaSha256, assignmentSchemaSha256);
const intent = supersessionIntentV1(scope, assignmentV3);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const authority = { privateKey, publicKey, publicKeySpkiDerBase64: publicDer.toString('base64'), fingerprintSha256: createHash('sha256').update(publicDer).digest('hex'), rootKeyCommitmentSha256: 'a'.repeat(64) };
const successorPath = 'production/reports/biological-continuity-v3/continuity-authority/g002-v2-supersession-v1.json';
const grant = { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaVersion: 'continuity-g002-v2-supersession-v1', schemaSha256, successorPath, assignmentV3, oneTime: true, nativeG002SignatureClaimAllowed: false };
const delegate = { algorithm: 'Ed25519', authorityEpoch: CONTINUITY_AUTHORITY_EPOCH, authorityFingerprint: authority.fingerprintSha256, publicKeySpkiDerBase64: authority.publicKeySpkiDerBase64, rootKeyCommitmentSha256: authority.rootKeyCommitmentSha256 };
const delegationCore = {
  schemaVersion: 'continuity-authority-delegation-v1',
  delegationId: `continuity-delegation-${sha256Canonical({ predecessor: G002_V2_IMMUTABLE_PREDECESSOR, successorPath }).slice(0, 24)}`,
  nonce: 'c'.repeat(64),
  issuer: { authorityEpoch: 'g003-authority-epoch-v1', authorityFingerprint: '91336f3180f8cf86cdef4b35f271c1e64eb609cd6b4e7f53360c777fa1a48e54' },
  delegate, grant, predecessor: G002_V2_IMMUTABLE_PREDECESSOR, successorIntentSha256: sha256Canonical(intent),
};
const delegationUnsigned = { ...delegationCore, outputSha256: sha256Canonical(delegationCore) };
const delegation = { ...delegationUnsigned, publicSignature: { algorithm: 'Ed25519', authorityEpoch: 'g003-authority-epoch-v1', authorityFingerprint: delegationCore.issuer.authorityFingerprint, purpose: 'g003:continuity-authority-delegation', schemaSha256: 'b'.repeat(64), signatureBase64: Buffer.alloc(64).toString('base64') } };
validateContinuityDelegation(delegation, { delegatedSchemaSha256: schemaSha256 });
assert.throws(() => deriveContinuityAuthority(Buffer.alloc(32, 7)), /hard-pinned G003/);
let derivationsBeforeVerification = 0; let signaturesBeforeVerification = 0;
await assert.rejects(attestContinuityAuthorityDelegation({
  repoRoot: ROOT, g003RootKey: Buffer.alloc(32), write: false,
  verifyPredecessor: async () => { throw new Error('predecessor rejected'); },
  deriveAuthority: () => { derivationsBeforeVerification += 1; return authority; },
  issuerSigner: () => { signaturesBeforeVerification += 1; return delegation.publicSignature; },
}), /ENOENT|freeze/i);
assert.equal(derivationsBeforeVerification, 0); assert.equal(signaturesBeforeVerification, 0);

const builtDelegation = await attestContinuityAuthorityDelegation({
  repoRoot: ROOT, g003RootKey: Buffer.alloc(32), write: false, nonce: 'e'.repeat(64),
  testOnlyTransitionSnapshot, deriveAuthority: () => authority,
  issuerSigner: (_unsigned, _key, options) => ({ algorithm: 'Ed25519', authorityEpoch: 'g003-authority-epoch-v1', authorityFingerprint: delegationCore.issuer.authorityFingerprint, purpose: options.purpose, schemaSha256: options.schemaSha256, signatureBase64: Buffer.alloc(64).toString('base64') }),
  issuerVerifier: () => true,
});
assert.equal(builtDelegation.delegation.successorIntentSha256, sha256Canonical(intent));
assert.equal(builtDelegation.delegation.grant.successorPath, successorPath);

await verifyImmutableG002V2Predecessor({ repoRoot: ROOT, verifyPredecessor: async () => ({ status: 'PASS' }) });
assert.deepEqual(scope.counts, { queue: 167, retained: 73, ordinaryEdges: 170, obligations: 337, dependent: 113, generatedParentEdges: 113, generatedChildEdges: 128, retainedChildEdges: 42, votes: 674, effectiveRoots: 17 });
assert.deepEqual(scope.excludedMixedSlotIds, Array.from({ length: 10 }, (_, index) => `PG-${196 + index}`));
assert.equal(scope.excludedMixedIncidentEdges.length, 20);
assert.equal(scope.fusionProvenance.length, 10);
assert.deepEqual(CONTINUITY_ROOT_DIRECTIVES[0].canonicalTarget, { biologicalClass: 'construct', speciesFamily: 'construct', coreAnatomy: 'hexapod', locomotionPlan: 'crawling' });
assert.deepEqual(CONTINUITY_ROOT_DIRECTIVES[0].visibilityRequirements, ['exactly-six-visible-walking-legs', 'all-six-legs-separately-readable']);
assert.equal(CONTINUITY_ROOT_DIRECTIVES[1].canonicalTarget.speciesFamily, 'ovine');

const signer = (unsigned, _key, usedDelegation, options) => signContinuityEvidenceWithAuthority(unsigned, authority, usedDelegation, options);
const built = await attestCrossAuthoritySupersession({ repoRoot: ROOT, delegation, write: false, testOnlyTransitionSnapshot, testOnlyVerifiedDelegation: { delegation }, signer });
validateCrossAuthoritySupersession(built.value, { delegation, schemaSha256, expectedIntent: intent });
assert.equal((await verifyCrossAuthoritySupersession({ repoRoot: ROOT, value: built.value, delegation, transitionSnapshot: testOnlyTransitionSnapshot, testOnlyVerifiedDelegation: { delegation } })).status, 'PASS');

const signedAssignment = await attestSignedG003V5AssignmentV3({
  repoRoot: ROOT, delegation, successor: built.value, write: false,
  testOnlyTransitionSnapshot, testOnlyVerifiedDelegation: { delegation }, signer,
});
assert.equal(signedAssignment.value.successorOutputSha256, built.value.outputSha256);
assert.equal(signedAssignment.value.delegationOutputSha256, delegation.outputSha256);
assert.equal(signedAssignment.value.publicSignature.schemaSha256, assignmentSchemaSha256);
assert.equal(Object.hasOwn(intent.assignmentV3, 'successorOutputSha256'), false, 'assignment core binding must remain acyclic');
assert.equal(Object.hasOwn(delegation.grant.assignmentV3, 'successorOutputSha256'), false, 'delegation assignment binding must remain acyclic');
assert.equal((await verifySignedG003V5AssignmentV3({
  repoRoot: ROOT, value: signedAssignment.value, delegation, successor: built.value,
  transitionSnapshot: testOnlyTransitionSnapshot, testOnlyVerifiedDelegation: { delegation },
})).status, 'PASS');
const assignmentCoreDrift = structuredClone(signedAssignment.value);
assignmentCoreDrift.obligations[0].requiredChildTaxonomy.speciesFamily = 'fabricated';
assert.throws(() => validateSignedG003V5AssignmentV3(assignmentCoreDrift, {
  delegation, successor: built.value, schemaSha256: assignmentSchemaSha256,
  expectedCore: projectG003V5AssignmentV3Core(signedAssignment.value),
}), /core differs/);
const successorReplayAssignment = structuredClone(signedAssignment.value); successorReplayAssignment.successorOutputSha256 = '0'.repeat(64);
assert.throws(() => validateSignedG003V5AssignmentV3(successorReplayAssignment, {
  delegation, successor: built.value, schemaSha256: assignmentSchemaSha256,
  expectedCore: projectG003V5AssignmentV3Core(signedAssignment.value),
}), /predecessor envelope/);
assert.throws(() => validateSignedG003V5AssignmentV3(signedAssignment.value, {
  delegation, successor: built.value, schemaSha256: '0'.repeat(64),
  expectedCore: projectG003V5AssignmentV3Core(signedAssignment.value),
}), /fixed path\/schema\/core binding/);
const assignmentPathDrift = structuredClone(built.value);
assignmentPathDrift.assignmentV3.fixedPath = 'production/reports/biological-continuity-v3/continuity-authority/alternate-assignment.json';
assert.throws(() => validateCrossAuthoritySupersession(assignmentPathDrift, {
  delegation, schemaSha256, expectedIntent: intent,
}), /assignment-v3 binding|projection differs/);

const purposeReplay = structuredClone(built.value); purposeReplay.publicSignature.purpose = 'continuity:other-purpose';
assert.throws(() => validateCrossAuthoritySupersession(purposeReplay, { delegation, schemaSha256, expectedIntent: intent }), /purpose|signature/);
const schemaReplay = structuredClone(built.value); schemaReplay.publicSignature.schemaSha256 = '0'.repeat(64);
assert.throws(() => validateCrossAuthoritySupersession(schemaReplay, { delegation, schemaSha256, expectedIntent: intent }), /schema|signature/);
const delegationReplay = structuredClone(built.value); delegationReplay.publicSignature.delegationOutputSha256 = '0'.repeat(64);
assert.throws(() => validateCrossAuthoritySupersession(delegationReplay, { delegation, schemaSha256, expectedIntent: intent }), /delegation|signature/);

const builtUnsigned = structuredClone(built.value); delete builtUnsigned.publicSignature;
const g003DomainPayload = {
  domain: 'punchgrow:g003:public-evidence-signature-v1\0', authorityEpoch: CONTINUITY_AUTHORITY_EPOCH,
  delegationOutputSha256: delegation.outputSha256, purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaSha256,
  unsignedCanonicalBytesBase64: Buffer.from(canonicalStringify(builtUnsigned)).toString('base64'),
};
const domainReplaySignature = { ...built.value.publicSignature, signatureBase64: sign(null, Buffer.from(canonicalStringify(g003DomainPayload)), privateKey).toString('base64') };
assert.throws(() => verifyContinuityEvidence(builtUnsigned, domainReplaySignature, delegation, { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaSha256 }), /verification failed/);

const namespaceConfusion = structuredClone(built.value); namespaceConfusion.rootDirectives[0].anchors[0] = 'g003:borrowed-anchor';
{ const unsigned = structuredClone(namespaceConfusion); delete unsigned.publicSignature; const core = structuredClone(unsigned); delete core.outputSha256; unsigned.outputSha256 = sha256Canonical(core); Object.assign(namespaceConfusion, unsigned); namespaceConfusion.publicSignature = signer(unsigned, null, delegation, { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaSha256 }); }
assert.throws(() => validateCrossAuthoritySupersession(namespaceConfusion, { delegation, schemaSha256, expectedIntent: intent }), /root directives|reserved namespace/);

const mixedDrift = structuredClone(built.value); mixedDrift.obligationScope.excludedMixedSlotIds[0] = 'PG-195';
{ const unsigned = structuredClone(mixedDrift); delete unsigned.publicSignature; const core = structuredClone(unsigned); delete core.outputSha256; unsigned.outputSha256 = sha256Canonical(core); Object.assign(mixedDrift, unsigned); mixedDrift.publicSignature = signer(unsigned, null, delegation, { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaSha256 }); }
assert.throws(() => validateCrossAuthoritySupersession(mixedDrift, { delegation, schemaSha256, expectedIntent: intent }), /scope mismatch/);

const purposeDelegationReplay = structuredClone(delegation); purposeDelegationReplay.grant.purpose = 'g003:continuity-authority-delegation';
assert.throws(() => validateContinuityDelegation(purposeDelegationReplay, { delegatedSchemaSha256: schemaSha256 }), /grant|namespace/);
assert.throws(() => validateContinuityDelegation(delegation, { delegatedSchemaSha256: '0'.repeat(64) }), /schema fingerprint/);

const rebuildDelegation = (candidate) => {
  const core = structuredClone(candidate); delete core.outputSha256; delete core.publicSignature;
  return { ...core, outputSha256: sha256Canonical(core), publicSignature: delegation.publicSignature };
};
const secondDelegation = rebuildDelegation({ ...structuredClone(delegation), nonce: 'd'.repeat(64) });
assert.throws(() => assertSingleContinuityDelegationTip([delegation, secondDelegation]), /second delegation for the same predecessor/);
const reusedNonce = structuredClone(delegation); reusedNonce.predecessor.assignmentFileSha256 = '0'.repeat(64);
reusedNonce.delegationId = `continuity-delegation-${sha256Canonical({ predecessor: reusedNonce.predecessor, successorPath }).slice(0, 24)}`;
assert.throws(() => assertSingleContinuityDelegationTip([delegation, rebuildDelegation(reusedNonce)]), /nonce reuse/);
const alternateTip = structuredClone(delegation); alternateTip.grant.successorPath = 'production/reports/biological-continuity-v3/continuity-authority/alternate.json';
assert.throws(() => validateContinuityDelegation(rebuildDelegation(alternateTip), { delegatedSchemaSha256: schemaSha256 }), /grant mismatch/);
const replayedIntentDelegation = rebuildDelegation({ ...structuredClone(delegation), successorIntentSha256: '0'.repeat(64) });
let replaySignerCalls = 0;
await assert.rejects(attestCrossAuthoritySupersession({ repoRoot: ROOT, delegation: replayedIntentDelegation, write: false, testOnlyTransitionSnapshot, testOnlyVerifiedDelegation: { delegation: replayedIntentDelegation }, signer: () => { replaySignerCalls += 1; return built.value.publicSignature; } }), /does not authorize canonical successor intent/);
assert.equal(replaySignerCalls, 0);

const circularIntent = structuredClone(intent); circularIntent.outputSha256 = '0'.repeat(64);
assert.throws(() => validateSupersessionIntentV1(circularIntent), /fields mismatch/);
const circularSuccessor = structuredClone(built.value); circularSuccessor.delegation = delegation;
assert.throws(() => validateCrossAuthoritySupersession(circularSuccessor, { delegation, schemaSha256, expectedIntent: intent }), /fields mismatch/);
const nativeG002Claim = structuredClone(built.value); nativeG002Claim.authorityTransition.nativeG002SignatureClaim = true;
assert.throws(() => validateCrossAuthoritySupersession(nativeG002Claim, { delegation, schemaSha256, expectedIntent: intent }), /authority transition/);
const oneBitMutation = structuredClone(built.value); oneBitMutation.obligationScope.queueSlotIds[0] = oneBitMutation.obligationScope.queueSlotIds[0] === 'PG-001' ? 'PG-002' : 'PG-001';
assert.throws(() => validateCrossAuthoritySupersession(oneBitMutation, { delegation, schemaSha256, expectedIntent: intent }), /projection differs/);
const alternateOrdering = structuredClone(built.value); alternateOrdering.obligationScope.ordinaryEdges.reverse();
assert.throws(() => validateCrossAuthoritySupersession(alternateOrdering, { delegation, schemaSha256, expectedIntent: intent }), /projection differs/);

const fixedTipRoot = await mkdtemp(path.join(os.tmpdir(), 'continuity-fixed-tip-'));
try {
  const fixedTip = path.join(fixedTipRoot, successorPath); await mkdir(path.dirname(fixedTip), { recursive: true }); await writeFile(fixedTip, '{}');
  await assert.rejects(assertContinuityDelegationTipAvailable(fixedTipRoot), /fixed tip already exists/);
  await assert.rejects(assertCrossAuthoritySupersessionTipAvailable(fixedTipRoot), /fixed tip already exists/);
  const assignmentTip = path.join(fixedTipRoot, G003_V5_ASSIGNMENT_V3_PATH);
  await mkdir(path.dirname(assignmentTip), { recursive: true }); await writeFile(assignmentTip, '{}');
  await assert.rejects(assertG003V5AssignmentV3TipAvailable(fixedTipRoot), /fixed tip already exists/);
} finally { await rm(fixedTipRoot, { recursive: true, force: true }); }

const driftRoot = await mkdtemp(path.join(os.tmpdir(), 'continuity-predecessor-drift-'));
try {
  for (const relative of [G002_V2_IMMUTABLE_PREDECESSOR.publicManifestPath, G002_V2_IMMUTABLE_PREDECESSOR.successorPath, G002_V2_IMMUTABLE_PREDECESSOR.assignmentPath, 'production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json']) {
    await mkdir(path.dirname(path.join(driftRoot, relative)), { recursive: true }); await copyFile(path.join(ROOT, relative), path.join(driftRoot, relative));
  }
  await writeFile(path.join(driftRoot, G002_V2_IMMUTABLE_PREDECESSOR.assignmentPath), Buffer.concat([await readFile(path.join(driftRoot, G002_V2_IMMUTABLE_PREDECESSOR.assignmentPath)), Buffer.from('\n')]));
  await assert.rejects(verifyImmutableG002V2Predecessor({ repoRoot: driftRoot, verifyPredecessor: async () => ({ status: 'PASS' }) }), /byte drift/);
  await assert.rejects(loadVerifiedG003TransitionSnapshot(driftRoot), /byte drift/);
} finally { await rm(driftRoot, { recursive: true, force: true }); }

const legacyV2 = await buildG002V2ContinuityAssignment({ write: false, includeDocuments: true });
for (const name of V2_OUTPUT_NAMES) assert.equal(stableJson(legacyV2.documents[name]), await readFile(path.join(ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v2', name), 'utf8'), `legacy G002-v2 bytes changed: ${name}`);
assert.deepEqual(buildSignedObligationScope({
  scopeAuthority: 'continuity-g002-v2-supersession-v1', queue: legacyV2.solution.queue,
  topology: legacyV2.solution.topology, familyProofs: legacyV2.solution.familyProofs,
  regenerate: new Set(legacyV2.solution.queue.map((entry) => entry.slotId)),
}), scope);

console.log(JSON.stringify({ status: 'PASS', hostileChecks: 21, legacyV2FilesByteIdentical: V2_OUTPUT_NAMES.length, ...scope.counts }));
