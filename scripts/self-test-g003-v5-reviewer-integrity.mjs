#!/usr/bin/env node

import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { adjudicateQuarantine } from './conduct-g003-reviews.mjs';
import {
  G003_V5_PROTOCOL, G003_V5_SCHEMA_PATHS, assertNoEffectiveMaterialRejection,
  assertRejectionObservationV2, assertReviewerAuthoredVerdictV2, canonicalReviewerObservationBytes,
  createG003V5AuthorityForTest, loadG003V5Authority, materialConstituentIndexKeys, materialWideTombstoneKey,
  readReviewerAuthoredObservation, resolveEffectiveRejectionState, resolveEffectiveReviewState,
} from './lib/g003-v5-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = '.omx/evidence/continuity-candidates/candidate-9a36ebc2adddf81cab12f955';
const assignmentPath = `${fixtureRoot}/review-authority/assignment-pass-2.json`;
const bindingPath = `${fixtureRoot}/private-binding.json`;
const assignmentBytes = await readFile(path.join(ROOT, assignmentPath));
const assignment = JSON.parse(assignmentBytes);
const binding = JSON.parse(await readFile(path.join(ROOT, bindingPath)));
const requiredAnchors = binding.reviewContract.anchorSets.flatMap((set) => set.anchors.map((anchor) => ({ parentRole: set.role, anchorId: anchor.anchorId, description: anchor.description })));
const packageContext = {
  opaqueCandidateId: binding.opaqueCandidateId, generationRunId: binding.generationRunId,
  packageManifestSha256: binding.packageManifestSha256,
  materialBindingSha256: assignment.materialBindingSha256,
  inputAllowlistSha256: binding.allowlistSha256, promptSha256: binding.promptSha256,
  inputAssetSha256s: assignment.inputAssetSha256s,
  requiredChildTaxonomy: binding.reviewContract.reviewPolicy.requiredChildTaxonomy,
  parentRoles: ['parent-1'], requiredAnchors,
  eiluBenchmarkId: binding.reviewContract.eiluBenchmark.benchmarkId, canonicalMode: false,
};
const base = {
  schemaVersion: 'continuity-g003-rejection-observation-v2', assignmentId: assignment.assignmentId,
  assignmentRawSha256: sha256Bytes(assignmentBytes), reviewerInstanceId: assignment.reviewerInstanceId,
  agentTaskId: assignment.agentTaskId, voterReviewRunId: assignment.voterReviewRunId, passNumber: assignment.passNumber,
  opaqueCandidateId: binding.opaqueCandidateId, generationRunId: binding.generationRunId,
  packageManifestSha256: binding.packageManifestSha256, materialBindingSha256: assignment.materialBindingSha256,
  inputAllowlistSha256: binding.allowlistSha256, promptSha256: binding.promptSha256,
  inputAssetSha256s: assignment.inputAssetSha256s, requiredChildTaxonomy: binding.reviewContract.reviewPolicy.requiredChildTaxonomy,
  verdict: 'REJECT', passEvidence: null,
  failureFindings: [{ type: 'taxonomy-mismatch', field: 'speciesFamily', expected: 'stylized-rockfish', observed: 'frog', surfaces: ['master', 'runtime'], explanation: 'Both child surfaces visibly read as a frog rather than the signed rockfish taxonomy.' }],
  explanation: 'Typed taxonomy mismatch blocks acceptance.', confidence: 0.99, observedAt: '2026-08-11T05:45:08.000Z',
};

