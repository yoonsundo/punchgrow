import { sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertExactIds, listContainedRegularFiles, readContainedFile } from './continuity-assignment/evidence.mjs';
import { verifyPublicEvidence } from './g002-public-authority.mjs';
import { G002_V1_BASE, G002_V2_ADDITION_IDS, G002_V2_ROOT, validateSignedG002V2Successor, verifyG002V1BaseAuthority } from './continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { V2_OUTPUT_NAMES } from '../build-g002-v2-continuity-assignment.mjs';
import { verifyCanonicalPublicReviewProof } from '../conduct-g002-v2-canonical-reviews.mjs';

export const V2_PUBLIC_UNSIGNED = `${G002_V2_ROOT}/public-evidence-manifest.unsigned.json`;
export const V2_PUBLIC_SIGNED = `${G002_V2_ROOT}/public-evidence-manifest.json`;
export const V2_CANONICAL_SIGNED = `${G002_V2_ROOT}/canonical-root-redesign-targets-v2.json`;
export const V2_AUTHORITATIVE_PATHS = Object.freeze([
  V2_CANONICAL_SIGNED,
  `${G002_V2_ROOT}/canonical-root-reviews/architect-approval.json`,
  ...G002_V2_ADDITION_IDS.map((id) => `${G002_V2_ROOT}/canonical-root-reviews/proofs/${id}.json`),
  ...V2_OUTPUT_NAMES.map((name) => `${G002_V2_ROOT}/${name}`),
].sort());
export const V2_INVENTORY_EXCEPTIONS = Object.freeze([
  `${G002_V2_ROOT}/architect-approval.template.json`, `${G002_V2_ROOT}/canonical-root-redesign-targets-v2.draft.json`,
  `${G002_V2_ROOT}/canonical-root-redesign-targets-v2.unsigned.json`, `${G002_V2_ROOT}/canonical-root-reviews/raw-observation.template.json`,
  V2_PUBLIC_UNSIGNED, V2_PUBLIC_SIGNED,
].sort());

