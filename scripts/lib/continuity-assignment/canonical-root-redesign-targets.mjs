import { sha256Canonical } from './canonical-json.mjs';
import { verifyPublicEvidence } from '../g002-public-authority.mjs';

export const CANONICAL_ROOT_IDS = Object.freeze(['PG-016', 'PG-021', 'PG-022', 'PG-028', 'PG-034', 'PG-041', 'PG-046', 'PG-050', 'PG-054']);
export const CANONICAL_TARGET_FIELDS = Object.freeze(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']);
export const CANONICAL_REVIEWERS = Object.freeze(['/root/visual_census_batch_recorder', '/root/release_version_review']);
export const CANONICAL_ARCHITECT = '/root/release_version_review';
export const APPROVED_CANONICAL_CORE_SHA256 = '8588703a71b4f02411d876eaf4a276d1e0836706fab3428de2509b3849571def';

const fail = (message) => { throw new Error(`canonical root redesign targets: ${message}`); };
const concrete = (value) => typeof value === 'string' && value.length >= 2 && !/^(?:unknown|manual-review-required)(?:-|$)/i.test(value);
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} fields mismatch`);
};

export function validateCanonicalRootRedesignCore(core) {
  exactKeys(core, ['schemaVersion', 'runId', 'state', 'contractKind', 'targetSource', 'reviewerProvenanceIds', 'architectApprovalSource', 'visibilityPolicy', 'targets'], 'contract');
  if (core.schemaVersion !== 'canonical-root-redesign-targets-v1' || core.runId !== 'g002-v1'
      || core.state !== 'APPROVED_FOR_REGENERATION_TARGETING' || core.contractKind !== 'CANONICAL_REDESIGN_TARGETS_NOT_PIXEL_TAXONOMY_CONSENSUS'
      || core.targetSource !== 'signed-canonical-root-redesign-contract') fail('contract identity or scope mismatch');
  if (JSON.stringify([...core.reviewerProvenanceIds].sort()) !== JSON.stringify([...CANONICAL_REVIEWERS].sort())
      || new Set(core.reviewerProvenanceIds).size !== 2 || core.architectApprovalSource !== CANONICAL_ARCHITECT) fail('independent reviewer/architect provenance mismatch');
  exactKeys(core.visibilityPolicy, ['surfaceRequirement', 'appendageCountingRule', 'ambiguityRule', 'preservationRule'], 'visibility policy');
  if (core.visibilityPolicy.surfaceRequirement !== 'master-and-runtime-independently-satisfy-canonical-tuple-and-all-three-anchors'
      || core.visibilityPolicy.appendageCountingRule !== 'count-visible-appendages-only'
      || core.visibilityPolicy.ambiguityRule !== 'hidden-merged-or-double-readable-is-block'
      || core.visibilityPolicy.preservationRule !== 'preserve-anchor-shape-relative-placement-and-color-role') fail('visibility policy weakened');
  if (!Array.isArray(core.targets) || core.targets.length !== CANONICAL_ROOT_IDS.length) fail('target coverage mismatch');
  const ids = core.targets.map((target) => target.rootId).sort();
  if (JSON.stringify(ids) !== JSON.stringify(CANONICAL_ROOT_IDS)) fail('target IDs are missing or extra');
  for (const target of core.targets) {
    exactKeys(target, ['rootId', 'currentPixelAssessment', 'canonicalTarget', 'anchors', 'clarificationRequirements'], `${target.rootId} target`);
    if (target.currentPixelAssessment !== 'DISPUTED_OR_AMBIGUOUS') fail(`${target.rootId}: current pixels must remain explicitly disputed/ambiguous`);
    exactKeys(target.canonicalTarget, CANONICAL_TARGET_FIELDS, `${target.rootId} canonical target`);
    if (Object.values(target.canonicalTarget).some((value) => !concrete(value))) fail(`${target.rootId}: canonical target contains unknown/manual/non-concrete fields`);
    if (!Array.isArray(target.anchors) || target.anchors.length !== 3 || new Set(target.anchors.map((anchor) => anchor.anchorId)).size !== 3) fail(`${target.rootId}: exactly three immutable anchors required`);
    for (const anchor of target.anchors) {
      exactKeys(anchor, ['anchorId', 'description'], `${target.rootId} anchor`);
      if (typeof anchor.anchorId !== 'string' || anchor.anchorId.length < 3 || typeof anchor.description !== 'string' || anchor.description.length < 8) fail(`${target.rootId}: incomplete anchor`);
    }
    if (!Array.isArray(target.clarificationRequirements) || target.clarificationRequirements.length < 2
        || target.clarificationRequirements.some((item) => typeof item !== 'string' || item.length < 8)) fail(`${target.rootId}: visibility/clarification requirements omitted`);
  }
  if (sha256Canonical(core) !== APPROVED_CANONICAL_CORE_SHA256) fail('contract differs from the architect-approved atomic targets, anchors, or clarification rules');
  return new Map(core.targets.map((target) => [target.rootId, target]));
}

export function validateSignedCanonicalRootRedesignTargets(value) {
  exactKeys(value, ['schemaVersion', 'runId', 'state', 'contractKind', 'targetSource', 'reviewerProvenanceIds', 'architectApprovalSource', 'visibilityPolicy', 'targets', 'outputSha256', 'publicSignature'], 'signed contract');
  const signed = structuredClone(value); delete signed.publicSignature;
  verifyPublicEvidence(signed, value.publicSignature);
  const core = structuredClone(signed); delete core.outputSha256;
  if (signed.outputSha256 !== sha256Canonical(core)) fail('output hash mismatch');
  return { byRootId: validateCanonicalRootRedesignCore(core), outputSha256: signed.outputSha256 };
}

export function resolveCanonicalRootAuthorityV1(value) {
  const verified = validateSignedCanonicalRootRedesignTargets(value);
  return {
    ...verified,
    targetSource: 'signed-canonical-root-redesign-contract',
    visibilityPolicy: value.visibilityPolicy,
    reviewerProvenanceIds: [...value.reviewerProvenanceIds],
    architectApprovalSource: value.architectApprovalSource,
  };
}

export function selectCanonicalRootTarget(rootId, currentPixelTarget, canonicalByRootId) {
  return canonicalByRootId.get(rootId)?.canonicalTarget ?? currentPixelTarget;
}