assert.equal(assertRejectionObservationV2(base, { assignment, assignmentBytes, packageContext }).verdict, 'REJECT');
for (const [finding, context = packageContext] of [
  [{ type: 'same-creature-failure', parentRole: 'parent-1', expected: 'yes', observed: 'no', surfaces: ['master', 'runtime'], explanation: 'The child is not visibly the same creature grown up.' }],
  [{ type: 'anchor-failure', parentRole: 'parent-1', anchorId: requiredAnchors[0].anchorId, expected: requiredAnchors[0].description, observed: 'The required cuboid silhouette is absent.', surfaces: ['master', 'runtime'], explanation: 'Both surfaces omit the locked anchor.' }],
  [{ type: 'eilu-failure', benchmarkId: packageContext.eiluBenchmarkId, metric: 'continuityScore', expectedMinimum: 0.96, observed: 0.71, explanation: 'Continuity is visibly below the locked Eilu benchmark.' }],
  [{ type: 'canonical-surface-failure', surface: 'master', field: 'speciesFamily', expected: 'stylized-rockfish', observed: 'frog', explanation: 'The master surface contradicts the canonical taxonomy.' }, { ...packageContext, canonicalMode: true }],
  [{ type: 'appendage-ambiguity', surface: 'runtime', expectedAmbiguity: false, observedAmbiguity: true, explanation: 'The runtime silhouette makes two fins read as a merged extra appendage.' }, { ...packageContext, canonicalMode: true }],
]) assert.equal(assertRejectionObservationV2({ ...structuredClone(base), failureFindings: [finding] }, { assignment, assignmentBytes, packageContext: context }).verdict, 'REJECT');

// Regression: the historical B-retry1 free-text rejection said the package
// required frog, but its signed immutable package requires stylized-rockfish.
const frogClaim = structuredClone(base);
frogClaim.requiredChildTaxonomy = { biologicalClass: 'amphibian', speciesFamily: 'frog', coreAnatomy: 'quadruped', locomotionPlan: 'quadrupedal' };
frogClaim.failureFindings[0].expected = 'frog'; frogClaim.failureFindings[0].observed = 'stylized-rockfish';
assert.throws(() => assertRejectionObservationV2(frogClaim, { assignment, assignmentBytes, packageContext }), /taxonomy claim differs/);

const barePass = { ...structuredClone(base), schemaVersion: 'continuity-g003-reviewer-verdict-v2', verdict: 'PASS', passEvidence: null, failureFindings: [], explanation: '', confidence: 1 };
assert.throws(() => assertReviewerAuthoredVerdictV2(barePass, { assignment, assignmentBytes, packageContext }), /boolean verdict cannot create evidence/);

const mutations = [
  ['borrowed assignment', { assignmentId: 'g003-assignment-' + '0'.repeat(32) }, /borrowed an assignment/],
  ['wrong assignment raw SHA', { assignmentRawSha256: '0'.repeat(64) }, /borrowed an assignment/],
  ['wrong run', { generationRunId: 'wrong-run' }, /generationRunId differs/],
  ['wrong package', { packageManifestSha256: '0'.repeat(64) }, /packageManifestSha256 differs/],
  ['wrong prompt', { promptSha256: '0'.repeat(64) }, /promptSha256 differs/],
  ['wrong material', { materialBindingSha256: '0'.repeat(64) }, /materialBindingSha256 differs/],
  ['wrong allowlist', { inputAllowlistSha256: '0'.repeat(64) }, /inputAllowlistSha256 differs/],
  ['wrong identity', { reviewerInstanceId: 'other-reviewer-instance' }, /borrowed or renamed reviewerInstanceId/],
  ['wrong input order', { inputAssetSha256s: [...base.inputAssetSha256s].reverse() }, /input assets differs/],
];
for (const [label, mutation, pattern] of mutations) assert.throws(
  () => assertRejectionObservationV2({ ...structuredClone(base), ...mutation }, { assignment, assignmentBytes, packageContext }),
  pattern, label,
);

const materialSha256s = [binding.child.surfaces.master.sha256, binding.child.surfaces.runtime.sha256];
assert.equal(materialWideTombstoneKey(materialSha256s), materialWideTombstoneKey([...materialSha256s].reverse()), 'material key is a canonical sorted set');
assert.equal(materialWideTombstoneKey(materialSha256s), materialWideTombstoneKey(materialSha256s), 'cross-candidate reuse has the same material key');
const runOne = sha256Canonical({ candidateId: binding.candidateId, generationRunId: 'run-1', materialSha256s: [...materialSha256s].sort() });
const runTwo = sha256Canonical({ candidateId: binding.candidateId, generationRunId: 'run-2', materialSha256s: [...materialSha256s].sort() });
assert.notEqual(runOne, runTwo, 'legacy run-scoped identity demonstrates laundering risk');

