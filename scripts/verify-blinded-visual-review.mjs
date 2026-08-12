import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pngjs from 'pngjs';
import { isStrictRfc3339, validateAttestation } from './attest-blinded-visual-review-run.mjs';
import { verifyReviewerPackage, verifyReviewerPackageSources } from './record-blinded-visual-review-batch.mjs';

const { PNG } = pngjs;

const SHA256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const BIOLOGICAL_CLASSES = new Set(['mammal', 'bird', 'fish', 'reptile', 'amphibian', 'arthropod', 'mollusk', 'annelid', 'cnidarian', 'plant', 'fungus', 'spirit', 'construct', 'unknown']);
const SPECIES_FAMILIES = new Set(['bear', 'canid', 'feline', 'mustelid', 'rodent', 'rabbit', 'deer', 'bovine', 'equine', 'bat', 'bird-owl', 'bird-raptor', 'bird-songbird', 'bird-waterfowl', 'bird-penguin', 'bird-other', 'serpent', 'lizard', 'turtle', 'frog', 'salamander', 'fish-bony', 'fish-shark', 'cetacean', 'pinniped', 'arachnid', 'insect-larva', 'insect-beetle', 'insect-lepidopteran', 'crustacean', 'cephalopod', 'gastropod', 'plant-flower', 'fungus', 'spirit', 'construct', 'unknown-family']);
const CORE_ANATOMIES = new Set(['quadruped', 'biped', 'winged-biped', 'serpentine', 'fishlike', 'cephalopod', 'arachnid', 'hexapod', 'multiped', 'radial', 'plantlike', 'amorphous', 'construct', 'unknown']);
const LOCOMOTION_PLANS = new Set(['quadrupedal', 'bipedal', 'flight', 'swimming', 'serpentine', 'crawling', 'burrowing', 'rooted', 'floating', 'amorphous', 'unknown']);
const DEVELOPMENTAL_DELTAS = new Set(['size-increase', 'limb-development', 'appendage-development', 'armor-development', 'silhouette-change', 'locomotion-change']);
const FORBIDDEN_CONTEXT_KEYS = new Set([
  'pgid',
  'id',
  'name',
  'lineage',
  'evolutionfrom',
  'parent',
  'parentids',
  'graph',
  'stage',
  'category',
  'priorverdict',
  'verdict',
  'summary',
  'pass',
]);
const VOTE_HMAC_DOMAIN = 'punchgrow:visual-review-v1:conductor-hmac\0';

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function finalizeVote(vote, conductorKey) {
  const withoutDigest = structuredClone(vote);
  delete withoutDigest.outputSha256;
  delete withoutDigest.conductorHmacSha256;
  const voteWithDigest = { ...withoutDigest, outputSha256: sha256Canonical(withoutDigest) };
  if (!conductorKey) fail('conductor key is required to finalize a raw vote');
  return {
    ...voteWithDigest,
    conductorHmacSha256: createHmac('sha256', conductorKey).update(VOTE_HMAC_DOMAIN).update(canonicalize(voteWithDigest)).digest('hex'),
  };
}

function fail(message) {
  throw new Error(message);
}

export function validateVoteAuthenticity(vote, conductorKey) {
  if (!vote || typeof vote !== 'object' || Array.isArray(vote)) fail('raw vote: expected object');
  if (!conductorKey) fail('conductor key is required to authenticate a raw vote');
  assertSha(vote.outputSha256, `${vote.reviewId ?? 'vote'}.outputSha256`);
  assertSha(vote.conductorHmacSha256, `${vote.reviewId ?? 'vote'}.conductorHmacSha256`);
  const withoutHmac = structuredClone(vote);
  delete withoutHmac.conductorHmacSha256;
  const withoutDigest = structuredClone(withoutHmac);
  delete withoutDigest.outputSha256;
  if (sha256Canonical(withoutDigest) !== vote.outputSha256) fail(`${vote.reviewId ?? 'vote'}: output hash drift detected`);
  const expected = createHmac('sha256', conductorKey).update(VOTE_HMAC_DOMAIN).update(canonicalize(withoutHmac)).digest();
  const actual = Buffer.from(vote.conductorHmacSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(`${vote.reviewId ?? 'vote'}: conductor HMAC verification failed`);
  return vote;
}

export function assertExactEvidenceFileSet(actual, expected, label) {
  if (new Set(expected).size !== expected.length) fail(`${label}: authorization replay produced duplicate expected path`);
  if (canonicalize([...actual].sort()) !== canonicalize([...expected].sort())) fail(`${label}: exact file set mismatch (partial, extra, or replayed evidence)`);
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: expected object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) fail(`${label}: unexpected field(s): ${extras.join(', ')}`);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label}: expected non-empty string`);
}

function assertOpaque(value, label) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !OPAQUE_ID.test(value)) fail(`${label}: expected opaque identifier`);
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label}: expected lowercase SHA-256`);
}

function assertSlug(value, label) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 80 || !SLUG.test(value)) fail(`${label}: expected controlled slug`);
}

function findForbiddenContext(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenContext(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_CONTEXT_KEYS.has(key.toLowerCase())) {
      fail(`forbidden context field ${key} at ${path}`);
    }
    findForbiddenContext(entry, `${path}.${key}`);
  }
}

function assertSurface(surface, label, { allowPath }) {
  assertExactKeys(surface, allowPath ? ['path', 'sha256', 'bytes', 'width', 'height'] : ['sha256', 'width', 'height'], label);
  if (allowPath) assertString(surface.path, `${label}.path`);
  assertSha(surface.sha256, `${label}.sha256`);
  if (allowPath && (!Number.isInteger(surface.bytes) || surface.bytes <= 0)) fail(`${label}.bytes: expected positive integer`);
  if (!Number.isInteger(surface.width) || surface.width <= 0) fail(`${label}.width: expected positive integer`);
  if (!Number.isInteger(surface.height) || surface.height <= 0) fail(`${label}.height: expected positive integer`);
}

function inputAssets(input) {
  const kind = input.targetKind;
  if (kind === 'asset') {
    if (!input.surfaces) fail(`${input.opaqueInputId}: asset input is missing surfaces`);
    return [{ slot: 'asset', master: input.surfaces.master, runtime: input.surfaces.runtime }];
  }
  if (kind === 'edge') {
    if (!Array.isArray(input.parents) || input.parents.length < 1 || input.parents.length > 2) {
      fail(`${input.opaqueInputId}: edge input must contain one or two parents`);
    }
    if (!input.child) fail(`${input.opaqueInputId}: edge input is missing child`);
    return [...input.parents, input.child].map((asset) => ({
      slot: asset.slot,
      master: asset.surfaces.master,
      runtime: asset.surfaces.runtime,
    }));
  }
  fail('manifest input: targetKind must be asset or edge');
}

function normalizedAssets(assets, label, { allowPath }) {
  if (!Array.isArray(assets) || assets.length === 0) fail(`${label}: expected assets array`);
  const seen = new Set();
  return assets
    .map((asset, index) => {
      assertExactKeys(asset, ['slot', 'master', 'runtime'], `${label}[${index}]`);
      if (!['asset', 'parent-a', 'parent-b', 'child'].includes(asset.slot)) fail(`${label}[${index}].slot: invalid slot`);
      if (seen.has(asset.slot)) fail(`${label}: duplicate asset slot ${asset.slot}`);
      seen.add(asset.slot);
      assertSurface(asset.master, `${label}[${index}].master`, { allowPath });
      assertSurface(asset.runtime, `${label}[${index}].runtime`, { allowPath });
      return structuredClone(asset);
    })
    .sort((left, right) => left.slot.localeCompare(right.slot));
}

function digestAssets(assets) {
  return assets.map((asset) => ({
    slot: asset.slot,
    master: { sha256: asset.master.sha256, width: asset.master.width, height: asset.master.height },
    runtime: { sha256: asset.runtime.sha256, width: asset.runtime.width, height: asset.runtime.height },
  }));
}

function targetKey(target) {
  return `${target.kind}:${target.opaqueInputId}`;
}

