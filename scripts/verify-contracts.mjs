import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readContainedFile } from './lib/continuity-assignment/evidence.mjs';
import { projectG002CatalogEpoch } from './lib/continuity-assignment/g002-catalog-epoch.mjs';

const catalog = JSON.parse(await readFile(new URL('../production/catalog/creatures.json', import.meta.url)));
const economy = JSON.parse(await readFile(new URL('../production/contracts/economy-v1.json', import.meta.url)));
const conformance = JSON.parse(await readFile(new URL('../production/contracts/conformance-v1.json', import.meta.url)));
const contractFiles = {
  taxonomy: '../production/contracts/taxonomy-consensus-v1.schema.json',
  candidateReview: '../production/contracts/continuity-candidate-review-v3.schema.json',
  assignment: '../production/contracts/continuity-assignment-v1.schema.json',
  revisionMap: '../production/contracts/catalog-revision-map-v1.schema.json',
  pixelAnchorConsensus: '../production/contracts/g001-pixel-anchor-consensus-v1.schema.json',
  taxonomyReview: '../production/contracts/g002-taxonomy-review-v1.schema.json',
  reviewCoverage: '../production/contracts/g003-review-coverage-v1.schema.json',
  publicCandidateReview: '../production/contracts/g003-public-review-artifact-v3.schema.json',
  candidateProvenance: '../production/contracts/continuity-candidate-provenance-v1.schema.json',
  rejectedCandidate: '../production/contracts/continuity-rejected-candidate-v1.schema.json',
  continuityPackLock: '../production/contracts/continuity-pack-lock-v2.schema.json',
  g003ActiveBaseline: '../production/contracts/g003-active-baseline-v2.schema.json',
  g003ReviewerAuthority: '../production/contracts/g003-reviewer-authority-v1.schema.json',
  g003RejectionTombstone: '../production/contracts/g003-rejection-tombstone-v1.schema.json',
  canonicalRootRedesignTargets: '../production/contracts/canonical-root-redesign-targets-v1.schema.json',
  canonicalRootRedesignTargetsV2: '../production/contracts/canonical-root-redesign-targets-v2.schema.json',
  assignmentV2: '../production/contracts/continuity-assignment-v2.schema.json',
  reviewCoverageV2: '../production/contracts/g003-review-coverage-v2.schema.json',
  publicEvidenceV3: '../production/contracts/g002-public-evidence-manifest-v3.schema.json',
  canonicalPublicReviewProofV2: '../production/contracts/g002-v2-canonical-public-review-proof-v1.schema.json',
  candidateReviewV4: '../production/contracts/continuity-candidate-review-v4.schema.json',
  publicCandidateReviewV4: '../production/contracts/g003-public-review-artifact-v4.schema.json',
  continuityPackLockV3: '../production/contracts/continuity-pack-lock-v3.schema.json',
  g003ActiveBaselineV3: '../production/contracts/g003-active-baseline-v3.schema.json',
  g003V5ProtocolAuthority: '../production/contracts/g003-v5-protocol-authority.schema.json',
  g003ReviewerVerdictV2: '../production/contracts/g003-reviewer-verdict-v2.schema.json',
  g003RejectionObservationV2: '../production/contracts/g003-rejection-observation-v2.schema.json',
  g003ReviewInvalidity: '../production/contracts/g003-review-invalidity-v1.schema.json',
  g003RejectionTombstoneV2: '../production/contracts/g003-rejection-tombstone-v2.schema.json',
  g003RejectionTombstoneSupersession: '../production/contracts/g003-rejection-tombstone-supersession-v1.schema.json',
  g003QuarantineAssignment: '../production/contracts/g003-quarantine-assignment-v1.schema.json',
  g003QuarantineInvalidityAttestation: '../production/contracts/g003-quarantine-invalidity-attestation-v1.schema.json',
  g003QuarantineAdjudication: '../production/contracts/g003-quarantine-adjudication-v1.schema.json',
  continuityAuthorityDelegation: '../production/contracts/continuity-authority-delegation-v1.schema.json',
  continuityG002V2SupersessionIntent: '../production/contracts/continuity-g002-v2-supersession-intent-v1.schema.json',
  continuityG002V2Supersession: '../production/contracts/continuity-g002-v2-supersession-v1.schema.json',
  continuityAssignmentV3: '../production/contracts/continuity-assignment-v3.schema.json',
  g003V4FreezeInventory: '../production/contracts/g003-v4-freeze-inventory-v1.schema.json',
  g003V5TerminalActivation: '../production/contracts/g003-v5-terminal-activation-v1.schema.json',
  g003ReviewerAssignmentV5: '../production/contracts/g003-reviewer-assignment-v5.schema.json',
  g003PrimaryVoteV5: '../production/contracts/g003-primary-vote-v5.schema.json',
  candidateReviewV5: '../production/contracts/continuity-candidate-review-v5.schema.json',
  publicCandidateReviewV5: '../production/contracts/g003-public-review-artifact-v5.schema.json',
  reviewCoverageV5: '../production/contracts/g003-review-coverage-v5.schema.json',
  rejectionArchiveV5: '../production/contracts/g003-rejection-archive-v5.schema.json',
  g003SourceReceiptsV5: '../production/contracts/continuity-g003-source-receipts-v5.schema.json',
  g003MaterialBindingV5: '../production/contracts/continuity-g003-material-binding-v5.schema.json',
  g003InputAllowlistV5: '../production/contracts/continuity-g003-input-allowlist-v5.schema.json',
  g003LockedReviewContractV5: '../production/contracts/continuity-g003-locked-review-contract-v5.schema.json',
  g003PackageManifestV5: '../production/contracts/continuity-g003-package-manifest-v5.schema.json',
  g003ApprovedMaterialV5: '../production/contracts/continuity-g003-approved-material-v5.schema.json',
};
const g002Contracts = Object.fromEntries(await Promise.all(Object.entries(contractFiles).map(async ([key, relative]) => [key, JSON.parse(await readFile(new URL(relative, import.meta.url)))])));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const g002RelativeRoot = 'production/reports/biological-continuity-v3/g002-evidence-v1';
const readG002 = async (name) => JSON.parse(await readContainedFile(repoRoot, `${g002RelativeRoot}/${name}`));
const [taxonomyConsensus, inputLock, pins, topology, assignmentManifest, revisionMap] = await Promise.all([
  'asset-census.json', 'inputs.lock.json', 'pins.json', 'topology-before.json', 'assignment-manifest.json', 'save-revision-map.json',
].map(readG002));

