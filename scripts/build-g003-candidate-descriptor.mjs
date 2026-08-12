#!/usr/bin/env node

/**
 * Build a non-authoritative queue material descriptor from immutable staged
 * candidate bytes. The conductor prepare command remains the authority and
 * revalidates every descriptor field before creating a reviewer package.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, ensureSafeDirectory, readContainedFile } from './lib/continuity-assignment/evidence.mjs';
import { verifyPublicEvidence } from './lib/g002-public-authority.mjs';
import { verifyG002V1BaseAuthority } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { assertG003ActiveBaseline, loadLockedG003Gate, withExclusiveG003Operation } from './conduct-g003-reviews.mjs';
import { assertGenerationRunId, PRIVATE_DESCRIPTOR_ROOT } from './prepare-continuity-candidate-review.mjs';
import { discoverCurrentAcceptedArtifacts } from './verify-biological-continuity-v3-pack.mjs';
import { G003_PROTOCOL_AUTHORITY_SHA256, G003_V4_EVIDENCE } from './lib/g003-v4-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_ROOT = 'assets/creatures/biological-continuity-v3';
const G003_EVIDENCE = G003_V4_EVIDENCE;
const G002_ASSIGNMENT = 'production/reports/biological-continuity-v3/g002-evidence-v2/assignment-manifest.json';
const PIXEL_CLUSTERS = 'production/reports/biological-continuity-v3/g002-evidence-v1/pixel-clusters.json';
const PUBLIC_EVIDENCE_MANIFEST = 'production/reports/biological-continuity-v3/g002-evidence-v2/public-evidence-manifest.json';
const SLOT = /^PG-[0-9]{3}$/;
const SHA = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROVENANCE_KEYS = ['schemaVersion', 'slotId', 'generationRunId', 'sourceKind', 'promptSha256', 'workspaceMaster', 'candidateMaster', 'runtime', 'derivation'];
const PNG_DESCRIPTOR_KEYS = ['path', 'sha256', 'bytes', 'width', 'height'];
const DERIVATION = Object.freeze({
  engine: 'pngjs', engineVersion: '3.4.0', resampler: 'LANCZOS3-premultiplied-alpha',
  width: 360, height: 360, mode: 'RGBA', colorSpace: 'sRGB', pngCompressionLevel: 9,
  metadataPolicy: 'strip-and-write-srgb-rendering-intent-0',
});

function fail(message) { throw new Error(`G003 descriptor builder: ${message}`); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const missing = expected.filter((key) => !(key in value)); const extra = Object.keys(value).filter((key) => !expected.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}
function containedRelation(root, target) {
  const relation = path.relative(path.resolve(root), path.resolve(target));
  return relation && !relation.startsWith('..') && !path.isAbsolute(relation) ? relation : null;
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
async function parseCanonicalJson(repoRoot, relativePath, label) {
  return parseCanonicalBytes(await readContainedFile(repoRoot, relativePath, label), label);
}

async function verifyPngDescriptor(repoRoot, descriptor, label, expectedPath, { runtime = false } = {}) {
  exactKeys(descriptor, PNG_DESCRIPTOR_KEYS, `${label} descriptor`);
  assertCanonicalRelativePath(descriptor.path, `${label} path`);
  if (descriptor.path !== expectedPath || !SHA.test(descriptor.sha256 ?? '') || !Number.isInteger(descriptor.bytes) || descriptor.bytes < 1
      || !Number.isInteger(descriptor.width) || descriptor.width < 1 || !Number.isInteger(descriptor.height) || descriptor.height < 1) fail(`${label} descriptor is invalid`);
  const bytes = await readContainedFile(repoRoot, descriptor.path, label);
  if (bytes.length !== descriptor.bytes || sha256Bytes(bytes) !== descriptor.sha256 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail(`${label} bytes differ from staged provenance`);
  let decoded;
  try { decoded = PNG.sync.read(bytes, { checkCRC: true, skipRescale: false }); } catch (error) { fail(`${label} PNG/CRC is invalid: ${error.message}`); }
  if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) fail(`${label} dimensions differ from staged provenance`);
  if (runtime && (decoded.width !== 360 || decoded.height !== 360 || bytes[25] !== 6 || !bytes.includes(Buffer.from('sRGB')))) fail('staged runtime is not the required 360x360 RGBA/sRGB derivative');
  return bytes;
}

async function verifyStagedCandidate(repoRoot, slotId, generationRunId) {
  const candidateRoot = `${STAGING_ROOT}/candidates/${generationRunId}/${slotId}`;
  const provenancePath = `${candidateRoot}/provenance.json`;
  let provenance;
  try { provenance = await parseCanonicalJson(repoRoot, provenancePath, 'staged provenance'); }
  catch (error) { if (/ENOENT|does not exist/.test(error.message)) fail(`staged provenance is missing for ${slotId}/${generationRunId}`); throw error; }
  exactKeys(provenance, PROVENANCE_KEYS, 'staged provenance');
  if (provenance.schemaVersion !== 'continuity-candidate-provenance-v1' || provenance.slotId !== slotId
      || provenance.generationRunId !== generationRunId || provenance.sourceKind !== 'local-built-in-imagegen-png'
      || !SHA.test(provenance.promptSha256 ?? '') || canonicalStringify(provenance.derivation) !== canonicalStringify(DERIVATION)) fail('staged provenance identity or derivation is invalid');
  const masterPath = `${candidateRoot}/master.png`; const runtimePath = `${candidateRoot}/runtime.png`;
  const masterBytes = await verifyPngDescriptor(repoRoot, provenance.candidateMaster, 'candidate master', masterPath);
  if (provenance.candidateMaster.width !== provenance.candidateMaster.height || provenance.candidateMaster.width < 1024) fail('staged master must be square and at least 1024px');
  const expectedWorkspacePath = `${STAGING_ROOT}/workspace-masters/${generationRunId}/${slotId}/${provenance.candidateMaster.sha256}.png`;
  const workspaceBytes = await verifyPngDescriptor(repoRoot, provenance.workspaceMaster, 'workspace master', expectedWorkspacePath);
  if (provenance.workspaceMaster.sha256 !== provenance.candidateMaster.sha256
      || provenance.workspaceMaster.bytes !== provenance.candidateMaster.bytes
      || provenance.workspaceMaster.width !== provenance.candidateMaster.width
      || provenance.workspaceMaster.height !== provenance.candidateMaster.height
      || !workspaceBytes.equals(masterBytes)) fail('workspace and candidate master bindings differ');
  await verifyPngDescriptor(repoRoot, provenance.runtime, 'candidate runtime', runtimePath, { runtime: true });
  const promptBytes = await readContainedFile(repoRoot, `${candidateRoot}/prompt.txt`, 'staged prompt');
  if (!promptBytes.toString('utf8').trim() || sha256Bytes(promptBytes) !== provenance.promptSha256) fail('staged prompt differs from provenance');
  return {
    sourceSlotId: slotId,
    master: { path: provenance.candidateMaster.path, sha256: provenance.candidateMaster.sha256 },
    runtime: { path: provenance.runtime.path, sha256: provenance.runtime.sha256 },
  };
}

async function verifiedSurface(repoRoot, surface, label, { acceptedParentId = null } = {}) {
  if (!surface || typeof surface.path !== 'string' || !SHA.test(surface.sha256 ?? '')) fail(`${label} surface binding is invalid`);
  assertCanonicalRelativePath(surface.path, `${label} path`);
  if (acceptedParentId !== null) {
    const prefix = `${G003_EVIDENCE}/candidates/${acceptedParentId}/`;
    if (!surface.path.startsWith(prefix) || !surface.path.endsWith(`/blobs/sha256/${surface.sha256}.png`)) fail(`${label} is outside the accepted parent evidence root`);
  }
  const bytes = await readContainedFile(repoRoot, surface.path, label);
  if (sha256Bytes(bytes) !== surface.sha256) fail(`${label} pixel hash is stale`);
  return { path: surface.path, sha256: surface.sha256 };
}

function pixelClusterEntry(pixelClusters, slotId) {
  const matches = (pixelClusters?.entries ?? []).filter((entry) => entry.pgId === slotId);
  if (matches.length !== 1) fail(`G002 pixel clusters do not contain exactly one ${slotId} binding`);
  return matches[0];
}

async function priorPixelParent(repoRoot, pixelClusters, slotId) {
  const entry = pixelClusterEntry(pixelClusters, slotId);
  return {
    sourceSlotId: slotId,
    master: await verifiedSurface(repoRoot, entry.surfaces?.master, `${slotId} G002 master`),
    runtime: await verifiedSurface(repoRoot, entry.surfaces?.runtime, `${slotId} G002 runtime`),
  };
}

function orderedQueueParentIds(queue) {
  const required = queue.requiredParentCandidateIds ?? [];
  if (!Array.isArray(required) || new Set(required).size !== required.length
      || required.some((candidateId) => !/^g003-candidate:PG-[0-9]{3}$/.test(candidateId))) fail('queue generated-parent requirements are invalid');
  const roleToParent = new Map(); const parentToRole = new Map();
  for (const anchor of queue.allowedAnchors ?? []) {
    if (anchor.parentId === null || anchor.parentId === undefined) continue;
    if (!SLOT.test(anchor.parentId) || !/^parent-[12]$/.test(anchor.parentRole ?? '')) fail('queue parent anchor routing is invalid');
    if ((roleToParent.has(anchor.parentRole) && roleToParent.get(anchor.parentRole) !== anchor.parentId)
        || (parentToRole.has(anchor.parentId) && parentToRole.get(anchor.parentId) !== anchor.parentRole)) fail('queue parent roles are ambiguous');
    roleToParent.set(anchor.parentRole, anchor.parentId); parentToRole.set(anchor.parentId, anchor.parentRole);
  }
  const ordered = [...roleToParent].sort(([left], [right]) => left.localeCompare(right)).map(([, parentId]) => parentId);
  const requiredSlots = required.map((candidateId) => candidateId.slice('g003-candidate:'.length));
  if (requiredSlots.some((parentId) => !parentToRole.has(parentId)) || ordered.length > 2) fail('queue parent coverage differs from locked G002 gate');
  return { ordered, required: new Set(requiredSlots) };
}

function currentTipMap(discovered) {
  if (!Array.isArray(discovered?.tips)) fail('current accepted parent discovery is unavailable');
  const result = new Map();
  for (const tip of discovered.tips) {
    if (typeof tip?.requirementId !== 'string' || result.has(tip.requirementId)) fail('current accepted parent tips are duplicated or malformed');
    result.set(tip.requirementId, tip);
  }
  return result;
}

async function approvedParent(repoRoot, tips, candidateId) {
  const parentId = candidateId.slice('g003-candidate:'.length); const record = tips.get(candidateId); const artifact = record?.artifact;
  if (!record || record.requirementKind !== 'queue' || record.requirementId !== candidateId || artifact?.reviewKind !== 'queue'
      || artifact.requirementId !== candidateId || artifact.candidateId !== candidateId || record.reviewSha256 !== artifact.review?.sha256
      || canonicalStringify(record.childPixels) !== canonicalStringify(artifact.childPixels)) fail(`dependent queue candidate requires current approved parent ${candidateId}`);
  assertGenerationRunId(record.generationRunId, `${candidateId} accepted parent generationRunId`);
  const bySurface = new Map((artifact.childPixels ?? []).map((surface) => [surface.surface, surface]));
  if (bySurface.size !== 2 || !bySurface.has('master') || !bySurface.has('runtime')) fail(`${candidateId} accepted parent pixels are incomplete`);
  return {
    sourceSlotId: parentId,
    master: await verifiedSurface(repoRoot, bySurface.get('master'), `${candidateId} accepted master`, { acceptedParentId: parentId }),
    runtime: await verifiedSurface(repoRoot, bySurface.get('runtime'), `${candidateId} accepted runtime`, { acceptedParentId: parentId }),
  };
}

async function resolveOutput(outputPath, repoRoot) {
  if (typeof outputPath !== 'string' || !outputPath || path.extname(outputPath) !== '.json') fail('--output must name a JSON file');
  if (!path.isAbsolute(outputPath)) {
    assertCanonicalRelativePath(outputPath, 'descriptor output');
    if (outputPath === '.' || path.posix.normalize(outputPath) !== outputPath) fail('descriptor output is not canonical');
    if (!outputPath.startsWith(`${PRIVATE_DESCRIPTOR_ROOT}/`)) fail(`repository-relative descriptor output must be beneath ${PRIVATE_DESCRIPTOR_ROOT}`);
    return { target: path.resolve(repoRoot, outputPath), containmentRoot: path.resolve(repoRoot), displayPath: outputPath };
  }
  if (path.normalize(outputPath) !== outputPath || outputPath.split(path.sep).includes('..')) fail('absolute descriptor output is not canonical');
  const absolute = path.resolve(outputPath); const lexicalTemp = path.resolve(os.tmpdir()); const canonicalTemp = await realpath(lexicalTemp);
  const relation = containedRelation(lexicalTemp, absolute) ?? containedRelation(canonicalTemp, absolute);
  if (relation) return { target: path.join(canonicalTemp, relation), containmentRoot: canonicalTemp, displayPath: outputPath };
  fail('absolute descriptor output must be beneath the current temporary directory');
}

async function captureOutputParent(containmentRoot, target) {
  const root = path.resolve(containmentRoot); const parent = path.dirname(path.resolve(target));
  await ensureSafeDirectory(root, parent, 'descriptor output');
  const [info, resolvedRoot, resolvedParent] = await Promise.all([lstat(parent, { bigint: true }), realpath(root), realpath(parent)]);
  const relation = path.relative(resolvedRoot, resolvedParent);
  if (!info.isDirectory() || info.isSymbolicLink() || relation.startsWith('..') || path.isAbsolute(relation)) fail('descriptor output parent is unsafe');
  return { parent, resolvedParent, dev: info.dev, ino: info.ino };
}

async function assertOutputParentIdentity(identity) {
  let info; let resolved;
  try {
    [info, resolved] = await Promise.all([lstat(identity.parent, { bigint: true }), realpath(identity.parent)]);
  } catch (error) {
    if (error.code === 'ENOENT') fail('descriptor output parent changed before publish');
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino
      || resolved !== identity.resolvedParent) fail('descriptor output parent changed before publish');
}

async function unlinkOwned(filePath, parentIdentity, fileIdentity) {
  try {
    await assertOutputParentIdentity(parentIdentity);
    const info = await lstat(filePath, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== fileIdentity.dev || info.ino !== fileIdentity.ino) return false;
    await unlink(filePath); return true;
  } catch (error) {
    if (error.code === 'ENOENT' || /parent changed before publish/.test(error.message)) return false;
    throw error;
  }
}

async function writeExclusiveCanonical({ target, containmentRoot }, value, { beforePublish = null } = {}) {
  const bytes = Buffer.from(canonicalStringify(value)); const parentIdentity = await captureOutputParent(containmentRoot, target);
  if (beforePublish) await beforePublish();
  await assertOutputParentIdentity(parentIdentity);
  const temporary = path.join(parentIdentity.parent, `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let handle; let fileIdentity; let temporaryExists = false; let targetLinked = false; let complete = false;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o644);
    temporaryExists = true;
    await handle.writeFile(bytes); await handle.chmod(0o644); await handle.sync();
    fileIdentity = await handle.stat({ bigint: true });
    if (!fileIdentity.isFile() || fileIdentity.nlink !== 1n) fail('descriptor staging output is not an independent regular file');
    await assertOutputParentIdentity(parentIdentity);
    try { await link(temporary, target); targetLinked = true; }
    catch (error) { if (error.code === 'EEXIST') fail(`refusing to overwrite descriptor output: ${target}`); throw error; }
    await assertOutputParentIdentity(parentIdentity);
    if (!(await unlinkOwned(temporary, parentIdentity, fileIdentity))) fail('descriptor staging output changed before publish');
    temporaryExists = false;
    const verified = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const info = await verified.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.dev !== fileIdentity.dev || info.ino !== fileIdentity.ino
          || !(await verified.readFile()).equals(bytes)) fail('published descriptor bytes or identity differ from staged output');
    } finally { await verified.close(); }
    await assertOutputParentIdentity(parentIdentity); complete = true;
  } finally {
    if (handle) await handle.close();
    if (temporaryExists && fileIdentity) await unlinkOwned(temporary, parentIdentity, fileIdentity);
    if (targetLinked && !complete && fileIdentity) await unlinkOwned(target, parentIdentity, fileIdentity);
  }
}

async function buildFromVerifiedInputs({ slotId, generationRunId, outputPath, repoRoot, gate, pixelClusters, discovered, testBeforeDescriptorPublish = null }) {
  if (!SLOT.test(slotId ?? '')) fail('invalid --slot'); assertGenerationRunId(generationRunId, '--generation-run-id');
  const output = await resolveOutput(outputPath, repoRoot);
  if (gate?.schemaVersion !== 'continuity-g003-review-gate-v2' || gate.state !== 'PENDING_G003_REVIEW'
      || gate.completionAllowed !== false || !Array.isArray(gate.queueCandidates) || !Array.isArray(gate.edgeCandidates)) fail('locked G002 review gate is invalid');
  const queueMatches = gate.queueCandidates.filter((entry) => entry.slotId === slotId && entry.candidateId === `g003-candidate:${slotId}`);
  if (queueMatches.length !== 1) fail(`${slotId} is retained, non-queue, or ambiguously routed`);
  const queue = queueMatches[0]; const child = await verifyStagedCandidate(repoRoot, slotId, generationRunId);
  const routing = orderedQueueParentIds(queue); const parents = [];
  if (routing.ordered.length === 0) {
    if (routing.required.size !== 0) fail('root queue candidate has generated-parent requirements');
    parents.push(await priorPixelParent(repoRoot, pixelClusters, slotId));
  } else {
    const tips = currentTipMap(discovered);
    for (const parentId of routing.ordered) {
      const candidateId = `g003-candidate:${parentId}`;
      parents.push(routing.required.has(parentId)
        ? await approvedParent(repoRoot, tips, candidateId)
        : await priorPixelParent(repoRoot, pixelClusters, parentId));
    }
  }
  const descriptor = {
    schemaVersion: 'continuity-candidate-material-v4', protocolAuthoritySha256:G003_PROTOCOL_AUTHORITY_SHA256, candidateId: queue.candidateId,
    generationRunId, reviewKind: 'asset-reuse', child, parents,
  };
  await writeExclusiveCanonical(output, descriptor, { beforePublish: testBeforeDescriptorPublish });
  return { descriptor, outputPath: output.displayPath, descriptorSha256: sha256Canonical(descriptor) };
}

async function buildEdgeFromVerifiedInputs({ edgeId, generationRunId, outputPath, repoRoot, gate, pixelClusters, discovered, testBeforeDescriptorPublish = null }) {
  if (!/^g003-edge:PG-[0-9]{3}:PG-[0-9]{3}$/.test(edgeId ?? '')) fail('invalid --edge-id');
  assertGenerationRunId(generationRunId, '--generation-run-id');
  const output = await resolveOutput(outputPath, repoRoot);
  if (gate?.schemaVersion !== 'continuity-g003-review-gate-v2' || gate.state !== 'PENDING_G003_REVIEW'
      || gate.completionAllowed !== false || !Array.isArray(gate.queueCandidates) || !Array.isArray(gate.edgeCandidates)) fail('locked G002 review gate is invalid');
  const matches = gate.edgeCandidates.filter((entry) => entry.edgeId === edgeId);
  if (matches.length !== 1) fail(`${edgeId} is absent or ambiguously routed`);
  const edge = matches[0]; const tips = currentTipMap(discovered);
  const child = gate.queueCandidates.some((entry) => entry.slotId === edge.childId)
    ? await approvedParent(repoRoot, tips, `g003-candidate:${edge.childId}`)
    : await priorPixelParent(repoRoot, pixelClusters, edge.childId);
  const parents = [];
  for (const parent of edge.allowedParentAnchors) {
    const generated = gate.queueCandidates.some((entry) => entry.slotId === parent.parentId);
    parents.push(generated
      ? await approvedParent(repoRoot, tips, `g003-candidate:${parent.parentId}`)
      : await priorPixelParent(repoRoot, pixelClusters, parent.parentId));
  }
  const descriptor = {
    schemaVersion: 'continuity-candidate-material-v4', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
    candidateId: edge.edgeId, generationRunId, reviewKind: 'new-edge', child, parents,
  };
  await writeExclusiveCanonical(output, descriptor, { beforePublish: testBeforeDescriptorPublish });
  return { descriptor, outputPath: output.displayPath, descriptorSha256: sha256Canonical(descriptor) };
}

export function verifyPinnedPublicManifestBytes(manifestBytes, snapshot) {
  if (!Buffer.isBuffer(manifestBytes) || !SHA.test(snapshot?.signedPublicEvidence?.fileSha256 ?? '')
      || sha256Bytes(manifestBytes) !== snapshot.signedPublicEvidence.fileSha256) fail('signed G002 public evidence differs from the active baseline file SHA');
  const manifest = parseCanonicalBytes(manifestBytes, 'signed G002 public evidence manifest');
  const unsignedManifest = structuredClone(manifest); delete unsignedManifest.publicSignature;
  verifyPublicEvidence(unsignedManifest, manifest.publicSignature);
  return manifest;
}

export function parseHashBoundJsonBytes(bytes, binding, label) {
  if (!Buffer.isBuffer(bytes) || !SHA.test(binding?.sha256 ?? '') || sha256Bytes(bytes) !== binding.sha256) fail(`${label} bytes differ from signed public evidence`);
  return parseJsonBytes(bytes, label);
}

async function productionVerifiedInputs() {
  const snapshot = await assertG003ActiveBaseline();
  if (snapshot.signedPublicEvidence.path !== PUBLIC_EVIDENCE_MANIFEST) fail('active G002 public evidence path is unexpected');
  const manifestBytes = await readContainedFile(ROOT, snapshot.signedPublicEvidence.path, 'signed G002 public evidence manifest');
  const manifest = verifyPinnedPublicManifestBytes(manifestBytes, snapshot); const gate = await loadLockedG003Gate();
  const bindings = new Map((manifest.files ?? []).map((binding) => [binding.path, binding]));
  if (bindings.size !== manifest.files?.length || !bindings.has(G002_ASSIGNMENT)) fail('signed G002-v2 public evidence lacks assignment binding');
  const verifiedBase=await verifyG002V1BaseAuthority(ROOT,manifest.baseAuthority);const baseBindings=new Map(verifiedBase.manifest.files.map((binding)=>[binding.path,binding]));if(!baseBindings.has(PIXEL_CLUSTERS))fail('signed G002-v1 base evidence lacks pixel binding');
  const [assignmentBytes, pixelBytes, discovered] = await Promise.all([
    readContainedFile(ROOT, G002_ASSIGNMENT), readContainedFile(ROOT, PIXEL_CLUSTERS), discoverCurrentAcceptedArtifacts(),
  ]);
  const assignment = parseHashBoundJsonBytes(assignmentBytes, bindings.get(G002_ASSIGNMENT), 'signed G002 assignment');
  const pixelClusters = parseHashBoundJsonBytes(pixelBytes, baseBindings.get(PIXEL_CLUSTERS), 'signed G002 pixel clusters');
  if (canonicalStringify(assignment.reviewCoverageManifest) !== canonicalStringify(gate)) fail('locked G002 gate differs from signed assignment bytes');
  return { gate, pixelClusters, discovered };
}

export async function buildQueueCandidateDescriptor({ slotId, generationRunId, outputPath } = {}) {
  return withExclusiveG003Operation('build-candidate-descriptor', async () => {
    const verified = await productionVerifiedInputs();
    return buildFromVerifiedInputs({ slotId, generationRunId, outputPath, repoRoot: ROOT, ...verified });
  });
}

export async function buildEdgeCandidateDescriptor({ edgeId, generationRunId, outputPath } = {}) {
  return withExclusiveG003Operation('build-edge-descriptor', async () => {
    const verified = await productionVerifiedInputs();
    return buildEdgeFromVerifiedInputs({ edgeId, generationRunId, outputPath, repoRoot: ROOT, ...verified });
  });
}

// Fixture-only seam: production CLI never accepts gate, pixel, or parent hashes.
export async function buildQueueCandidateDescriptorFixture({ slotId, generationRunId, outputPath, repoRoot, verifiedInputs, testBeforeDescriptorPublish = null } = {}) {
  return withExclusiveG003Operation('build-candidate-descriptor-fixture', () => buildFromVerifiedInputs({
    slotId, generationRunId, outputPath, repoRoot, ...verifiedInputs, testBeforeDescriptorPublish,
  }), { repoRoot });
}

export async function buildEdgeCandidateDescriptorFixture({ edgeId, generationRunId, outputPath, repoRoot, verifiedInputs, testBeforeDescriptorPublish = null } = {}) {
  return withExclusiveG003Operation('build-edge-descriptor-fixture', () => buildEdgeFromVerifiedInputs({
    edgeId, generationRunId, outputPath, repoRoot, ...verifiedInputs, testBeforeDescriptorPublish,
  }), { repoRoot });
}

function parseCli(args) {
  if (args.length !== 6) fail('usage: --slot PG-NNN --generation-run-id RUN --output RELATIVE_OR_TMP_PATH');
  const allowed = new Set(['--slot', '--edge-id', '--generation-run-id', '--output']); const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!allowed.has(flag) || flag in values || typeof value !== 'string' || value.startsWith('--')) fail('usage: --slot PG-NNN --generation-run-id RUN --output RELATIVE_OR_TMP_PATH');
    values[flag] = value;
  }
  if (Boolean(values['--slot']) === Boolean(values['--edge-id']) || !values['--generation-run-id'] || !values['--output']) fail('usage: (--slot PG-NNN | --edge-id g003-edge:PG-NNN:PG-NNN) --generation-run-id RUN --output PATH');
  return { slotId: values['--slot'], edgeId: values['--edge-id'], generationRunId: values['--generation-run-id'], outputPath: values['--output'] };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const result = options.edgeId ? await buildEdgeCandidateDescriptor(options) : await buildQueueCandidateDescriptor(options);
  console.log(JSON.stringify({ status: 'BUILT_NON_AUTHORITATIVE_DESCRIPTOR', candidateId: result.descriptor.candidateId,
    output: result.outputPath, descriptorSha256: result.descriptorSha256, parentSlots: result.descriptor.parents.map((parent) => parent.sourceSlotId) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