function validateManifestAndAllowlist(manifest, allowlist, expectedCoverage, byteHashes) {
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'bundleGenerationRunId',
      'pixelMaterialization',
      'packManifestSha256',
      'contractSha256',
      'promptSha256',
      'allowlistSha256',
      'templateSha256',
      'privateSidecarSha256',
      'counts',
      'inputs',
    ],
    'manifest',
  );
  if (manifest.schemaVersion !== 'blinded-visual-bundle-v1') fail('manifest.schemaVersion: unsupported schema');
  assertOpaque(manifest.bundleGenerationRunId, 'manifest.bundleGenerationRunId');
  if (manifest.pixelMaterialization !== 'hard-link-with-copy-fallback') fail('manifest.pixelMaterialization: unsupported mode');
  for (const key of ['packManifestSha256', 'contractSha256', 'promptSha256', 'allowlistSha256', 'templateSha256', 'privateSidecarSha256']) {
    assertSha(manifest[key], `manifest.${key}`);
  }
  if ((byteHashes.allowlistSha256 ?? sha256Canonical(allowlist)) !== manifest.allowlistSha256) fail('allowlist hash drift detected');
  if (byteHashes.packManifestSha256 && byteHashes.packManifestSha256 !== manifest.packManifestSha256) fail('active pack manifest hash drift detected');
  if (byteHashes.contractSha256 && byteHashes.contractSha256 !== manifest.contractSha256) fail('review contract hash drift detected');
  if (byteHashes.promptSha256 && byteHashes.promptSha256 !== manifest.promptSha256) fail('review prompt hash drift detected');
  if (byteHashes.privateSidecarSha256 && byteHashes.privateSidecarSha256 !== manifest.privateSidecarSha256) fail('private sidecar hash drift detected');

  assertExactKeys(allowlist, ['schemaVersion', 'bundleGenerationRunId', 'inputs'], 'allowlist');
  if (allowlist.schemaVersion !== 'blinded-input-allowlist-v1') fail('allowlist.schemaVersion: unsupported schema');
  if (allowlist.bundleGenerationRunId !== manifest.bundleGenerationRunId) fail('allowlist bundle generation run mismatch');
  if (!Array.isArray(manifest.inputs) || !Array.isArray(allowlist.inputs)) fail('manifest/allowlist inputs must be arrays');

  assertExactKeys(manifest.counts, ['assets', 'edges', 'total'], 'manifest.counts');
  if (
    manifest.counts.assets !== expectedCoverage.asset
    || manifest.counts.edges !== expectedCoverage.edge
    || manifest.counts.total !== expectedCoverage.asset + expectedCoverage.edge
  ) fail('manifest asserted target counts do not match required coverage');

  const targets = new Map();
  const counts = { asset: 0, edge: 0 };
  for (const [index, input] of manifest.inputs.entries()) {
    assertExactKeys(
      input,
      input.targetKind === 'asset'
        ? ['opaqueInputId', 'targetKind', 'surfaces']
        : ['opaqueInputId', 'targetKind', 'focusParentSlot', 'parents', 'child', 'stageOrder'],
      `manifest.inputs[${index}]`,
    );
    const { targetKind: kind, opaqueInputId } = input;
    if (!['asset', 'edge'].includes(kind)) fail(`manifest.inputs[${index}]: invalid target kind`);
    assertOpaque(opaqueInputId, `manifest.inputs[${index}].opaqueInputId`);
    const key = `${kind}:${opaqueInputId}`;
    if (targets.has(key)) fail(`duplicate manifest target ${key}`);
    const assets = normalizedAssets(inputAssets(input), `${key}.assets`, { allowPath: true });
    const requiredSlots = kind === 'asset' ? ['asset'] : assets.map((asset) => asset.slot).sort();
    if (kind === 'asset' && requiredSlots.join(',') !== 'asset') fail(`${key}: asset target must contain only asset slot`);
    if (kind === 'edge') {
      const parentSlots = assets.filter((asset) => asset.slot.startsWith('parent-')).map((asset) => asset.slot).sort();
      const expectedSlots = parentSlots.length === 1 ? ['child', 'parent-a'] : ['child', 'parent-a', 'parent-b'];
      if (assets.map((asset) => asset.slot).join(',') !== expectedSlots.join(',')) fail(`${key}: edge slots are incomplete`);
      if (!parentSlots.includes(input.focusParentSlot)) fail(`${key}: focusParentSlot is not present`);
      if (canonicalize(input.stageOrder) !== canonicalize([...parentSlots, 'child'])) fail(`${key}: stageOrder mismatch`);
    }
    targets.set(key, { kind, opaqueInputId, input, assets });
    counts[kind] += 1;
  }

  if (counts.asset !== expectedCoverage.asset || counts.edge !== expectedCoverage.edge) {
    fail(`target coverage mismatch: expected ${expectedCoverage.asset} assets/${expectedCoverage.edge} edges, got ${counts.asset}/${counts.edge}`);
  }
  if (allowlist.inputs.length !== manifest.inputs.length) fail('allowlist target count mismatch');

  const allowlistTargets = new Set();
  for (const [index, entry] of allowlist.inputs.entries()) {
    assertExactKeys(entry, ['opaqueInputId', 'targetKind', 'files'], `allowlist.inputs[${index}]`);
    const key = `${entry.targetKind}:${entry.opaqueInputId}`;
    if (allowlistTargets.has(key)) fail(`duplicate allowlist target ${key}`);
    allowlistTargets.add(key);
    const target = targets.get(key);
    if (!target) fail(`allowlist contains non-manifest target ${key}`);
    if (!Array.isArray(entry.files)) fail(`allowlist ${key}.files: expected array`);
    const actualFiles = entry.files.map((surface, fileIndex) => {
      assertSurface(surface, `allowlist ${key}.files[${fileIndex}]`, { allowPath: true });
      return structuredClone(surface);
    }).sort((left, right) => left.path.localeCompare(right.path));
    const expectedFiles = target.assets
      .flatMap((asset) => [asset.master, asset.runtime])
      .sort((left, right) => left.path.localeCompare(right.path));
    if (canonicalize(actualFiles) !== canonicalize(expectedFiles)) fail(`${key}: allowlist files do not exactly match manifest`);
  }
  if ([...targets.keys()].some((key) => !allowlistTargets.has(key))) fail('allowlist is missing manifest target(s)');
  return targets;
}

export function verifyBlindedReviewBundle({ manifest, allowlist, expectedCoverage = { asset: 240, edge: 190 }, byteHashes = {} }) {
  void manifest; void allowlist; void expectedCoverage; void byteHashes;
  fail('legacy in-memory bundle verification is disabled; use verifyTrustedVisualReviewRun or the trusted CLI entrypoint');
}

function validateAnchor(anchor, label, kind) {
  const visibleKey = kind === 'asset' ? 'visible' : 'visibleInChild';
  const allowed = kind === 'asset' ? ['anchorId', 'visible', 'observation'] : ['anchorId', 'sourceSlots', 'visibleInChild', 'observation'];
  assertExactKeys(anchor, allowed, label);
  assertSlug(anchor.anchorId, `${label}.anchorId`);
  if (typeof anchor[visibleKey] !== 'boolean') fail(`${label}.${visibleKey}: expected boolean`);
  if (typeof anchor.observation !== 'string' || anchor.observation.trim().length < 3 || anchor.observation.length > 500) fail(`${label}: anchor evidence is missing or invalid`);
  if (kind === 'edge') {
    if (!Array.isArray(anchor.sourceSlots) || anchor.sourceSlots.length === 0 || anchor.sourceSlots.length > 2) fail(`${label}.sourceSlots: expected one or two source slots`);
    if (new Set(anchor.sourceSlots).size !== anchor.sourceSlots.length) fail(`${label}.sourceSlots: duplicate source slot`);
    for (const slot of anchor.sourceSlots) {
      if (!['parent-a', 'parent-b'].includes(slot)) fail(`${label}.sourceSlots: invalid parent slot`);
    }
  }
}

function validateAssetObservation(observation, label) {
  assertExactKeys(
    observation,
    [
      'biologicalClass',
      'speciesFamily',
      'coreAnatomy',
      'locomotionPlan',
      'faceAnchors',
      'bodyAnchors',
      'developmentalDeltas',
      'masterRuntimeContinuity',
    ],
    label,
  );
  if (!BIOLOGICAL_CLASSES.has(observation.biologicalClass)) fail(`${label}.biologicalClass: invalid controlled value`);
  assertSlug(observation.speciesFamily, `${label}.speciesFamily`);
  if (!SPECIES_FAMILIES.has(observation.speciesFamily)) fail(`${label}.speciesFamily: outside controlled visual family vocabulary`);
  if (!CORE_ANATOMIES.has(observation.coreAnatomy)) fail(`${label}.coreAnatomy: invalid controlled value`);
  if (!LOCOMOTION_PLANS.has(observation.locomotionPlan)) fail(`${label}.locomotionPlan: invalid controlled value`);
  if (!['yes', 'no', 'undetermined'].includes(observation.masterRuntimeContinuity)) fail(`${label}.masterRuntimeContinuity: invalid answer`);
  if (!Array.isArray(observation.faceAnchors) || !Array.isArray(observation.bodyAnchors)) fail(`${label}: anchor arrays are required`);
  if (observation.faceAnchors.length < 1 || observation.bodyAnchors.length < 2) fail(`${label}: at least one face and two body anchors are required`);
  [...observation.faceAnchors, ...observation.bodyAnchors].forEach((anchor, index) => validateAnchor(anchor, `${label}.anchors[${index}]`, 'asset'));
  if (canonicalize(observation.faceAnchors.map((x) => x.anchorId)) !== canonicalize(['face-geometry']) || canonicalize(observation.bodyAnchors.map((x) => x.anchorId)) !== canonicalize(['body-silhouette', 'signature-organ'])) fail(`${label}: asset anchor IDs must use fixed review vocabulary`);
  if (!Array.isArray(observation.developmentalDeltas)) fail(`${label}.developmentalDeltas: expected array`);
  observation.developmentalDeltas.forEach((delta, index) => { assertSlug(delta, `${label}.developmentalDeltas[${index}]`); if (!DEVELOPMENTAL_DELTAS.has(delta)) fail(`${label}.developmentalDeltas[${index}]: outside controlled vocabulary`); });
  if (new Set(observation.developmentalDeltas).size !== observation.developmentalDeltas.length) fail(`${label}.developmentalDeltas: duplicate value`);
}

function validateEdgeObservation(observation, label) {
  assertExactKeys(
    observation,
    ['sameCreatureContinuity', 'coreAnatomyAgreement', 'locomotionAgreement', 'inheritedAnchors', 'developmentalDeltas'],
    label,
  );
  for (const key of ['sameCreatureContinuity', 'coreAnatomyAgreement', 'locomotionAgreement']) {
    if (!['yes', 'no', 'undetermined'].includes(observation[key])) fail(`${label}.${key}: invalid answer`);
  }
  if (!Array.isArray(observation.inheritedAnchors)) fail(`${label}.inheritedAnchors: expected array`);
  if (observation.inheritedAnchors.length < 3) fail(`${label}.inheritedAnchors: at least three anchors are required`);
  observation.inheritedAnchors.forEach((anchor, index) => validateAnchor(anchor, `${label}.inheritedAnchors[${index}]`, 'edge'));
  const slots = new Set(observation.inheritedAnchors.flatMap((x) => x.sourceSlots));
  const expectedAnchors = slots.has('parent-b') ? ['parent-a-face', 'parent-a-body', 'parent-b-face', 'parent-b-body'] : ['ancestry-face', 'ancestry-body', 'ancestry-signature'];
  if (canonicalize(observation.inheritedAnchors.map((x) => x.anchorId)) !== canonicalize(expectedAnchors)) fail(`${label}: edge anchor IDs must use fixed review vocabulary`);
  if (!Array.isArray(observation.developmentalDeltas)) fail(`${label}.developmentalDeltas: expected array`);
  observation.developmentalDeltas.forEach((delta, index) => { assertSlug(delta, `${label}.developmentalDeltas[${index}]`); if (!DEVELOPMENTAL_DELTAS.has(delta)) fail(`${label}.developmentalDeltas[${index}]: outside controlled vocabulary`); });
  if (new Set(observation.developmentalDeltas).size !== observation.developmentalDeltas.length) fail(`${label}.developmentalDeltas: duplicate value`);
}