const fail = (message) => { throw new Error(`G002 public evidence v3: ${message}`); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} fields mismatch`);
};

export async function assertV2Inventory(repoRoot, { requireUnsigned = false, requireSigned = false } = {}) {
  const actual = (await listContainedRegularFiles(repoRoot, G002_V2_ROOT)).map((entry) => `${G002_V2_ROOT}/${entry}`);
  const fixedExceptions = V2_INVENTORY_EXCEPTIONS.filter((entry) => ![V2_PUBLIC_UNSIGNED, V2_PUBLIC_SIGNED].includes(entry) && actual.includes(entry));
  const expected = [...V2_AUTHORITATIVE_PATHS, ...fixedExceptions];
  if (requireUnsigned || actual.includes(V2_PUBLIC_UNSIGNED)) expected.push(V2_PUBLIC_UNSIGNED);
  if (requireSigned || actual.includes(V2_PUBLIC_SIGNED)) expected.push(V2_PUBLIC_SIGNED);
  assertExactIds(actual, expected.sort(), 'G002-v2 evidence inventory');
}

export function assertV2PublicManifestShape(value, { signed = true } = {}) {
  exactKeys(value, signed ? ['schemaVersion', 'runId', 'authorityMode', 'baseAuthority', 'files', 'runtimeAssets', 'outputSha256', 'publicSignature'] : ['schemaVersion', 'runId', 'authorityMode', 'baseAuthority', 'files', 'runtimeAssets', 'outputSha256'], 'manifest');
  if (value.schemaVersion !== 'g002-public-evidence-manifest-v3' || value.runId !== 'g002-v2' || value.authorityMode !== 'PUBLIC_ED25519_NO_FALLBACK'
      || sha256Canonical(value.baseAuthority) !== sha256Canonical(G002_V1_BASE)) fail('manifest identity/base mismatch');
  assertExactIds(value.files.map((entry) => entry.path), V2_AUTHORITATIVE_PATHS, 'manifest files');
  if (value.runtimeAssets.length !== 240) fail('runtime inventory mismatch');
  const core = { schemaVersion: value.schemaVersion, runId: value.runId, authorityMode: value.authorityMode, baseAuthority: value.baseAuthority, files: value.files, runtimeAssets: value.runtimeAssets };
  if (value.outputSha256 !== sha256Canonical(core)) fail('manifest output hash mismatch');
  if (signed) verifyPublicEvidence({ ...core, outputSha256: value.outputSha256 }, value.publicSignature);
  return core;
}

export function assertG002V2AssignmentSemantics({ assignment, queue, feasibility, topology, attestation }) {
  if (assignment.schemaVersion !== 'continuity-assignment-v2' || assignment.runId !== 'g002-v2'
      || assignment.verdict !== 'FEASIBLE_WITH_REGENERATION' || !Array.isArray(assignment.assignments) || assignment.assignments.length !== 240) fail('assignment identity/count/policy mismatch');
  const authority = assignment.effectiveAuthoritySha256;
  if (!/^[a-f0-9]{64}$/.test(authority) || [queue, feasibility, attestation].some((document) => document.effectiveAuthoritySha256 !== authority)) fail('effective authority cross-binding mismatch');
  if (queue.schemaVersion !== 'continuity-regeneration-queue-g002-v2' || queue.runId !== 'g002-v2' || !Array.isArray(queue.entries) || queue.entries.length !== 177) fail('regeneration queue relaxed or incomplete');
  if (feasibility.schemaVersion !== 'continuity-feasibility-g002-v2' || feasibility.runId !== 'g002-v2'
      || feasibility.regenerationCount !== 177 || feasibility.retainedCount !== 63 || feasibility.incompatibleEdgeCount !== 0
      || feasibility.exactCompatibleEdgeCount !== 190 || feasibility.fixedPointReached !== true) fail('feasibility policy/count mismatch');
  const gate = assignment.reviewCoverageManifest;
  if (gate?.schemaVersion !== 'continuity-g003-review-gate-v2' || gate.state !== 'PENDING_G003_REVIEW' || gate.completionAllowed !== false
      || gate.queueCandidates?.length !== 177 || gate.edgeCandidates?.length !== 190
      || gate.coverage?.requiredQueueCandidates !== 177 || gate.coverage?.passedQueueCandidates !== 0
      || gate.coverage?.requiredFinalEdges !== 190 || gate.coverage?.passedFinalEdges !== 0 || gate.coverage?.missingCoverage !== 367) fail('G003 review gate relaxed or incomplete');
  if (gate.authority?.effectiveAuthoritySha256 !== authority || !/^[a-f0-9]{64}$/.test(gate.authority?.canonicalSuccessorOutputSha256 ?? '')) fail('G003 gate authority cross-binding mismatch');
  const candidates = [...gate.queueCandidates, ...gate.edgeCandidates];
  if (candidates.some((candidate) => candidate.status !== 'PENDING_COMPARATIVE_VISUAL_REVIEW' || candidate.reviewEvidence !== null
      || candidate.comparisonThresholds?.sameCreatureGrownUp !== 'yes' || candidate.comparisonThresholds?.minimumAnchorRetentionRatio !== 1)) fail('comparative review threshold relaxed');
  if (topology.schemaVersion !== 'continuity-topology-after-v2' || topology.runId !== 'g002-v2' || !Array.isArray(topology.edges) || topology.edges.length !== 190
      || topology.edges.some((edge) => edge.targetCompatible !== true || !['VERIFIED_PIXEL_VOTE_TARGET', 'VERIFIED_MIXED_PARENT_ANCHOR_CONTRACT'].includes(edge.compatibilityStatus))) fail('topology contains a relaxed edge');
  if (attestation.schemaVersion !== 'continuity-output-attestation-g002-v2' || attestation.runId !== 'g002-v2'
      || attestation.declaredVerdict !== 'FEASIBLE_WITH_REGENERATION'
      || attestation.generationPolicy !== 'deterministic-fail-closed-public-atomic-no-active-mutation-no-v1-fallback') fail('output attestation policy relaxed');
  return true;
}

export async function verifyV2PublicMaterial(value, { repoRoot }) {
  assertV2PublicManifestShape(value, { signed: false });
  const verifiedBase = await verifyG002V1BaseAuthority(repoRoot, value.baseAuthority);
  for (const binding of value.files) if (sha256Bytes(await readContainedFile(repoRoot, binding.path)) !== binding.sha256) fail(`${binding.path} hash drift`);
  await assertV2Inventory(repoRoot);
  const successor = JSON.parse(await readContainedFile(repoRoot, V2_CANONICAL_SIGNED));
  validateSignedG002V2Successor(successor);
  for (const binding of successor.reviewProofs) {
    const bytes = await readContainedFile(repoRoot, binding.publicProofPath); const persisted = JSON.parse(bytes);
    verifyCanonicalPublicReviewProof(persisted);
    if (sha256Bytes(bytes) !== binding.publicProofFileSha256 || persisted.outputSha256 !== binding.publicProofOutputSha256
        || sha256Canonical(persisted.publicSignature) !== binding.publicProofSignatureSha256) fail(`${binding.rootId} review proof differs from signed successor`);
  }
  const architect = JSON.parse(await readContainedFile(repoRoot, `${G002_V2_ROOT}/canonical-root-reviews/architect-approval.json`));
  if (sha256Canonical(architect) !== sha256Canonical(successor.architectApproval)) fail('architect approval differs from signed successor');
  if (JSON.stringify(value.runtimeAssets) !== JSON.stringify(verifiedBase.manifest.runtimeAssets)) fail('runtime assets drift from immutable v1 baseline');
  for (const asset of value.runtimeAssets) {
    exactKeys(asset, ['pgId', 'master', 'mobile', 'macos'], `runtime asset ${asset?.pgId ?? '?'}`);
    if (!/^PG-[0-9]{3}$/.test(asset.pgId ?? '')) fail('runtime asset ID is invalid');
    for (const surfaceName of ['mobile', 'macos']) {
      const surface = asset[surfaceName];
      exactKeys(surface, ['path', 'sha256', 'bytes', 'width', 'height'], `${asset.pgId} ${surfaceName}`);
      const bytes = await readContainedFile(repoRoot, surface.path);
      if (bytes.length !== surface.bytes || sha256Bytes(bytes) !== surface.sha256 || surface.width !== 360 || surface.height !== 360) {
        fail(`${asset.pgId} ${surfaceName} runtime bytes drift`);
      }
    }
  }
  const [assignment, queue, feasibility, topology, attestation] = await Promise.all([
    'assignment-manifest.json', 'regeneration-queue.json', 'feasibility-report.json', 'topology-after.json', 'output-attestation.json',
  ].map(async (name) => JSON.parse(await readContainedFile(repoRoot, `${G002_V2_ROOT}/${name}`))));
  assertG002V2AssignmentSemantics({ assignment, queue, feasibility, topology, attestation });
  if (assignment.reviewCoverageManifest.authority.canonicalSuccessorOutputSha256 !== successor.outputSha256) fail('G003 gate differs from signed canonical successor');
  const module = await import('../verify-g002-v2-continuity-assignment.mjs');
  await module.verifyG002V2ContinuityAssignment({ repoRoot });
  return true;
}
