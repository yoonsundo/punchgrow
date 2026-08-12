import path from 'node:path';
import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { readContainedFile } from './evidence.mjs';
import { verifyPublicEvidence } from '../g002-public-authority.mjs';
import { CANONICAL_ROOT_IDS as V1_ROOT_IDS, validateSignedCanonicalRootRedesignTargets } from './canonical-root-redesign-targets.mjs';

export const G002_V2_ROOT = 'production/reports/biological-continuity-v3/g002-evidence-v2';
export const G002_V2_TARGET_SOURCE = 'signed-canonical-root-redesign-successor-v2';
export const G002_V2_DRAFT_CANONICAL_SHA256 = '1386c9f87ca703533ef5f06c60585f97b97ec9ee30772799a7185b98e2a87584';
export const G002_V2_ADDITION_IDS = Object.freeze(['PG-024', 'PG-029', 'PG-047', 'PG-052', 'PG-053', 'PG-056']);
export const G002_V2_EFFECTIVE_ROOT_IDS = Object.freeze([...V1_ROOT_IDS, ...G002_V2_ADDITION_IDS].sort());
export const G002_V2_CANDIDATE_IDENTITY_ANCHORS = Object.freeze({
  'PG-024': Object.freeze(['eight-separate-mechanical-walking-legs', 'four-pink-eyes-and-paired-gold-fangs', 'four-pink-rimmed-dorsal-ports-and-gold-braces']),
  'PG-029': Object.freeze(['six-legs-two-crystal-wings-no-antennae', 'silver-segmented-insect-body', 'paired-diamond-eyes-pearl-tail']),
  'PG-047': Object.freeze(['four-separate-walking-leg-pairs', 'separate-pincer-pedipalp-pair', 'burgundy-armor-cyan-striped-tail-and-bulb-stinger']),
  'PG-052': Object.freeze(['eight-separate-spider-legs', 'two-huge-cyan-eyes-single-gold-forehead-horn', 'thin-gold-dorsal-stripe-over-rounded-black-abdomen']),
  'PG-053': Object.freeze(['black-head-red-eyes-three-red-gills-per-side', 'black-body-red-underside-four-short-legs', 'black-paddle-tail-red-dorsal-seam']),
  'PG-056': Object.freeze(['charcoal-body-teal-eyes-red-facial-stripe', 'exactly-four-red-lobed-fins', 'red-dorsal-mint-edge-red-forked-tail']),
});
export const G002_V1_BASE = Object.freeze({
  publicManifestPath: 'production/reports/biological-continuity-v3/g002-evidence-v1/public-evidence-manifest.json',
  publicManifestFileSha256: 'ea86e51a1fc21eaaad708e256bf3348480fa284d201814ec71f89fec128889af',
  publicManifestOutputSha256: '5b29298aaf917955ac8f094552948ee4093be363a478e92d987fc5b13d88e01c',
  canonicalContractPath: 'production/reports/biological-continuity-v3/g002-evidence-v1/canonical-root-redesign-targets-v1.json',
  canonicalContractFileSha256: 'ede8e2a728c588cafc4f614e7858495f138cf7b208b7048166b66610fd5c6de1',
  canonicalContractOutputSha256: '8588703a71b4f02411d876eaf4a276d1e0836706fab3428de2509b3849571def',
});