function validateVote(vote, target, manifest, bundleManifestSha256, authorization) {
  findForbiddenContext(vote);
  assertExactKeys(
    vote,
    [
      'schemaVersion',
      'reviewId',
      'voterReviewRunId',
      'reviewTarget',
      'reviewer',
      'provenance',
      'assets',
      'assetObservation',
      'edgeObservation',
      'confidence',
      'submittedAt',
      'outputSha256',
      'conductorHmacSha256',
    ],
    vote.reviewId ?? 'vote',
  );
  if (vote.schemaVersion !== 'visual-review-v1') fail(`${vote.reviewId}: unsupported vote schema`);
  assertOpaque(vote.reviewId, 'vote.reviewId');
  assertOpaque(vote.voterReviewRunId, `${vote.reviewId}.voterReviewRunId`);
  assertExactKeys(vote.reviewTarget, ['kind', 'opaqueInputId'], `${vote.reviewId}.reviewTarget`);
  if (targetKey(vote.reviewTarget) !== targetKey(target)) fail(`${vote.reviewId}: review target mismatch`);
  assertExactKeys(vote.reviewer, ['reviewerInstanceId', 'agentTaskId', 'role'], `${vote.reviewId}.reviewer`);
  assertOpaque(vote.reviewer.reviewerInstanceId, `${vote.reviewId}.reviewerInstanceId`);
  assertOpaque(vote.reviewer.agentTaskId, `${vote.reviewId}.agentTaskId`);
  if (!['primary', 'adjudicator'].includes(vote.reviewer.role)) fail(`${vote.reviewId}: invalid reviewer role`);
  assertExactKeys(
    vote.provenance,
    ['bundleGenerationRunId', 'promptSha256', 'allowlistSha256', 'templateSha256', 'bundleManifestSha256', 'privateSidecarSha256', 'authorizationId', 'batchPackageManifestSha256', 'fileSetSha256'],
    `${vote.reviewId}.provenance`,
  );
  if (vote.provenance.bundleGenerationRunId !== manifest.bundleGenerationRunId) fail(`${vote.reviewId}: bundle generation run mismatch`);
  if (vote.provenance.promptSha256 !== manifest.promptSha256) fail(`${vote.reviewId}: prompt hash drift detected`);
  if (vote.provenance.allowlistSha256 !== manifest.allowlistSha256) fail(`${vote.reviewId}: allowlist hash drift detected`);
  if (vote.provenance.templateSha256 !== manifest.templateSha256) fail(`${vote.reviewId}: template hash drift detected`);
  if (vote.provenance.bundleManifestSha256 !== bundleManifestSha256) fail(`${vote.reviewId}: bundle manifest hash drift detected`);
  if (vote.provenance.privateSidecarSha256 !== manifest.privateSidecarSha256) fail(`${vote.reviewId}: private sidecar hash drift detected`);
  if (!authorization || vote.provenance.authorizationId !== authorization.authorizationId || vote.provenance.batchPackageManifestSha256 !== authorization.batchPackageManifestSha256 || vote.provenance.fileSetSha256 !== authorization.fileSetSha256) fail(`${vote.reviewId}: conductor authorization provenance drift detected`);
  const expectedSlotOrder = target.kind === 'asset'
    ? ['asset']
    : target.assets.map((asset) => asset.slot).sort((left, right) => {
        const order = ['parent-a', 'parent-b', 'child'];
        return order.indexOf(left) - order.indexOf(right);
      });
  if (canonicalize(vote.assets.map((asset) => asset.slot)) !== canonicalize(expectedSlotOrder)) {
    fail(`${vote.reviewId}: asset slots are not in the immutable contract order`);
  }
  const assets = normalizedAssets(vote.assets, `${vote.reviewId}.assets`, { allowPath: false });
  const expectedAssets = digestAssets(target.assets);
  if (canonicalize(assets) !== canonicalize(expectedAssets)) fail(`${vote.reviewId}: master/runtime asset hash or dimensions drift detected`);
  if (target.kind === 'asset') {
    if (!vote.assetObservation || vote.edgeObservation !== undefined) fail(`${vote.reviewId}: target-kind-specific asset evidence is required`);
    validateAssetObservation(vote.assetObservation, `${vote.reviewId}.assetObservation`);
  } else {
    if (!vote.edgeObservation || vote.assetObservation !== undefined) fail(`${vote.reviewId}: target-kind-specific edge evidence is required`);
    validateEdgeObservation(vote.edgeObservation, `${vote.reviewId}.edgeObservation`);
  }
  if (typeof vote.confidence !== 'number' || vote.confidence < 0 || vote.confidence > 1) fail(`${vote.reviewId}.confidence: expected 0..1`);
  if (!isStrictRfc3339(vote.submittedAt)) {
    fail(`${vote.reviewId}.submittedAt: invalid RFC 3339 timestamp`);
  }
  assertSha(vote.outputSha256, `${vote.reviewId}.outputSha256`);
  assertSha(vote.conductorHmacSha256, `${vote.reviewId}.conductorHmacSha256`);
}

function assetSubstantiveSignature(vote) {
  const observation = vote.assetObservation;
  const anchor = (entry) => `${entry.anchorId}:${entry.visible}`;
  return canonicalize({
    coreAnatomy: observation.coreAnatomy,
    locomotionPlan: observation.locomotionPlan,
    faceAnchors: observation.faceAnchors.map(anchor).sort(),
    bodyAnchors: observation.bodyAnchors.map(anchor).sort(),
    masterRuntimeContinuity: observation.masterRuntimeContinuity,
  });
}

function edgeSubstantiveSignature(vote) {
  const observation = vote.edgeObservation;
  const anchor = (entry) => `${entry.anchorId}:${[...entry.sourceSlots].sort().join('+')}:${entry.visibleInChild}`;
  return canonicalize({
    sameCreatureContinuity: observation.sameCreatureContinuity,
    coreAnatomyAgreement: observation.coreAnatomyAgreement,
    locomotionAgreement: observation.locomotionAgreement,
    inheritedAnchors: observation.inheritedAnchors.map(anchor).sort(),
  });
}

function evidenceReasons(vote, target) {
  const reasons = [];
  if (vote.confidence < 0.85) reasons.push(`${vote.reviewId}: confidence below 0.85`);
  if (target.kind === 'asset') {
    const observation = vote.assetObservation;
    if (observation.masterRuntimeContinuity !== 'yes') reasons.push(`${vote.reviewId}: master/runtime continuity is not yes`);
    const anchors = [...observation.faceAnchors, ...observation.bodyAnchors];
    if (anchors.filter((anchor) => anchor.visible).length < 3) reasons.push(`${vote.reviewId}: fewer than three visible identity anchors`);
    if (new Set(anchors.map((anchor) => anchor.anchorId)).size !== anchors.length) reasons.push(`${vote.reviewId}: duplicate identity anchor`);
  } else {
    const observation = vote.edgeObservation;
    if (observation.sameCreatureContinuity !== 'yes') reasons.push(`${vote.reviewId}: same-creature continuity dissent`);
    if (observation.coreAnatomyAgreement !== 'yes') reasons.push(`${vote.reviewId}: core anatomy dissent`);
    if (observation.locomotionAgreement !== 'yes') reasons.push(`${vote.reviewId}: locomotion dissent`);
    const visibleAnchors = observation.inheritedAnchors.filter((anchor) => anchor.visibleInChild);
    if (visibleAnchors.length < 3) reasons.push(`${vote.reviewId}: fewer than three inherited anchors`);
    if (new Set(observation.inheritedAnchors.map((anchor) => anchor.anchorId)).size !== observation.inheritedAnchors.length) {
      reasons.push(`${vote.reviewId}: duplicate inherited anchor`);
    }
    const parentSlots = target.assets.filter((asset) => asset.slot.startsWith('parent-')).map((asset) => asset.slot);
    for (const parentSlot of parentSlots) {
      const inherited = visibleAnchors.filter((anchor) => anchor.sourceSlots.includes(parentSlot)).length;
      const minimum = parentSlots.length === 2 ? 2 : 3;
      if (inherited < minimum) reasons.push(`${vote.reviewId}: ${parentSlot} has ${inherited}/${minimum} required inherited anchors`);
    }
  }
  return reasons;
}

function assertDistinctIdentities(votes, key, label) {
  const values = votes.map((vote) => key.split('.').reduce((value, part) => value[part], vote));
  if (new Set(values).size !== values.length) fail(`${label}: reviewers must use distinct ${key.split('.').at(-1)}`);
}

export function deriveTarget(target, votes) {
  const primaries = votes.filter((vote) => vote.reviewer.role === 'primary');
  const adjudicators = votes.filter((vote) => vote.reviewer.role === 'adjudicator');
  if (primaries.length !== 2) fail(`${targetKey(target)}: exactly two primary votes are required`);
  if (adjudicators.length > 1) fail(`${targetKey(target)}: at most one adjudicator is allowed`);
  for (const key of ['reviewer.reviewerInstanceId', 'reviewer.agentTaskId', 'voterReviewRunId']) {
    assertDistinctIdentities(votes, key, targetKey(target));
  }

  const reasons = votes.flatMap((vote) => evidenceReasons(vote, target));
  const signature = target.kind === 'asset' ? assetSubstantiveSignature : edgeSubstantiveSignature;
  if (signature(primaries[0]) !== signature(primaries[1])) {
    reasons.push('primary votes contain substantive core-anatomy/locomotion/continuity/required-anchor dissent');
  }
  if (adjudicators.length === 1 && signature(adjudicators[0]) !== signature(primaries[0])) {
    reasons.push('adjudicator attempted to override substantive dissent');
  }

  if (target.kind === 'edge') {
    if (adjudicators.length > 0) fail(`${targetKey(target)}: edge adjudication is forbidden because only taxonomy labels may be adjudicated`);
  } else {
    const taxonomy = (vote) => `${vote.assetObservation.biologicalClass}\0${vote.assetObservation.speciesFamily}`;
    const taxonomyDisagrees = taxonomy(primaries[0]) !== taxonomy(primaries[1]);
    if (taxonomyDisagrees) {
      if (adjudicators.length !== 1) reasons.push('taxonomy-label disagreement requires one fresh adjudicator');
      else if (![taxonomy(primaries[0]), taxonomy(primaries[1])].includes(taxonomy(adjudicators[0]))) {
        reasons.push('adjudicator taxonomy does not match either primary label');
      }
    } else if (adjudicators.length > 0) {
      fail(`${targetKey(target)}: adjudicator is not allowed without taxonomy-label disagreement`);
    }
  }
  return {
    kind: target.kind,
    opaqueInputId: target.opaqueInputId,
    verdict: reasons.length === 0 ? 'PASS' : 'BLOCKED',
    reasons,
    primaryReviewIds: primaries.map((vote) => vote.reviewId),
    adjudicatorReviewId: adjudicators[0]?.reviewId ?? null,
  };
}

export function deriveBlindedVisualReview({
  manifest,
  allowlist,
  votes,
  expectedCoverage = { asset: 240, edge: 190 },
  assertedSummary,
  byteHashes = {},
}) {
  void manifest; void allowlist; void votes; void expectedCoverage; void assertedSummary; void byteHashes;
  fail('legacy in-memory verdict derivation is disabled; use deriveRunVerdicts through the trusted CLI entrypoint');
}