assert.equal(catalog.length, 256);
assert.equal(new Set(catalog.map((item) => item.id)).size, 256);
assert.equal(catalog.filter((item) => item.category === 'start' && item.stage === 1).length, 64);
assert.equal(Object.values(economy.baseRarityWeights).reduce((sum, value) => sum + value, 0), 100);
assert.equal(Object.values(economy.maximumActivityRarityWeights).reduce((sum, value) => sum + value, 0), 100);
assert.equal(economy.originPityMisses, 300);
assert.equal(economy.uniqueColorProbability, 0.001);
assert.deepEqual(conformance.pityCases, [
  { missesBeforePull: 299, forcedOrigin: false },
  { missesBeforePull: 300, forcedOrigin: true },
]);

const byId = new Map(catalog.map((item) => [item.id, item]));
const byLineageStage = new Set(catalog.map((item) => `${item.lineageId}:S${item.stage}`));
for (const creature of catalog) {
  assert.match(creature.id, /^PG-[0-9]{3}$/);
  const parents = creature.evolutionFrom == null
    ? []
    : Array.isArray(creature.evolutionFrom) ? creature.evolutionFrom : [creature.evolutionFrom];
  for (const parent of parents) {
    assert.ok(byId.has(parent) || byLineageStage.has(parent), `${creature.id}: missing parent ${parent}`);
  }
  if (creature.category === 'mixed') assert.equal(parents.length, 2, `${creature.id}: mixed evolution needs two parents`);
}

