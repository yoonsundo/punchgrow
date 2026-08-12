#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import {
  assertCanonicalRelativePath, assertExactIds, fail, listContainedRegularFiles, readContainedFile, readJson, writeCanonicalFile, writeFileAtomicNoFollow,
} from './lib/continuity-assignment/evidence.mjs';
import {
  CANONICAL_TARGET_FIELDS,
} from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';
import { G002_V2_EFFECTIVE_ROOT_IDS, G002_V2_TARGET_SOURCE, resolveG002V2Authority, verifyG002V1BaseAuthority } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { assertG003ConductorKeyPinned, g003PurposeHmac } from './lib/g003-public-authority.mjs';
import { G002_V2_ASSIGNMENT, G002_V2_SUCCESSOR, G003_AUTHORITY, G003_BASELINE_SCHEMA_VERSION, G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256, G003_V4_EVIDENCE, g003V4OpaqueId, verifyG003V4Authority } from './lib/g003-v4-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRIVATE_CANDIDATE_ROOT = '.omx/evidence/continuity-candidates';
export const PRIVATE_DESCRIPTOR_ROOT = `${PRIVATE_CANDIDATE_ROOT}/descriptors`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SLOT_PATTERN = /^PG-[0-9]{3}$/;
export const GENERATION_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MATERIAL_ROLES = ['master', 'runtime'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASSIGNMENT_PATH = G002_V2_ASSIGNMENT;
const PIXEL_CLUSTERS_PATH = 'production/reports/biological-continuity-v3/g002-evidence-v1/pixel-clusters.json';
const CANONICAL_TARGETS_PATH = G002_V2_SUCCESSOR;
const G003_PUBLIC_EVIDENCE_ROOT = G003_V4_EVIDENCE;
// Deliberately code-pinned here as well as in the conductor: prepare must not
// accept a validly signed historical manifest after the conductor gate check.
const ACTIVE_PUBLIC_EVIDENCE_OUTPUT_SHA256 = G003_AUTHORITY.publicManifestOutputSha256;
const STAGING_ROOT = 'assets/creatures/biological-continuity-v3';
const PROVENANCE_KEYS = ['schemaVersion', 'slotId', 'generationRunId', 'sourceKind', 'promptSha256', 'workspaceMaster', 'candidateMaster', 'runtime', 'derivation'];
const PNG_DESCRIPTOR_KEYS = ['path', 'sha256', 'bytes', 'width', 'height'];
const STAGED_DERIVATION = Object.freeze({
  engine: 'pngjs', engineVersion: '3.4.0', resampler: 'LANCZOS3-premultiplied-alpha',
  width: 360, height: 360, mode: 'RGBA', colorSpace: 'sRGB', pngCompressionLevel: 9,
  metadataPolicy: 'strip-and-write-srgb-rendering-intent-0',
});
const TRUSTED_DEPENDENCIES = new WeakSet();
const REVIEW_PROTOCOL = G003_PROTOCOL;

const promptFor = (parentCount, reviewContract) => Buffer.from([
  'PunchGrow blinded biological-continuity primary review.',
  'Judge only the supplied parent/child pixels; names, themes, lore, palette similarity, catalog claims, and prior verdicts are forbidden evidence.',
  reviewContract.reviewPolicy.assessmentMode === 'canonical-root-replacement'
    ? 'This package is a signed canonical-root replacement. Treat prior parent pixels only as historical reference. Report no parent observations; instead confirm whether the child exactly matches all four locked canonical taxonomy fields and every signed canonical anchor.'
    : 'For every parent independently report exact biological class, species family, core anatomy, locomotion, whether the child is immediately the same creature grown up, inherited anchor IDs, and visible evidence for every anchor.',
  reviewContract.reviewPolicy.assessmentMode === 'canonical-root-replacement'
    ? 'The historical parent is not a continuity subject and cannot be used to weaken or substitute the signed canonical target.'
    : (parentCount === 1 ? 'A single-parent candidate requires at least three inherited anchor IDs.' : 'A mixed candidate requires at least two inherited anchor IDs from each parent; parents are evaluated independently.'),
  reviewContract.reviewPolicy.assessmentMode === 'canonical-root-replacement'
    ? 'For master and runtime separately: confirm the exact four-field taxonomy, provide visible evidence for all three signed anchors, confirm every locked clarification requirement, count only visible appendages, reject any hidden/merged/double-readable ambiguity, and confirm anchor shape, relative placement, and color role preservation.'
    : 'No canonical visibility or clarification assessment is permitted in strict continuity mode.',
  'Any anatomy, locomotion, same-creature, required-anchor, provenance, or confidence dissent blocks the candidate and cannot be outvoted or adjudicated by pass 3.',
  'The required anchor IDs and required descriptions below are immutable. Report visible candidate evidence separately; do not rename or paraphrase the required descriptions.',
  `Locked review contract: ${canonicalStringify(reviewContract).trim()}`,
].join('\n') + '\n');

const VOTE_HMAC_DOMAIN = 'punchgrow:g003:candidate-primary-vote-v4:hmac\0';
const BINDING_HMAC_DOMAIN = 'punchgrow:g003:candidate-material-binding-v4:hmac\0';
const hmac = (domain, key, value) => g003PurposeHmac(domain, value, key);

function requireConductorKey(conductorKey) {
  const key = Buffer.isBuffer(conductorKey) ? conductorKey : Buffer.from(conductorKey ?? '');
  if (key.length < 32) fail('candidate review conductor key must contain at least 32 bytes');
  assertG003ConductorKeyPinned(key);
  return key;
}

export function assertGenerationRunId(value, label = 'generationRunId') {
  if (typeof value !== 'string' || !GENERATION_RUN_ID_PATTERN.test(value)) {
    fail(`${label} must match ${GENERATION_RUN_ID_PATTERN}`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (extras.length || missing.length) fail(`${label} fields mismatch: missing=${missing.join(',') || 'none'} extra=${extras.join(',') || 'none'}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertTrustedDependency(dependency, label) {
  if (!dependency || !TRUSTED_DEPENDENCIES.has(dependency)) fail(`${label} was not produced by persisted candidate review verification`);
  assertExactKeys(dependency, ['parentId', 'candidateId', 'reviewPath', 'reviewSha256', 'pixelSurfaces', 'anchors'], label);
}

function assertSurface(surface, label) {
  assertExactKeys(surface, ['path', 'sha256'], label);
  assertCanonicalRelativePath(surface.path, `${label} path`);
  if (!SHA256_PATTERN.test(surface.sha256)) fail(`${label} has invalid SHA-256`);
}

function assertMaterialDescriptor(candidate) {
  assertExactKeys(candidate, ['schemaVersion','protocolAuthoritySha256', 'candidateId', 'generationRunId', 'reviewKind', 'child', 'parents'], 'candidate material');
  assertGenerationRunId(candidate.generationRunId, 'candidate material generationRunId');
  if (candidate.schemaVersion !== 'continuity-candidate-material-v4'||candidate.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256 || !candidate.candidateId
      || !['new-edge', 'asset-reuse'].includes(candidate.reviewKind)) fail('candidate material identity is invalid');
  if (!Array.isArray(candidate.parents) || ![1, 2].includes(candidate.parents.length)) fail('candidate material requires one or two parents');
  for (const [label, material] of [['child', candidate.child], ...candidate.parents.map((parent, index) => [`parent ${index + 1}`, parent])]) {
    assertExactKeys(material, ['sourceSlotId', 'master', 'runtime'], label);
    if (!SLOT_PATTERN.test(material.sourceSlotId)) fail(`${label} source slot is invalid`);
    assertSurface(material.master, `${label} master`); assertSurface(material.runtime, `${label} runtime`);
  }
  assertExactIds(candidate.parents.map((parent) => parent.sourceSlotId), [...new Set(candidate.parents.map((parent) => parent.sourceSlotId))], 'candidate parent slots');
  // A root regeneration deliberately compares the new child pixels with the
  // prior pixels from the same catalog slot. The locked queue gate below is
  // the only context allowed to authorize that same-slot parent relationship.
}

function parseCanonicalBytes(bytes, label) {
  let value;
  try { value = JSON.parse(bytes); } catch { fail(`${label} is not JSON`); }
  if (!bytes.equals(Buffer.from(canonicalStringify(value)))) fail(`${label} is not canonical JSON`);
  return value;
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(bytes); } catch { fail(`${label} is not JSON`); }
}

async function verifyStagedPng(repoRoot, descriptor, expectedPath, label, { runtime = false } = {}) {
  assertExactKeys(descriptor, PNG_DESCRIPTOR_KEYS, `${label} descriptor`);
  assertCanonicalRelativePath(descriptor.path, `${label} path`);
  if (descriptor.path !== expectedPath || !SHA256_PATTERN.test(descriptor.sha256 ?? '')
      || !Number.isInteger(descriptor.bytes) || descriptor.bytes < 1
      || !Number.isInteger(descriptor.width) || descriptor.width < 1
      || !Number.isInteger(descriptor.height) || descriptor.height < 1) fail(`${label} descriptor is invalid`);
  const bytes = await readContainedFile(repoRoot, descriptor.path, label);
  if (bytes.length !== descriptor.bytes || sha256Bytes(bytes) !== descriptor.sha256
      || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail(`${label} bytes differ from staged provenance`);
  let decoded;
  try { decoded = PNG.sync.read(bytes, { checkCRC: true, skipRescale: false }); } catch (error) { fail(`${label} PNG/CRC is invalid: ${error.message}`); }
  if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) fail(`${label} dimensions differ from staged provenance`);
  if (runtime && (decoded.width !== 360 || decoded.height !== 360 || bytes[25] !== 6 || !bytes.includes(Buffer.from('sRGB')))) {
    fail('staged runtime is not the required 360x360 RGBA/sRGB derivative');
  }
  return bytes;
}

async function stagedChildMaterial(repoRoot, slotId, generationRunId) {
  const candidateRoot = `${STAGING_ROOT}/candidates/${generationRunId}/${slotId}`;
  const provenanceBytes = await readContainedFile(repoRoot, `${candidateRoot}/provenance.json`, 'staged candidate provenance');
  const provenance = parseCanonicalBytes(provenanceBytes, 'staged candidate provenance');
  assertExactKeys(provenance, PROVENANCE_KEYS, 'staged candidate provenance');
  if (provenance.schemaVersion !== 'continuity-candidate-provenance-v1' || provenance.slotId !== slotId
      || provenance.generationRunId !== generationRunId || provenance.sourceKind !== 'local-built-in-imagegen-png'
      || !SHA256_PATTERN.test(provenance.promptSha256 ?? '')
      || canonicalStringify(provenance.derivation) !== canonicalStringify(STAGED_DERIVATION)) fail('staged candidate provenance identity or derivation is invalid');
  const masterPath = `${candidateRoot}/master.png`; const runtimePath = `${candidateRoot}/runtime.png`;
  const masterBytes = await verifyStagedPng(repoRoot, provenance.candidateMaster, masterPath, 'staged candidate master');
  if (provenance.candidateMaster.width !== provenance.candidateMaster.height || provenance.candidateMaster.width < 1024) fail('staged candidate master must be square and at least 1024px');
  const workspacePath = `${STAGING_ROOT}/workspace-masters/${generationRunId}/${slotId}/${provenance.candidateMaster.sha256}.png`;
  const workspaceBytes = await verifyStagedPng(repoRoot, provenance.workspaceMaster, workspacePath, 'staged workspace master');
  if (provenance.workspaceMaster.sha256 !== provenance.candidateMaster.sha256
      || provenance.workspaceMaster.bytes !== provenance.candidateMaster.bytes
      || provenance.workspaceMaster.width !== provenance.candidateMaster.width
      || provenance.workspaceMaster.height !== provenance.candidateMaster.height
      || !workspaceBytes.equals(masterBytes)) fail('staged workspace and candidate master bindings differ');
  await verifyStagedPng(repoRoot, provenance.runtime, runtimePath, 'staged candidate runtime', { runtime: true });
  const promptBytes = await readContainedFile(repoRoot, `${candidateRoot}/prompt.txt`, 'staged candidate prompt');
  if (!promptBytes.toString('utf8').trim() || sha256Bytes(promptBytes) !== provenance.promptSha256) fail('staged candidate prompt differs from provenance');
  return {
    sourceSlotId: slotId,
    master: { path: provenance.candidateMaster.path, sha256: provenance.candidateMaster.sha256 },
    runtime: { path: provenance.runtime.path, sha256: provenance.runtime.sha256 },
  };
}

async function loadSignedMaterialAuthority(repoRoot, suppliedGate) {
  const verified=await verifyG003V4Authority(repoRoot);
  const baseline = verified.baseline;
  if (baseline.schemaVersion !== G003_BASELINE_SCHEMA_VERSION || baseline.reviewProtocol!==G003_PROTOCOL||baseline.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256||baseline.activePack !== 'cute-redesign-v2') fail('G003 active baseline material authority changed');
  const manifest = verified.publicManifest;
  if (manifest.outputSha256 !== ACTIVE_PUBLIC_EVIDENCE_OUTPUT_SHA256 || !Array.isArray(manifest.files)) fail('active signed G002 public evidence identity changed');
  const bindings = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (bindings.size !== manifest.files.length || !bindings.has(ASSIGNMENT_PATH)||!bindings.has(CANONICAL_TARGETS_PATH)) fail('active signed G002-v2 public evidence lacks assignment/successor bindings');
  const verifiedBase=await verifyG002V1BaseAuthority(repoRoot,manifest.baseAuthority);const baseBindings=new Map(verifiedBase.manifest.files.map((entry)=>[entry.path,entry]));if(!baseBindings.has(PIXEL_CLUSTERS_PATH))fail('G002-v1 base evidence lacks pixel binding');
  const pixelBytes = await readContainedFile(repoRoot, PIXEL_CLUSTERS_PATH, 'signed G002 pixel clusters');
  if (sha256Bytes(pixelBytes) !== baseBindings.get(PIXEL_CLUSTERS_PATH).sha256) fail('G002 pixel clusters differ from active signed public evidence');
  const assignment = verified.assignment; const pixelClusters = parseJsonBytes(pixelBytes, 'signed G002 pixel clusters');
  const signedGate = assignment.reviewCoverageManifest;
  if (suppliedGate && canonicalStringify(suppliedGate) !== canonicalStringify(signedGate)) fail('supplied review gate differs from active signed G002 assignment');
  const canonicalValue = verified.successor;
  const resolved=await resolveG002V2Authority(canonicalValue,{repoRoot});const canonicalTargets={byRootId:resolved.byRootId,outputSha256:resolved.outputSha256,targetSource:resolved.targetSource,visibilityPolicy:structuredClone(canonicalValue.visibilityPolicy)};
  return { lockedGate: suppliedGate ?? signedGate, pixelClusters, assignment, canonicalTargets };
}

async function signedPriorMaterial(repoRoot, pixelClusters, slotId) {
  const matches = (pixelClusters?.entries ?? []).filter((entry) => entry.pgId === slotId);
  if (matches.length !== 1) fail(`signed G002 pixel clusters require exactly one ${slotId} binding`);
  const expected = { sourceSlotId: slotId };
  for (const surface of MATERIAL_ROLES) {
    const binding = matches[0].surfaces?.[surface];
    if (!binding || typeof binding.path !== 'string' || !SHA256_PATTERN.test(binding.sha256 ?? '')) fail(`${slotId} signed G002 ${surface} binding is invalid`);
    assertCanonicalRelativePath(binding.path, `${slotId} signed G002 ${surface} path`);
    const bytes = await readContainedFile(repoRoot, binding.path, `${slotId} signed G002 ${surface}`);
    if (sha256Bytes(bytes) !== binding.sha256) fail(`${slotId} signed G002 ${surface} pixels are stale`);
    expected[surface] = { path: binding.path, sha256: binding.sha256 };
  }
  return expected;
}

function assertExactMaterial(actual, expected, label) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) fail(`${label} differs from authoritative pixel binding`);
}

function assertApprovedGeneratedParentMaterial(material, parentId, candidateId, approvedDependencies, label) {
  const dependency = approvedDependencies[parentId];
  if (!dependency) fail(`${label} requires approved parent ${candidateId}`);
  assertTrustedDependency(dependency, `${label} dependency`);
  if (dependency.parentId !== parentId || dependency.candidateId !== candidateId || material.sourceSlotId !== parentId) fail(`${label} dependency candidate binding mismatch`);
  for (const surface of MATERIAL_ROLES) {
    const approved = dependency.pixelSurfaces?.[surface]; const supplied = material[surface];
    assertSurface(approved, `${label} approved ${surface}`); assertSurface(supplied, `${label} supplied ${surface}`);
    const prefix = `${G003_PUBLIC_EVIDENCE_ROOT}/candidates/${parentId}/`; const relative = supplied.path.slice(prefix.length); const components = relative.split('/');
    if (supplied.sha256 !== approved.sha256 || !supplied.path.startsWith(prefix)
        || components.length !== 4 || components[1] !== 'blobs' || components[2] !== 'sha256'
        || components[3] !== `${supplied.sha256}.png`) fail(`${label} differs from current approved public parent pixels`);
    assertGenerationRunId(components[0], `${label} public generationRunId`);
  }
}

async function assertAuthoritativeCandidateMaterials(candidate, lockedGate, pixelClusters, approvedDependencies, repoRoot) {
  const queue = lockedGate?.queueCandidates?.find((entry) => entry.candidateId === candidate.candidateId);
  const edge = lockedGate?.edgeCandidates?.find((entry) => entry.edgeId === candidate.candidateId);
  if ((queue ? 1 : 0) + (edge ? 1 : 0) !== 1) fail('candidate material does not resolve to one active signed G003 requirement');
  const childSlotId = queue?.slotId ?? edge.childId;
  if (queue) {
    assertExactMaterial(candidate.child, await stagedChildMaterial(repoRoot, childSlotId, candidate.generationRunId), 'candidate child material');
  } else {
    const generatedChild = lockedGate.queueCandidates.find((entry) => entry.slotId === childSlotId);
    if (generatedChild) assertApprovedGeneratedParentMaterial(candidate.child, childSlotId, generatedChild.candidateId, approvedDependencies, 'edge child material');
    else assertExactMaterial(candidate.child, await signedPriorMaterial(repoRoot, pixelClusters, childSlotId), 'retained edge child material');
  }
  const generatedQueueParents = new Map((queue?.requiredParentCandidateIds ?? []).map((candidateId) => [candidateId.split(':').at(-1), candidateId]));
  for (const parent of candidate.parents) {
    let expected; let label;
    if (queue && generatedQueueParents.has(parent.sourceSlotId)) {
      label = `queue parent ${parent.sourceSlotId}`;
      assertApprovedGeneratedParentMaterial(parent, parent.sourceSlotId, generatedQueueParents.get(parent.sourceSlotId), approvedDependencies, label);
      continue;
    } else if (edge) {
      const generated = lockedGate.queueCandidates.find((entry) => entry.slotId === parent.sourceSlotId);
      if (generated) {
        label = `edge parent ${parent.sourceSlotId}`;
        assertApprovedGeneratedParentMaterial(parent, parent.sourceSlotId, generated.candidateId, approvedDependencies, label);
        continue;
      }
    }
    if (!expected) {
      label = queue && (queue.requiredParentCandidateIds ?? []).length === 0 ? 'root queue parent material' : `retained parent ${parent.sourceSlotId}`;
      expected = await signedPriorMaterial(repoRoot, pixelClusters, parent.sourceSlotId);
    }
    assertExactMaterial(parent, expected, label);
  }
}

function blindedEiluBenchmark(benchmark, benchmarkInputs) {
  return {
    benchmarkId: benchmark.benchmarkId, minimumConfidence: benchmark.minimumConfidence,
    minimumRetainedAnchorCount: benchmark.minimumRetainedAnchorCount, minimumAnchorRetentionRatio: benchmark.minimumAnchorRetentionRatio,
    comparisonRequirements: benchmark.comparisonRequirements,
    pixelBindings: benchmarkInputs.map((input) => ({ opaqueBenchmarkId: input.opaqueBenchmarkId, masterSha256: input.surfaces.master.sha256, runtimeSha256: input.surfaces.runtime.sha256 })),
  };
}

function qualifiedAnchors(opaqueInputId, anchors) {
  return anchors.map(({ anchorId, description }) => ({ anchorKey: `${opaqueInputId}:${anchorId}`, anchorId, description }));
}

function queueParentRequirements(queue) {
  if (Array.isArray(queue.allowedParentAnchors)) return queue.allowedParentAnchors;
  if (Array.isArray(queue.allowedAnchors) && queue.allowedAnchors.every((entry) => entry?.parentId && Array.isArray(entry.anchors))) return queue.allowedAnchors;
  if (Array.isArray(queue.allowedAnchors) && queue.allowedAnchors.some((entry) => entry?.parentId)) {
    const grouped = new Map();
    for (const anchor of queue.allowedAnchors) {
      if (!anchor?.parentId) fail('dependent queue anchors must all be parent-qualified');
      if (!grouped.has(anchor.parentId)) grouped.set(anchor.parentId, []);
      grouped.get(anchor.parentId).push(anchor);
    }
    return [...grouped].map(([parentId, anchors]) => ({ parentId, anchors }));
  }
  return [];
}

function reviewRequirementFor(candidate, gate, inputs, benchmarkInputs, approvedDependencies = {}, signedAuthority = {}) {
  if (gate?.schemaVersion !== 'continuity-g003-review-gate-v2' || gate.state !== 'PENDING_G003_REVIEW' || gate.completionAllowed !== false) fail('candidate review requires the locked pending G003-v3 review gate');
  const queue = gate.queueCandidates.find((entry) => entry.candidateId === candidate.candidateId);
  const edge = gate.edgeCandidates.find((entry) => entry.edgeId === candidate.candidateId);
  if ((queue ? 1 : 0) + (edge ? 1 : 0) !== 1) fail('candidate ID must resolve to exactly one locked G003 queue or edge requirement');
  const anchorSets = [];
  let reviewPolicy;
  if (queue) {
    if (candidate.child.sourceSlotId !== queue.slotId) fail('queue candidate child differs from locked G003 slot');
    const requiredParentCandidateIds = queue.requiredParentCandidateIds ?? [];
    const parentRequirements = queueParentRequirements(queue);
    if (requiredParentCandidateIds.length > 0 || parentRequirements.length > 0) {
      const requiredByParent = new Map(requiredParentCandidateIds.map((candidateId) => [candidateId.split(':').at(-1), candidateId]));
      if (requiredByParent.size !== requiredParentCandidateIds.length) fail('dependent queue candidate has duplicate generated-parent requirements');
      assertExactIds(candidate.parents.map((parent) => parent.sourceSlotId), [...new Set([...requiredByParent.keys(), ...parentRequirements.map((entry) => entry.parentId)])], 'dependent queue candidate parent coverage');
      for (const [parentIndex, parent] of candidate.parents.entries()) {
        const parentId = parent.sourceSlotId;
        const dependencyCandidateId = requiredByParent.get(parentId);
        const opaqueInputId = inputs[parentIndex + 1].opaqueInputId; const parentRole = `parent-${parentIndex + 1}`;
        if (!dependencyCandidateId) {
          if (approvedDependencies[parentId]) fail('retained queue parent must not accept generated-parent dependency evidence');
          const parentRequirement = parentRequirements.find((entry) => entry.parentId === parentId);
          if (!parentRequirement || !Array.isArray(parentRequirement.anchors) || parentRequirement.anchors.length < 2) fail(`retained queue parent ${parentId} requires at least two locked anchors`);
          anchorSets.push({ opaqueInputId, role: parentRole, approvedParentCandidateId: null, approvedParentReviewSha256: null, anchors: qualifiedAnchors(opaqueInputId, parentRequirement.anchors) });
          continue;
        }
        const dependency = approvedDependencies[parentId];
        if (!dependency) fail(`dependent queue candidate requires approved parent ${dependencyCandidateId}`);
        assertTrustedDependency(dependency, 'approved queue parent dependency');
        if (dependency.parentId !== parentId || dependency.candidateId !== dependencyCandidateId || !SHA256_PATTERN.test(dependency.reviewSha256)) fail('queue parent dependency candidate/review binding mismatch');
        assertApprovedGeneratedParentMaterial(candidate.parents[parentIndex], parentId, dependencyCandidateId, approvedDependencies, 'dependent queue parent');
        if (!Array.isArray(dependency.anchors) || dependency.anchors.length < 2) fail('approved queue parent requires review-derived anchors');
        for (const anchor of dependency.anchors) {
          assertExactKeys(anchor, ['anchorKey', 'parentId', 'anchorId', 'description', 'sourceReviewId'], 'approved queue parent anchor');
          if (anchor.parentId !== parentId || anchor.anchorKey !== `${parentId}:${anchor.anchorId}`) fail('queue parent anchor is not parent-qualified');
        }
        anchorSets.push({ opaqueInputId, role: parentRole, approvedParentCandidateId: dependency.candidateId, approvedParentReviewSha256: dependency.reviewSha256, anchors: qualifiedAnchors(opaqueInputId, dependency.anchors) });
      }
    } else {
      if (candidate.parents.length !== 1 || candidate.parents[0].sourceSlotId !== queue.slotId) {
        fail('root queue candidate requires exactly one prior-pixel parent from the same locked slot');
      }
      if (!Array.isArray(queue.allowedAnchors) || queue.allowedAnchors.some((anchor) => !anchor || typeof anchor.description !== 'string')) fail('queue candidate has unresolved/null anchor contracts');
      anchorSets.push({ opaqueInputId: inputs[0].opaqueInputId, role: 'child', approvedParentCandidateId: null, approvedParentReviewSha256: null, anchors: qualifiedAnchors(inputs[0].opaqueInputId, queue.allowedAnchors) });
    }
  } else {
    if (candidate.child.sourceSlotId !== edge.childId) fail('edge candidate child differs from locked G003 edge');
    assertExactIds(candidate.parents.map((parent) => parent.sourceSlotId), edge.allowedParentAnchors.map((entry) => entry.parentId), 'edge candidate locked parents');
    for (const parentRequirement of edge.allowedParentAnchors) {
      const parentIndex = candidate.parents.findIndex((parent) => parent.sourceSlotId === parentRequirement.parentId);
      const opaqueInputId = inputs[parentIndex + 1].opaqueInputId;
      const dependencyCandidate = gate.queueCandidates.find((entry) => entry.slotId === parentRequirement.parentId);
      if (dependencyCandidate) {
        const dependency = approvedDependencies[parentRequirement.parentId];
        if (!dependency) fail(`generated parent ${parentRequirement.parentId} requires approved candidate/review evidence before child packaging`);
        assertTrustedDependency(dependency, 'approved generated parent dependency');
        if (dependency.parentId !== parentRequirement.parentId || dependency.candidateId !== dependencyCandidate.candidateId || !SHA256_PATTERN.test(dependency.reviewSha256)) fail('generated parent dependency candidate/review binding mismatch');
        assertApprovedGeneratedParentMaterial(candidate.parents[parentIndex], parentRequirement.parentId, dependencyCandidate.candidateId, approvedDependencies, 'generated edge parent');
        if (!Array.isArray(dependency.anchors) || dependency.anchors.length < 2) fail('approved generated parent requires review-derived anchors');
        for (const anchor of dependency.anchors) {
          assertExactKeys(anchor, ['anchorKey', 'parentId', 'anchorId', 'description', 'sourceReviewId'], 'generated parent review anchor');
          if (anchor.parentId !== dependency.parentId || anchor.anchorKey !== `${anchor.parentId}:${anchor.anchorId}`) fail('generated parent anchor is not parent-qualified');
        }
        anchorSets.push({ opaqueInputId, role: `parent-${parentIndex + 1}`, approvedParentCandidateId: dependency.candidateId, approvedParentReviewSha256: dependency.reviewSha256, anchors: qualifiedAnchors(opaqueInputId, dependency.anchors) });
      } else {
        if (approvedDependencies[parentRequirement.parentId]) fail('retained parent must not accept generated-parent dependency evidence');
        anchorSets.push({ opaqueInputId, role: `parent-${parentIndex + 1}`, approvedParentCandidateId: null, approvedParentReviewSha256: null, anchors: qualifiedAnchors(opaqueInputId, parentRequirement.anchors) });
      }
    }
  }
  const assignment = signedAuthority.assignment?.assignments?.find((entry) => entry.slotId === candidate.child.sourceSlotId);
  const canonicalTarget = signedAuthority.canonicalTargets?.byRootId?.get(candidate.child.sourceSlotId);
  const canonicalRootShape = Boolean(queue)
    && (queue.requiredParentCandidateIds ?? []).length === 0
    && queueParentRequirements(queue).length === 0
    && candidate.parents.length === 1
    && candidate.parents[0].sourceSlotId === queue.slotId;
  const canonicalMode = G002_V2_EFFECTIVE_ROOT_IDS.includes(candidate.child.sourceSlotId)
    || queue?.allowedAnchors?.some((anchor) => anchor?.resolutionState === 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET');
  if (canonicalMode) {
    if (!canonicalRootShape || assignment?.targetEvidence?.targetSource !== G002_V2_TARGET_SOURCE
        || assignment?.targetEvidence?.canonicalContractOutputSha256 == null || canonicalTarget == null
        || !G002_V2_EFFECTIVE_ROOT_IDS.includes(candidate.child.sourceSlotId)
        || assignment.targetEvidence.canonicalContractOutputSha256 !== signedAuthority.canonicalTargets.outputSha256
        || canonicalStringify(assignment.targetTaxonomy) !== canonicalStringify(canonicalTarget.canonicalTarget)
        || queue.allowedAnchors.length !== canonicalTarget.anchors.length
        || queue.allowedAnchors.some((anchor) => anchor.sourceReviewId !== `canonical-root-redesign:${queue.slotId}`
          || anchor.resolutionState !== 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET'
          || canonicalStringify({ anchorId: anchor.anchorId, description: anchor.description })
            !== canonicalStringify(canonicalTarget.anchors.find((expected) => expected.anchorId === anchor.anchorId)))) {
      fail('canonical-root replacement policy requires the complete exact signed G002 canonical contract');
    }
    reviewPolicy = {
      assessmentMode: 'canonical-root-replacement', continuitySubject: 'signed-canonical-root-contract',
      taxonomyTargetSource: G002_V2_TARGET_SOURCE,
      requiredChildTaxonomy: Object.fromEntries(CANONICAL_TARGET_FIELDS.map((field) => [field, canonicalTarget.canonicalTarget[field]])),
      canonicalContractOutputSha256: signedAuthority.canonicalTargets.outputSha256,
      canonicalEffectiveAuthoritySha256: G003_AUTHORITY.effectiveAuthoritySha256, historicalParentPixelsOnly: true,
      visibilityPolicy: structuredClone(signedAuthority.canonicalTargets.visibilityPolicy),
      clarificationRequirements: structuredClone(canonicalTarget.clarificationRequirements),
    };
  } else {
    if (canonicalTarget != null || queue?.allowedAnchors?.some((anchor) => anchor?.resolutionState === 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET')) fail('partial canonical-root policy signals are forbidden');
    reviewPolicy = {
      assessmentMode: 'same-creature-continuity', continuitySubject: 'prior-parent-pixels',
      taxonomyTargetSource: assignment?.targetEvidence?.targetSource ?? 'signed-g002-assignment',
      requiredChildTaxonomy: Object.fromEntries(CANONICAL_TARGET_FIELDS.map((field) => [field, assignment?.targetTaxonomy?.[field]])),
      canonicalContractOutputSha256: null, canonicalEffectiveAuthoritySha256: null, historicalParentPixelsOnly: false, visibilityPolicy: null, clarificationRequirements: [],
    };
    if (Object.values(reviewPolicy.requiredChildTaxonomy).some((value) => typeof value !== 'string' || !value)) fail('strict continuity policy lacks exact signed child taxonomy');
  }
  return {
    schemaVersion: 'continuity-candidate-locked-review-contract-v4', protocolAuthoritySha256:G003_PROTOCOL_AUTHORITY_SHA256, requirementType: queue ? 'queue' : 'edge',
    reviewPolicy, anchorSets, eiluBenchmark: blindedEiluBenchmark(gate.eiluBenchmark, benchmarkInputs),
    comparisonThresholds: (queue ?? edge).comparisonThresholds,
  };
}

function unsignedBinding(binding) {
  const value = structuredClone(binding); delete value.conductorHmacSha256; return value;
}

export function candidateMaterialBindingSha256(binding) {
  return sha256Canonical(unsignedBinding(binding));
}

function unsignedVote(vote) {
  const value = structuredClone(vote); delete value.outputSha256; delete value.conductorHmacSha256; return value;
}

export function finalizeCandidateVote(vote, conductorKey) {
  assertGenerationRunId(vote?.generationRunId, 'candidate vote generationRunId');
  const key = requireConductorKey(conductorKey); const result = structuredClone(vote);
  delete result.outputSha256; delete result.conductorHmacSha256;
  result.outputSha256 = sha256Canonical(result);
  result.conductorHmacSha256 = hmac(VOTE_HMAC_DOMAIN, key, result.outputSha256);
  return result;
}

async function materializeCandidatePackageInternal(candidate, {
  repoRoot = REPO_ROOT, conductorKey, reviewGate, approvedDependencies = {}, enforceMaterialAuthority,
} = {}) {
  assertMaterialDescriptor(candidate);
  const key = requireConductorKey(conductorKey);
  let lockedGate; let pixelClusters; let assignment; let canonicalTargets;
  if (enforceMaterialAuthority) {
    ({ lockedGate, pixelClusters, assignment, canonicalTargets } = await verifyCandidateMaterializationAuthority(candidate, { repoRoot, reviewGate, approvedDependencies }));
  } else {
    assignment = await readJson(repoRoot, ASSIGNMENT_PATH);
    lockedGate = reviewGate ?? assignment.reviewCoverageManifest;
    pixelClusters = await readJson(repoRoot, PIXEL_CLUSTERS_PATH);
    const canonicalValue = await readJson(repoRoot, CANONICAL_TARGETS_PATH);
    const resolved=await resolveG002V2Authority(canonicalValue,{repoRoot});canonicalTargets={byRootId:resolved.byRootId,outputSha256:resolved.outputSha256,targetSource:resolved.targetSource,visibilityPolicy:structuredClone(canonicalValue.visibilityPolicy)};
  }
  const descriptorSha256 = sha256Canonical(candidate);
  const opaqueCandidateId = g003V4OpaqueId('candidate',{descriptorSha256,reviewProtocol:REVIEW_PROTOCOL});
  const outputRelative = `${PRIVATE_CANDIDATE_ROOT}/${opaqueCandidateId}`;
  const outputRoot = path.join(repoRoot, outputRelative);
  const reviewerRoot = path.join(outputRoot, 'reviewer-package');
  const inputs = [];
  const materials = [
    { role: 'child', material: candidate.child },
    ...candidate.parents.map((material, index) => ({ role: `parent-${index + 1}`, material })),
  ];
  const seenAssetHashes = new Set();
  for (const { role, material } of materials) {
    const opaqueInputId = `${role}-${sha256Canonical({ opaqueCandidateId, role, hashes: MATERIAL_ROLES.map((surface) => material[surface].sha256) }).slice(0, 20)}`;
    const surfaces = {};
    for (const surface of MATERIAL_ROLES) {
      const source = material[surface];
      const bytes = await readContainedFile(repoRoot, source.path, `${role} ${surface}`);
      if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail(`${role} ${surface} material is not a PNG`);
      const actual = sha256Bytes(bytes);
      if (actual !== source.sha256) fail(`${role} ${surface} material hash is stale`);
      if (seenAssetHashes.has(actual)) fail(`candidate material reuses duplicate PNG bytes: ${actual}`);
      seenAssetHashes.add(actual);
      const packagePath = `inputs/${opaqueInputId}/${surface}.png`;
      await writeFileAtomicNoFollow(path.join(reviewerRoot, packagePath), bytes, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set(['master.png', 'runtime.png']) });
      surfaces[surface] = { path: packagePath, sha256: actual };
    }
    inputs.push({ opaqueInputId, role, surfaces });
  }
  const benchmarkInputs = [];
  for (const pixelBinding of lockedGate.eiluBenchmark.pixelBindings) {
    const sourceEntry = pixelClusters.entries.find((entry) => entry.pgId === pixelBinding.pgId);
    if (!sourceEntry) fail('Eilu positive-control stage is absent from public pixel clusters');
    const opaqueBenchmarkId = `benchmark-${sha256Canonical({ masterSha256: pixelBinding.masterSha256, runtimeSha256: pixelBinding.runtimeSha256 }).slice(0, 20)}`;
    const surfaces = {};
    for (const surface of MATERIAL_ROLES) {
      const source = sourceEntry.surfaces[surface];
      const expectedSha256 = pixelBinding[`${surface}Sha256`];
      const bytes = await readContainedFile(repoRoot, source.path, `Eilu ${surface}`);
      if (sha256Bytes(bytes) !== expectedSha256 || source.sha256 !== expectedSha256) fail('Eilu positive-control pixel binding drift');
      const packagePath = `benchmarks/${opaqueBenchmarkId}/${surface}.png`;
      await writeFileAtomicNoFollow(path.join(reviewerRoot, packagePath), bytes, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set(['master.png', 'runtime.png']) });
      surfaces[surface] = { path: packagePath, sha256: expectedSha256 };
    }
    benchmarkInputs.push({ opaqueBenchmarkId, surfaces });
  }
  if (benchmarkInputs.length !== lockedGate.eiluBenchmark.pixelBindings.length || benchmarkInputs.length < 3) fail('candidate package lacks complete Eilu positive-control stages');
  const reviewContract = reviewRequirementFor(candidate, lockedGate, inputs, benchmarkInputs, approvedDependencies, { assignment, canonicalTargets });
  const allowlistInputs = [...inputs.map((input) => ({ id: input.opaqueInputId, surfaces: input.surfaces })), ...benchmarkInputs.map((input) => ({ id: input.opaqueBenchmarkId, surfaces: input.surfaces }))];
  const allowlist = { schemaVersion: 'continuity-candidate-allowlist-v4', protocolAuthoritySha256:G003_PROTOCOL_AUTHORITY_SHA256, opaqueCandidateId, files: allowlistInputs.flatMap((input) => MATERIAL_ROLES.map((surface) => ({ path: input.surfaces[surface].path, sha256: input.surfaces[surface].sha256 }))).sort((a, b) => a.path.localeCompare(b.path)) };
  const promptBytes = promptFor(candidate.parents.length, reviewContract);
  const allowlistSha256 = sha256Canonical(allowlist); const promptSha256 = sha256Bytes(promptBytes);
  const packageManifest = {
    schemaVersion: 'continuity-candidate-package-v4', protocolAuthoritySha256:G003_PROTOCOL_AUTHORITY_SHA256, opaqueCandidateId, reviewKind: candidate.reviewKind,
    generationRunId: candidate.generationRunId, parentCount: candidate.parents.length, allowlistSha256, promptSha256, inputs, benchmarkInputs, reviewContract,
  };
  const packageManifestSha256 = sha256Canonical(packageManifest);
  const binding = {
    schemaVersion: 'continuity-candidate-material-binding-v4', protocolAuthoritySha256:G003_PROTOCOL_AUTHORITY_SHA256, candidateId: candidate.candidateId, opaqueCandidateId,
    generationRunId: candidate.generationRunId, reviewKind: candidate.reviewKind, descriptorSha256,
    packageManifestSha256, allowlistSha256, promptSha256,
    child: { sourceSlotId: candidate.child.sourceSlotId, opaqueInputId: inputs[0].opaqueInputId, surfaces: inputs[0].surfaces },
    parents: candidate.parents.map((parent, index) => ({ sourceSlotId: parent.sourceSlotId, opaqueInputId: inputs[index + 1].opaqueInputId, surfaces: inputs[index + 1].surfaces })), reviewContract,
  };
  binding.conductorHmacSha256 = hmac(BINDING_HMAC_DOMAIN, key, sha256Canonical(binding));
  await writeCanonicalFile(path.join(reviewerRoot, 'allowlist.json'), allowlist, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set(['allowlist.json']) });
  await writeFileAtomicNoFollow(path.join(reviewerRoot, 'prompt.txt'), promptBytes, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set(['prompt.txt']) });
  await writeCanonicalFile(path.join(reviewerRoot, 'package-manifest.json'), packageManifest, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set(['package-manifest.json']) });
  await writeCanonicalFile(path.join(outputRoot, 'private-binding.json'), binding, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set(['private-binding.json']) });
  return { outputRelative, opaqueCandidateId, binding, packageManifest, allowlist };
}

export async function verifyCandidateMaterializationAuthority(candidate, {
  repoRoot = REPO_ROOT, reviewGate, approvedDependencies = {},
} = {}) {
  assertMaterialDescriptor(candidate);
  const authority = await loadSignedMaterialAuthority(repoRoot, reviewGate);
  await assertAuthoritativeCandidateMaterials(candidate, authority.lockedGate, authority.pixelClusters, approvedDependencies, repoRoot);
  return authority;
}

export async function materializeCandidatePackage(candidate, options = {}) {
  return materializeCandidatePackageInternal(candidate, { ...options, enforceMaterialAuthority: true });
}

// Test-only seam for synthetic review-contract fixtures. Production CLIs and
// the G003 conductor always call materializeCandidatePackage above.
export async function materializeCandidatePackageFixture(candidate, options = {}) {
  if (typeof options.repoRoot !== 'string' || !options.repoRoot) fail('candidate package fixture requires an explicit temporary repoRoot');
  const [temporaryRoot, fixtureRoot, productionRoot] = await Promise.all([realpath(os.tmpdir()), realpath(options.repoRoot), realpath(REPO_ROOT)]);
  const relation = path.relative(temporaryRoot, fixtureRoot);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation) || fixtureRoot === productionRoot) {
    fail('candidate package fixture repoRoot must be a non-production directory beneath the current temporary directory');
  }
  return materializeCandidatePackageInternal(candidate, { ...options, enforceMaterialAuthority: false });
}

async function loadAndVerifyPackage(repoRoot, packageRelative, conductorKey) {
  assertCanonicalRelativePath(packageRelative, 'candidate package root');
  if (!packageRelative.startsWith(`${PRIVATE_CANDIDATE_ROOT}/`)) fail('candidate package is outside the private evidence root');
  const binding = await readJson(repoRoot, `${packageRelative}/private-binding.json`);
  assertExactKeys(binding, ['schemaVersion','protocolAuthoritySha256', 'candidateId', 'opaqueCandidateId', 'generationRunId', 'reviewKind', 'descriptorSha256', 'packageManifestSha256', 'allowlistSha256', 'promptSha256', 'child', 'parents', 'reviewContract', 'conductorHmacSha256'], 'candidate material binding');
  if (binding.schemaVersion !== 'continuity-candidate-material-binding-v4'||binding.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256) fail('candidate material binding must use review protocol v4 authority');
  assertGenerationRunId(binding?.generationRunId, 'candidate material binding generationRunId');
  const key = requireConductorKey(conductorKey);
  if (binding.conductorHmacSha256 !== hmac(BINDING_HMAC_DOMAIN, key, sha256Canonical(unsignedBinding(binding)))) fail('candidate material binding HMAC verification failed');
  const reviewerRelative = `${packageRelative}/reviewer-package`;
  const [packageManifest, allowlist, promptBytes] = await Promise.all([
    readJson(repoRoot, `${reviewerRelative}/package-manifest.json`), readJson(repoRoot, `${reviewerRelative}/allowlist.json`), readContainedFile(repoRoot, `${reviewerRelative}/prompt.txt`),
  ]);
  assertExactKeys(allowlist,['schemaVersion','protocolAuthoritySha256','opaqueCandidateId','files'],'candidate allowlist');if(allowlist.schemaVersion!=='continuity-candidate-allowlist-v4'||allowlist.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256||allowlist.opaqueCandidateId!==binding.opaqueCandidateId)fail('candidate allowlist must use protocol v4 authority');
  assertExactKeys(packageManifest, ['schemaVersion','protocolAuthoritySha256', 'opaqueCandidateId', 'reviewKind', 'generationRunId', 'parentCount', 'allowlistSha256', 'promptSha256', 'inputs', 'benchmarkInputs', 'reviewContract'], 'candidate package manifest');
  if (packageManifest.schemaVersion !== 'continuity-candidate-package-v4'||packageManifest.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256) fail('candidate package must use review protocol v4 authority');
  assertGenerationRunId(packageManifest?.generationRunId, 'candidate package manifest generationRunId');
  if (packageManifest.generationRunId !== binding.generationRunId) fail('candidate package generationRunId differs from private binding');
  if (binding.reviewContract?.schemaVersion !== 'continuity-candidate-locked-review-contract-v4'||binding.reviewContract?.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256
      || packageManifest.reviewContract?.schemaVersion !== 'continuity-candidate-locked-review-contract-v4'||packageManifest.reviewContract?.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256) fail('candidate locked review contract must use protocol v4 authority');
  assertReviewPolicy(binding.reviewContract.reviewPolicy);
  if (sha256Canonical(packageManifest) !== binding.packageManifestSha256 || sha256Canonical(allowlist) !== binding.allowlistSha256
      || sha256Bytes(promptBytes) !== binding.promptSha256 || !promptBytes.equals(promptFor(binding.parents.length, binding.reviewContract))) fail('candidate package manifest/allowlist/prompt hash drift');
  if (canonicalStringify(packageManifest.reviewContract) !== canonicalStringify(binding.reviewContract)) fail('candidate locked review contract differs from private binding');
  const expectedPaths = [...packageManifest.inputs, ...packageManifest.benchmarkInputs].flatMap((input) => MATERIAL_ROLES.map((surface) => input.surfaces[surface].path)).sort();
  assertExactIds(allowlist.files.map((file) => file.path), expectedPaths, 'candidate package allowlist');
  const expectedPackageFiles = [...expectedPaths, 'allowlist.json', 'package-manifest.json', 'prompt.txt'].sort();
  assertExactIds(await listContainedRegularFiles(repoRoot, reviewerRelative), expectedPackageFiles, 'candidate reviewer package files');
  for (const file of allowlist.files) {
    const bytes = await readContainedFile(repoRoot, `${reviewerRelative}/${file.path}`);
    if (sha256Bytes(bytes) !== file.sha256) fail(`candidate package material hash drift: ${file.path}`);
  }
  const manifestInputs = new Map(packageManifest.inputs.map((input) => [input.opaqueInputId, input]));
  for (const material of [binding.child, ...binding.parents]) {
    const input = manifestInputs.get(material.opaqueInputId);
    if (!input || MATERIAL_ROLES.some((surface) => input.surfaces[surface].sha256 !== material.surfaces[surface].sha256)) fail('candidate private material binding differs from reviewer package');
  }
  return { binding, packageManifest, allowlist };
}

function taxonomyTuple(value) {
  return CANONICAL_TARGET_FIELDS.map((field) => value?.[field]);
}

function assertReviewPolicy(policy) {
  assertExactKeys(policy, ['assessmentMode', 'continuitySubject', 'taxonomyTargetSource', 'requiredChildTaxonomy', 'canonicalContractOutputSha256', 'canonicalEffectiveAuthoritySha256', 'historicalParentPixelsOnly', 'visibilityPolicy', 'clarificationRequirements'], 'candidate review policy');
  assertExactKeys(policy.requiredChildTaxonomy, CANONICAL_TARGET_FIELDS, 'candidate policy child taxonomy');
  if (Object.values(policy.requiredChildTaxonomy).some((value) => typeof value !== 'string' || !value || value.startsWith('unknown'))
      || typeof policy.taxonomyTargetSource !== 'string' || !policy.taxonomyTargetSource) fail('candidate review policy lacks exact signed taxonomy');
  if (policy.assessmentMode === 'canonical-root-replacement') {
    assertExactKeys(policy.visibilityPolicy, ['surfaceRequirement', 'appendageCountingRule', 'ambiguityRule', 'preservationRule'], 'candidate canonical visibility policy');
    if (policy.continuitySubject !== 'signed-canonical-root-contract' || policy.taxonomyTargetSource !== G002_V2_TARGET_SOURCE
        || !SHA256_PATTERN.test(policy.canonicalContractOutputSha256 ?? '') || policy.canonicalEffectiveAuthoritySha256 !== G003_AUTHORITY.effectiveAuthoritySha256 || policy.historicalParentPixelsOnly !== true
        || policy.visibilityPolicy.surfaceRequirement !== 'master-and-runtime-independently-satisfy-canonical-tuple-and-all-three-anchors'
        || policy.visibilityPolicy.appendageCountingRule !== 'count-visible-appendages-only'
        || policy.visibilityPolicy.ambiguityRule !== 'hidden-merged-or-double-readable-is-block'
        || policy.visibilityPolicy.preservationRule !== 'preserve-anchor-shape-relative-placement-and-color-role'
        || !Array.isArray(policy.clarificationRequirements) || policy.clarificationRequirements.length < 2
        || new Set(policy.clarificationRequirements).size !== policy.clarificationRequirements.length
        || policy.clarificationRequirements.some((value) => typeof value !== 'string' || value.length < 8)) fail('candidate canonical review policy is malformed');
  } else if (policy.assessmentMode !== 'same-creature-continuity' || policy.continuitySubject !== 'prior-parent-pixels'
      || policy.canonicalContractOutputSha256 !== null || policy.canonicalEffectiveAuthoritySha256 !== null || policy.historicalParentPixelsOnly !== false
      || policy.visibilityPolicy !== null || !Array.isArray(policy.clarificationRequirements) || policy.clarificationRequirements.length !== 0) fail('candidate strict continuity review policy is malformed');
}

function validateCandidateObservationCore(vote, context) {
  assertExactKeys(vote.observation, ['assessmentMode', 'childTaxonomy', 'parentObservations', 'canonicalAssessment', 'requiredAnchorEvidence', 'eiluComparison'], 'candidate observation');
  if (vote.observation.assessmentMode !== context.binding.reviewContract.reviewPolicy.assessmentMode) fail('candidate observation assessment mode differs from signed review policy');
  assertExactKeys(vote.observation.childTaxonomy, CANONICAL_TARGET_FIELDS, 'candidate child taxonomy');
  const childTuple = taxonomyTuple(vote.observation.childTaxonomy);
  if (childTuple.some((value) => typeof value !== 'string' || !value || value.startsWith('unknown'))) fail('candidate vote child taxonomy is not exact');
  const policy = context.binding.reviewContract.reviewPolicy;
  if (canonicalStringify(vote.observation.childTaxonomy) !== canonicalStringify(policy.requiredChildTaxonomy)) fail('candidate child taxonomy differs from signed review policy');
  if (policy.assessmentMode === 'canonical-root-replacement') {
    if (!Array.isArray(vote.observation.parentObservations) || vote.observation.parentObservations.length !== 0) fail('canonical-root replacement must not submit parent continuity observations');
    assertExactKeys(vote.observation.canonicalAssessment, ['matchesRequiredCanonicalTarget', 'historicalParentComparisonRequired', 'surfaceAssessments'], 'candidate canonical assessment');
    if (vote.observation.canonicalAssessment.matchesRequiredCanonicalTarget !== 'yes'
        || vote.observation.canonicalAssessment.historicalParentComparisonRequired !== false
        || policy.continuitySubject !== 'signed-canonical-root-contract' || policy.historicalParentPixelsOnly !== true
        || policy.taxonomyTargetSource !== G002_V2_TARGET_SOURCE || policy.canonicalEffectiveAuthoritySha256 !== G003_AUTHORITY.effectiveAuthoritySha256
        || !SHA256_PATTERN.test(policy.canonicalContractOutputSha256 ?? '')) {
      fail('candidate canonical-root assessment does not satisfy the signed replacement policy');
    }
    const childAnchorSet = context.binding.reviewContract.anchorSets.find((entry) => entry.role === 'child');
    const requiredAnchorIds = childAnchorSet?.anchors?.map((anchor) => anchor.anchorId) ?? [];
    if (requiredAnchorIds.length !== 3 || new Set(requiredAnchorIds).size !== 3) fail('candidate canonical-root policy lacks exactly three signed child anchors');
    const surfaces = vote.observation.canonicalAssessment.surfaceAssessments;
    if (!Array.isArray(surfaces) || surfaces.length !== 2 || new Set(surfaces.map((entry) => entry.surface)).size !== 2
        || !surfaces.some((entry) => entry.surface === 'master') || !surfaces.some((entry) => entry.surface === 'runtime')) fail('candidate canonical assessment must independently cover master and runtime');
    for (const surface of surfaces) {
      assertExactKeys(surface, ['surface', 'matchesRequiredTaxonomy', 'anchorAssessments', 'satisfiedClarificationRequirements', 'visibleAppendageCountsComply', 'hiddenMergedOrDoubleReadableAmbiguity'], `candidate canonical ${surface.surface} assessment`);
      if (!['master', 'runtime'].includes(surface.surface) || surface.matchesRequiredTaxonomy !== 'yes'
          || surface.visibleAppendageCountsComply !== true || surface.hiddenMergedOrDoubleReadableAmbiguity !== false
          || !Array.isArray(surface.anchorAssessments) || surface.anchorAssessments.length !== 3
          || !Array.isArray(surface.satisfiedClarificationRequirements)
          || canonicalStringify([...surface.satisfiedClarificationRequirements].sort()) !== canonicalStringify([...policy.clarificationRequirements].sort())) fail(`candidate canonical ${surface.surface} visibility/clarification assessment failed`);
      const observedAnchorIds = surface.anchorAssessments.map((entry) => entry.anchorId);
      assertExactIds(observedAnchorIds, requiredAnchorIds, `candidate canonical ${surface.surface} anchor assessments`);
      for (const anchor of surface.anchorAssessments) {
        assertExactKeys(anchor, ['anchorId', 'shapeRelativePlacementAndColorRolePreserved', 'observation'], `candidate canonical ${surface.surface} anchor`);
        if (anchor.shapeRelativePlacementAndColorRolePreserved !== 'yes' || typeof anchor.observation !== 'string' || !anchor.observation.trim()) fail(`candidate canonical ${surface.surface} anchor visibility failed`);
      }
    }
  } else {
    if (vote.observation.canonicalAssessment !== null) fail('strict continuity vote must not claim a canonical-root assessment');
    if (!Array.isArray(vote.observation.parentObservations) || vote.observation.parentObservations.length !== context.binding.parents.length) fail('candidate vote parent coverage mismatch');
    assertExactIds(vote.observation.parentObservations.map((parent) => parent.opaqueParentId), context.binding.parents.map((parent) => parent.opaqueInputId), 'candidate vote parents');
    for (const parent of vote.observation.parentObservations) {
      assertExactKeys(parent, ['opaqueParentId', 'taxonomy', 'sameCreatureGrownUp', 'inheritedAnchorIds', 'perAnchorEvidence'], 'candidate parent observation');
      assertExactKeys(parent.taxonomy, CANONICAL_TARGET_FIELDS, 'candidate parent taxonomy');
      if (parent.sameCreatureGrownUp !== 'yes' || JSON.stringify(taxonomyTuple(parent.taxonomy)) !== JSON.stringify(childTuple)) fail('candidate parent is not exact-taxonomy same-creature continuity');
      const minimum = context.binding.parents.length === 2 ? 2 : 3;
      if (!Array.isArray(parent.inheritedAnchorIds) || new Set(parent.inheritedAnchorIds).size !== parent.inheritedAnchorIds.length || parent.inheritedAnchorIds.length < minimum) fail(`candidate parent requires ${minimum} distinct inherited anchors`);
      if (!Array.isArray(parent.perAnchorEvidence)) fail('candidate parent lacks per-anchor evidence');
      for (const entry of parent.perAnchorEvidence) {
        assertExactKeys(entry, ['anchorKey', 'anchorId', 'observation'], 'candidate parent anchor evidence');
        if (entry.anchorKey !== `${parent.opaqueParentId}:${entry.anchorId}`) fail('candidate parent anchor evidence key is not parent-qualified');
      }
      const prefix = `${parent.opaqueParentId}:`;
      if (parent.inheritedAnchorIds.some((anchorKey) => typeof anchorKey !== 'string' || !anchorKey.startsWith(prefix))) fail('candidate parent anchors must use parent-qualified keys');
      const evidence = new Map(parent.perAnchorEvidence.map((entry) => [entry.anchorKey, entry.observation]));
      if (evidence.size !== parent.perAnchorEvidence.length || parent.inheritedAnchorIds.some((anchorKey) => typeof evidence.get(anchorKey) !== 'string' || !evidence.get(anchorKey))) fail('candidate parent anchor evidence is missing or duplicated');
    }
  }
  if (!Array.isArray(vote.observation.requiredAnchorEvidence) || vote.observation.requiredAnchorEvidence.length !== context.binding.reviewContract.anchorSets.length) fail('candidate required anchor evidence coverage mismatch');
  const submittedSets = new Map(vote.observation.requiredAnchorEvidence.map((entry) => [entry.opaqueInputId, entry]));
  if (submittedSets.size !== vote.observation.requiredAnchorEvidence.length) fail('candidate required anchor evidence duplicates an input');
  for (const requiredSet of context.binding.reviewContract.anchorSets) {
    const submitted = submittedSets.get(requiredSet.opaqueInputId);
    assertExactKeys(submitted, ['opaqueInputId', 'anchors'], 'candidate required anchor set');
    if (!Array.isArray(submitted.anchors) || submitted.anchors.length !== requiredSet.anchors.length) fail('candidate required anchor count mismatch');
    const submittedAnchors = new Map(submitted.anchors.map((anchor) => [anchor.anchorId, anchor]));
    if (submittedAnchors.size !== submitted.anchors.length) fail('candidate required anchors are duplicated');
    for (const required of requiredSet.anchors) {
      const actual = submittedAnchors.get(required.anchorId);
      assertExactKeys(actual, ['anchorKey', 'anchorId', 'requiredDescription', 'observation'], 'candidate required anchor evidence');
      if (actual.anchorKey !== required.anchorKey || actual.requiredDescription !== required.description || typeof actual.observation !== 'string' || !actual.observation.trim()) fail('candidate required anchor tuple/description/evidence differs from locked queue');
    }
    assertExactIds([...submittedAnchors.keys()], requiredSet.anchors.map((anchor) => anchor.anchorId), 'candidate locked anchor IDs');
  }
  const comparison = vote.observation.eiluComparison; const benchmark = context.binding.reviewContract.eiluBenchmark;
  assertExactKeys(comparison, ['benchmarkId', 'sameCreatureGrownUp', 'stageObservations', 'candidateContinuityScore', 'retainedAnchorCount', 'anchorRetentionRatio'], 'candidate Eilu comparison');
  if (comparison.benchmarkId !== benchmark.benchmarkId || comparison.sameCreatureGrownUp !== 'yes' || vote.confidence < benchmark.minimumConfidence
      || comparison.candidateContinuityScore < benchmark.minimumConfidence || comparison.retainedAnchorCount < benchmark.minimumRetainedAnchorCount
      || comparison.anchorRetentionRatio < benchmark.minimumAnchorRetentionRatio || !Array.isArray(comparison.stageObservations)) fail('candidate does not satisfy locked Eilu benchmark thresholds');
  const stageMap = new Map(comparison.stageObservations.map((entry) => [entry.opaqueBenchmarkId, entry]));
  if (stageMap.size !== comparison.stageObservations.length || stageMap.size !== benchmark.pixelBindings.length) fail('candidate Eilu stage coverage mismatch');
  for (const expected of benchmark.pixelBindings) {
    const actual = stageMap.get(expected.opaqueBenchmarkId);
    assertExactKeys(actual, ['opaqueBenchmarkId', 'masterSha256', 'runtimeSha256', 'continuityScore', 'observation'], 'candidate Eilu stage observation');
    if (actual.masterSha256 !== expected.masterSha256 || actual.runtimeSha256 !== expected.runtimeSha256 || actual.continuityScore < benchmark.minimumConfidence
        || typeof actual.observation !== 'string' || !actual.observation.trim()) fail('candidate Eilu observation is not bound to supplied positive-control pixels/score');
  }
}

function validateVote(vote, context, conductorKey) {
  assertExactKeys(vote, ['schemaVersion','protocolAuthoritySha256', 'reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber', 'role', 'fresh', 'blinded', 'opaqueCandidateId', 'generationRunId', 'packageManifestSha256', 'materialBindingSha256', 'inputAllowlistSha256', 'promptSha256', 'inputAssetSha256s', 'assignmentManifestSha256', 'reviewerRunAttestationSha256', 'rawObservationSha256', 'observation', 'confidence', 'outputSha256', 'conductorHmacSha256'], 'candidate vote');
  assertGenerationRunId(vote.generationRunId, 'candidate vote generationRunId');
  if (vote.schemaVersion !== 'continuity-candidate-primary-vote-v4'||vote.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256 || vote.role !== 'primary' || ![1, 2].includes(vote.passNumber)
      || vote.fresh !== true || vote.blinded !== true || !Number.isFinite(vote.confidence) || vote.confidence < 0.85 || vote.confidence > 1) fail('candidate vote role/freshness/confidence is invalid');
  for (const field of ['reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) if (!vote[field]) fail(`candidate vote lacks ${field}`);
  const bindingSha256 = candidateMaterialBindingSha256(context.binding);
  if (vote.opaqueCandidateId !== context.binding.opaqueCandidateId || vote.generationRunId !== context.binding.generationRunId
      || vote.packageManifestSha256 !== context.binding.packageManifestSha256 || vote.materialBindingSha256 !== bindingSha256
      || vote.inputAllowlistSha256 !== context.binding.allowlistSha256 || vote.promptSha256 !== context.binding.promptSha256) fail('candidate vote provenance differs from material package');
  for (const field of ['assignmentManifestSha256', 'reviewerRunAttestationSha256', 'rawObservationSha256']) if (!SHA256_PATTERN.test(vote[field])) fail(`candidate vote lacks ${field}`);
  const expectedHashes = context.allowlist.files.map((file) => file.sha256).sort();
  if (JSON.stringify([...vote.inputAssetSha256s].sort()) !== JSON.stringify(expectedHashes)) fail('candidate vote input asset hash set differs from allowlist');
  const unsigned = unsignedVote(vote);
  if (vote.outputSha256 !== sha256Canonical(unsigned) || vote.conductorHmacSha256 !== hmac(VOTE_HMAC_DOMAIN, requireConductorKey(conductorKey), vote.outputSha256)) fail('candidate vote output hash/HMAC verification failed');
  validateCandidateObservationCore(vote, context);
}

export async function verifyCandidatePackageContext({ repoRoot = REPO_ROOT, packageRelative, conductorKey } = {}) {
  return loadAndVerifyPackage(repoRoot, packageRelative, conductorKey);
}

export async function validateRawCandidateObservation(observation, confidence, { repoRoot = REPO_ROOT, packageRelative, conductorKey } = {}) {
  const context = await loadAndVerifyPackage(repoRoot, packageRelative, conductorKey);
  if (!Number.isFinite(confidence) || confidence < 0.96 || confidence > 1) fail('raw candidate observation confidence is invalid');
  validateCandidateObservationCore({ observation, confidence }, context);
  return context;
}

export function validateCandidateObservationAgainstBinding(observation, confidence, binding) {
  validateCandidateObservationCore({ observation, confidence }, { binding });
  return true;
}

// Test-only alias. Production authority paths must use
// validateRawCandidateObservation so the private package HMAC is verified first.
export const validateCandidateObservationFixture = validateCandidateObservationAgainstBinding;

export async function validateCandidateReview(review, { repoRoot = REPO_ROOT, packageRelative, conductorKey, persistedReviewRelative = null } = {}) {
  assertExactKeys(review, ['schemaVersion','protocolAuthoritySha256', 'opaqueCandidateId', 'generationRunId', 'reviewKind', 'packageManifestSha256', 'materialBindingSha256', 'inputAllowlistSha256', 'promptSha256', 'votes'], 'candidate review');
  assertGenerationRunId(review.generationRunId, 'candidate review generationRunId');
  if (review.schemaVersion !== 'continuity-candidate-review-v4'||review.protocolAuthoritySha256!==G003_PROTOCOL_AUTHORITY_SHA256 || !Array.isArray(review.votes) || review.votes.length !== 2) fail('candidate review requires review protocol v4 authority and exactly two primary votes');
  const context = await loadAndVerifyPackage(repoRoot, packageRelative, conductorKey);
  const expectedReview = {
    opaqueCandidateId: context.binding.opaqueCandidateId, generationRunId: context.binding.generationRunId, reviewKind: context.binding.reviewKind,
    packageManifestSha256: context.binding.packageManifestSha256, materialBindingSha256: candidateMaterialBindingSha256(context.binding),
    inputAllowlistSha256: context.binding.allowlistSha256, promptSha256: context.binding.promptSha256,
  };
  for (const [field, expected] of Object.entries(expectedReview)) if (review[field] !== expected) fail(`candidate review ${field} differs from material binding`);
  for (const vote of review.votes) validateVote(vote, context, conductorKey);
  for (const field of ['reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) {
    if (new Set(review.votes.map((vote) => vote[field])).size !== 2) fail(`candidate review shares ${field}`);
  }
  if (JSON.stringify(review.votes.map((vote) => vote.passNumber).sort()) !== JSON.stringify([1, 2])) fail('candidate review must contain distinct pass 1 and pass 2 primary votes');
  const canonicalObservation = (vote) => ({
    assessmentMode: vote.observation.assessmentMode,
    childTaxonomy: vote.observation.childTaxonomy,
    parents: [...vote.observation.parentObservations].sort((a, b) => a.opaqueParentId.localeCompare(b.opaqueParentId)).map((parent) => ({
      opaqueParentId: parent.opaqueParentId, taxonomy: parent.taxonomy, sameCreatureGrownUp: parent.sameCreatureGrownUp,
      inheritedAnchorIds: [...parent.inheritedAnchorIds].sort(),
    })),
    canonicalAssessment: vote.observation.canonicalAssessment,
    requiredAnchorEvidence: [...vote.observation.requiredAnchorEvidence].sort((a, b) => a.opaqueInputId.localeCompare(b.opaqueInputId)).map((entry) => ({
      opaqueInputId: entry.opaqueInputId, anchors: [...entry.anchors].sort((a, b) => a.anchorKey.localeCompare(b.anchorKey)).map(({ anchorKey, anchorId, requiredDescription }) => ({ anchorKey, anchorId, requiredDescription })),
    })),
    eiluComparison: vote.observation.eiluComparison,
  });
  if (canonicalStringify(canonicalObservation(review.votes[0])) !== canonicalStringify(canonicalObservation(review.votes[1]))) fail('candidate primary votes disagree on taxonomy, continuity, or inherited anchor ID sets');
  let persistedReviewSha256 = null;
  if (persistedReviewRelative !== null) {
    assertCanonicalRelativePath(persistedReviewRelative, 'persisted candidate review');
    const persistedBytes = await readContainedFile(repoRoot, persistedReviewRelative); let persisted;
    try { persisted = JSON.parse(persistedBytes); } catch { fail('persisted candidate review is not JSON'); }
    if (canonicalStringify(persisted) !== canonicalStringify(review)) fail('persisted candidate review bytes differ from validated review');
    persistedReviewSha256 = sha256Bytes(persistedBytes);
  }
  const firstVote = review.votes.find((vote) => vote.passNumber === 1);
  const anchorById = new Map();
  for (const set of firstVote.observation.requiredAnchorEvidence) for (const anchor of set.anchors) {
    if (!anchorById.has(anchor.anchorId)) anchorById.set(anchor.anchorId, {
      anchorKey: `${context.binding.child.sourceSlotId}:${anchor.anchorId}`, parentId: context.binding.child.sourceSlotId,
      anchorId: anchor.anchorId, description: anchor.observation, sourceReviewId: firstVote.reviewId,
    });
  }
  if (anchorById.size < 2) fail('validated candidate review does not yield enough review-derived child anchors');
  const result = Object.freeze({
    status: 'PASS', opaqueCandidateId: context.binding.opaqueCandidateId,
    sourceSlots: { child: context.binding.child.sourceSlotId, parents: context.binding.parents.map((parent) => parent.sourceSlotId) },
    taxonomy: review.votes[0].observation.childTaxonomy,
    trustedDependency: persistedReviewSha256 === null ? null : deepFreeze({
      parentId: context.binding.child.sourceSlotId, candidateId: context.binding.candidateId,
      reviewPath: persistedReviewRelative, reviewSha256: persistedReviewSha256,
      pixelSurfaces: structuredClone(context.binding.child.surfaces), anchors: [...anchorById.values()],
    }),
  });
  if (result.trustedDependency) TRUSTED_DEPENDENCIES.add(result.trustedDependency);
  return result;
}

async function readConductorKeyFromStdin() {
  if (process.stdin.isTTY) fail('--conductor-key-stdin requires piped or inherited non-TTY stdin');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  return requireConductorKey(Buffer.concat(chunks));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [command, inputPath] = args;
  if (command === 'prepare') {
    console.error('Direct prepare is disabled; use npm run continuity:g003:prepare -- <descriptor.json> --conductor-key-stdin');
    process.exitCode = 2;
  } else if (command !== 'verify' || !inputPath || !args[2] || args[3] !== '--conductor-key-stdin' || args.length !== 4) {
    console.error('Usage: <key-producer> | node scripts/prepare-continuity-candidate-review.mjs verify <review.json> <package-root> --conductor-key-stdin');
    process.exitCode = 2;
  } else {
    const key = await readConductorKeyFromStdin();
    const review = await readJson(REPO_ROOT, inputPath);
    console.log(JSON.stringify(await validateCandidateReview(review, { packageRelative: args[2], conductorKey: key })));
  }
}