function validateAssignmentPackageData(manifest, allowlist, byteHashes = {}) {
  assertExactKeys(manifest, [
    'schemaVersion', 'bundleGenerationRunId', 'assignmentId', 'reviewTarget', 'pixelMaterialization',
    'registrySha256', 'catalogSha256', 'packSha256', 'privateSidecarSha256', 'contractSha256',
    'promptSha256', 'allowlistSha256', 'templateSha256', 'counts', 'input',
  ], 'assignment manifest');
  if (manifest.schemaVersion !== 'blinded-visual-assignment-v1') fail('assignment manifest: unsupported schema');
  assertOpaque(manifest.bundleGenerationRunId, 'assignment manifest.bundleGenerationRunId');
  assertOpaque(manifest.assignmentId, 'assignment manifest.assignmentId');
  assertExactKeys(manifest.reviewTarget, ['kind', 'opaqueInputId'], 'assignment manifest.reviewTarget');
  if (!['asset', 'edge'].includes(manifest.reviewTarget.kind)) fail('assignment manifest.reviewTarget.kind: invalid');
  assertOpaque(manifest.reviewTarget.opaqueInputId, 'assignment manifest.reviewTarget.opaqueInputId');
  if (manifest.pixelMaterialization !== 'independent-apfs-clone-or-copy') fail('assignment manifest.pixelMaterialization: invalid');
  for (const key of ['registrySha256', 'catalogSha256', 'packSha256', 'privateSidecarSha256', 'contractSha256', 'promptSha256', 'allowlistSha256', 'templateSha256']) {
    assertSha(manifest[key], `assignment manifest.${key}`);
  }
  for (const [field, manifestField] of [
    ['registrySha256', 'registrySha256'], ['catalogSha256', 'catalogSha256'], ['packSha256', 'packSha256'],
    ['privateSidecarSha256', 'privateSidecarSha256'], ['contractSha256', 'contractSha256'],
    ['promptSha256', 'promptSha256'], ['allowlistSha256', 'allowlistSha256'], ['templateSha256', 'templateSha256'],
  ]) {
    if (byteHashes[field] && byteHashes[field] !== manifest[manifestField]) fail(`${field} drift detected`);
  }
  assertExactKeys(manifest.counts, ['targets', 'pixelFiles'], 'assignment manifest.counts');
  if (manifest.counts.targets !== 1) fail('assignment package must contain exactly one target');
  assertExactKeys(
    manifest.input,
    manifest.input?.targetKind === 'asset'
      ? ['opaqueInputId', 'targetKind', 'surfaces']
      : ['opaqueInputId', 'targetKind', 'focusParentSlot', 'parents', 'child', 'stageOrder'],
    'assignment manifest.input',
  );
  if (manifest.input.targetKind === 'asset') {
    assertExactKeys(manifest.input.surfaces, ['master', 'runtime'], 'assignment asset surfaces');
  } else {
    if (!Array.isArray(manifest.input.parents)) fail('assignment edge parents must be array');
    manifest.input.parents.forEach((parent, index) => {
      assertExactKeys(parent, ['slot', 'surfaces'], `assignment edge parents[${index}]`);
      assertExactKeys(parent.surfaces, ['master', 'runtime'], `assignment edge parents[${index}].surfaces`);
    });
    assertExactKeys(manifest.input.child, ['slot', 'surfaces'], 'assignment edge child');
    assertExactKeys(manifest.input.child.surfaces, ['master', 'runtime'], 'assignment edge child.surfaces');
  }
  if (manifest.input.opaqueInputId !== manifest.reviewTarget.opaqueInputId || manifest.input.targetKind !== manifest.reviewTarget.kind) {
    fail('assignment manifest target/input mismatch');
  }
  const targetAssets = normalizedAssets(inputAssets(manifest.input), `${manifest.assignmentId}.assets`, { allowPath: true });
  const expectedPixelFiles = targetAssets.length * 2;
  if (manifest.counts.pixelFiles !== expectedPixelFiles) fail('assignment manifest pixel count mismatch');

  assertExactKeys(allowlist, ['schemaVersion', 'bundleGenerationRunId', 'assignmentId', 'inputs'], 'assignment allowlist');
  if (allowlist.schemaVersion !== 'blinded-input-allowlist-v1') fail('assignment allowlist: unsupported schema');
  if (allowlist.bundleGenerationRunId !== manifest.bundleGenerationRunId || allowlist.assignmentId !== manifest.assignmentId) fail('assignment allowlist identity mismatch');
  if (!Array.isArray(allowlist.inputs) || allowlist.inputs.length !== 1) fail('assignment allowlist must contain exactly one target');
  const entry = allowlist.inputs[0];
  assertExactKeys(entry, ['opaqueInputId', 'targetKind', 'files'], 'assignment allowlist input');
  if (entry.opaqueInputId !== manifest.reviewTarget.opaqueInputId || entry.targetKind !== manifest.reviewTarget.kind) fail('assignment allowlist target mismatch');
  if (!Array.isArray(entry.files) || entry.files.length !== expectedPixelFiles) fail('assignment allowlist pixel count mismatch');
  const allowlisted = entry.files.map((surface, index) => {
    assertSurface(surface, `assignment allowlist.files[${index}]`, { allowPath: true });
    return surface;
  }).sort((left, right) => left.path.localeCompare(right.path));
  const expected = targetAssets.flatMap((asset) => [asset.master, asset.runtime]).sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalize(allowlisted) !== canonicalize(expected)) fail('assignment allowlist does not exactly match manifest pixels');
  return {
    kind: manifest.reviewTarget.kind,
    opaqueInputId: manifest.reviewTarget.opaqueInputId,
    assignmentId: manifest.assignmentId,
    input: manifest.input,
    assets: targetAssets,
  };
}

async function rejectSymlinkComponents(root, absolutePath) {
  const relation = path.relative(root, absolutePath);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`path escapes approved root: ${absolutePath}`);
  let cursor = root;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`symlinked path rejected: ${cursor}`);
  }
}