for (const [name, schema] of Object.entries(g002Contracts)) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${name}: JSON Schema draft drift`);
  assert.equal(schema.type, 'object', `${name}: root type drift`);
  assert.equal(schema.additionalProperties, false, `${name}: root must fail closed on unknown fields`);
  assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${name}: required fields missing`);
}
assert.equal(g002Contracts.taxonomy.properties.schemaVersion.const, 'taxonomy-consensus-v1');
assert.equal(g002Contracts.candidateReview.properties.schemaVersion.const, 'continuity-candidate-review-v3');
assert.ok(g002Contracts.candidateReview.required.includes('protocolAuthoritySha256'));
assert.equal(g002Contracts.candidateReview.properties.votes.minItems, 2);
assert.equal(g002Contracts.candidateReview.properties.votes.maxItems, 2);
assert.deepEqual(g002Contracts.candidateReview.$defs.vote.properties.passNumber.enum, [1, 2]);
assert.equal(g002Contracts.candidateReview.$defs.vote.properties.role.const, 'primary');
assert.equal(g002Contracts.candidateReview.$defs.vote.properties.schemaVersion.const, 'continuity-candidate-primary-vote-v3');
assert.ok(g002Contracts.candidateReview.$defs.vote.required.includes('protocolAuthoritySha256'));
assert.deepEqual(g002Contracts.candidateReview.$defs.taxonomy.required, ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']);
assert.deepEqual(g002Contracts.candidateReview.$defs.canonicalAssessment.required, ['matchesRequiredCanonicalTarget', 'historicalParentComparisonRequired', 'surfaceAssessments']);
assert.equal(g002Contracts.candidateReview.$defs.canonicalSurfaceAssessment.properties.anchorAssessments.minItems, 3);
assert.equal(g002Contracts.candidateReview.$defs.canonicalSurfaceAssessment.properties.anchorAssessments.maxItems, 3);
assert.equal(g002Contracts.candidateReview.$defs.vote.properties.confidence.minimum, 0.96);
assert.equal(g002Contracts.assignment.properties.schemaVersion.const, 'continuity-assignment-v1');
assert.equal(g002Contracts.revisionMap.properties.schemaVersion.const, 'catalog-revision-map-v1');
assert.equal(g002Contracts.pixelAnchorConsensus.properties.schemaVersion.const, 'g001-pixel-anchor-consensus-v1');
assert.ok(g002Contracts.taxonomyReview.required.includes('conductorHmacSha256'));
assert.equal(g002Contracts.taxonomyReview.properties.anchors.maxItems, 3);
assert.equal(g002Contracts.reviewCoverage.properties.schemaVersion.const, 'continuity-g003-review-gate-v1');
assert.ok(g002Contracts.reviewCoverage.$defs.baseEvidence.required.includes('reviewPolicy'));
assert.ok(g002Contracts.reviewCoverage.$defs.baseEvidence.required.includes('parentEvidence'));
assert.ok(g002Contracts.reviewCoverage.$defs.parentEvidence.required.includes('evidenceRole'));
assert.ok(g002Contracts.reviewCoverage.$defs.reviewPolicy.required.includes('visibilityPolicy'));
assert.ok(g002Contracts.reviewCoverage.$defs.reviewPolicy.required.includes('clarificationRequirements'));
assert.equal(g002Contracts.publicCandidateReview.properties.schemaVersion.const, 'continuity-g003-public-review-artifact-v3');
assert.ok(g002Contracts.publicCandidateReview.required.includes('protocolAuthoritySha256'));
assert.ok(g002Contracts.publicCandidateReview.required.includes('reviewPolicy'));
assert.ok(g002Contracts.publicCandidateReview.$defs.parentEvidence.required.includes('evidenceRole'));
assert.ok(g002Contracts.publicCandidateReview.$defs.reviewPolicy.required.includes('visibilityPolicy'));
assert.ok(g002Contracts.publicCandidateReview.$defs.reviewPolicy.required.includes('clarificationRequirements'));
assert.equal(g002Contracts.candidateProvenance.properties.schemaVersion.const, 'continuity-candidate-provenance-v1');
assert.equal(g002Contracts.rejectedCandidate.properties.schemaVersion.const, 'continuity-rejected-candidate-v1');
assert.equal(g002Contracts.continuityPackLock.properties.schemaVersion.const, 'continuity-pack-lock-v2');
assert.ok(g002Contracts.continuityPackLock.required.includes('protocolAuthoritySha256'));
assert.equal(g002Contracts.g003ActiveBaseline.properties.schemaVersion.const, 'continuity-g003-active-baseline-v2');
assert.equal(g002Contracts.g003ActiveBaseline.properties.targetSource.const, 'signed-canonical-root-redesign-successor-v2');
assert.ok(g002Contracts.g003ReviewerAuthority.required.includes('assignment'));
assert.equal(g002Contracts.g003RejectionTombstone.properties.schemaVersion.const, 'continuity-g003-rejection-tombstone-v1');
assert.equal(g002Contracts.canonicalRootRedesignTargets.properties.schemaVersion.const, 'canonical-root-redesign-targets-v1');
assert.equal(g002Contracts.canonicalRootRedesignTargetsV2.properties.schemaVersion.const, 'canonical-root-redesign-targets-v2');
assert.deepEqual(g002Contracts.canonicalRootRedesignTargetsV2.properties.newTargetIds.const, ['PG-024', 'PG-029', 'PG-047', 'PG-052', 'PG-053', 'PG-056']);
assert.equal(g002Contracts.canonicalRootRedesignTargetsV2.properties.targets.minItems, 6);
assert.equal(g002Contracts.canonicalRootRedesignTargetsV2.properties.reviewProofs.minItems, 6);
assert.equal(g002Contracts.assignmentV2.properties.schemaVersion.const, 'continuity-assignment-v2');
assert.equal(g002Contracts.reviewCoverageV2.properties.schemaVersion.const, 'continuity-g003-review-gate-v2');
assert.equal(g002Contracts.publicEvidenceV3.properties.schemaVersion.const, 'g002-public-evidence-manifest-v3');
assert.equal(g002Contracts.publicEvidenceV3.properties.runtimeAssets.minItems, 240);
assert.equal(g002Contracts.canonicalPublicReviewProofV2.properties.schemaVersion.const, 'g002-v2-canonical-public-review-proof-v1');
assert.equal(g002Contracts.candidateReviewV4.properties.schemaVersion.const, 'continuity-candidate-review-v4');
assert.equal(g002Contracts.candidateReviewV4.properties.protocolAuthoritySha256.const, 'e1a569f6cd3351c04db5795acc98762d6f2bfd0596826fc4a0c35fe3f870df5e');
assert.equal(g002Contracts.candidateReviewV4.$defs.vote.properties.schemaVersion.const, 'continuity-candidate-primary-vote-v4');
assert.equal(g002Contracts.publicCandidateReviewV4.properties.schemaVersion.const, 'continuity-g003-public-review-artifact-v4');
assert.equal(g002Contracts.publicCandidateReviewV4.$defs.publicSignature.properties.authorityEpoch.const, 'g003-authority-epoch-v1');
assert.equal(g002Contracts.publicCandidateReviewV4.$defs.publicSignature.properties.authorityFingerprint.const, '91336f3180f8cf86cdef4b35f271c1e64eb609cd6b4e7f53360c777fa1a48e54');
assert.equal(g002Contracts.continuityPackLockV3.properties.schemaVersion.const, 'continuity-pack-lock-v3');
assert.equal(g002Contracts.continuityPackLockV3.properties.publicSignature.properties.authorityFingerprint.const, '91336f3180f8cf86cdef4b35f271c1e64eb609cd6b4e7f53360c777fa1a48e54');
assert.equal(g002Contracts.g003ActiveBaselineV3.properties.schemaVersion.const, 'continuity-g003-active-baseline-v3');
assert.equal(g002Contracts.g003ActiveBaselineV3.properties.priorProtocolAuthoritySha256.const, 'f585f5002c5f173a6a083e4a1d547d6b827d2277f140e94d1b8519d02b0124c7');
assert.equal(g002Contracts.g003ActiveBaselineV3.properties.signingAuthority.properties.authorityFingerprint.const, '91336f3180f8cf86cdef4b35f271c1e64eb609cd6b4e7f53360c777fa1a48e54');
assert.equal(g002Contracts.g003V5ProtocolAuthority.properties.protocol.const, 'continuity-g003-review-protocol-v5');
assert.equal(g002Contracts.g003ReviewerAssignmentV5.properties.schemaVersion.const, 'continuity-g003-reviewer-assignment-v5');
assert.ok(g002Contracts.g003ReviewerAssignmentV5.required.includes('signedObligationScope'));
assert.ok(g002Contracts.g003ReviewerAssignmentV5.required.includes('requiredChildTaxonomy'));
assert.equal(g002Contracts.g003PrimaryVoteV5.properties.schemaVersion.const, 'continuity-g003-primary-vote-v5');
assert.equal(g002Contracts.g003PrimaryVoteV5.properties.reviewerVerdictSchema.const, 'continuity-g003-reviewer-verdict-v2');
assert.equal(g002Contracts.candidateReviewV5.properties.schemaVersion.const, 'continuity-g003-candidate-review-v5');
assert.equal(g002Contracts.publicCandidateReviewV5.properties.schemaVersion.const, 'continuity-g003-public-review-artifact-v5');
assert.equal(g002Contracts.reviewCoverageV5.properties.counts.const.obligations, 337);
assert.equal(g002Contracts.reviewCoverageV5.properties.counts.const.votes, 674);
assert.equal(g002Contracts.reviewCoverageV5.properties.v4HistoricalVoteCredit.const, 0);
assert.equal(g002Contracts.rejectionArchiveV5.properties.schemaVersion.const, 'continuity-g003-rejection-archive-v5');
for (const [name, schemaVersion] of [
  ['g003SourceReceiptsV5', 'continuity-g003-source-receipts-v5'],
  ['g003MaterialBindingV5', 'continuity-g003-material-binding-v5'],
  ['g003InputAllowlistV5', 'continuity-g003-input-allowlist-v5'],
  ['g003LockedReviewContractV5', 'continuity-g003-locked-review-contract-v5'],
  ['g003PackageManifestV5', 'continuity-g003-package-manifest-v5'],
  ['g003ApprovedMaterialV5', 'continuity-g003-approved-material-v5'],
]) assert.equal(g002Contracts[name].properties.schemaVersion.const, schemaVersion);
assert.equal(g002Contracts.g003V5ProtocolAuthority.properties.schemaBindings.minItems, 16);
assert.equal(g002Contracts.g003V5ProtocolAuthority.properties.schemaBindings.maxItems, 16);
assert.deepEqual(g002Contracts.g003V5ProtocolAuthority.properties.schemaBindings.prefixItems.map((item) => item.properties.path.const), [
  'production/contracts/g003-v5-protocol-authority.schema.json',
  'production/contracts/g003-v5-terminal-activation-v1.schema.json',
  'production/contracts/g003-reviewer-verdict-v2.schema.json',
  'production/contracts/g003-reviewer-assignment-v5.schema.json',
  'production/contracts/g003-primary-vote-v5.schema.json',
  'production/contracts/continuity-candidate-review-v5.schema.json',
  'production/contracts/g003-public-review-artifact-v5.schema.json',
  'production/contracts/g003-review-coverage-v5.schema.json',
  'production/contracts/g003-rejection-archive-v5.schema.json',
  'production/contracts/g003-rejection-observation-v2.schema.json',
  'production/contracts/g003-review-invalidity-v1.schema.json',
  'production/contracts/g003-rejection-tombstone-v2.schema.json',
  'production/contracts/g003-rejection-tombstone-supersession-v1.schema.json',
  'production/contracts/g003-quarantine-assignment-v1.schema.json',
  'production/contracts/g003-quarantine-invalidity-attestation-v1.schema.json',
  'production/contracts/g003-quarantine-adjudication-v1.schema.json',
]);
for (const binding of ['freezeOutputSha256', 'freezeFileSha256', 'freezeTreeSha256']) assert.ok(g002Contracts.g003V5ProtocolAuthority.properties.continuityAuthority.required.includes(binding));
assert.equal(g002Contracts.g003ReviewerVerdictV2.properties.schemaVersion.const, 'continuity-g003-reviewer-verdict-v2');
assert.ok(g002Contracts.g003ReviewerVerdictV2.required.includes('assignmentRawSha256'));
assert.ok(g002Contracts.g003ReviewerVerdictV2.required.includes('requiredChildTaxonomy'));
assert.equal(g002Contracts.g003RejectionObservationV2.properties.schemaVersion.const, 'continuity-g003-rejection-observation-v2');
assert.equal(g002Contracts.g003RejectionObservationV2.properties.failureFindings.minItems, 1);
assert.equal(g002Contracts.g003ReviewInvalidity.properties.schemaVersion.const, 'continuity-g003-review-invalidity-v1');
assert.equal(g002Contracts.g003RejectionTombstoneV2.properties.value.properties.schemaVersion.const, 'continuity-g003-rejection-tombstone-v2');
assert.equal(g002Contracts.g003RejectionTombstoneV2.properties.value.properties.publicSignature.$ref, '#/$defs/signature');
assert.equal(g002Contracts.g003RejectionTombstoneSupersession.properties.action.const, 'INVALIDATE_REJECTION');
assert.equal(g002Contracts.g003QuarantineAssignment.properties.obligationCredit.const, 0);
assert.equal(g002Contracts.g003QuarantineInvalidityAttestation.properties.verdict.const, 'INVALID_REJECTION');
assert.ok(g002Contracts.g003QuarantineInvalidityAttestation.required.includes('publicSignature'));
assert.equal(g002Contracts.g003QuarantineAdjudication.properties.requiredFreshContinuityReviews.const, 2);
for (const [name, purpose] of [
  ['g003ReviewInvalidity', 'continuity:g003-review-invalidity-v1'],
  ['g003RejectionTombstoneV2', 'continuity:g003-rejection-tombstone-v2'],
  ['g003RejectionTombstoneSupersession', 'continuity:g003-rejection-tombstone-supersession-v1'],
  ['g003QuarantineAssignment', 'continuity:g003-quarantine-assignment-v1'],
  ['g003QuarantineInvalidityAttestation', 'continuity:g003-quarantine-invalidity-attestation-v1'],
]) {
  const signature = g002Contracts[name].$defs.signature;
  assert.equal(signature.additionalProperties, false);
  assert.equal(signature.properties.authorityEpoch.const, 'continuity-authority-epoch-v1');
  assert.equal(signature.properties.purpose.const, purpose);
  assert.equal(signature.properties.schemaSha256.$ref, '#/$defs/sha');
}
assert.equal(g002Contracts.g003ReviewerVerdictV2.$defs.passEvidence.additionalProperties, false);
assert.equal(g002Contracts.g003RejectionObservationV2.required.length, g002Contracts.g003ReviewerVerdictV2.required.length);
assert.equal(g002Contracts.continuityAuthorityDelegation.properties.schemaVersion.const, 'continuity-authority-delegation-v1');
assert.ok(g002Contracts.continuityAuthorityDelegation.required.includes('nonce'));
assert.ok(g002Contracts.continuityAuthorityDelegation.required.includes('successorIntentSha256'));
assert.equal(g002Contracts.continuityAuthorityDelegation.properties.grant.properties.purpose.const, 'continuity:g002-v2-supersession');
assert.equal(g002Contracts.continuityAuthorityDelegation.properties.grant.properties.oneTime.const, true);
assert.equal(g002Contracts.continuityAuthorityDelegation.properties.grant.properties.assignmentV3.$ref, '#/$defs/assignmentV3Binding');
assert.equal(g002Contracts.continuityAuthorityDelegation.$defs.assignmentV3Binding.properties.fixedPath.const, 'production/reports/biological-continuity-v3/continuity-authority/continuity-assignment-v3.json');
assert.equal(g002Contracts.continuityAuthorityDelegation.$defs.g003Signature.properties.purpose.const, 'g003:continuity-authority-delegation');
assert.equal(g002Contracts.continuityG002V2SupersessionIntent.properties.schemaVersion.const, 'continuity-g002-v2-supersession-v1');
assert.equal(g002Contracts.continuityG002V2SupersessionIntent.properties.contractKind.const, 'CROSS_AUTHORITY_SUCCESSOR');
assert.equal(g002Contracts.continuityG002V2SupersessionIntent.properties.rootDirectives.minItems, 2);
assert.equal(g002Contracts.continuityG002V2SupersessionIntent.properties.rootDirectives.maxItems, 2);
assert.equal(g002Contracts.continuityG002V2SupersessionIntent.properties.assignmentV3.$ref, '#/$defs/assignmentV3Binding');
assert.equal(g002Contracts.continuityG002V2Supersession.properties.schemaVersion.const, 'continuity-g002-v2-supersession-v1');
assert.ok(g002Contracts.continuityG002V2Supersession.required.includes('delegationOutputSha256'));
assert.equal(g002Contracts.continuityG002V2Supersession.properties.publicSignature.properties.authorityEpoch.const, 'continuity-authority-epoch-v1');
assert.equal(g002Contracts.continuityG002V2Supersession.properties.publicSignature.properties.purpose.const, 'continuity:g002-v2-supersession');
assert.equal(g002Contracts.continuityG002V2Supersession.properties.assignmentV3.$ref, '#/$defs/assignmentV3Binding');
assert.equal(g002Contracts.continuityAssignmentV3.properties.schemaVersion.const, 'continuity-assignment-v3');
assert.equal(g002Contracts.continuityAssignmentV3.properties.publicSignature.$ref, '#/$defs/signature');
assert.equal(g002Contracts.continuityAssignmentV3.$defs.signature.properties.purpose.const, 'continuity:assignment-v3');
for (const binding of ['delegationOutputSha256', 'successorOutputSha256', 'outputSha256', 'publicSignature']) assert.ok(g002Contracts.continuityAssignmentV3.required.includes(binding));
assert.equal(g002Contracts.g003V4FreezeInventory.properties.schemaVersion.const, 'continuity-g003-v4-freeze-inventory-v1');
assert.equal(g002Contracts.g003V4FreezeInventory.properties.state.const, 'FROZEN');
assert.equal(g002Contracts.g003V4FreezeInventory.properties.protocolAuthoritySha256.const, 'e1a569f6cd3351c04db5795acc98762d6f2bfd0596826fc4a0c35fe3f870df5e');
assert.equal(g002Contracts.g003V4FreezeInventory.$defs.signature.properties.purpose.const, 'g003:v4-freeze-inventory');
assert.equal(g002Contracts.g003V4FreezeInventory.properties.roots.minItems, 2);
assert.equal(g002Contracts.g003V5TerminalActivation.properties.schemaVersion.const, 'continuity-g003-v5-terminal-candidate-v1');
assert.equal(g002Contracts.g003V5TerminalActivation.properties.state.const, 'TERMINAL');
assert.equal(g002Contracts.g003V5TerminalActivation.properties.reviewProtocol.const, 'continuity-g003-review-protocol-v5');
assert.equal(g002Contracts.g003V5TerminalActivation.properties.priorProtocolAuthoritySha256.const, 'e1a569f6cd3351c04db5795acc98762d6f2bfd0596826fc4a0c35fe3f870df5e');
for (const binding of ['predecessorFileSha256', 'freezeOutputSha256', 'freezeFileSha256', 'delegationOutputSha256', 'delegationFileSha256', 'successorOutputSha256', 'successorFileSha256']) {
  assert.ok(g002Contracts.g003V5TerminalActivation.required.includes(binding), `g003V5TerminalActivation: missing ${binding}`);
}

assert.equal(taxonomyConsensus.schemaVersion, 'taxonomy-consensus-v1');
assert.equal(taxonomyConsensus.assets.length, 240);
assert.deepEqual(taxonomyConsensus.counts, { regenerateRequired: 62, reusable: 145, reviewEvidenceOnly: 21, reviewPassUnknown: 12, reviewRequired: 33 });
assert.equal(taxonomyConsensus.assets.filter((asset) => asset.disposition === 'reusable' && asset.taxonomy.speciesFamily.startsWith('unknown')).length, 0);
assert.equal(new Set(taxonomyConsensus.assets.map((asset) => asset.pgId)).size, 240);
assert.equal(inputLock.schemaVersion, 'continuity-input-lock-v1');
assert.ok(inputLock.inputs.every((binding) => !binding.path.startsWith('.omx/')), 'public G002 lock may not depend on private OMX files');
for (const binding of inputLock.inputs) {
  if (binding.path === 'production/catalog/creatures.json') {
    const projection = projectG002CatalogEpoch(JSON.parse(await readContainedFile(repoRoot, binding.path)));
    assert.equal(projection.sha256, binding.sha256, `stale G002 public input: ${binding.path}`);
    continue;
  }
  const bytes = await readContainedFile(repoRoot, binding.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), binding.sha256, `stale G002 public input: ${binding.path}`);
}
assert.equal(pins.fixtures.length, 6);
assert.ok(pins.fixtures.every((fixture) => fixture.screenshotPath.startsWith('production/reports/biological-continuity-v3/g002-evidence-v1/screenshots/')));
assert.equal(topology.rootSlotIds.length, 60);
assert.equal(topology.edges.length, 190);
assert.deepEqual(topology.counts.choiceProfile, { noChoice: 32, stageOneChoice: 10, stageTwoChoice: 18 });
assert.equal(assignmentManifest.schemaVersion, 'continuity-assignment-v1');
assert.equal(assignmentManifest.assignments.length, 240);
assert.equal(new Set(assignmentManifest.assignments.map((entry) => entry.slotId)).size, 240);
assert.equal(revisionMap.schemaVersion, 'catalog-revision-map-v1');
assert.equal(revisionMap.collection.length, 240);
assert.equal(revisionMap.display.length, 242);
assert.equal(revisionMap.mutationRetryRoots.length, 60);

console.log(JSON.stringify({ catalog: catalog.length, contracts: ['v1', ...Object.keys(g002Contracts)], g002EvidenceRoot: 'public', status: 'ok' }));