const TARGET_FIELDS = ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'];
const fail = (message) => { throw new Error(`G002-v2 canonical authority: ${message}`); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} fields mismatch`);
};
const exactArray = (actual, expected, label) => {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
};
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validatePrimaryReview(review, rootId, expectedPass) {
  exactKeys(review, ['reviewerInstanceId', 'agentTaskId', 'reviewRunId', 'passNumber', 'assignmentSha256', 'packageManifestSha256', 'materialBindingSha256', 'promptSha256', 'inputAllowlistSha256', 'rawVoteSha256', 'reviewOutputSha256', 'observedSurfaces', 'verdicts', 'blinded'], `${rootId} primary review`);
  if (![review.reviewerInstanceId, review.agentTaskId, review.reviewRunId].every((value) => typeof value === 'string' && value.length >= 4)
      || review.passNumber !== expectedPass || review.blinded !== true) fail(`${rootId}: primary review identity/pass/blinding mismatch`);
  for (const field of ['assignmentSha256', 'packageManifestSha256', 'materialBindingSha256', 'promptSha256', 'inputAllowlistSha256', 'rawVoteSha256', 'reviewOutputSha256']) if (!sha(review[field])) fail(`${rootId}: ${field} missing`);
  exactKeys(review.observedSurfaces, ['masterSha256', 'runtimeSha256'], `${rootId} observed surfaces`);
  if (!sha(review.observedSurfaces.masterSha256) || !sha(review.observedSurfaces.runtimeSha256)) fail(`${rootId}: observed surface binding missing`);
  exactKeys(review.verdicts, ['target', 'anchors', 'visibility', 'clarifications'], `${rootId} verdicts`);
  if (Object.values(review.verdicts).some((value) => value !== 'PASS')) fail(`${rootId}: review verdict is not PASS`);
}

export function validateG002V2SuccessorCore(core) {
  exactKeys(core, ['schemaVersion', 'runId', 'state', 'contractKind', 'targetSource', 'baseAuthority', 'newTargetIds', 'visibilityPolicy', 'targets', 'reviewProofs', 'architectApproval'], 'successor');
  if (core.schemaVersion !== 'canonical-root-redesign-targets-v2' || core.runId !== 'g002-v2'
      || core.state !== 'APPROVED_FOR_REGENERATION_TARGETING' || core.contractKind !== 'ADDITIVE_CANONICAL_ROOT_AUTHORITY_SUCCESSOR'
      || core.targetSource !== G002_V2_TARGET_SOURCE) fail('successor identity mismatch');
  exactKeys(core.baseAuthority, Object.keys(G002_V1_BASE), 'base authority');
  if (sha256Canonical(core.baseAuthority) !== sha256Canonical(G002_V1_BASE)) fail('base authority binding mismatch');
  exactArray(core.newTargetIds, G002_V2_ADDITION_IDS, 'new target IDs');
  if (core.newTargetIds.some((id) => V1_ROOT_IDS.includes(id)) || new Set(core.newTargetIds).size !== 6) fail('new targets overlap v1 or are duplicated');
  exactKeys(core.visibilityPolicy, ['surfaceRequirement', 'appendageCountingRule', 'ambiguityRule', 'preservationRule'], 'visibility policy');
  if (core.visibilityPolicy.surfaceRequirement !== 'master-and-runtime-independently-satisfy-canonical-tuple-and-all-three-anchors'
      || core.visibilityPolicy.appendageCountingRule !== 'count-visible-appendages-only'
      || core.visibilityPolicy.ambiguityRule !== 'hidden-merged-or-double-readable-is-block'
      || core.visibilityPolicy.preservationRule !== 'preserve-anchor-shape-relative-placement-and-color-role') fail('visibility policy weakened');
  if (!Array.isArray(core.targets) || core.targets.length !== 6) fail('exactly six successor targets required');
  exactArray(core.targets.map((target) => target.rootId).sort(), G002_V2_ADDITION_IDS, 'target coverage');
  for (const target of core.targets) {
    exactKeys(target, ['rootId', 'currentPixelAssessment', 'canonicalTarget', 'anchors', 'clarificationRequirements'], `${target.rootId} target`);
    if (target.currentPixelAssessment !== 'DISPUTED_OR_AMBIGUOUS') fail(`${target.rootId}: pixel assessment mismatch`);
    exactKeys(target.canonicalTarget, TARGET_FIELDS, `${target.rootId} taxonomy`);
    if (Object.values(target.canonicalTarget).some((value) => typeof value !== 'string' || value.length < 2 || /^(unknown|manual-review-required)/i.test(value))) fail(`${target.rootId}: non-concrete taxonomy`);
    if (!Array.isArray(target.anchors) || target.anchors.length !== 3 || new Set(target.anchors.map((anchor) => anchor.anchorId)).size !== 3) fail(`${target.rootId}: exactly three anchors required`);
    for (const anchor of target.anchors) {
      exactKeys(anchor, ['anchorId', 'description'], `${target.rootId} anchor`);
      if (typeof anchor.anchorId !== 'string' || anchor.anchorId.length < 3 || typeof anchor.description !== 'string' || anchor.description.length < 8) fail(`${target.rootId}: incomplete anchor`);
    }
    const lockedIdentityAnchors = G002_V2_CANDIDATE_IDENTITY_ANCHORS[target.rootId];
    if (lockedIdentityAnchors && JSON.stringify(target.anchors.map((anchor) => anchor.anchorId)) !== JSON.stringify(lockedIdentityAnchors)) fail(`${target.rootId}: accepted candidate identity anchors mismatch`);
    if (!Array.isArray(target.clarificationRequirements) || target.clarificationRequirements.length < 2
        || target.clarificationRequirements.some((value) => typeof value !== 'string' || value.length < 8)) fail(`${target.rootId}: clarification requirements missing`);
    if (target.rootId === 'PG-024' && !target.clarificationRequirements.some((value) => /extra eyes, extra fangs, extra dorsal ports/i.test(value))) fail('PG-024: extra candidate features are not explicitly rejected');
    if (target.rootId === 'PG-052' && !target.clarificationRequirements.some((value) => /extra eyes, fangs, additional horns/i.test(value))) fail('PG-052: extra candidate features are not explicitly rejected');
    const identityText = `${target.anchors.map((anchor) => `${anchor.anchorId} ${anchor.description}`).join(' ')} ${target.clarificationRequirements.join(' ')}`;
    const requiredIdentityTerms = {
      'PG-029': [/silver/i, /segmented/i, /no antennae|reject antennae/i, /six/i, /two/i, /diamond/i, /pearl/i],
      'PG-047': [/burgundy/i, /gold joints/i, /cyan dorsal stripe/i, /cyan bulb stinger/i],
      'PG-053': [/black/i, /red eyes/i, /three.*gill/i, /four.*legs/i, /paddle/i, /red dorsal seam/i],
      'PG-056': [/charcoal/i, /teal/i, /red facial stripe/i, /exactly four.*red lobed fins/i, /red forked tail/i],
    }[target.rootId];
    if (requiredIdentityTerms?.some((pattern) => !pattern.test(identityText))) fail(`${target.rootId}: accepted candidate visual identity is incomplete`);
  }
  if (!Array.isArray(core.reviewProofs) || core.reviewProofs.length !== 6) fail('exactly six review consensus proofs required');
  exactArray(core.reviewProofs.map((proof) => proof.rootId).sort(), G002_V2_ADDITION_IDS, 'review proof coverage');
  for (const proof of core.reviewProofs) {
    exactKeys(proof, ['rootId', 'targetSha256', 'publicProofPath', 'publicProofFileSha256', 'publicProofOutputSha256', 'publicProofSignatureSha256', 'primaryReviews', 'consensusSha256'], `${proof.rootId} review proof`);
    if (proof.publicProofPath !== `${G002_V2_ROOT}/canonical-root-reviews/proofs/${proof.rootId}.json`
        || proof.targetSha256 !== sha256Canonical(core.targets.find((target) => target.rootId === proof.rootId))
        || !sha(proof.publicProofFileSha256) || !sha(proof.publicProofOutputSha256) || !sha(proof.publicProofSignatureSha256)) fail(`${proof.rootId}: public review proof binding invalid`);
    if (!Array.isArray(proof.primaryReviews) || proof.primaryReviews.length !== 2) fail(`${proof.rootId}: two primary reviews required`);
    proof.primaryReviews.forEach((review, index) => validatePrimaryReview(review, proof.rootId, index + 1));
    const [first, second] = proof.primaryReviews;
    for (const field of ['reviewerInstanceId', 'agentTaskId', 'reviewRunId', 'reviewOutputSha256', 'rawVoteSha256']) if (first[field] === second[field]) fail(`${proof.rootId}: primary reviews are not independent`);
    if (first.packageManifestSha256 !== second.packageManifestSha256 || first.materialBindingSha256 !== second.materialBindingSha256
        || first.promptSha256 !== second.promptSha256 || first.inputAllowlistSha256 !== second.inputAllowlistSha256
        || sha256Canonical(first.observedSurfaces) !== sha256Canonical(second.observedSurfaces)) fail(`${proof.rootId}: primary reviews do not bind identical blinded material`);
    if (proof.consensusSha256 !== sha256Canonical({ rootId: proof.rootId, primaryReviews: proof.primaryReviews })) fail(`${proof.rootId}: review consensus hash mismatch`);
  }
  exactKeys(core.architectApproval, ['schemaVersion', 'source', 'reviewerId', 'decision', 'approvedTargetIds', 'evidenceSha256', 'approvedAt', 'outputSha256', 'publicSignature'], 'architect approval');
  if (core.architectApproval.schemaVersion !== 'g002-v2-canonical-architect-approval-v1') fail('architect approval schema mismatch');
  if (core.architectApproval.source !== 'independent-architect-review' || typeof core.architectApproval.reviewerId !== 'string'
      || core.architectApproval.reviewerId.length < 4 || core.architectApproval.decision !== 'APPROVE'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(core.architectApproval.approvedAt)) fail('architect approval missing or invalid');
  exactArray(core.architectApproval.approvedTargetIds, G002_V2_ADDITION_IDS, 'architect approved target IDs');
  const architectCore = structuredClone(core.architectApproval); delete architectCore.outputSha256; delete architectCore.publicSignature;
  if (core.architectApproval.outputSha256 !== sha256Canonical(architectCore)) fail('architect approval output hash mismatch');
  const evidence = { newTargetIds: core.newTargetIds, targets: core.targets, reviewProofs: core.reviewProofs, visibilityPolicy: core.visibilityPolicy };
  if (core.architectApproval.evidenceSha256 !== sha256Canonical(evidence)) fail('architect evidence hash mismatch');
  return new Map(core.targets.map((target) => [target.rootId, target]));
}

export function validateSignedG002V2Successor(value) {
  exactKeys(value, ['schemaVersion', 'runId', 'state', 'contractKind', 'targetSource', 'baseAuthority', 'newTargetIds', 'visibilityPolicy', 'targets', 'reviewProofs', 'architectApproval', 'outputSha256', 'publicSignature'], 'signed successor');
  const unsigned = structuredClone(value); delete unsigned.publicSignature;
  verifyPublicEvidence(unsigned, value.publicSignature);
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (unsigned.outputSha256 !== sha256Canonical(core)) fail('successor output hash mismatch');
  const additions = validateG002V2SuccessorCore(core);
  const architectUnsigned = structuredClone(core.architectApproval); delete architectUnsigned.publicSignature;
  verifyPublicEvidence(architectUnsigned, core.architectApproval.publicSignature);
  const primaryReviewerIds = new Set(core.reviewProofs.flatMap((proof) => proof.primaryReviews.map((review) => review.reviewerInstanceId)));
  if (primaryReviewerIds.has(core.architectApproval.reviewerId)) fail('architect identity reuses a primary reviewer identity');
  return { additions, outputSha256: unsigned.outputSha256 };
}

export function validateUnsignedG002V2Successor(value) {
  exactKeys(value, ['schemaVersion', 'runId', 'state', 'contractKind', 'targetSource', 'baseAuthority', 'newTargetIds', 'visibilityPolicy', 'targets', 'reviewProofs', 'architectApproval', 'outputSha256'], 'unsigned successor');
  const core = structuredClone(value); delete core.outputSha256;
  if (value.outputSha256 !== sha256Canonical(core)) fail('successor output hash mismatch');
  return { additions: validateG002V2SuccessorCore(core), outputSha256: value.outputSha256 };
}

export async function verifyG002V1BaseAuthority(repoRoot, binding = G002_V1_BASE) {
  if (sha256Canonical(binding) !== sha256Canonical(G002_V1_BASE)) fail('unrecognized v1 base authority');
  const [manifestBytes, contractBytes] = await Promise.all([
    readContainedFile(repoRoot, binding.publicManifestPath), readContainedFile(repoRoot, binding.canonicalContractPath),
  ]);
  if (sha256Bytes(manifestBytes) !== binding.publicManifestFileSha256 || sha256Bytes(contractBytes) !== binding.canonicalContractFileSha256) fail('v1 base file hash mismatch');
  const manifest = JSON.parse(manifestBytes); const contract = JSON.parse(contractBytes);
  const manifestUnsigned = structuredClone(manifest); delete manifestUnsigned.publicSignature;
  verifyPublicEvidence(manifestUnsigned, manifest.publicSignature);
  if (manifest.outputSha256 !== binding.publicManifestOutputSha256) fail('v1 public manifest output hash mismatch');
  const verifiedV1 = validateSignedCanonicalRootRedesignTargets(contract);
  if (verifiedV1.outputSha256 !== binding.canonicalContractOutputSha256) fail('v1 canonical contract output hash mismatch');
  return { manifest, contract, verifiedV1 };
}

export async function resolveG002V2Authority(value, { repoRoot }) {
  const successor = validateSignedG002V2Successor(value);
  const base = await verifyG002V1BaseAuthority(repoRoot, value.baseAuthority);
  const byRootId = new Map([...base.verifiedV1.byRootId, ...successor.additions]);
  exactArray([...byRootId.keys()].sort(), G002_V2_EFFECTIVE_ROOT_IDS, 'effective canonical roots');
  return {
    byRootId, outputSha256: successor.outputSha256, targetSource: G002_V2_TARGET_SOURCE,
    visibilityPolicy: value.visibilityPolicy,
    reviewerProvenanceIds: [...new Set(value.reviewProofs.flatMap((proof) => proof.primaryReviews.map((review) => review.reviewerInstanceId)))].sort(),
    architectApprovalSource: value.architectApproval.reviewerId,
    baseAuthority: value.baseAuthority,
    effectiveAuthoritySha256: sha256Canonical({ baseCanonicalOutputSha256: base.verifiedV1.outputSha256, successorOutputSha256: successor.outputSha256, effectiveRootIds: G002_V2_EFFECTIVE_ROOT_IDS }),
  };
}

export function assertV2OutputPath(relativePath, allowedBasenames) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith(`${G002_V2_ROOT}/`) || relativePath.includes('\\')
      || path.posix.normalize(relativePath) !== relativePath || relativePath.split('/').includes('..')
      || !allowedBasenames.has(path.posix.basename(relativePath))) fail('output path is not confined to g002-evidence-v2');
}