const validSignatureBase64 = Buffer.alloc(64).toString('base64');
const signatureFor = (purpose, signatureBase64 = validSignatureBase64) => ({ algorithm: 'Ed25519', authorityEpoch: 'continuity-authority-epoch-v1', authorityFingerprint: '1'.repeat(64), delegationOutputSha256: '2'.repeat(64), purpose, schemaSha256: '3'.repeat(64), signatureBase64 });
const expectedSchemaShaByPath = new Proxy({}, { get: () => '3'.repeat(64) });
const signatureVerifier = (value, bindingOptions) => value.publicSignature?.purpose === bindingOptions.purpose
  && bindingOptions.schemaPath.endsWith(`${bindingOptions.purpose.slice('continuity:g003-'.length)}.schema.json`)
  && value.publicSignature.schemaSha256 === bindingOptions.claimedSchemaSha256 && bindingOptions.claimedSchemaSha256 === expectedSchemaShaByPath[bindingOptions.schemaPath]
  && value.publicSignature.signatureBase64 === validSignatureBase64;
const accepted = { artifactSha256: 'a'.repeat(64), artifactFileSha256: 'b'.repeat(64) };
const invalidityCore = { schemaVersion: 'continuity-g003-review-invalidity-v1', invalidityId: 'c'.repeat(64), invalidatedArtifactSha256: accepted.artifactSha256, invalidatedArtifactFileSha256: accepted.artifactFileSha256, reasonCode: 'reviewer-evidence-invalid', findingSha256: 'd'.repeat(64), priorInvaliditySha256: null, issuedAt: '2026-08-11T06:00:00.000Z' };
const invalidity = { ...invalidityCore, outputSha256: sha256Canonical(invalidityCore), publicSignature: signatureFor('continuity:g003-review-invalidity-v1') };
const reviewState = resolveEffectiveReviewState({ acceptedReviews: [accepted], invalidities: [invalidity], verifySignature: signatureVerifier });
assert.equal(reviewState.effectiveReviews.length, 0); assert.equal(reviewState.autoAcceptedPixels, false);
assert.throws(() => resolveEffectiveReviewState({ acceptedReviews: [accepted], invalidities: [{ ...invalidity, outputSha256: '0'.repeat(64) }], verifySignature: signatureVerifier }), /output hash is forged/);
assert.throws(() => resolveEffectiveReviewState({ acceptedReviews: [accepted], invalidities: [{ ...invalidity, publicSignature: signatureFor('continuity:g003-review-invalidity-v1', Buffer.alloc(64, 1).toString('base64')) }], verifySignature: signatureVerifier }), /signature is forged/);
assert.throws(() => resolveEffectiveReviewState({ acceptedReviews: [accepted], invalidities: [{ ...invalidity, publicSignature: { ...invalidity.publicSignature, schemaSha256: '4'.repeat(64) } }], verifySignature: signatureVerifier }), /signature is forged/);
assert.throws(() => resolveEffectiveReviewState({ acceptedReviews: [accepted], invalidities: [invalidity, { ...invalidity, invalidityId: 'e'.repeat(64), outputSha256: 'f'.repeat(64) }], verifySignature: signatureVerifier }), /forged|fork|rollback/);