export async function assertTrustedDirectoryRoot(root, label = 'trusted directory root') {
  const absolute = path.resolve(root);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label}: root must be a real non-symlink directory`);
  const resolved = await realpath(absolute);
  return resolved;
}

async function assertTrustedDirectoryTree(containmentRoot, root, label) {
  const basePath = path.resolve(containmentRoot); const base = await assertTrustedDirectoryRoot(basePath, `${label} containment`);
  const target = path.resolve(root); const relation = path.relative(basePath, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label}: root escapes approved containment`);
  let cursor = basePath;
  for (const part of relation.split(path.sep)) {
    cursor = path.join(cursor, part); const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label}: root contains symlink or non-directory component`);
  }
  const resolved = await realpath(target);
  if (path.relative(base, resolved).startsWith('..')) fail(`${label}: root resolves outside approved containment`);
}

async function readContainedRegular(root, relativePath, label) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\')) fail(`${label}: non-canonical path`);
  const absoluteRoot = path.resolve(root);
  await assertTrustedDirectoryRoot(absoluteRoot, `${label} root`);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  const relation = path.relative(absoluteRoot, absolutePath);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label}: path traversal outside bundle root`);
  await rejectSymlinkComponents(absoluteRoot, absolutePath);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label}: expected regular non-symlink file`);
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(absoluteRoot), realpath(absolutePath)]);
  const realRelation = path.relative(resolvedRoot, resolvedPath);
  if (!realRelation || realRelation.startsWith('..') || path.isAbsolute(realRelation)) fail(`${label}: resolved path escapes bundle root`);
  return { bytes: await readFile(absolutePath), info, absolutePath };
}

function canonicalPixelPath(slot, surfaceName) {
  return `inputs/${slot}/${surfaceName}.png`;
}

export async function verifyMaterializedAssignmentPixels({ manifest, bundleRoot }) {
  const assets = normalizedAssets(inputAssets(manifest.input), `${manifest.assignmentId}.pixels`, { allowPath: true });
  let verified = 0;
  for (const asset of assets) {
    for (const surfaceName of ['master', 'runtime']) {
      const surface = asset[surfaceName];
      const expectedPath = canonicalPixelPath(asset.slot, surfaceName);
      if (surface.path !== expectedPath) fail(`${manifest.assignmentId}: non-canonical pixel path ${surface.path}; expected ${expectedPath}`);
      const { bytes, info } = await readContainedRegular(bundleRoot, surface.path, `${manifest.assignmentId}:${surface.path}`);
      if (info.nlink !== 1) fail(`${manifest.assignmentId}:${surface.path}: pixel must be an independent file, not a hard link`);
      if (bytes.length !== surface.bytes) fail(`${manifest.assignmentId}:${surface.path}: byte length drift`);
      if (sha256Bytes(bytes) !== surface.sha256) fail(`${manifest.assignmentId}:${surface.path}: pixel hash drift`);
      let decoded;
      try {
        decoded = PNG.sync.read(bytes);
      } catch (error) {
        fail(`${manifest.assignmentId}:${surface.path}: PNG decode failed: ${error.message}`);
      }
      if (decoded.width !== surface.width || decoded.height !== surface.height) fail(`${manifest.assignmentId}:${surface.path}: decoded PNG dimensions drift`);
      verified += 1;
    }
  }
  return verified;
}

export async function listPackageFiles(root, current = root) {
  if (current === root) await assertTrustedDirectoryRoot(root, 'enumerated package root');
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`assignment package contains symlink: ${absolute}`);
    if (entry.isDirectory()) files.push(...await listPackageFiles(root, absolute));
    else if (entry.isFile()) {
      const info = await lstat(absolute);
      if (info.nlink !== 1) fail(`package contains hard-linked file: ${absolute}`);
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
    else fail(`assignment package contains non-regular entry: ${absolute}`);
  }
  return files.sort();
}

export async function verifyIsolatedPackageFileSet(root, target) {
  const slots = target.kind === 'asset' ? ['asset'] : target.assets.map((asset) => asset.slot).sort();
  const expected = [
    'REVIEW_PROMPT.md', 'bundle-manifest.json', 'input-allowlist.json', 'review-contract.schema.json', 'vote-template.json',
    ...slots.flatMap((slot) => [`inputs/${slot}/master.png`, `inputs/${slot}/runtime.png`]),
  ].sort();
  const actual = await listPackageFiles(root);
  if (canonicalize(actual) !== canonicalize(expected)) fail(`${target.assignmentId}: assignment package contains missing/extra files or global context`);
}

function resolveCurrentEdges(catalog) {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const byLineageStage = new Map();
  for (const creature of catalog) {
    const key = `${creature.lineageId}:S${creature.stage}`;
    const values = byLineageStage.get(key) ?? [];
    values.push(creature);
    byLineageStage.set(key, values);
  }
  const resolve = (reference) => {
    if (/^PG-\d{3}$/.test(reference)) {
      if (!byId.has(reference)) fail(`catalog edge references missing ID ${reference}`);
      return reference;
    }
    const hits = byLineageStage.get(reference) ?? [];
    if (hits.length !== 1) fail(`catalog edge reference ${reference} is ambiguous or missing`);
    return hits[0].id;
  };
  const edges = new Map();
  for (const child of catalog) {
    if (!child.evolutionFrom) continue;
    const parentIds = (Array.isArray(child.evolutionFrom) ? child.evolutionFrom : [child.evolutionFrom]).map(resolve);
    if (new Set(parentIds).size !== parentIds.length) fail(`${child.id}: duplicate catalog parent`);
    for (const focusParentId of parentIds) {
      const key = `${focusParentId}>${child.id}`;
      if (edges.has(key)) fail(`duplicate focused catalog edge ${key}`);
      edges.set(key, { focusParentId, childId: child.id, parentIds: [...parentIds].sort() });
    }
  }
  return edges;
}

export async function verifyTrustedVisualReviewRun({
  repoRoot,
  runRoot,
  orchestration,
  orchestrationBytes,
  privateSidecar,
  privateSidecarBytes,
  assignmentAttestation,
  assignmentAttestationBytes,
  registry,
  registryBytes,
  pack,
  packBytes,
  catalog,
  catalogBytes,
  packageRecords,
  expectedCoverage = { asset: 240, edge: 190 },
}) {
  assertExactKeys(orchestration, ['schemaVersion', 'bundleGenerationRunId', 'counts', 'assignments'], 'orchestration');
  if (orchestration.schemaVersion !== 'blinded-review-orchestration-v1') fail('orchestration: unsupported schema');
  assertExactKeys(orchestration.counts, ['assets', 'edges', 'assignments'], 'orchestration.counts');
  const total = expectedCoverage.asset + expectedCoverage.edge;
  if (orchestration.counts.assets !== expectedCoverage.asset || orchestration.counts.edges !== expectedCoverage.edge || orchestration.counts.assignments !== total) fail('orchestration coverage mismatch');

  assertExactKeys(privateSidecar, ['schemaVersion', 'bundleGenerationRunId', 'registryPath', 'registrySha256', 'activePackId', 'packManifestPath', 'packSha256', 'catalogPath', 'catalogSha256', 'counts', 'assets', 'edges', 'assignments'], 'private sidecar');
  if (privateSidecar.schemaVersion !== 'private-visual-alias-map-v2') fail('private sidecar: unsupported schema');
  if (privateSidecar.bundleGenerationRunId !== orchestration.bundleGenerationRunId) fail('private sidecar run mismatch');
  if (privateSidecar.registryPath !== 'config/creature-assets.json' || privateSidecar.catalogPath !== 'production/catalog/creatures.json') fail('private sidecar trusted source path mismatch');
  assertExactKeys(privateSidecar.counts, ['assets', 'edges', 'assignments'], 'private sidecar.counts');
  if (privateSidecar.counts.assets !== expectedCoverage.asset || privateSidecar.counts.edges !== expectedCoverage.edge || privateSidecar.counts.assignments !== total) fail('private sidecar coverage mismatch');
  const trustHashes = {
    registrySha256: sha256Bytes(registryBytes), catalogSha256: sha256Bytes(catalogBytes), packSha256: sha256Bytes(packBytes), privateSidecarSha256: sha256Bytes(privateSidecarBytes),
  };
  for (const key of ['registrySha256', 'catalogSha256', 'packSha256']) if (privateSidecar[key] !== trustHashes[key]) fail(`private sidecar ${key} drift`);
  if (registry.activePack !== privateSidecar.activePackId || registry.packs?.[registry.activePack] !== privateSidecar.packManifestPath) fail('active registry selection does not match private sidecar');
  if (pack.packId !== registry.activePack || pack.status !== 'active') fail('selected pack is not the active registry pack');
  if (!Array.isArray(pack.entries) || !Array.isArray(catalog)) fail('pack/catalog entries must be arrays');
  const packById = new Map(pack.entries.map((entry) => [entry.id, entry]));
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  if (pack.entries.length !== expectedCoverage.asset || packById.size !== expectedCoverage.asset) fail('selected pack must contain exactly 240 unique IDs');
  if (catalog.length !== expectedCoverage.asset || catalogById.size !== expectedCoverage.asset) fail('current catalog must contain exactly 240 unique IDs');
  for (const id of packById.keys()) if (!/^PG-\d{3}$/.test(id) || !catalogById.has(id)) fail(`selected pack/catalog ID substitution ${id}`);

  const currentEdges = resolveCurrentEdges(catalog);
  if (currentEdges.size !== expectedCoverage.edge) fail('current catalog must contain exactly 190 unique focused edges');
  if (!Array.isArray(privateSidecar.assets) || !Array.isArray(privateSidecar.edges) || !Array.isArray(privateSidecar.assignments)) fail('private mappings must be arrays');
  const assetAliases = new Map();
  const seenAssetIds = new Set();
  for (const alias of privateSidecar.assets) {
    assertExactKeys(alias, ['opaqueInputId', 'assetId'], 'private asset alias');
    if (assetAliases.has(alias.opaqueInputId) || seenAssetIds.has(alias.assetId) || !packById.has(alias.assetId)) fail('duplicate/substituted private asset alias');
    assetAliases.set(alias.opaqueInputId, alias.assetId); seenAssetIds.add(alias.assetId);
  }
  if (assetAliases.size !== expectedCoverage.asset) fail('private asset alias coverage mismatch');
  const edgeAliases = new Map();
  const seenEdgeKeys = new Set();
  for (const alias of privateSidecar.edges) {
    assertExactKeys(alias, ['opaqueInputId', 'focusParentId', 'parentSlots', 'childId'], 'private edge alias');
    assertExactKeys(alias.parentSlots, Object.keys(alias.parentSlots), 'private edge parentSlots');
    const edgeKey = `${alias.focusParentId}>${alias.childId}`;
    const expected = currentEdges.get(edgeKey);
    const mappedParents = Object.values(alias.parentSlots).sort();
    if (!expected || edgeAliases.has(alias.opaqueInputId) || seenEdgeKeys.has(edgeKey) || canonicalize(mappedParents) !== canonicalize(expected.parentIds)) fail('duplicate/substituted private focused edge');
    const expectedSlotKeys = expected.parentIds.length === 1 ? ['parent-a'] : ['parent-a', 'parent-b'];
    if (canonicalize(Object.keys(alias.parentSlots).sort()) !== canonicalize(expectedSlotKeys)) fail('private mixed parent slots are incomplete or substituted');
    if (!['parent-a', 'parent-b'].includes(Object.entries(alias.parentSlots).find(([, id]) => id === alias.focusParentId)?.[0])) fail('private focus parent slot missing');
    edgeAliases.set(alias.opaqueInputId, alias); seenEdgeKeys.add(edgeKey);
  }
  if (edgeAliases.size !== expectedCoverage.edge) fail('private edge alias coverage mismatch');

  assertExactKeys(assignmentAttestation, ['schemaVersion', 'bundleGenerationRunId', 'privateSidecarSha256', 'registrySha256', 'catalogSha256', 'packSha256', 'assignments'], 'private assignment attestation');
  if (assignmentAttestation.schemaVersion !== 'private-visual-assignment-attestation-v1') fail('private assignment attestation: unsupported schema');
  if (assignmentAttestation.bundleGenerationRunId !== orchestration.bundleGenerationRunId || assignmentAttestation.privateSidecarSha256 !== trustHashes.privateSidecarSha256) fail('private assignment attestation run/sidecar mismatch');
  for (const key of ['registrySha256', 'catalogSha256', 'packSha256']) if (assignmentAttestation[key] !== trustHashes[key]) fail(`private assignment attestation ${key} drift`);
  if (packageRecords.length !== total || orchestration.assignments.length !== total || assignmentAttestation.assignments.length !== total) fail('assignment package coverage mismatch');

  const privateAssignments = new Map(privateSidecar.assignments.map((entry) => [entry.assignmentId, entry]));
  if (privateAssignments.size !== total) fail('duplicate private assignment mapping');
  const attestedAssignments = new Map(assignmentAttestation.assignments.map((entry) => [entry.assignmentId, entry]));
  if (attestedAssignments.size !== total) fail('duplicate private package attestation');
  const orchestrationAssignments = new Map(orchestration.assignments.map((entry) => [entry.assignmentId, entry]));
  if (orchestrationAssignments.size !== total) fail('duplicate orchestration assignment');
  const packageByAssignment = new Map(packageRecords.map((entry) => [entry.manifest.assignmentId, entry]));
  if (packageByAssignment.size !== total) fail('duplicate assignment package');
  for (const [assignmentId, mapping] of privateAssignments) {
    assertExactKeys(mapping, ['assignmentId', 'opaqueInputId', 'targetKind'], 'private assignment mapping');
    const packageRecord = packageByAssignment.get(assignmentId);
    const privateProof = attestedAssignments.get(assignmentId);
    const publicProof = orchestrationAssignments.get(assignmentId);
    if (!packageRecord || !privateProof || !publicProof) fail(`missing assignment proof ${assignmentId}`);
    if (mapping.opaqueInputId !== packageRecord.target.opaqueInputId || mapping.targetKind !== packageRecord.target.kind) fail(`assignment target substitution ${assignmentId}`);
    const expectedRelative = `assignments/${assignmentId}`;
    if (privateProof.relativePackagePath !== expectedRelative || publicProof.relativePackagePath !== expectedRelative) fail(`non-canonical assignment package path ${assignmentId}`);
    if (sha256Bytes(packageRecord.manifestBytes) !== privateProof.bundleManifestSha256 || privateProof.bundleManifestSha256 !== publicProof.bundleManifestSha256) fail(`assignment manifest hash drift ${assignmentId}`);
    if (sha256Bytes(packageRecord.templateBytes) !== privateProof.templateSha256 || sha256Bytes(packageRecord.allowlistBytes) !== privateProof.allowlistSha256) fail(`assignment template/allowlist hash drift ${assignmentId}`);
    for (const key of ['registrySha256', 'catalogSha256', 'packSha256', 'privateSidecarSha256']) if (packageRecord.manifest[key] !== trustHashes[key]) fail(`assignment trusted ${key} drift ${assignmentId}`);
    const alias = mapping.targetKind === 'asset' ? assetAliases.get(mapping.opaqueInputId) : edgeAliases.get(mapping.opaqueInputId);
    if (!alias) fail(`assignment references missing trusted alias ${assignmentId}`);
    const slotToId = mapping.targetKind === 'asset' ? { asset: alias } : { ...alias.parentSlots, child: alias.childId };
    for (const asset of packageRecord.target.assets) {
      const entry = packById.get(slotToId[asset.slot]);
      if (!entry || asset.master.sha256 !== entry.sha256 || asset.runtime.sha256 !== entry.mobileSha256) fail(`assignment pixel substituted from selected pack ${assignmentId}:${asset.slot}`);
    }
  }

  for (const entry of pack.entries) {
    const masterPath = entry.path;
    if (masterPath !== `${pack.masterRoot}/${entry.id}.png`) fail(`non-canonical master path ${entry.id}`);
    const runtimePath = entry.deploymentPaths?.macos;
    if (runtimePath !== `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${entry.id}.png`) fail(`non-canonical runtime path ${entry.id}`);
    const [masterFile, runtimeFile] = await Promise.all([readContainedRegular(repoRoot, masterPath, `master ${entry.id}`), readContainedRegular(repoRoot, runtimePath, `runtime ${entry.id}`)]);
    let masterDecoded; let runtimeDecoded;
    try { masterDecoded = PNG.sync.read(masterFile.bytes); runtimeDecoded = PNG.sync.read(runtimeFile.bytes); } catch (error) { fail(`${entry.id}: PNG decode failed: ${error.message}`); }
    if (sha256Bytes(masterFile.bytes) !== entry.sha256 || masterDecoded.width !== 1254 || masterDecoded.height !== 1254) fail(`master bytes do not match selected pack sha256/dimensions ${entry.id}`);
    if (sha256Bytes(runtimeFile.bytes) !== entry.mobileSha256 || runtimeDecoded.width !== 360 || runtimeDecoded.height !== 360) fail(`runtime bytes do not match selected pack mobileSha256 ${entry.id}`);
  }
  return {
    schemaVersion: 'trusted-visual-review-run-v1', verdict: 'READY_FOR_REVIEW',
    counts: { assets: assetAliases.size, edges: edgeAliases.size, assignments: packageRecords.length },
    hashes: { ...trustHashes, orchestrationSha256: sha256Bytes(orchestrationBytes), assignmentAttestationSha256: sha256Bytes(assignmentAttestationBytes) },
  };
}

function validateAssignmentSets(assignmentSets, packageRecords, expectedBundleManifestSha256) {
  const expectedTargets = new Set(packageRecords.map((record) => record.target.opaqueInputId));
  const assetTargets = new Set(packageRecords.filter((record) => record.target.kind === 'asset').map((record) => record.target.opaqueInputId));
  const byPass = new Map();
  for (const assignment of assignmentSets) {
    assertExactKeys(assignment, ['schemaVersion', 'bundleGenerationRunId', 'bundleManifestSha256', 'passId', 'batchSize', 'targetCount', 'shuffleSha256', 'batches', 'assignmentSha256'], 'review assignment set');
    if (assignment.schemaVersion !== 'blinded-visual-review-assignment-set-v1') fail('review assignment set: unsupported schema');
    if (assignment.bundleGenerationRunId !== packageRecords[0]?.manifest.bundleGenerationRunId) fail('review assignment set run mismatch');
    if (expectedBundleManifestSha256 && assignment.bundleManifestSha256 !== expectedBundleManifestSha256) fail('review assignment set bundle commitment mismatch');
    const core = structuredClone(assignment); delete core.assignmentSha256;
    if (sha256Canonical(core) !== assignment.assignmentSha256) fail('review assignment set hash drift');
    if (byPass.has(assignment.passId)) fail('duplicate review pass assignment set');
    const assigned = [];
    for (const batch of assignment.batches ?? []) {
      assertExactKeys(batch, ['batchId', 'targetCount', 'opaqueInputIds'], 'review assignment batch');
      if (!Array.isArray(batch.opaqueInputIds) || batch.targetCount !== batch.opaqueInputIds.length) fail('review assignment batch count mismatch');
      assigned.push(...batch.opaqueInputIds);
    }
    if (new Set(assigned).size !== assigned.length || assignment.targetCount !== assigned.length) fail('review assignment set coverage mismatch');
    if (assignment.passId === 'pass-3') {
      if (assigned.length < 1 || assigned.some((id) => !assetTargets.has(id))) fail('pass-3 taxonomy adjudication must be a non-empty asset-only subset');
    } else {
      if (!['pass-1', 'pass-2'].includes(assignment.passId)) fail('unsupported review pass');
      if (assigned.length !== expectedTargets.size || assigned.some((id) => !expectedTargets.has(id))) fail('primary review assignment set coverage mismatch');
    }
    byPass.set(assignment.passId, assignment);
  }
  if (!byPass.has('pass-1') || !byPass.has('pass-2')) fail('two full independent primary review pass assignment sets are required');
  return byPass;
}

function validateReviewerAttestation(attestation, vote, packageRecord, assignmentSets, reviewerPackages) {
  const assignmentSet = assignmentSets.get(attestation.passId);
  if (!assignmentSet || assignmentSet.assignmentSha256 !== attestation.assignmentSha256) fail('reviewer-run attestation assignment-set commitment mismatch');
  if (attestation.passId === 'pass-3' && (attestation.role !== 'adjudicator' || packageRecord.target.kind !== 'asset')) fail('pass-3 is restricted to fresh asset taxonomy adjudication');
  if (['pass-1', 'pass-2'].includes(attestation.passId) && attestation.role !== 'primary') fail('pass-1/pass-2 are restricted to primary reviewers');
  const matchingBatches = assignmentSet.batches.filter((batch) => batch.opaqueInputIds.includes(packageRecord.target.opaqueInputId));
  if (matchingBatches.length !== 1 || attestation.batchId !== matchingBatches[0].batchId) fail('reviewer-run attestation batch assignment mismatch');
  const reviewerPackage = reviewerPackages.get(`${attestation.passId}:${attestation.batchId}`);
  if (!reviewerPackage || attestation.batchPackageManifestSha256 !== reviewerPackage.manifestSha256) fail('reviewer-run attestation reviewer-package manifest hash drift');
  if (attestation.fileSetSha256 !== sha256Canonical(reviewerPackage.manifest.files)) fail('reviewer-run attestation reviewer-package file-set hash drift');
  if (canonicalize(attestation.assignedOpaqueInputIds) !== canonicalize(matchingBatches[0].opaqueInputIds)) fail('reviewer-run attestation target coverage mismatch');
  if (attestation.targetManifestSha256s?.[packageRecord.target.opaqueInputId] !== sha256Bytes(packageRecord.manifestBytes)) fail('reviewer-run attestation target manifest hash drift');
  if (
    attestation.bundleGenerationRunId !== packageRecord.manifest.bundleGenerationRunId
    || attestation.reviewerInstanceId !== vote.reviewer.reviewerInstanceId
    || attestation.agentTaskId !== vote.reviewer.agentTaskId
    || attestation.voterReviewRunId !== vote.voterReviewRunId
    || attestation.role !== vote.reviewer.role
  ) fail(`${vote.reviewId}: arbitrary reviewer identity is not attested`);
}

export function validateAuthorizationIdentityConstraints(attestations) {
  const batchAttempts = new Set(); const taskOwners = new Map(); const runOwners = new Map(); const reviewerOwners = new Map();
  const primary = { reviewer: new Set(), task: new Set(), run: new Set() }; const adjudicator = { reviewer: new Set(), task: new Set(), run: new Set() };
  for (const auth of attestations) {
    const owner = `${auth.passId}\0${auth.batchId}\0${auth.role}\0${auth.attempt}`;
    const batchAttempt = `${auth.passId}\0${auth.batchId}\0${auth.attempt}`;
    if (batchAttempts.has(batchAttempt)) fail('one authorization may cover only one batch and attempt'); batchAttempts.add(batchAttempt);
    for (const [map, value, label] of [[taskOwners, auth.agentTaskId, 'agentTaskId'], [runOwners, auth.voterReviewRunId, 'voterReviewRunId']]) {
      if (map.has(value) && map.get(value) !== owner) fail(`${label} must be bundle-wide unique to one batch authorization`); map.set(value, owner);
    }
    if (reviewerOwners.has(auth.reviewerInstanceId) && reviewerOwners.get(auth.reviewerInstanceId) !== owner) fail('reviewerInstanceId may belong to exactly one batch, role, and attempt');
    reviewerOwners.set(auth.reviewerInstanceId, owner);
    const role = auth.role === 'primary' ? primary : adjudicator;
    role.reviewer.add(auth.reviewerInstanceId); role.task.add(auth.agentTaskId); role.run.add(auth.voterReviewRunId);
  }
  for (const key of ['reviewer', 'task', 'run']) if ([...adjudicator[key]].some((value) => primary[key].has(value))) fail('adjudicator identity must be disjoint from every primary identity');
}

export function deriveTaxonomyAdjudicationTargetIds(packageRecords, votes) {
  const primaryByTarget = new Map(packageRecords.filter((record) => record.target.kind === 'asset').map((record) => [record.target.opaqueInputId, []]));
  for (const vote of votes) if (vote.reviewer?.role === 'primary' && vote.reviewTarget?.kind === 'asset' && primaryByTarget.has(vote.reviewTarget.opaqueInputId)) primaryByTarget.get(vote.reviewTarget.opaqueInputId).push(vote);
  const targets = [];
  for (const record of packageRecords.filter((entry) => entry.target.kind === 'asset')) {
    const primaries = primaryByTarget.get(record.target.opaqueInputId);
    if (primaries.length !== 2) continue;
    if (primaries.some((vote) => vote.confidence < 0.85 || evidenceReasons(vote, record.target).length > 0)) continue;
    if (assetSubstantiveSignature(primaries[0]) !== assetSubstantiveSignature(primaries[1])) continue;
    const taxonomy = (vote) => `${vote.assetObservation.biologicalClass}\0${vote.assetObservation.speciesFamily}`;
    if (taxonomy(primaries[0]) !== taxonomy(primaries[1])) targets.push(record.target.opaqueInputId);
  }
  return targets.sort();
}

export function assertAdjudicationTargetSet(actual, expected) {
  if (canonicalize([...actual].sort()) !== canonicalize([...expected].sort())) fail('pass-3 assignment must exactly match independently derived taxonomy-only disagreement targets');
}

export function finalizeAdjudicationTargets(core, conductorKey) {
  const outputSha256 = sha256Canonical(core);
  return { ...core, outputSha256, conductorHmacSha256: createHmac('sha256', conductorKey).update(canonicalize({ ...core, outputSha256 })).digest('hex') };
}

export function deriveRunVerdicts({ packageRecords, votes, reviewerAttestations, assignmentSets, expectedBundleManifestSha256, assertedSummary, conductorKey, reviewerPackages = new Map(), allowPendingAdjudication = false }) {
  if (assertedSummary && String(assertedSummary.verdict).toUpperCase() === 'PASS') fail('summary PASS assertions are forbidden; verdicts are derived only from immutable raw votes');
  const packageByTarget = new Map(packageRecords.map((record) => [targetKey(record.target), record]));
  const trustedAssignmentSets = validateAssignmentSets(assignmentSets, packageRecords, expectedBundleManifestSha256);
  const validatedReviewerAttestations = reviewerAttestations.map((value) => validateAttestation(value, conductorKey));
  validateAuthorizationIdentityConstraints(validatedReviewerAttestations);
  const attestationsByIdentity = new Map();
  const authorizationKeys = new Set();
  const taskOwners = new Map();
  const runOwners = new Map();
  const reviewerPasses = new Map();
  const primaryIdentities = { reviewer: new Set(), task: new Set(), run: new Set() };
  const adjudicatorIdentities = { reviewer: new Set(), task: new Set(), run: new Set() };
  for (const attestation of validatedReviewerAttestations) {
    const authorizationKey = `${attestation.passId}\0${attestation.batchId}\0${attestation.attempt}`;
    if (authorizationKeys.has(authorizationKey)) fail('one authorization may cover only one batch and attempt');
    authorizationKeys.add(authorizationKey);
    for (const [map, value, label] of [[taskOwners, attestation.agentTaskId, 'agentTaskId'], [runOwners, attestation.voterReviewRunId, 'voterReviewRunId']]) {
      const owner = `${attestation.passId}\0${attestation.batchId}\0${attestation.attempt}`;
      if (map.has(value) && map.get(value) !== owner) fail(`${label} must be bundle-wide unique to one batch authorization`);
      map.set(value, owner);
    }
    const reviewerOwner = `${attestation.passId}\0${attestation.batchId}\0${attestation.role}\0${attestation.attempt}`;
    if (reviewerPasses.has(attestation.reviewerInstanceId) && reviewerPasses.get(attestation.reviewerInstanceId) !== reviewerOwner) fail('reviewerInstanceId may belong to exactly one batch, role, and attempt');
    reviewerPasses.set(attestation.reviewerInstanceId, reviewerOwner);
    const roleSet = attestation.role === 'primary' ? primaryIdentities : adjudicatorIdentities;
    roleSet.reviewer.add(attestation.reviewerInstanceId); roleSet.task.add(attestation.agentTaskId); roleSet.run.add(attestation.voterReviewRunId);
    for (const target of attestation.assignedOpaqueInputIds) {
      const key = `${target}\0${attestation.reviewerInstanceId}\0${attestation.agentTaskId}\0${attestation.voterReviewRunId}\0${attestation.role}`;
      if (attestationsByIdentity.has(key)) fail('duplicate or cross-batch reviewer-run attestation target');
      attestationsByIdentity.set(key, attestation);
    }
  }
  for (const key of ['reviewer', 'task', 'run']) if ([...adjudicatorIdentities[key]].some((value) => primaryIdentities[key].has(value))) fail('adjudicator identity must be disjoint from every primary identity');
  const votesByTarget = new Map([...packageByTarget.keys()].map((key) => [key, []]));
  const reviewIds = new Set();
  for (const vote of votes) {
    validateVoteAuthenticity(vote, conductorKey);
    const key = targetKey(vote.reviewTarget ?? {});
    const record = packageByTarget.get(key);
    if (!record) fail(`vote references unknown assigned target ${key}`);
    if (reviewIds.has(vote.reviewId)) fail(`duplicate reviewId ${vote.reviewId}`);
    reviewIds.add(vote.reviewId);
    const identityKey = `${record.target.opaqueInputId}\0${vote.reviewer.reviewerInstanceId}\0${vote.reviewer.agentTaskId}\0${vote.voterReviewRunId}\0${vote.reviewer.role}`;
    const attestation = attestationsByIdentity.get(identityKey);
    if (!attestation) fail(`${vote.reviewId}: arbitrary reviewer identity lacks external attestation`);
    validateReviewerAttestation(attestation, vote, record, trustedAssignmentSets, reviewerPackages);
    validateVote(vote, record.target, record.manifest, sha256Bytes(record.manifestBytes), attestation);
    votesByTarget.get(key).push(vote);
  }
  const usedAttestations = new Set(votes.map((vote) => {
    const record = packageByTarget.get(targetKey(vote.reviewTarget));
    return `${record.target.opaqueInputId}\0${vote.reviewer.reviewerInstanceId}\0${vote.reviewer.agentTaskId}\0${vote.voterReviewRunId}\0${vote.reviewer.role}`;
  }));
  if (usedAttestations.size !== attestationsByIdentity.size) fail('unused or unbound reviewer-run attestation target');
  const expectedAdjudicationTargets = deriveTaxonomyAdjudicationTargetIds(packageRecords, votes);
  const passThree = trustedAssignmentSets.get('pass-3');
  const assignedAdjudicationTargets = passThree ? passThree.batches.flatMap((batch) => batch.opaqueInputIds).sort() : [];
  if (!allowPendingAdjudication) assertAdjudicationTargetSet(assignedAdjudicationTargets, expectedAdjudicationTargets);
  const targets = [...packageByTarget.entries()].map(([key, record]) => {
    const targetVotes = votesByTarget.get(key);
    const targetAttestations = targetVotes.map((vote) => attestationsByIdentity.get(`${record.target.opaqueInputId}\0${vote.reviewer.reviewerInstanceId}\0${vote.reviewer.agentTaskId}\0${vote.voterReviewRunId}\0${vote.reviewer.role}`));
    const primaryAttestations = targetAttestations.filter((attestation) => attestation.role === 'primary');
    if (primaryAttestations.length === 2 && (new Set(primaryAttestations.map((x) => x.passId)).size !== 2 || new Set(primaryAttestations.map((x) => x.assignmentSha256)).size !== 2)) {
      fail(`${key}: primary votes must come from distinct attested passes and assignment sets`);
    }
    if (new Set(targetAttestations.map((x) => x.passId)).size !== targetAttestations.length) fail(`${key}: reviewer pass was reused`);
    return deriveTarget(record.target, targetVotes);
  });
  const blocked = targets.filter((entry) => entry.verdict === 'BLOCKED').length;
  return { schemaVersion: 'blinded-visual-derived-verdict-v2', verdict: blocked === 0 ? 'PASS' : 'BLOCKED', counts: { assets: targets.filter((x) => x.kind === 'asset').length, edges: targets.filter((x) => x.kind === 'edge').length, blocked }, targets };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`);
    if (key === '--conductor-key-stdin') { args['conductor-key-stdin'] = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${key}: missing value`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeAtomicEvidence(repoRoot, approved, requested, bytes, label) {
  const destination = path.resolve(requested);
  if (destination !== path.resolve(approved)) fail(`Verifier --output must be the approved ${label} path`);
  const parent = path.dirname(destination);
  const assertAncestors = async (allowMissing) => {
    let cursor = repoRoot;
    for (const part of path.relative(repoRoot, parent).split(path.sep)) {
      cursor = path.join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) fail(`Symlinked verifier output ancestor rejected: ${cursor}`); }
      catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    }
  };
  await assertAncestors(true);
  await mkdir(parent, { recursive: true });
  await assertAncestors(false);
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(destination);
      if (!existing.equals(Buffer.from(bytes))) fail(`Immutable verifier output differs: ${destination}`);
    }
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('Verifier output must be an atomic regular non-symlink file with nlink=1');
}

export async function writeAtomicApproved(repoRoot, runId, requested, bytes) {
  return writeAtomicEvidence(repoRoot, path.join(repoRoot, '.omx/evidence/visual-census', runId, 'derived-verdict.json'), requested, bytes, 'run evidence derived-verdict.json');
}

export async function writeAtomicAdjudicationTargets(repoRoot, runId, requested, bytes) {
  return writeAtomicEvidence(repoRoot, path.join(repoRoot, '.omx/evidence/visual-census', runId, 'adjudication-targets.json'), requested, bytes, 'run evidence adjudication-targets.json');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNoAggregateInputs(args);
  const requiredArgs = ['run-root'];
  for (const required of requiredArgs) {
    if (!args[required]) fail(`--${required} is required`);
  }
  const repoRoot = process.cwd();
  const runRoot = path.resolve(args['run-root']);
  const approvedRunParent = path.join(repoRoot, 'production/reports/biological-continuity-v3/blinded-inputs');
  await assertTrustedDirectoryTree(approvedRunParent, runRoot, 'blinded run');
  const orchestrationFile = await readContainedRegular(runRoot, 'orchestration-index.json', 'orchestration index');
  const orchestration = JSON.parse(orchestrationFile.bytes);
  const runId = orchestration.bundleGenerationRunId;
  const sidecarRel = args['private-sidecar'] ?? `.omx/evidence/visual-census/${runId}/alias-map.json`;
  const packageAttestationRel = args['assignment-attestation'] ?? `.omx/evidence/visual-census/${runId}/assignment-attestation.json`;
  const registryRel = args.registry ?? 'config/creature-assets.json';
  const catalogRel = args.catalog ?? 'production/catalog/creatures.json';
  const [sidecarFile, packageAttestationFile, registryFile, catalogFile] = await Promise.all([
    readContainedRegular(repoRoot, sidecarRel, 'private sidecar'),
    readContainedRegular(repoRoot, packageAttestationRel, 'private assignment attestation'),
    readContainedRegular(repoRoot, registryRel, 'active registry'),
    readContainedRegular(repoRoot, catalogRel, 'current catalog'),
  ]);
  const privateSidecar = JSON.parse(sidecarFile.bytes);
  const assignmentAttestation = JSON.parse(packageAttestationFile.bytes);
  const registry = JSON.parse(registryFile.bytes);
  const catalog = JSON.parse(catalogFile.bytes);
  const packRel = registry.packs?.[registry.activePack];
  if (typeof packRel !== 'string') fail('active registry pack path is missing');
  const packFile = await readContainedRegular(repoRoot, packRel, 'active selected pack');
  const pack = JSON.parse(packFile.bytes);
  const expectedCoverage = {
    asset: args['expected-assets'] === undefined ? 240 : Number(args['expected-assets']),
    edge: args['expected-edges'] === undefined ? 190 : Number(args['expected-edges']),
  };
  if (!Array.isArray(orchestration.assignments)) fail('orchestration assignments must be array');
  const packageRecords = [];
  for (const orchestrationEntry of orchestration.assignments) {
    assertExactKeys(orchestrationEntry, ['assignmentId', 'relativePackagePath', 'bundleManifestSha256'], 'orchestration assignment');
    const expectedRelative = `assignments/${orchestrationEntry.assignmentId}`;
    if (orchestrationEntry.relativePackagePath !== expectedRelative) fail('non-canonical orchestration assignment path');
    const packageRoot = path.resolve(runRoot, expectedRelative);
    await assertTrustedDirectoryTree(runRoot, packageRoot, `assignment package ${orchestrationEntry.assignmentId}`);
    const [manifestFile, allowlistFile, templateFile, contractFile, promptFile] = await Promise.all([
      readContainedRegular(packageRoot, 'bundle-manifest.json', 'assignment manifest'),
      readContainedRegular(packageRoot, 'input-allowlist.json', 'assignment allowlist'),
      readContainedRegular(packageRoot, 'vote-template.json', 'assignment template'),
      readContainedRegular(packageRoot, 'review-contract.schema.json', 'assignment contract'),
      readContainedRegular(packageRoot, 'REVIEW_PROMPT.md', 'assignment prompt'),
    ]);
    if (sha256Bytes(manifestFile.bytes) !== orchestrationEntry.bundleManifestSha256) fail('orchestration assignment manifest hash drift');
    const manifest = JSON.parse(manifestFile.bytes);
    const allowlist = JSON.parse(allowlistFile.bytes);
    const target = validateAssignmentPackageData(manifest, allowlist, {
      registrySha256: sha256Bytes(registryFile.bytes), catalogSha256: sha256Bytes(catalogFile.bytes), packSha256: sha256Bytes(packFile.bytes),
      privateSidecarSha256: sha256Bytes(sidecarFile.bytes), contractSha256: sha256Bytes(contractFile.bytes), promptSha256: sha256Bytes(promptFile.bytes),
      allowlistSha256: sha256Bytes(allowlistFile.bytes), templateSha256: sha256Bytes(templateFile.bytes),
    });
    const record = { manifest, sourceManifest: manifest, manifestBytes: manifestFile.bytes, sourceManifestBytes: manifestFile.bytes, allowlist, allowlistBytes: allowlistFile.bytes, templateBytes: templateFile.bytes, contractBytes: contractFile.bytes, promptBytes: promptFile.bytes, sourceRoot: packageRoot, packageRoot, target };
    await verifyIsolatedPackageFileSet(packageRoot, target);
    await verifyMaterializedAssignmentPixels({ manifest, bundleRoot: packageRoot });
    packageRecords.push(record);
  }
  const trusted = await verifyTrustedVisualReviewRun({
    repoRoot, runRoot, orchestration, orchestrationBytes: orchestrationFile.bytes,
    privateSidecar, privateSidecarBytes: sidecarFile.bytes,
    assignmentAttestation, assignmentAttestationBytes: packageAttestationFile.bytes,
    registry, registryBytes: registryFile.bytes, pack, packBytes: packFile.bytes, catalog, catalogBytes: catalogFile.bytes,
    packageRecords, expectedCoverage,
  });
  const [passOneFile, passTwoFile] = await Promise.all([
    readContainedRegular(runRoot, 'review-batches/pass-1/assignment-manifest.json', 'pass-1 assignment manifest'),
    readContainedRegular(runRoot, 'review-batches/pass-2/assignment-manifest.json', 'pass-2 assignment manifest'),
  ]);
  const passOne = JSON.parse(passOneFile.bytes); const passTwo = JSON.parse(passTwoFile.bytes);
  const assignmentSets = [passOne, passTwo];
  try {
    const passThreeFile = await readContainedRegular(runRoot, 'review-batches/pass-3/assignment-manifest.json', 'pass-3 adjudication assignment manifest');
    assignmentSets.push(JSON.parse(passThreeFile.bytes));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  validateAssignmentSets(assignmentSets, packageRecords, sha256Bytes(orchestrationFile.bytes));
  const reviewerPackages = new Map();
  const packageRecordByTarget = new Map(packageRecords.map((record) => [record.target.opaqueInputId, record]));
  const [trustedBatchSchemaBytes, trustedVoteSchemaBytes] = await Promise.all([
    readContainedRegular(repoRoot, 'production/contracts/visual-review-batch-v1.schema.json', 'trusted batch observation schema'),
    readContainedRegular(repoRoot, 'production/contracts/visual-review-v1.schema.json', 'trusted vote schema'),
  ]);
  JSON.parse(trustedBatchSchemaBytes.bytes); JSON.parse(trustedVoteSchemaBytes.bytes);
  for (const assignmentSet of assignmentSets) {
    for (const batch of assignmentSet.batches) {
      const relative = `review-batches/${assignmentSet.passId}/reviewer-packages/${batch.batchId}/package-manifest.json`;
      await assertTrustedDirectoryTree(runRoot, path.dirname(path.join(runRoot, relative)), `${batch.batchId} reviewer package`);
      const packageManifestFile = await readContainedRegular(runRoot, relative, `${batch.batchId} reviewer package manifest`);
      const packageManifest = JSON.parse(packageManifestFile.bytes);
      assertExactKeys(packageManifest, ['schemaVersion', 'bundleGenerationRunId', 'orchestrationIndexSha256', 'passId', 'assignmentSha256', 'batchId', 'targetCount', 'observationContractSha256', 'observationDependencySha256', 'targets', 'files'], 'reviewer package manifest');
      if (packageManifest.schemaVersion !== 'blinded-reviewer-batch-package-v1' || packageManifest.passId !== assignmentSet.passId || packageManifest.batchId !== batch.batchId || packageManifest.assignmentSha256 !== assignmentSet.assignmentSha256) fail(`${batch.batchId}: reviewer package assignment drift`);
      if (canonicalize(packageManifest.targets.map((target) => target.opaqueInputId)) !== canonicalize(batch.opaqueInputIds)) fail(`${batch.batchId}: reviewer package target coverage drift`);
      await verifyReviewerPackage(packageManifestFile.absolutePath, packageManifest, packageManifestFile.bytes);
      await verifyReviewerPackageSources(path.dirname(packageManifestFile.absolutePath), packageManifest, packageRecordByTarget);
      const filesByPath = new Map(packageManifest.files.map((entry) => [entry.path, entry]));
      if (filesByPath.get('observation-contract.schema.json')?.sha256 !== packageManifest.observationContractSha256 || filesByPath.get('visual-review-v1.schema.json')?.sha256 !== packageManifest.observationDependencySha256) fail(`${batch.batchId}: packaged schema commitment drift`);
      if (packageManifest.observationContractSha256 !== sha256Bytes(trustedBatchSchemaBytes.bytes) || packageManifest.observationDependencySha256 !== sha256Bytes(trustedVoteSchemaBytes.bytes)) fail(`${batch.batchId}: packaged schema differs from trusted contract`);
      for (const target of packageManifest.targets) {
        const record = packageRecordByTarget.get(target.opaqueInputId);
        if (!record || target.assignmentId !== record.manifest.assignmentId || target.targetManifestSha256 !== sha256Bytes(record.manifestBytes) || target.bundleManifestSha256 !== sha256Bytes(record.manifestBytes)) fail(`${batch.batchId}: packaged target manifest commitment drift`);
      }
      reviewerPackages.set(`${assignmentSet.passId}:${batch.batchId}`, { manifest: packageManifest, manifestSha256: sha256Bytes(packageManifestFile.bytes) });
    }
  }
  let result = trusted;
  if (args.mode !== 'bundle') {
    if (args['key-file']) fail('--key-file is forbidden in the production verifier; use --conductor-key-stdin');
    if (!args['conductor-key-stdin'] || process.stdin.isTTY) fail('--conductor-key-stdin with piped/inherited stdin is required for final verification');
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const conductorKey = Buffer.concat(chunks);
    if (conductorKey.length < 32) fail('Conductor key from stdin must contain at least 32 bytes');
    const authorizationRoot = path.join(repoRoot, '.omx/evidence/visual-census', runId, 'authorizations');
    const rawVoteRoot = path.join(repoRoot, '.omx/evidence/visual-census', runId, 'raw-votes');
    await assertTrustedDirectoryTree(repoRoot, authorizationRoot, 'authorization evidence');
    await assertTrustedDirectoryTree(repoRoot, rawVoteRoot, 'raw-vote evidence');
    const expectedAuthorizationFiles = assignmentSets.flatMap((set) => set.batches.map((batch) => `${set.passId}/${batch.batchId}.json`)).sort();
    const actualAuthorizationFiles = await listPackageFiles(authorizationRoot);
    assertExactEvidenceFileSet(actualAuthorizationFiles, expectedAuthorizationFiles, 'approved authorization');
    const reviewerAttestations = [];
    for (const relative of expectedAuthorizationFiles) {
      const file = await readContainedRegular(authorizationRoot, relative, `authorization ${relative}`);
      reviewerAttestations.push(validateAttestation(JSON.parse(file.bytes), conductorKey));
    }
    const expectedVoteFiles = reviewerAttestations.flatMap((auth) => auth.assignedOpaqueInputIds.map((id) => `${auth.passId}/${auth.batchId}/${id}.json`)).sort();
    const actualVoteFiles = await listPackageFiles(rawVoteRoot);
    assertExactEvidenceFileSet(actualVoteFiles, expectedVoteFiles, 'approved raw-vote');
    const votes = [];
    for (const relative of expectedVoteFiles) {
      const file = await readContainedRegular(rawVoteRoot, relative, `raw vote ${relative}`);
      votes.push(JSON.parse(file.bytes));
    }
    const assertedSummary = args.summary ? await readJson(args.summary) : undefined;
    if (args.mode === 'derive-adjudication') {
      if (assignmentSets.length !== 2) fail('adjudication targets must be derived before pass-3 is appended');
      deriveRunVerdicts({ packageRecords, votes, reviewerAttestations, assignmentSets, expectedBundleManifestSha256: sha256Bytes(orchestrationFile.bytes), assertedSummary, conductorKey, reviewerPackages, allowPendingAdjudication: true });
      const document = finalizeAdjudicationTargets({ schemaVersion: 'blinded-visual-adjudication-targets-v1', bundleGenerationRunId: runId, orchestrationIndexSha256: sha256Bytes(orchestrationFile.bytes), targets: deriveTaxonomyAdjudicationTargetIds(packageRecords, votes) }, conductorKey);
      const bytes = `${JSON.stringify(document, null, 2)}\n`;
      if (args.output) await writeAtomicAdjudicationTargets(repoRoot, runId, args.output, bytes); else process.stdout.write(bytes);
      return;
    }
    result = deriveRunVerdicts({ packageRecords, votes, reviewerAttestations, assignmentSets, expectedBundleManifestSha256: sha256Bytes(orchestrationFile.bytes), assertedSummary, conductorKey, reviewerPackages });
    result.trustedRun = trusted;
  }
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output && args.mode === 'bundle') fail('READY_FOR_REVIEW bundle verification is stdout-only');
  if (args.output) await writeAtomicApproved(repoRoot, runId, args.output, output);
  else process.stdout.write(output);
  if (!['PASS', 'READY_FOR_REVIEW'].includes(result.verdict)) process.exitCode = 1;
}

export function assertNoAggregateInputs(args) {
  if (args.votes || args['reviewer-attestations']) fail('--votes and --reviewer-attestations aggregate inputs are forbidden; final verification reads approved evidence roots only');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