const tombstoneCore = { schemaVersion: 'continuity-g003-rejection-tombstone-v2', candidateId: binding.candidateId, generationRunId: 'run-1', materialSha256s, tombstoneKey: materialWideTombstoneKey(materialSha256s), constituentIndexKeys: materialConstituentIndexKeys(materialSha256s), rejectionObservationSha256: '0'.repeat(64), rejectionArchiveSha256: 'f'.repeat(64), rejectedAt: '2026-08-11T05:45:08.000Z' };
const tombstone = { ...tombstoneCore, outputSha256: sha256Canonical(tombstoneCore), publicSignature: signatureFor('continuity:g003-rejection-tombstone-v2') };
const tombstoneRecord = { value: tombstone, fileSha256: '3'.repeat(64) };
const frozen = { materialKey: tombstone.tombstoneKey, materialSha256s, archivedMaterialFileSha256s: ['b'.repeat(64), 'c'.repeat(64)], lockedContractSha256: 'd'.repeat(64), priorRejectionObservationSha256: 'e'.repeat(64), tombstoneOutputSha256: tombstone.outputSha256, tombstoneFileSha256: tombstoneRecord.fileSha256 };
const assignmentFor = (passNumber) => {
  const core = { schemaVersion: 'continuity-g003-quarantine-assignment-v1', assignmentId: `quarantine-assignment-${passNumber}`, role: 'quarantine-invalidity', reviewerInstanceId: `quarantine-reviewer-${passNumber}`, agentTaskId: `/root/quarantine-task-${passNumber}`, reviewRunId: `quarantine-review-run-${passNumber}`, passNumber, ...frozen, obligationCredit: 0, pixelDisposition: 'UNCHANGED', assignedAt: `2026-08-11T06:0${passNumber}:00.000Z` };
  return { ...core, outputSha256: sha256Canonical(core), publicSignature: signatureFor('continuity:g003-quarantine-assignment-v1') };
};
const quarantineAssignments = [assignmentFor(1), assignmentFor(2)];
const quarantineAssignmentBytes = quarantineAssignments.map(canonicalReviewerObservationBytes);
const attestationFor = (assignmentValue, index) => {
  const core = { schemaVersion: 'continuity-g003-quarantine-invalidity-attestation-v1', assignmentId: assignmentValue.assignmentId, assignmentRawSha256: sha256Bytes(quarantineAssignmentBytes[index]), reviewerInstanceId: assignmentValue.reviewerInstanceId, agentTaskId: assignmentValue.agentTaskId, reviewRunId: assignmentValue.reviewRunId, passNumber: assignmentValue.passNumber, ...frozen, verdict: 'INVALID_REJECTION', obligationCredit: 0, pixelDisposition: 'UNCHANGED', invalidityFinding: { type: 'taxonomy-claim-mismatch', expected: 'stylized-rockfish', observed: 'rejection claimed frog', evidenceSha256: base.assignmentRawSha256, explanation: 'The frozen locked contract requires stylized-rockfish, not frog.' }, confidence: 0.99, observedAt: `2026-08-11T06:1${index}:00.000Z` };
  return { ...core, outputSha256: sha256Canonical(core), publicSignature: signatureFor('continuity:g003-quarantine-invalidity-attestation-v1') };
};
const quarantineAttestations = quarantineAssignments.map(attestationFor);
const quarantineAttestationBytes = quarantineAttestations.map(canonicalReviewerObservationBytes);
const quarantineInput = { frozen, assignments: quarantineAssignments, assignmentBytes: quarantineAssignmentBytes, attestations: quarantineAttestations, attestationBytes: quarantineAttestationBytes };
const adjudication = adjudicateQuarantine(quarantineInput, { verifySignature: signatureVerifier });
assert.equal(adjudication.obligationCredit, 0); assert.equal(adjudication.pixelDisposition, 'UNCHANGED'); assert.equal(adjudication.requiredFreshContinuityReviews, 2);
assert.throws(() => adjudicateQuarantine({ frozen, assignments: [quarantineAssignments[0], quarantineAssignments[0]], assignmentBytes: [quarantineAssignmentBytes[0], quarantineAssignmentBytes[0]], attestations: [quarantineAttestations[0], quarantineAttestations[0]], attestationBytes: [quarantineAttestationBytes[0], quarantineAttestationBytes[0]] }, { verifySignature: signatureVerifier }), /not independent/);
const forgedAttestation = { ...quarantineAttestations[0], publicSignature: signatureFor('continuity:g003-quarantine-invalidity-attestation-v1', Buffer.alloc(64, 1).toString('base64')) };
assert.throws(() => adjudicateQuarantine({ ...quarantineInput, attestations: [forgedAttestation, quarantineAttestations[1]], attestationBytes: [canonicalReviewerObservationBytes(forgedAttestation), quarantineAttestationBytes[1]] }, { verifySignature: signatureVerifier }), /signature is forged/);
const supersessionCore = { schemaVersion: 'continuity-g003-rejection-tombstone-supersession-v1', supersessionId: '2'.repeat(64), tombstoneKey: tombstone.tombstoneKey, priorTombstoneSha256: tombstone.outputSha256, priorTombstoneFileSha256: tombstoneRecord.fileSha256, action: 'INVALIDATE_REJECTION', reasonCode: 'incorrect-review-binding', invalidityProofSha256: adjudication.invalidityProofSha256, quarantineAssignmentRawSha256s: adjudication.assignmentRawSha256s, quarantineAttestationRawSha256s: adjudication.attestationRawSha256s, priorSupersessionSha256: null, issuedAt: '2026-08-11T06:20:00.000Z' };
const supersession = { ...supersessionCore, outputSha256: sha256Canonical(supersessionCore), publicSignature: signatureFor('continuity:g003-rejection-tombstone-supersession-v1') };
const pg120Material = ['5'.repeat(64), '6'.repeat(64)]; const nonTargetMaterial = ['7'.repeat(64), '8'.repeat(64)];
const otherTombstone = (candidateId, hashes, file) => { const core = { ...tombstoneCore, candidateId, materialSha256s: hashes, tombstoneKey: materialWideTombstoneKey(hashes), constituentIndexKeys: materialConstituentIndexKeys(hashes) }; return { value: { ...core, outputSha256: sha256Canonical(core), publicSignature: signatureFor('continuity:g003-rejection-tombstone-v2') }, fileSha256: file }; };
const pg120Tombstone = otherTombstone('g003-candidate:PG-120', pg120Material, 'a'.repeat(64));
const nonTargetTombstone = otherTombstone('g003-candidate:PG-999', nonTargetMaterial, 'c'.repeat(64));
const blockedState = resolveEffectiveRejectionState({ tombstones: [tombstoneRecord, pg120Tombstone, nonTargetTombstone], verifySignature: signatureVerifier });
assert.throws(() => assertNoEffectiveMaterialRejection([materialSha256s[0], 'f'.repeat(64)], blockedState), /rejected constituent surface/);
const rejectionState = resolveEffectiveRejectionState({ tombstones: [tombstoneRecord, pg120Tombstone, nonTargetTombstone], supersessions: [supersession], quarantineEvidenceCases: [quarantineInput], verifySignature: signatureVerifier });
assert.equal(rejectionState.effectiveTombstones.length, 2); assert.equal(rejectionState.preservedTombstones.length, 3); assert.equal(rejectionState.autoAcceptedPixels, false);
assert.equal(rejectionState.requiredFreshContinuityReviewsByMaterialKey[tombstone.tombstoneKey], 2);
assert.ok(rejectionState.effectiveMaterialKeys.includes(pg120Tombstone.value.tombstoneKey)); assert.ok(rejectionState.effectiveMaterialKeys.includes(nonTargetTombstone.value.tombstoneKey));
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [{ value: { ...tombstone, generationRunId: 'laundered-run', tombstoneKey: sha256Canonical({ generationRunId: 'laundered-run', materialSha256s }) }, fileSha256: tombstoneRecord.fileSha256 }], verifySignature: signatureVerifier }), /run-ID laundering/);
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [{ value: { ...tombstone, candidateId: 'g003-candidate:PG-999', tombstoneKey: sha256Canonical({ candidateId: 'g003-candidate:PG-999', materialSha256s }) }, fileSha256: tombstoneRecord.fileSha256 }], verifySignature: signatureVerifier }), /run-ID laundering/);
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [tombstoneRecord], supersessions: [supersession], quarantineAdjudications: [adjudication], verifySignature: signatureVerifier }), /lacks the exact/);
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [tombstoneRecord], supersessions: [supersession], quarantineEvidenceCases: [{ ...quarantineInput, assignmentBytes: [] }], verifySignature: signatureVerifier }), /exactly two/);
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [tombstoneRecord], supersessions: [{ ...supersession, outputSha256: '5'.repeat(64) }], quarantineEvidenceCases: [quarantineInput], verifySignature: signatureVerifier }), /output hash is forged/);
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [tombstoneRecord], supersessions: [{ ...supersession, publicSignature: signatureFor('continuity:g003-rejection-tombstone-supersession-v1', Buffer.alloc(64, 1).toString('base64')) }], quarantineEvidenceCases: [quarantineInput], verifySignature: signatureVerifier }), /signature is forged/);
assert.throws(() => resolveEffectiveRejectionState({ tombstones: [tombstoneRecord], supersessions: [supersession, supersession], quarantineEvidenceCases: [quarantineInput], verifySignature: signatureVerifier }), /fork|rollback/);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-observation-'));
await mkdir(path.join(temporary, 'observations'));
const canonicalBytes = canonicalReviewerObservationBytes(base);
await writeFile(path.join(temporary, 'observations/rejection.json'), canonicalBytes);
assert.equal((await readReviewerAuthoredObservation(temporary, 'observations/rejection.json')).sha256, sha256Bytes(canonicalBytes));
await symlink(path.join(temporary, 'observations/rejection.json'), path.join(temporary, 'observations/symlink.json'));
await assert.rejects(readReviewerAuthoredObservation(temporary, 'observations/symlink.json'), /symlink|independent regular file/);
await link(path.join(temporary, 'observations/rejection.json'), path.join(temporary, 'observations/hardlink.json'));
await assert.rejects(readReviewerAuthoredObservation(temporary, 'observations/hardlink.json'), /independent regular file/);
await assert.rejects(readReviewerAuthoredObservation(temporary, '../escape.json'), /canonical|escape|relative/);

const schemaBindings = await Promise.all(G003_V5_SCHEMA_PATHS.map(async (schemaPath) => ({ path: schemaPath, sha256: sha256Bytes(await readFile(path.join(ROOT, schemaPath))) })));
const authority = createG003V5AuthorityForTest({
  priorProtocolAuthoritySha256: '6'.repeat(64),
  continuityAuthority: { delegationOutputSha256: '7'.repeat(64), delegationFileSha256: '8'.repeat(64), supersessionOutputSha256: '9'.repeat(64), supersessionFileSha256: 'a'.repeat(64), freezeOutputSha256: 'b'.repeat(64), freezeFileSha256: 'c'.repeat(64), freezeTreeSha256: 'd'.repeat(64) },
  schemaBindings,
});
assert.equal(authority.protocol, G003_V5_PROTOCOL); assert.match(authority.protocolAuthoritySha256, /^[a-f0-9]{64}$/);
const terminalBindingIndex = G003_V5_SCHEMA_PATHS.indexOf('production/contracts/g003-v5-terminal-activation-v1.schema.json');
assert.ok(terminalBindingIndex >= 0, 'terminal activation schema must be protocol-authority bound');
const substitutedTerminalBindings = schemaBindings.map((binding, index) => index === terminalBindingIndex ? { ...binding, sha256: '0'.repeat(64) } : binding);
const substitutedTerminalAuthority = createG003V5AuthorityForTest({
  priorProtocolAuthoritySha256: '6'.repeat(64), continuityAuthority: authority.continuityAuthority, schemaBindings: substitutedTerminalBindings,
});
assert.notEqual(substitutedTerminalAuthority.protocolAuthoritySha256, authority.protocolAuthoritySha256, 'terminal schema substitution must change protocol authority');
const outsideTerminalBindings = schemaBindings.map((binding, index) => index === terminalBindingIndex ? { ...binding, path: 'production/contracts/unbound-terminal.schema.json' } : binding);
assert.throws(() => createG003V5AuthorityForTest({ priorProtocolAuthoritySha256: '6'.repeat(64), continuityAuthority: authority.continuityAuthority, schemaBindings: outsideTerminalBindings }), /paths\/order changed/);
let forgedLoaderCallbacks = 0;
await assert.rejects(loadG003V5Authority({ repoRoot: ROOT, verifyContinuity: () => { forgedLoaderCallbacks += 1; return true; } }), /ENOENT|freeze/i);
assert.equal(forgedLoaderCallbacks, 0, 'production v5 loader must not accept caller-forged verification callbacks');
assert.throws(() => createG003V5AuthorityForTest({ priorProtocolAuthoritySha256: '6'.repeat(64), continuityAuthority: {}, schemaBindings }), /fields mismatch/);

console.log(JSON.stringify({ status: 'PASS', protocol: G003_V5_PROTOCOL, barePassWrites: 0, frogClaimWrites: 0, hostileBindingsRejected: mutations.length, quarantineCredits: adjudication.obligationCredit, freshReviewsRequired: adjudication.requiredFreshContinuityReviews, preservedTombstones: rejectionState.preservedTombstones.length, effectiveUnaffectedTombstones: rejectionState.effectiveTombstones.length }));
