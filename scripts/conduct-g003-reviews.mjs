#!/usr/bin/env node

/**
 * G003 conductor boundary.
 *
 * Serialized dependency summaries are never accepted as authority. Every
 * command that needs a generated parent revalidates persisted review bytes in
 * this process so prepare-continuity-candidate-review.mjs can issue a WeakSet-
 * backed trusted dependency object.
 */

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import {
  ensureSafeDirectory, listContainedRegularFiles, readContainedFile, readJson, writeCanonicalFile, writeFileAtomicNoFollow,
} from './lib/continuity-assignment/evidence.mjs';
import { assertG003ConductorKeyPinned, g003PurposeHmac, signG003PublicEvidence, verifyG003PublicEvidence } from './lib/g003-public-authority.mjs';
import { G002_V2_ASSIGNMENT, G003_AUTHORITY, G003_COUNTS, G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256, G003_SCHEMA_BINDINGS, G003_V4_EVIDENCE, assertG003V4BaselineShape, verifyG003V4Authority } from './lib/g003-v4-authority.mjs';
import { assertG003V4NotFrozen } from './lib/g003-v4-freeze-inventory.mjs';
import { withG003TransitionLock } from './lib/g003-transition-integrity.mjs';
import { adjudicateQuarantineInvalidityV1, assertRejectionObservationV2, readReviewerAuthoredObservation } from './lib/g003-v5-authority.mjs';
import {
  assertGenerationRunId, candidateMaterialBindingSha256, finalizeCandidateVote, materializeCandidatePackage, validateCandidateReview,
  validateCandidateObservationAgainstBinding, validateRawCandidateObservation, verifyCandidatePackageContext,
} from './prepare-continuity-candidate-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G002_ASSIGNMENT = G002_V2_ASSIGNMENT;
const EVIDENCE = G003_V4_EVIDENCE;
export const G003_FINALIZING_STATE = `${EVIDENCE}/finalization/finalizing.json`;
export const G003_TERMINAL_STATE = `${EVIDENCE}/finalization/terminal.json`;
const SHA = /^[a-f0-9]{64}$/;
const ACTIVE_BASELINE_SHA256 = G003_AUTHORITY.publicManifestOutputSha256;
const ACTIVE_BASELINE_FILE_SHA256 = G003_AUTHORITY.publicManifestFileSha256;
const G003_KERNEL_LOCK_DOMAIN = 'punchgrow:g003:exclusive-operation-lock-v1\0';
const G003_KERNEL_LOCK_HOST = '127.0.0.1';
const G003_KERNEL_LOCK_PORT_BASE = 49_152;
const G003_KERNEL_LOCK_PORT_COUNT = 65_535 - G003_KERNEL_LOCK_PORT_BASE + 1;
const PROTECTED_BASELINE_BINDINGS = Object.freeze([
  Object.freeze({ path: 'config/creature-assets.json', sha256: '27fbc75e2347a9048ea0d215df56ba8e3fbc62e6d66e9e875b3ed886d8a894bb' }),
  Object.freeze({ path: 'production/catalog/creatures.json', sha256: 'd9a3265d8e8f07d9ce7f3de52affe3420df4d2aa3406a7f4f364ae1380e9e8a0' }),
  Object.freeze({ path: 'macos/Sources/PunchGrowMenuBar/Resources/creatures.json', sha256: 'd9a3265d8e8f07d9ce7f3de52affe3420df4d2aa3406a7f4f364ae1380e9e8a0' }),
  Object.freeze({ path: 'production/manifests/creature-asset-packs/cute-redesign-v2.json', sha256: '7bb53a3cbdc04ba22ff1c68ca174d92e014d7725c16edcd32fcc175e0ecdf3fa' }),
]);
const AUTHORITY_DOMAINS = Object.freeze({
  assignment: 'punchgrow:g003:reviewer-assignment-v1:hmac\0',
  run: 'punchgrow:g003:reviewer-run-attestation-v1:hmac\0',
  supersession: 'punchgrow:g003:accepted-review-supersession-v1:hmac\0',
  rejection: 'punchgrow:g003:rejected-candidate-v1:hmac\0',
  rejectionIndex: 'punchgrow:g003:rejection-index-v1:hmac\0',
});
const AUTHORITY_SCHEMA_BY_DOMAIN = new Map([
  [AUTHORITY_DOMAINS.assignment, 'continuity-g003-reviewer-assignment-v1'],
  [AUTHORITY_DOMAINS.run, 'continuity-g003-reviewer-run-attestation-v1'],
  [AUTHORITY_DOMAINS.supersession, 'continuity-g003-accepted-review-supersession-v1'],
  [AUTHORITY_DOMAINS.rejection, 'continuity-rejected-candidate-v1'],
  [AUTHORITY_DOMAINS.rejectionIndex, 'continuity-g003-rejection-tombstone-v1'],
]);
const AUTHORITY_SCHEMAS = new Set(AUTHORITY_SCHEMA_BY_DOMAIN.values());

function fail(message) { throw new Error(`G003 conductor: ${message}`); }
function rel(...parts) { return parts.join('/'); }
function unsignedPublic(value) { const copy = structuredClone(value); delete copy.publicSignature; return copy; }
function coreWithoutOutput(value) { const copy = structuredClone(value); delete copy.publicSignature; delete copy.outputSha256; return copy; }
function withoutAuthority(value) { const copy = structuredClone(value); delete copy.publicSignature; delete copy.conductorHmacSha256; delete copy.outputSha256; return copy; }
function signatureProfile(value) {
  const schemaVersion = value?.schemaVersion;
  if (typeof schemaVersion !== 'string' || !/^continuity-[a-z0-9-]+-v[0-9]+$/.test(schemaVersion)) fail('signed authority schemaVersion is invalid');
  return { purpose: `g003:${schemaVersion}`, schemaSha256: sha256Canonical({ schemaVersion, fields: Object.keys(value).sort() }) };
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const missing = keys.filter((key) => !(key in value)); const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}
function authorityHmac(domain, value, key) { return g003PurposeHmac(domain, value, key); }
function finalizeAuthority(core, domain, key) {
  if (core.schemaVersion !== AUTHORITY_SCHEMA_BY_DOMAIN.get(domain)) fail('signed authority schema/domain mismatch');
  const boundCore = { ...core, protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256 };
  const output = { ...boundCore, outputSha256: sha256Canonical(boundCore) };
  const hmac = { ...output, conductorHmacSha256: authorityHmac(domain, output, key) };
  return { ...hmac, publicSignature: signG003PublicEvidence(hmac, key, signatureProfile(hmac)) };
}
function verifyAuthority(value, domain, key, label) {
  if (value?.schemaVersion !== AUTHORITY_SCHEMA_BY_DOMAIN.get(domain) || value.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256) fail(`${label} schema/protocol authority is invalid`);
  const core = withoutAuthority(value); const output = { ...core, outputSha256: value.outputSha256 };
  if (value.outputSha256 !== sha256Canonical(core) || value.conductorHmacSha256 !== authorityHmac(domain, output, key)) fail(`${label} output/HMAC is invalid`);
  const unsigned = structuredClone(value); delete unsigned.publicSignature; verifyG003PublicEvidence(unsigned, value.publicSignature, signatureProfile(unsigned));
}
function verifyAuthorityPublic(value, label) {
  if (!AUTHORITY_SCHEMAS.has(value?.schemaVersion) || value.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256) fail(`${label} schema/protocol authority is invalid`);
  const core = withoutAuthority(value);
  if (value.outputSha256 !== sha256Canonical(core) || !SHA.test(value.conductorHmacSha256 ?? '')) fail(`${label} output/HMAC shape is invalid`);
  const unsigned = structuredClone(value); delete unsigned.publicSignature; verifyG003PublicEvidence(unsigned, value.publicSignature, signatureProfile(unsigned));
}
function assertExactCoverageIds(requiredIds, actualIds, label) {
  if (new Set(requiredIds).size !== requiredIds.length || new Set(actualIds).size !== actualIds.length
      || JSON.stringify([...requiredIds].sort()) !== JSON.stringify([...actualIds].sort())) fail(`${label} does not match exact locked ID set`);
}
function assertRejectionSource(source) {
  if (typeof source !== 'string' || !source || source.includes('\\') || path.posix.normalize(source) !== source
      || path.posix.isAbsolute(source) || source.split('/').some((component) => component === '..' || component === '.')) {
    fail(`rejection source is non-canonical: ${source}`);
  }
  const sourceAbsolute = path.resolve(ROOT, source);
  const allowedRoots = [
    'assets/creatures/biological-continuity-v3/candidates', '.omx/evidence/continuity-candidates',
    `${EVIDENCE}/candidates`, `${EVIDENCE}/edges`,
  ].map((relativeRoot) => path.resolve(ROOT, relativeRoot));
  const contained = allowedRoots.some((allowedRoot) => {
    const relation = path.relative(allowedRoot, sourceAbsolute);
    return Boolean(relation) && !relation.startsWith('..') && !path.isAbsolute(relation);
  });
  if (!contained) {
    fail(`rejection source is outside isolated candidate evidence: ${source}`);
  }
}
function candidateMaterialSha256s(candidate) {
  const child = candidate?.child?.surfaces ?? candidate?.child;
  const values = [child?.master?.sha256, child?.runtime?.sha256].sort();
  if (values.length !== 2 || values.some((value) => !SHA.test(value ?? '')) || new Set(values).size !== 2) fail('candidate child material hashes are invalid or duplicated');
  return values;
}
function rejectionTombstoneKey(candidateId, generationRunId, materialSha256s) {
  assertGenerationRunId(generationRunId, 'rejection tombstone generationRunId');
  return sha256Canonical({ candidateId, generationRunId, materialSha256s: [...materialSha256s].sort() });
}

async function conductorKey() {
  if (process.stdin.isTTY) fail('--conductor-key-stdin requires non-TTY stdin');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const key = Buffer.concat(chunks); if (key.length < 32) fail('conductor key must contain at least 32 bytes');
  assertG003ConductorKeyPinned(key);
  return key;
}

async function stateFileExists(repoRoot, relativePath, label) {
  try {
    const info = await lstat(path.join(repoRoot, relativePath));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${label} is unsafe`);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function assertG003MutationOpen({ repoRoot = ROOT, finalizingPath = G003_FINALIZING_STATE, terminalPath = G003_TERMINAL_STATE } = {}) {
  if (await stateFileExists(repoRoot, terminalPath, 'G003 terminal state')) fail('G003 is TERMINAL; mutations are permanently closed');
  if (await stateFileExists(repoRoot, finalizingPath, 'G003 finalizing state')) fail('G003 is FINALIZING; mutations are closed');
  return true;
}

export function g003KernelLockDescriptor() {
  const digest = Buffer.from(sha256Bytes(Buffer.from(G003_KERNEL_LOCK_DOMAIN)), 'hex');
  return {
    host: G003_KERNEL_LOCK_HOST,
    port: G003_KERNEL_LOCK_PORT_BASE + (digest.readUInt16BE(0) % G003_KERNEL_LOCK_PORT_COUNT),
    domain: G003_KERNEL_LOCK_DOMAIN,
  };
}

async function acquireG003KernelLock(label) {
  const descriptor = g003KernelLockDescriptor();
  const server = createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: descriptor.host, port: descriptor.port, exclusive: true });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      const busy = new Error(`G003 conductor: G003 kernel operation lock already in progress; ${label} must retry`, { cause: error });
      busy.code = error.code;
      throw busy;
    }
    throw error;
  }
  if (!server.listening) fail('G003 kernel operation lock was not acquired');
  return { ...descriptor, server };
}

async function releaseG003KernelLock(lock) {
  if (!lock.server.listening) fail('G003 kernel operation lock was lost while held');
  await new Promise((resolve) => lock.server.close(resolve));
}

export async function withExclusiveG003Operation(label, operation, {
  repoRoot = ROOT, allowFinalizing = false,
  finalizingPath = G003_FINALIZING_STATE, terminalPath = G003_TERMINAL_STATE,
} = {}) {
  await assertG003V4NotFrozen({ repoRoot });
  return withG003TransitionLock(repoRoot, async () => {
    const lock = await acquireG003KernelLock(label);
    try {
      await assertG003V4NotFrozen({ repoRoot });
      if (!allowFinalizing) await assertG003MutationOpen({ repoRoot, finalizingPath, terminalPath });
      return await operation();
    } finally {
      await releaseG003KernelLock(lock);
    }
  });
}

export async function loadLockedG003Gate() {
  const authority = await assertG003ActiveBaseline();
  const assignment = authority.assignment;
  const value = assignment.reviewCoverageManifest;
  if (value?.schemaVersion !== 'continuity-g003-review-gate-v2' || value.queueCandidates?.length !== G003_COUNTS.regenerate || value.edgeCandidates?.length !== G003_COUNTS.edges) {
    fail('locked G002-v2 assignment does not contain the exact 177 queue / 190 edge gate');
  }
  if (value.queueCandidates.filter((item) => item.requiredParentCandidateIds.length > 0).length !== G003_COUNTS.dependentQueue
      || value.edgeCandidates.filter((item) => item.allowedParentAnchors.some((parent) => parent.sourceKind === 'generated-parent-candidate')).length !== G003_COUNTS.generatedParentEdges) {
    fail('locked generated-parent topology drifted from 123 candidates / 133 edges');
  }
  return value;
}

async function assertG003ActiveBaseline() {
  const verified=await verifyG003V4Authority(ROOT);return{...verified.baseline,...verified,signedPublicEvidence:{path:'production/reports/biological-continuity-v3/g002-evidence-v2/public-evidence-manifest.json',fileSha256:G003_AUTHORITY.publicManifestFileSha256,outputSha256:G003_AUTHORITY.publicManifestOutputSha256,runtimeAssets:240}};
}
export function assertBaselineSnapshotShape(snapshot) {
  assertG003V4BaselineShape(snapshot);
}

async function acceptedArtifactPaths() {
  const result = [];
  for (const root of [`${EVIDENCE}/candidates`, `${EVIDENCE}/edges`]) {
    try { result.push(...(await listContainedRegularFiles(ROOT, root)).filter((name) => name.endsWith('/public-review-artifact.json')).map((name) => `${root}/${name}`)); }
    catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  }
  return result;
}

export function resolveVerifiedRecordChains(records) {
  const current = [];
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.requirementId) ?? []; group.push(record); groups.set(record.requirementId, group);
  }
  for (const [requirementId, group] of groups) {
    for (const record of group) assertGenerationRunId(record?.generationRunId, `${requirementId} accepted chain generationRunId`);
    const byArtifact = new Map(group.map((record) => [record.artifactSha256, record]));
    if (byArtifact.size !== group.length) fail(`duplicate accepted artifact in chain: ${requirementId}`);
    const successors = new Map(); const roots = [];
    for (const record of group) {
      if (!record.supersession) { roots.push(record); continue; }
      const prior = byArtifact.get(record.supersession.priorArtifactSha256);
      const value = record.supersession.value;
      if (!prior || !value || value.requirementId !== requirementId || value.newGenerationRunId !== record.generationRunId
          || value.priorArtifactSha256 !== prior.artifactSha256 || value.priorReviewSha256 !== prior.reviewSha256) fail(`invalid supersession chain binding: ${requirementId}`);
      if (successors.has(prior.artifactSha256)) fail(`forked supersession chain: ${requirementId}`);
      successors.set(prior.artifactSha256, record);
    }
    if (roots.length !== 1) fail(`accepted chain requires exactly one root: ${requirementId}`);
    let cursor = roots[0]; const visited = new Set();
    let lastIssuedAt = Number.NEGATIVE_INFINITY;
    while (cursor) {
      if (visited.has(cursor.artifactSha256)) fail(`cyclic supersession chain: ${requirementId}`);
      visited.add(cursor.artifactSha256); const next = successors.get(cursor.artifactSha256); if (!next) break;
      const issuedAt = Date.parse(next.supersession.value.issuedAt);
      if (!Number.isFinite(issuedAt) || issuedAt <= lastIssuedAt) fail(`supersession chain time/order is invalid: ${requirementId}`);
      lastIssuedAt = issuedAt; cursor = next;
    }
    if (visited.size !== group.length) fail(`disconnected or rollback-spliced supersession chain: ${requirementId}`);
    current.push(cursor);
  }
  return current.sort((a, b) => a.requirementId.localeCompare(b.requirementId));
}

async function readVerifiedRecords(key) {
  const records = [];
  for (const artifactPath of await acceptedArtifactPaths()) {
    const artifactBytes = await readContainedFile(ROOT, artifactPath); const artifactSha256 = sha256Bytes(artifactBytes);
    const artifact = await verifyArtifact({ artifactPath, artifactSha256, requirementId: artifactPath });
    const requirementId = artifact.requirementId;
    assertGenerationRunId(artifact.generationRunId, `accepted artifact ${requirementId} generationRunId`);
    if ((artifact.reviewKind === 'queue' && requirementId !== artifact.candidateId)
        || (artifact.reviewKind === 'edge' && requirementId !== artifact.edgeId)) fail(`signed artifact requirement identity mismatch: ${artifactPath}`);
    let supersession = null;
    if (artifact.supersession) {
      if (!artifact.supersession.path.startsWith(`${EVIDENCE}/supersessions/`)) fail(`supersession path is outside append-only evidence: ${artifact.supersession.path}`);
      const bytes = await readContainedFile(ROOT, artifact.supersession.path);
      if (sha256Bytes(bytes) !== artifact.supersession.sha256) fail(`supersession raw hash drift: ${artifact.supersession.path}`);
      const value = JSON.parse(bytes); verifyAuthority(value, AUTHORITY_DOMAINS.supersession, key, 'accepted review supersession'); assertSupersessionValue(value);
      supersession = { ...artifact.supersession, value };
    }
    records.push({
      requirementKind: artifact.reviewKind, requirementId, generationRunId: artifact.generationRunId,
      privatePackagePath: path.posix.dirname(artifact.privateMaterialBinding.path), reviewPath: artifact.review.path, reviewSha256: artifact.review.sha256,
      artifactPath, artifactSha256, childPixels: artifact.childPixels, packageManifestSha256: artifact.packageManifest.sha256,
      materialBindingSha256: artifact.privateMaterialBinding.materialBindingSha256, inputAllowlistSha256: artifact.inputAllowlist.sha256,
      promptSha256: artifact.prompt.sha256, supersession, artifact,
    });
  }
  return resolveVerifiedRecordChains(records);
}

async function reconstructDependencies(key) {
  const dependencies = {};
  for (const record of await readVerifiedRecords(key)) {
    if (record.requirementKind !== 'queue') continue;
    const review = await readJson(ROOT, record.reviewPath);
    const result = await validateCandidateReview(review, {
      repoRoot: ROOT, packageRelative: record.privatePackagePath, conductorKey: key, persistedReviewRelative: record.reviewPath,
    });
    if (!result.trustedDependency) fail(`queue record did not reconstruct trusted dependency: ${record.requirementId}`);
    const approvedPixels = Object.fromEntries(record.childPixels.map((pixel) => [pixel.surface, pixel]));
    if (result.trustedDependency.reviewSha256 !== record.reviewSha256
        || result.trustedDependency.pixelSurfaces?.master?.sha256 !== approvedPixels.master?.sha256
        || result.trustedDependency.pixelSurfaces?.runtime?.sha256 !== approvedPixels.runtime?.sha256) fail(`queue dependency differs from current signed artifact: ${record.requirementId}`);
    dependencies[result.trustedDependency.parentId] = result.trustedDependency;
  }
  return dependencies;
}

async function verifySupersession(relativePath, requirementId, newGenerationRunId, existingRecord, key) {
  assertGenerationRunId(newGenerationRunId, 'supersession target generationRunId');
  if (!relativePath) fail(`accepted requirement requires explicit signed supersession: ${requirementId}`);
  if (!relativePath.startsWith(`${EVIDENCE}/supersessions/`)) fail('supersession path is outside append-only evidence');
  const value = await readJson(ROOT, relativePath); verifyAuthority(value, AUTHORITY_DOMAINS.supersession, key, 'accepted review supersession');
  assertSupersessionValue(value);
  if (value.requirementId !== requirementId || value.newGenerationRunId !== newGenerationRunId
      || value.priorArtifactSha256 !== existingRecord.artifactSha256 || value.priorReviewSha256 !== existingRecord.reviewSha256) fail('supersession does not bind prior accepted record and new run exactly');
  return { path: relativePath, sha256: sha256Bytes(await readContainedFile(ROOT, relativePath)), priorArtifactSha256: existingRecord.artifactSha256 };
}
function assertSupersessionValue(value) {
  exactKeys(value, ['schemaVersion', 'protocolAuthoritySha256', 'requirementId', 'priorArtifactSha256', 'priorReviewSha256', 'newGenerationRunId', 'reason', 'issuedAt', 'nonce', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], 'accepted review supersession');
  assertGenerationRunId(value.newGenerationRunId, 'supersession newGenerationRunId');
  if (value.schemaVersion !== 'continuity-g003-accepted-review-supersession-v1' || !SHA.test(value.priorArtifactSha256 ?? '')
      || !SHA.test(value.priorReviewSha256 ?? '')
      || typeof value.reason !== 'string' || value.reason.length < 8 || Number.isNaN(Date.parse(value.issuedAt))
      || typeof value.nonce !== 'string' || value.nonce.length < 16) fail('accepted review supersession fields are invalid');
}

async function authorizeSupersessionUnlocked(requestPath, key) {
  const request = await readJson(ROOT, requestPath);
  exactKeys(request, ['requirementId', 'priorArtifactSha256', 'priorReviewSha256', 'newGenerationRunId', 'reason', 'issuedAt', 'nonce'], 'supersession request');
  assertGenerationRunId(request.newGenerationRunId, 'supersession request newGenerationRunId');
  if (!SHA.test(request.priorArtifactSha256) || !SHA.test(request.priorReviewSha256)
      || typeof request.reason !== 'string' || request.reason.length < 8 || Number.isNaN(Date.parse(request.issuedAt)) || typeof request.nonce !== 'string' || request.nonce.length < 16) fail('invalid supersession request');
  const existing = (await readVerifiedRecords(key)).find((record) => record.requirementId === request.requirementId);
  if (!existing || existing.artifactSha256 !== request.priorArtifactSha256 || existing.reviewSha256 !== request.priorReviewSha256) fail('supersession request does not bind current accepted record');
  const core = { schemaVersion: 'continuity-g003-accepted-review-supersession-v1', ...request };
  const signed = finalizeAuthority(core, AUTHORITY_DOMAINS.supersession, key); const digest = sha256Canonical(core);
  const relativePath = `${EVIDENCE}/supersessions/${digest}.json`; await publishPrivateImmutable(relativePath, signed);
  return { status: 'SUPERSESSION_AUTHORIZED', relativePath, requirementId: request.requirementId, newGenerationRunId: request.newGenerationRunId };
}
async function authorizeSupersession(requestPath, key) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('authorize-supersession', () => authorizeSupersessionUnlocked(requestPath, key));
}

async function prepareUnlocked(descriptorPath, key, { supersessionRelative = null } = {}) {
  const descriptor = await readJson(ROOT, descriptorPath);
  assertGenerationRunId(descriptor?.generationRunId, 'prepare generationRunId');
  await assertCandidateNotRejected(descriptor, key);
  const existing = (await readVerifiedRecords(key)).find((record) => record.requirementId === descriptor.candidateId);
  if (existing) await verifySupersession(supersessionRelative, descriptor.candidateId, descriptor.generationRunId, existing, key);
  const locked = await loadLockedG003Gate();
  const approvedDependencies = await reconstructDependencies(key);
  const result = await materializeCandidatePackage(descriptor, { repoRoot: ROOT, conductorKey: key, reviewGate: locked, approvedDependencies });
  return { status: 'PREPARED', outputRelative: result.outputRelative, opaqueCandidateId: result.opaqueCandidateId };
}
async function prepare(descriptorPath, key, options = {}) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('prepare', () => prepareUnlocked(descriptorPath, key, options));
}

async function packageAuthorityContext(packageRelative, key = null) {
  const verified = key ? await verifyCandidatePackageContext({ repoRoot: ROOT, packageRelative, conductorKey: key }) : null;
  const [bindingBytes, manifestBytes, allowlistBytes, promptBytes] = await Promise.all([
    readContainedFile(ROOT, `${packageRelative}/private-binding.json`),
    readContainedFile(ROOT, `${packageRelative}/reviewer-package/package-manifest.json`),
    readContainedFile(ROOT, `${packageRelative}/reviewer-package/allowlist.json`),
    readContainedFile(ROOT, `${packageRelative}/reviewer-package/prompt.txt`),
  ]);
  const binding = JSON.parse(bindingBytes); const manifest = JSON.parse(manifestBytes); const allowlist = JSON.parse(allowlistBytes);
  if (binding.schemaVersion !== 'continuity-candidate-material-binding-v4'
      || binding.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256
      || manifest.schemaVersion !== 'continuity-candidate-package-v4'
      || manifest.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256
      || allowlist.schemaVersion !== 'continuity-candidate-allowlist-v4'
      || allowlist.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256
      || binding.reviewContract?.schemaVersion !== 'continuity-candidate-locked-review-contract-v4'
      || binding.reviewContract?.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256) {
    fail('review authority requires candidate review protocol v4 package/material/contract');
  }
  assertGenerationRunId(binding?.generationRunId, 'review package binding generationRunId');
  assertGenerationRunId(manifest?.generationRunId, 'review package manifest generationRunId');
  if (manifest.generationRunId !== binding.generationRunId) fail('review package generationRunId differs across binding/manifest');
  if (sha256Canonical(manifest) !== binding.packageManifestSha256 || sha256Canonical(allowlist) !== binding.allowlistSha256) fail('review authority package hashes drifted');
  if (sha256Bytes(promptBytes) !== binding.promptSha256) fail('review authority prompt hash drifted');
  if (verified && (canonicalStringify(verified.binding) !== canonicalStringify(binding)
      || canonicalStringify(verified.packageManifest) !== canonicalStringify(manifest)
      || canonicalStringify(verified.allowlist) !== canonicalStringify(allowlist))) fail('review authority context differs from fully verified package');
  return { binding, manifest, allowlist, bindingBytes, manifestBytes, allowlistBytes, promptBytes,
    inputAssetSha256s: allowlist.files.map((file) => file.sha256).sort() };
}

async function publishPrivateImmutable(relativePath, value) {
  const bytes = Buffer.from(canonicalStringify(value));
  try { const existing = await readContainedFile(ROOT, relativePath); if (!existing.equals(bytes)) fail(`private review authority evidence is immutable: ${relativePath}`); return sha256Bytes(existing); }
  catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  await writeFileAtomicNoFollow(path.join(ROOT, relativePath), bytes, { containmentRoot: ROOT, mode: 0o600, allowedBasenames: new Set([path.basename(relativePath)]) });
  return sha256Bytes(bytes);
}
async function publishPublicImmutable(relativePath, value) {
  const bytes = Buffer.from(canonicalStringify(value));
  try { const existing = await readContainedFile(ROOT, relativePath); if (!existing.equals(bytes)) fail(`public evidence is append-only: ${relativePath}`); return sha256Bytes(existing); }
  catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  await writeFileAtomicNoFollow(path.join(ROOT, relativePath), bytes, { containmentRoot: ROOT, mode: 0o644, allowedBasenames: new Set([path.basename(relativePath)]) });
  return sha256Bytes(bytes);
}
async function readRejectionTombstones(key) {
  const values = new Map(); const root = `${EVIDENCE}/rejection-index`;
  let paths = [];
  try { paths = (await listContainedRegularFiles(ROOT, root)).filter((name) => name.endsWith('.json')).map((name) => `${root}/${name}`); }
  catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  for (const relativePath of paths) {
    const value = await readJson(ROOT, relativePath); verifyAuthority(value, AUTHORITY_DOMAINS.rejectionIndex, key, 'rejection tombstone');
    exactKeys(value, ['schemaVersion', 'protocolAuthoritySha256', 'tombstoneKey', 'candidateId', 'generationRunId', 'materialSha256s', 'rejectionArchiveId', 'rejectionSha256', 'rejectedAt', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], 'rejection tombstone');
    const expectedKey = rejectionTombstoneKey(value.candidateId, value.generationRunId, value.materialSha256s);
    if (value.schemaVersion !== 'continuity-g003-rejection-tombstone-v1' || value.tombstoneKey !== expectedKey
        || relativePath !== `${root}/${expectedKey}/${value.rejectionArchiveId}.json` || !SHA.test(value.rejectionArchiveId ?? '')
        || !SHA.test(value.rejectionSha256 ?? '') || !/^(g003-candidate:PG-[0-9]{3}|g003-edge:PG-[0-9]{3}:PG-[0-9]{3})$/.test(value.candidateId)
        || !Array.isArray(value.materialSha256s) || value.materialSha256s.length !== 2
        || new Set(value.materialSha256s).size !== 2 || value.materialSha256s.some((digest) => !SHA.test(digest))
        || Number.isNaN(Date.parse(value.rejectedAt))) fail(`invalid rejection tombstone routing: ${relativePath}`);
    assertGenerationRunId(value.generationRunId, `rejection tombstone ${relativePath} generationRunId`);
    await verifyTombstoneRejectionArchive(value, key, relativePath);
    const existing = values.get(expectedKey);
    if (existing && existing.rejectionSha256 !== value.rejectionSha256) fail(`conflicting rejection tombstones: ${expectedKey}`);
    values.set(expectedKey, value);
  }
  return values;
}

function rejectionArchiveRelativePath(value) {
  assertGenerationRunId(value.generationRunId, 'rejection archive generationRunId');
  if (!SHA.test(value.rejectionArchiveId ?? '')) fail('rejection archiveId is invalid');
  return `assets/creatures/biological-continuity-v3/rejected/${value.generationRunId}/${value.rejectionArchiveId}/rejection.json`;
}

function assertRejectionValue(rejection, label = 'rejection archive') {
  exactKeys(rejection, ['schemaVersion', 'protocolAuthoritySha256', 'candidateId', 'generationRunId', 'archiveId', 'archiveBinding', 'materialSha256s', 'reasonCodes', 'sourceFiles', 'associatedReviewSha256s', 'rejectedAt', 'nonce', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], label);
  assertGenerationRunId(rejection.generationRunId, `${label} generationRunId`);
  if (rejection.schemaVersion !== 'continuity-rejected-candidate-v1' || !SHA.test(rejection.archiveId ?? '')
      || rejection.archiveId !== sha256Canonical(rejection.archiveBinding)
      || rejection.archiveBinding?.candidateId !== rejection.candidateId || rejection.archiveBinding?.generationRunId !== rejection.generationRunId
      || canonicalStringify(rejection.archiveBinding?.materialSha256s) !== canonicalStringify(rejection.materialSha256s)
      || canonicalStringify(rejection.archiveBinding?.reasonCodes) !== canonicalStringify(rejection.reasonCodes)
      || canonicalStringify(rejection.archiveBinding?.associatedReviewSha256s) !== canonicalStringify(rejection.associatedReviewSha256s)
      || rejection.archiveBinding?.rejectedAt !== rejection.rejectedAt || rejection.archiveBinding?.nonce !== rejection.nonce) fail(`${label} immutable binding is invalid`);
  return true;
}

async function verifyTombstoneRejectionArchive(tombstone, key, label = 'rejection tombstone') {
  const rejectionPath = rejectionArchiveRelativePath(tombstone);
  const rejectionBytes = await readContainedFile(ROOT, rejectionPath);
  const rejection = JSON.parse(rejectionBytes);
  verifyAuthority(rejection, AUTHORITY_DOMAINS.rejection, key, 'rejection archive');
  assertRejectionValue(rejection);
  await verifyRejectionArchivePayloads(rejection);
  assertTombstoneRejectionBinding(tombstone, rejection, rejectionBytes, label);
  return rejection;
}

export async function verifyRejectionArchivePayloads(rejection, { repoRoot = ROOT } = {}) {
  assertGenerationRunId(rejection?.generationRunId, 'rejection payload generationRunId');
  if (!SHA.test(rejection?.archiveId ?? '') || !Array.isArray(rejection.sourceFiles) || !Array.isArray(rejection.archiveBinding?.sourceFiles)
      || rejection.sourceFiles.length === 0 || rejection.sourceFiles.length !== rejection.archiveBinding.sourceFiles.length) fail('rejection payload inventory is incomplete');
  const archiveRoot = `assets/creatures/biological-continuity-v3/rejected/${rejection.generationRunId}/${rejection.archiveId}`;
  const archivedPaths = new Set(); const originalPaths = new Set();
  for (const [index, archived] of rejection.sourceFiles.entries()) {
    const original = rejection.archiveBinding.sourceFiles[index];
    if (!original || typeof original.path !== 'string' || !SHA.test(original.sha256 ?? '') || !SHA.test(archived?.sha256 ?? '')) fail('rejection payload metadata is invalid');
    assertRejectionSource(original.path);
    const expectedPath = `${archiveRoot}/${String(index + 1).padStart(2, '0')}-${path.posix.basename(original.path)}`;
    if (archived.path !== expectedPath || path.posix.normalize(archived.path) !== archived.path || archived.path.includes('\\')
        || archived.sha256 !== original.sha256 || archivedPaths.has(archived.path) || originalPaths.has(original.path)) fail('rejection payload paths/digests do not reconcile with archiveBinding.sourceFiles');
    archivedPaths.add(archived.path); originalPaths.add(original.path);
    const absoluteArchiveRoot = path.resolve(repoRoot, archiveRoot); const absolutePayload = path.resolve(repoRoot, archived.path);
    const relation = path.relative(absoluteArchiveRoot, absolutePayload);
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('rejection payload escapes its exact archive directory');
    const bytes = await readContainedFile(repoRoot, archived.path);
    if (sha256Bytes(bytes) !== archived.sha256) fail(`rejection archived payload changed or is missing: ${archived.path}`);
  }
  return true;
}

export function assertTombstoneRejectionBinding(tombstone, rejection, rejectionBytes, label = 'rejection tombstone') {
  if (sha256Bytes(rejectionBytes) !== tombstone.rejectionSha256) fail(`${label} references missing or changed rejection bytes`);
  if (rejection.archiveId !== tombstone.rejectionArchiveId || rejection.candidateId !== tombstone.candidateId
      || rejection.generationRunId !== tombstone.generationRunId || rejection.rejectedAt !== tombstone.rejectedAt
      || canonicalStringify(rejection.materialSha256s) !== canonicalStringify(tombstone.materialSha256s)) fail(`${label} does not bind the referenced rejection archive`);
  return true;
}
async function assertCandidateNotRejected(candidate, key) {
  return assertNoMatchingRejectionTombstone(candidate, await readRejectionTombstones(key));
}
export function assertNoMatchingRejectionTombstone(candidate, tombstones) {
  const materialSha256s = candidateMaterialSha256s(candidate);
  const tombstoneKey = rejectionTombstoneKey(candidate.candidateId, candidate.generationRunId, materialSha256s);
  if (tombstones.has(tombstoneKey)) fail(`candidate run/material is permanently rejected; use a new generation run: ${candidate.candidateId}`);
  return { materialSha256s, tombstoneKey };
}
async function publishRejectionTombstone(rejection, rejectionBytes, key) {
  assertRejectionValue(rejection);
  await verifyRejectionArchivePayloads(rejection);
  const persistedRejectionBytes = await readContainedFile(ROOT, rejectionArchiveRelativePath({
    generationRunId: rejection.generationRunId, rejectionArchiveId: rejection.archiveId,
  }));
  if (!persistedRejectionBytes.equals(rejectionBytes)) fail('rejection archive must be durably published before its tombstone');
  const tombstoneKey = rejectionTombstoneKey(rejection.candidateId, rejection.generationRunId, rejection.materialSha256s);
  const core = {
    schemaVersion: 'continuity-g003-rejection-tombstone-v1', tombstoneKey, candidateId: rejection.candidateId,
    generationRunId: rejection.generationRunId, materialSha256s: rejection.materialSha256s,
    rejectionArchiveId: rejection.archiveId, rejectionSha256: sha256Bytes(rejectionBytes), rejectedAt: rejection.rejectedAt,
  };
  const value = finalizeAuthority(core, AUTHORITY_DOMAINS.rejectionIndex, key);
  const relativePath = `${EVIDENCE}/rejection-index/${tombstoneKey}/${rejection.archiveId}.json`;
  await publishPublicImmutable(relativePath, value); return { tombstoneKey, relativePath };
}

export async function publishArchiveThenTombstone(publishArchive, publishTombstone) {
  await publishArchive();
  return publishTombstone();
}

async function issueAssignmentUnlocked(identityPath, packageRelative, key) {
  const identity = await readJson(ROOT, identityPath);
  exactKeys(identity, ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber', 'assignedAt'], 'reviewer assignment identity');
  for (const field of ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) if (typeof identity[field] !== 'string' || identity[field].length < 8) fail(`assignment identity lacks ${field}`);
  if (![1, 2].includes(identity.passNumber) || Number.isNaN(Date.parse(identity.assignedAt))) fail('assignment pass/time is invalid');
  const context = await packageAuthorityContext(packageRelative, key);
  const assignmentId = `g003-assignment-${sha256Canonical({ opaqueCandidateId: context.binding.opaqueCandidateId, ...identity }).slice(0, 32)}`;
  const core = {
    schemaVersion: 'continuity-g003-reviewer-assignment-v1', assignmentId, opaqueCandidateId: context.binding.opaqueCandidateId,
    generationRunId: context.binding.generationRunId, passNumber: identity.passNumber, role: 'primary',
    reviewerInstanceId: identity.reviewerInstanceId, agentTaskId: identity.agentTaskId, voterReviewRunId: identity.voterReviewRunId,
    packageManifestSha256: context.binding.packageManifestSha256, materialBindingSha256: candidateMaterialBindingSha256(context.binding),
    inputAllowlistSha256: context.binding.allowlistSha256, promptSha256: context.binding.promptSha256,
    inputAssetSha256s: context.inputAssetSha256s, assignedAt: identity.assignedAt,
  };
  const assignment = finalizeAuthority(core, AUTHORITY_DOMAINS.assignment, key);
  const relativePath = `${packageRelative}/review-authority/assignment-pass-${identity.passNumber}.json`;
  const fileSha256 = await publishPrivateImmutable(relativePath, assignment);
  return { status: 'ASSIGNMENT_ISSUED', passNumber: identity.passNumber, assignmentId, relativePath, fileSha256 };
}
async function issueAssignment(identityPath, packageRelative, key) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('issue-assignment', () => issueAssignmentUnlocked(identityPath, packageRelative, key));
}

async function verifyAssignment(relativePath, context, key) {
  const assignment = await readJson(ROOT, relativePath); verifyAuthority(assignment, AUTHORITY_DOMAINS.assignment, key, 'reviewer assignment');
  assertAssignmentContext(assignment, context);
  return assignment;
}
function assertAssignmentContext(assignment, context) {
  assertGenerationRunId(assignment?.generationRunId, 'reviewer assignment generationRunId');
  if (assignment.opaqueCandidateId !== context.binding.opaqueCandidateId || assignment.generationRunId !== context.binding.generationRunId
      || assignment.packageManifestSha256 !== context.binding.packageManifestSha256
      || assignment.materialBindingSha256 !== candidateMaterialBindingSha256(context.binding)
      || assignment.inputAllowlistSha256 !== context.binding.allowlistSha256 || assignment.promptSha256 !== context.binding.promptSha256
      || JSON.stringify(assignment.inputAssetSha256s) !== JSON.stringify(context.inputAssetSha256s)) fail('reviewer assignment differs from immutable package');
}

async function attestVoteUnlocked(rawPath, assignmentRelative, packageRelative, key) {
  const raw = await readJson(ROOT, rawPath);
  exactKeys(raw, ['assignmentId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber', 'observation', 'confidence', 'observedAt'], 'raw candidate observation');
  const context = await packageAuthorityContext(packageRelative, key);
  await validateRawCandidateObservation(raw.observation, raw.confidence, { repoRoot: ROOT, packageRelative, conductorKey: key });
  const assignment = await verifyAssignment(assignmentRelative, context, key);
  for (const field of ['assignmentId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber']) if (raw[field] !== assignment[field]) fail(`raw observation differs from assignment ${field}`);
  if (Number.isNaN(Date.parse(raw.observedAt)) || !Number.isFinite(raw.confidence) || raw.confidence < 0.96 || raw.confidence > 1) fail('raw observation time/confidence is invalid');
  const rawObservationSha256 = sha256Canonical(raw);
  const assignmentManifestSha256 = sha256Bytes(await readContainedFile(ROOT, assignmentRelative));
  const runCore = {
    schemaVersion: 'continuity-g003-reviewer-run-attestation-v1', assignmentId: assignment.assignmentId, assignmentManifestSha256,
    opaqueCandidateId: assignment.opaqueCandidateId, generationRunId: assignment.generationRunId, passNumber: assignment.passNumber, role: 'primary',
    reviewerInstanceId: assignment.reviewerInstanceId, agentTaskId: assignment.agentTaskId, voterReviewRunId: assignment.voterReviewRunId,
    packageManifestSha256: assignment.packageManifestSha256, rawObservationSha256, fresh: true, blinded: true, createdAt: raw.observedAt,
  };
  const run = finalizeAuthority(runCore, AUTHORITY_DOMAINS.run, key);
  const authorityRoot = `${packageRelative}/review-authority`;
  const rawRelative = `${authorityRoot}/raw-observation-pass-${assignment.passNumber}.json`;
  const runRelative = `${authorityRoot}/run-attestation-pass-${assignment.passNumber}.json`;
  await publishPrivateImmutable(rawRelative, raw); const reviewerRunAttestationSha256 = await publishPrivateImmutable(runRelative, run);
  const voteCore = {
    schemaVersion: 'continuity-candidate-primary-vote-v4', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
    reviewId: `g003-review-${sha256Canonical({ assignmentId: assignment.assignmentId, rawObservationSha256 }).slice(0, 32)}`,
    reviewerInstanceId: assignment.reviewerInstanceId, agentTaskId: assignment.agentTaskId, voterReviewRunId: assignment.voterReviewRunId,
    passNumber: assignment.passNumber, role: 'primary', fresh: true, blinded: true,
    opaqueCandidateId: assignment.opaqueCandidateId, generationRunId: assignment.generationRunId,
    packageManifestSha256: assignment.packageManifestSha256, materialBindingSha256: assignment.materialBindingSha256,
    inputAllowlistSha256: assignment.inputAllowlistSha256, promptSha256: assignment.promptSha256,
    inputAssetSha256s: assignment.inputAssetSha256s, assignmentManifestSha256, reviewerRunAttestationSha256, rawObservationSha256,
    observation: raw.observation, confidence: raw.confidence,
  };
  const vote = finalizeCandidateVote(voteCore, key); const voteRelative = `${authorityRoot}/vote-pass-${assignment.passNumber}.json`;
  await publishPrivateImmutable(voteRelative, vote);
  return { status: 'VOTE_ATTESTED', passNumber: assignment.passNumber, voteRelative, assignmentRelative, runRelative, rawRelative, reviewId: vote.reviewId };
}
async function attestVote(rawPath, assignmentRelative, packageRelative, key) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('attest-vote', () => attestVoteUnlocked(rawPath, assignmentRelative, packageRelative, key));
}

async function verifyReviewAuthority(review, packageRelative, key) {
  assertGenerationRunId(review?.generationRunId, 'review authority generationRunId');
  const context = await packageAuthorityContext(packageRelative, key);
  const result = [];
  for (const vote of review.votes) {
    const authorityRoot = `${packageRelative}/review-authority`; const assignmentRelative = `${authorityRoot}/assignment-pass-${vote.passNumber}.json`;
    const runRelative = `${authorityRoot}/run-attestation-pass-${vote.passNumber}.json`; const rawRelative = `${authorityRoot}/raw-observation-pass-${vote.passNumber}.json`;
    const [assignmentBytes, runBytes, rawBytes] = await Promise.all([
      readContainedFile(ROOT, assignmentRelative), readContainedFile(ROOT, runRelative), readContainedFile(ROOT, rawRelative),
    ]);
    const assignment = JSON.parse(assignmentBytes); const run = JSON.parse(runBytes); const raw = JSON.parse(rawBytes);
    verifyAuthority(assignment, AUTHORITY_DOMAINS.assignment, key, 'reviewer assignment'); assertAssignmentContext(assignment, context);
    verifyAuthority(run, AUTHORITY_DOMAINS.run, key, 'reviewer run attestation');
    assertGenerationRunId(run?.generationRunId, 'reviewer run attestation generationRunId');
    assertReviewAuthorityTuple(vote, assignment, run, raw, {
      assignmentSha256: sha256Bytes(assignmentBytes), runSha256: sha256Bytes(runBytes),
    });
    result.push({ assignmentRelative, runRelative, rawRelative, assignmentBytes, runBytes, rawBytes });
  }
  return { context, passes: result };
}

export function assertReviewAuthorityTuple(vote, assignment, run, raw, { assignmentSha256, runSha256 }) {
  if (!vote || !assignment || !run || !raw || assignmentSha256 !== vote.assignmentManifestSha256 || runSha256 !== vote.reviewerRunAttestationSha256
      || sha256Canonical(raw) !== vote.rawObservationSha256 || run.rawObservationSha256 !== vote.rawObservationSha256
      || run.assignmentManifestSha256 !== vote.assignmentManifestSha256 || run.assignmentId !== assignment.assignmentId
      || raw.assignmentId !== assignment.assignmentId || canonicalStringify(raw.observation) !== canonicalStringify(vote.observation)
      || raw.confidence !== vote.confidence) fail(`pass ${vote?.passNumber ?? '?'} vote lacks exact assignment/run/raw observation binding`);
  for (const field of ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber']) if (vote[field] !== assignment[field] || run[field] !== assignment[field] || raw[field] !== assignment[field]) fail(`pass ${vote.passNumber} borrowed or renamed ${field}`);
}

export function assertPublicParentEvidence(parentEvidence, binding, label = 'public parent evidence') {
  if (!Array.isArray(parentEvidence) || ![1, 2].includes(parentEvidence.length)
      || !Array.isArray(binding?.parents) || parentEvidence.length !== binding.parents.length) fail(`${label} parent count is invalid`);
  const roles = new Set(); const parentIds = new Set();
  for (const [index, entry] of parentEvidence.entries()) {
    exactKeys(entry, ['evidenceRole', 'parentRole', 'parentId', 'pixelSha256s', 'approvedParentCandidateId', 'approvedParentReviewSha256', 'anchors'], `${label} entry`);
    const expectedRole = `parent-${index + 1}`; const parent = binding.parents[index];
    if (entry.parentRole !== expectedRole || entry.parentId !== parent.sourceSlotId || roles.has(entry.parentRole) || parentIds.has(entry.parentId)) fail(`${label} roles/IDs are not exact and unique`);
    roles.add(entry.parentRole); parentIds.add(entry.parentId);
    const expectedPixels = [parent.surfaces.master.sha256, parent.surfaces.runtime.sha256];
    if (!Array.isArray(entry.pixelSha256s) || entry.pixelSha256s.length !== 2 || new Set(entry.pixelSha256s).size !== 2
        || entry.pixelSha256s.some((digest) => !SHA.test(digest)) || canonicalStringify(entry.pixelSha256s) !== canonicalStringify(expectedPixels)) fail(`${label} must bind exact master/runtime parent pixels`);
    const policy = binding.reviewContract?.reviewPolicy;
    const expectedEvidenceRole = policy?.assessmentMode === 'canonical-root-replacement' ? 'historical-reference-only' : 'continuity-parent';
    if (entry.evidenceRole !== expectedEvidenceRole) fail(`${label} evidence role differs from signed review policy`);
    const contract = binding.reviewContract?.anchorSets?.find((item) => item.role === expectedRole);
    const expectedApprovedCandidateId = contract?.approvedParentCandidateId ?? null;
    const expectedApprovedReviewSha256 = contract?.approvedParentReviewSha256 ?? null;
    if (entry.approvedParentCandidateId !== expectedApprovedCandidateId || entry.approvedParentReviewSha256 !== expectedApprovedReviewSha256
        || (entry.approvedParentCandidateId === null) !== (entry.approvedParentReviewSha256 === null)) fail(`${label} approved-parent bindings are invalid`);
    if (entry.approvedParentCandidateId !== null && entry.approvedParentCandidateId !== `g003-candidate:${entry.parentId}`) fail(`${label} approved parent candidate does not match parentId`);
    if (!Array.isArray(entry.anchors) || entry.anchors.length !== (contract?.anchors.length ?? 0)) fail(`${label} anchors differ from the signed review contract`);
    if (entry.evidenceRole === 'historical-reference-only' && (entry.anchors.length !== 0
        || entry.approvedParentCandidateId !== null || entry.approvedParentReviewSha256 !== null)) fail(`${label} historical reference must not claim continuity anchors or approved-parent authority`);
    const contractAnchors = new Map((contract?.anchors ?? []).map((anchor) => [anchor.anchorId, anchor]));
    const actualAnchorIds = entry.anchors.map((anchor) => anchor.anchorId);
    const requiredAnchorIds = [...contractAnchors.keys()];
    if (contractAnchors.size !== (contract?.anchors.length ?? 0) || new Set(actualAnchorIds).size !== actualAnchorIds.length
        || canonicalStringify([...actualAnchorIds].sort()) !== canonicalStringify([...requiredAnchorIds].sort())) fail(`${label} anchor IDs must exactly and uniquely cover the locked contract`);
    for (const anchor of entry.anchors) {
      exactKeys(anchor, ['anchorKey', 'parentRole', 'parentId', 'anchorId', 'description', 'sourceReviewId', 'sourceConfidence', 'resolutionState', 'dependencyCandidateId'], `${label} anchor`);
      const contractAnchor = contractAnchors.get(anchor.anchorId);
      if (!contractAnchor || anchor.anchorKey !== `${entry.parentId}:${anchor.anchorId}` || anchor.parentRole !== entry.parentRole || anchor.parentId !== entry.parentId
          || anchor.description !== contractAnchor.description || typeof anchor.description !== 'string' || anchor.description.length < 3
          || typeof anchor.sourceReviewId !== 'string' || anchor.sourceReviewId.length < 8 || !Number.isFinite(anchor.sourceConfidence)
          || anchor.sourceConfidence < 0.85 || anchor.sourceConfidence > 1
          || !['RESOLVED_AUTHENTICATED_PIXELS', 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET'].includes(anchor.resolutionState)
          || anchor.dependencyCandidateId !== entry.approvedParentCandidateId) fail(`${label} anchor is malformed`);
    }
  }
  return true;
}

async function buildPublicParentEvidence(binding, { queue, edge, currentRecords }) {
  return Promise.all(binding.parents.map(async (parent, index) => {
    const parentRole = `parent-${index + 1}`;
    const contract = binding.reviewContract.anchorSets.find((item) => item.role === parentRole);
    const approvedParentCandidateId = contract?.approvedParentCandidateId ?? null;
    const approvedParentReviewSha256 = contract?.approvedParentReviewSha256 ?? null;
    let templates = [];
    if (edge) templates = edge.allowedParentAnchors.find((item) => item.parentRole === parentRole && item.parentId === parent.sourceSlotId)?.anchors ?? [];
    else if (queue) templates = queue.allowedAnchors.filter((item) => item.parentRole === parentRole && item.parentId === parent.sourceSlotId);
    let sourceReview = null;
    if (approvedParentCandidateId) {
      const parentRecord = currentRecords.find((record) => record.requirementId === approvedParentCandidateId);
      if (!parentRecord || parentRecord.reviewSha256 !== approvedParentReviewSha256) fail(`${binding.candidateId}: approved parent review is not the current signed chain tip`);
      const parentReview = await readJson(ROOT, parentRecord.reviewPath);
      sourceReview = parentReview.votes.find((vote) => vote.passNumber === 1);
      if (!sourceReview || sourceReview.confidence < 0.96) fail(`${binding.candidateId}: approved parent lacks a qualifying persisted source review`);
    }
    const anchors = (contract?.anchors ?? []).map((contractAnchor) => {
      const template = templates.find((item) => item.anchorId === contractAnchor.anchorId);
      if (!template) fail(`${binding.candidateId}: parent anchor is absent from the locked requirement`);
      if (approvedParentCandidateId) return {
        anchorKey: `${parent.sourceSlotId}:${contractAnchor.anchorId}`, parentRole, parentId: parent.sourceSlotId,
        anchorId: contractAnchor.anchorId, description: contractAnchor.description, sourceReviewId: sourceReview.reviewId,
        sourceConfidence: sourceReview.confidence, resolutionState: 'RESOLVED_AUTHENTICATED_PIXELS', dependencyCandidateId: approvedParentCandidateId,
      };
      if (template.description !== contractAnchor.description || typeof template.sourceReviewId !== 'string' || template.sourceConfidence < 0.85) fail(`${binding.candidateId}: retained parent anchor does not match authenticated locked evidence`);
      return structuredClone(template);
    });
    return {
      evidenceRole: binding.reviewContract.reviewPolicy.assessmentMode === 'canonical-root-replacement' ? 'historical-reference-only' : 'continuity-parent',
      parentRole, parentId: parent.sourceSlotId,
      pixelSha256s: [parent.surfaces.master.sha256, parent.surfaces.runtime.sha256],
      approvedParentCandidateId, approvedParentReviewSha256, anchors,
    };
  }));
}

async function assembleReviewUnlocked(packageRelative) {
  const context = await packageAuthorityContext(packageRelative); const votes = [];
  for (const passNumber of [1, 2]) votes.push(await readJson(ROOT, `${packageRelative}/review-authority/vote-pass-${passNumber}.json`));
  const review = {
    schemaVersion: 'continuity-candidate-review-v4', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
    opaqueCandidateId: context.binding.opaqueCandidateId,
    generationRunId: context.binding.generationRunId, reviewKind: context.binding.reviewKind,
    packageManifestSha256: context.binding.packageManifestSha256, materialBindingSha256: candidateMaterialBindingSha256(context.binding),
    inputAllowlistSha256: context.binding.allowlistSha256, promptSha256: context.binding.promptSha256, votes,
  };
  const relativePath = `${packageRelative}/review-authority/review.json`; await publishPrivateImmutable(relativePath, review);
  return { status: 'REVIEW_ASSEMBLED', relativePath };
}
async function assembleReview(packageRelative) {
  return withExclusiveG003Operation('assemble-review', () => assembleReviewUnlocked(packageRelative));
}

async function transactionFile(transactionRoot, publicRoot, finalRelative, bytes) {
  if (!finalRelative.startsWith(`${publicRoot}/`)) fail('transaction output differs from final public root');
  const inside = finalRelative.slice(publicRoot.length + 1); const destination = path.join(transactionRoot, inside);
  await writeFileAtomicNoFollow(destination, bytes, { containmentRoot: transactionRoot, mode: 0o644, allowedBasenames: new Set([path.basename(destination)]) });
  return { path: finalRelative, sha256: sha256Bytes(bytes) };
}
async function publishParentIdentity(finalRoot, containmentRoot) {
  const parent = path.dirname(path.resolve(finalRoot)); await ensureSafeDirectory(containmentRoot, parent, 'atomic publish parent');
  const info = await lstat(parent, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail('atomic publish parent is symlinked or non-directory');
  return { parent, dev: info.dev, ino: info.ino };
}
async function assertPublishParentIdentity(identity) {
  const info = await lstat(identity.parent, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) fail('atomic publish parent changed before commit');
}
export async function createAtomicPublishTransaction(finalRoot, { containmentRoot = ROOT, prefix = '.accept-transaction-' } = {}) {
  const parentIdentity = await publishParentIdentity(finalRoot, containmentRoot);
  const transactionRoot = await mkdtemp(path.join(parentIdentity.parent, prefix));
  await assertPublishParentIdentity(parentIdentity);
  return { transactionRoot, parentIdentity };
}
export async function atomicPublishDirectory(transactionRoot, finalRoot, { containmentRoot = ROOT, parentIdentity = null, beforePublish = null } = {}) {
  const absolute = path.resolve(finalRoot); const relation = path.relative(path.resolve(containmentRoot), absolute);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('atomic publish escapes containment');
  const liveIdentity = await publishParentIdentity(absolute, containmentRoot);
  if (parentIdentity && (parentIdentity.parent !== liveIdentity.parent || parentIdentity.dev !== liveIdentity.dev || parentIdentity.ino !== liveIdentity.ino)) fail('atomic publish parent changed before transaction validation');
  const identity = parentIdentity ?? liveIdentity;
  if (identity.parent !== path.dirname(absolute) || path.dirname(path.resolve(transactionRoot)) !== identity.parent) fail('atomic publish transaction must be a sibling of the final directory');
  const transactionInfo = await lstat(transactionRoot);
  if (!transactionInfo.isDirectory() || transactionInfo.isSymbolicLink()) fail('atomic publish transaction is symlinked or non-directory');
  try { await lstat(absolute); fail(`atomic publish target already exists: ${absolute}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (beforePublish) await beforePublish();
  await assertPublishParentIdentity(identity);
  await rename(transactionRoot, absolute);
}
async function cleanupAtomicTransaction(transactionRoot, parentIdentity) {
  try { await assertPublishParentIdentity(parentIdentity); } catch { return; }
  try {
    const info = await lstat(transactionRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(path.resolve(transactionRoot)) !== parentIdentity.parent) return;
    await rm(transactionRoot, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function acceptUnlocked(reviewInputPath, packageRelative, key, { supersessionRelative = null } = {}) {
  const review = await readJson(ROOT, reviewInputPath);
  assertGenerationRunId(review?.generationRunId, 'accept review generationRunId');
  if (!Array.isArray(review.votes) || review.votes.length !== 2) fail('accept requires exactly two attested primary votes');
  const binding = await readJson(ROOT, `${packageRelative}/private-binding.json`);
  assertGenerationRunId(binding?.generationRunId, 'accept binding generationRunId');
  await assertCandidateNotRejected(binding, key);
  const locked = await loadLockedG003Gate();
  const queue = locked.queueCandidates.find((item) => item.candidateId === binding.candidateId);
  const edge = locked.edgeCandidates.find((item) => item.edgeId === binding.candidateId);
  if ((queue ? 1 : 0) + (edge ? 1 : 0) !== 1) fail('private binding does not map to one locked requirement');
  const requirementKind = queue ? 'queue' : 'edge';
  const requirementId = queue?.candidateId ?? edge.edgeId;
  const childId = queue?.slotId ?? edge.childId;
  const publicRoot = queue
    ? `${EVIDENCE}/candidates/${childId}/${binding.generationRunId}`
    : `${EVIDENCE}/edges/${edge.parentId}-${edge.childId}/${binding.generationRunId}`;
  const existingRecords = await readVerifiedRecords(key);
  const priorRecord = existingRecords.find((record) => record.requirementId === requirementId);
  const supersession = priorRecord ? await verifySupersession(supersessionRelative, requirementId, binding.generationRunId, priorRecord, key) : null;
  if (existingRecords.some((record) => record.privatePackagePath === packageRelative)) fail(`private package was already accepted: ${packageRelative}`);
  try { await lstat(path.join(ROOT, publicRoot)); fail(`public run directory already exists: ${publicRoot}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const validated = await validateCandidateReview(review, { repoRoot: ROOT, packageRelative, conductorKey: key });
  if (validated.status !== 'PASS') fail('candidate validation did not pass');
  const { context: publicContext, passes: authority } = await verifyReviewAuthority(review, packageRelative, key);

  const persistedReviewPath = `${publicRoot}/review.json`;
  const reviewerRoot = `${packageRelative}/reviewer-package`;
  const packageManifest = publicContext.manifest;
  const { transactionRoot, parentIdentity } = await createAtomicPublishTransaction(path.join(ROOT, publicRoot));
  try {
    const publicFiles = {
      packageManifest: await transactionFile(transactionRoot, publicRoot, `${publicRoot}/package-manifest.json`, publicContext.manifestBytes),
      materialBinding: await transactionFile(transactionRoot, publicRoot, `${publicRoot}/material-binding.json`, publicContext.bindingBytes),
      inputAllowlist: await transactionFile(transactionRoot, publicRoot, `${publicRoot}/input-allowlist.json`, publicContext.allowlistBytes),
      prompt: await transactionFile(transactionRoot, publicRoot, `${publicRoot}/prompt.txt`, publicContext.promptBytes),
    };
    const reviewBytes = Buffer.from(canonicalStringify(review)); const persistedReview = await transactionFile(transactionRoot, publicRoot, persistedReviewPath, reviewBytes);
    const votes = []; const reviewerAssignments = []; const reviewerRunAttestations = []; const rawObservations = [];
    for (const vote of [...review.votes].sort((a, b) => a.passNumber - b.passNumber)) {
      votes.push(await transactionFile(transactionRoot, publicRoot, `${publicRoot}/vote-pass-${vote.passNumber}.json`, Buffer.from(canonicalStringify(vote))));
      const evidence = authority.find((item) => item.assignmentRelative.endsWith(`pass-${vote.passNumber}.json`));
      reviewerAssignments.push(await transactionFile(transactionRoot, publicRoot, `${publicRoot}/assignment-pass-${vote.passNumber}.json`, evidence.assignmentBytes));
      reviewerRunAttestations.push(await transactionFile(transactionRoot, publicRoot, `${publicRoot}/run-attestation-pass-${vote.passNumber}.json`, evidence.runBytes));
      rawObservations.push(await transactionFile(transactionRoot, publicRoot, `${publicRoot}/raw-observation-pass-${vote.passNumber}.json`, evidence.rawBytes));
    }
    const childInput = packageManifest.inputs[0]; const childPixels = [];
    for (const surface of ['master', 'runtime']) {
      const bytes = await readContainedFile(ROOT, `${reviewerRoot}/${childInput.surfaces[surface].path}`); const digest = childInput.surfaces[surface].sha256;
      if (sha256Bytes(bytes) !== digest) fail(`reviewed child ${surface} changed before atomic publication`);
      const blobPath = `${publicRoot}/blobs/sha256/${digest}.png`; const descriptor = await transactionFile(transactionRoot, publicRoot, blobPath, bytes);
      childPixels.push({ surface, ...descriptor });
    }
    const eiluPixels = [];
    for (const benchmark of packageManifest.benchmarkInputs) {
      const bindingEntry = locked.eiluBenchmark.pixelBindings.find((item) => item.masterSha256 === benchmark.surfaces.master.sha256 && item.runtimeSha256 === benchmark.surfaces.runtime.sha256);
      if (!bindingEntry) fail('review package benchmark is not a locked Eilu stage');
      for (const surface of ['master', 'runtime']) {
        const bytes = await readContainedFile(ROOT, `${reviewerRoot}/${benchmark.surfaces[surface].path}`); const digest = benchmark.surfaces[surface].sha256;
        if (sha256Bytes(bytes) !== digest) fail(`reviewed Eilu ${bindingEntry.pgId} ${surface} changed before atomic publication`);
        const descriptor = await transactionFile(transactionRoot, publicRoot, `${publicRoot}/blobs/sha256/${digest}.png`, bytes);
        eiluPixels.push({ pgId: bindingEntry.pgId, surface, ...descriptor });
      }
    }
    const parentEvidence = await buildPublicParentEvidence(binding, { queue, edge, currentRecords: existingRecords });
    assertPublicParentEvidence(parentEvidence, binding, `${requirementId} public parent evidence`);
    const artifactCore = {
    schemaVersion: 'continuity-g003-public-review-artifact-v4', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
    requirementId, generationRunId: binding.generationRunId,
    candidateId: `g003-candidate:${childId}`, opaqueCandidateId: binding.opaqueCandidateId, reviewKind: requirementKind, edgeId: edge?.edgeId ?? null,
      review: persistedReview,
      privateMaterialBinding: { path: `${packageRelative}/private-binding.json`, sha256: sha256Bytes(publicContext.bindingBytes), materialBindingSha256: candidateMaterialBindingSha256(binding) },
    ...publicFiles, childPixels, eiluPixels, reviewPolicy: binding.reviewContract.reviewPolicy, comparisonThresholds: (queue ?? edge).comparisonThresholds,
      votes, reviewerAssignments, reviewerRunAttestations, rawObservations, parentEvidence, supersession,
    };
    const artifactWithOutput = { ...artifactCore, outputSha256: sha256Canonical(artifactCore) };
    const artifact = { ...artifactWithOutput, publicSignature: signG003PublicEvidence(artifactWithOutput, key, { purpose: 'g003:public-review-artifact', schemaSha256: G003_SCHEMA_BINDINGS[1].normalizedSha256 }) };
    const artifactPath = `${publicRoot}/public-review-artifact.json`; const artifactBytes = Buffer.from(canonicalStringify(artifact));
    await transactionFile(transactionRoot, publicRoot, artifactPath, artifactBytes);
    const record = {
    schemaVersion: 'continuity-g003-accepted-record-v1', requirementKind, requirementId, candidateId: artifact.candidateId,
    edgeId: edge?.edgeId ?? null, childId, generationRunId: binding.generationRunId,
    sortOrder: queue ? locked.queueCandidates.findIndex((item) => item.candidateId === queue.candidateId) : 1000 + locked.edgeCandidates.findIndex((item) => item.edgeId === edge.edgeId),
      privatePackagePath: packageRelative, reviewPath: persistedReviewPath, reviewSha256: sha256Bytes(reviewBytes), artifactPath,
      artifactSha256: sha256Bytes(artifactBytes),
    childPixels, packageManifestSha256: binding.packageManifestSha256,
    materialBindingSha256: candidateMaterialBindingSha256(binding), inputAllowlistSha256: binding.allowlistSha256,
      promptSha256: binding.promptSha256, supersession,
    };
    await transactionFile(transactionRoot, publicRoot, `${publicRoot}/acceptance-record.json`, Buffer.from(canonicalStringify(record)));
    await atomicPublishDirectory(transactionRoot, path.join(ROOT, publicRoot), { parentIdentity });
    return { status: 'ACCEPTED', requirementId, publicArtifact: artifactPath, record: `${publicRoot}/acceptance-record.json` };
  } catch (error) { await cleanupAtomicTransaction(transactionRoot, parentIdentity); throw error; }
}
async function accept(reviewInputPath, packageRelative, key, options = {}) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('accept', () => acceptUnlocked(reviewInputPath, packageRelative, key, options));
}

async function verifyArtifact(record) {
  const artifact = await readJson(ROOT, record.artifactPath);
  exactKeys(artifact, ['schemaVersion', 'protocolAuthoritySha256', 'requirementId', 'generationRunId', 'candidateId', 'opaqueCandidateId', 'reviewKind', 'edgeId', 'review', 'privateMaterialBinding', 'packageManifest', 'materialBinding', 'inputAllowlist', 'prompt', 'childPixels', 'eiluPixels', 'reviewPolicy', 'comparisonThresholds', 'votes', 'reviewerAssignments', 'reviewerRunAttestations', 'rawObservations', 'parentEvidence', 'supersession', 'outputSha256', 'publicSignature'], `public artifact ${record.requirementId}`);
  if (sha256Bytes(await readContainedFile(ROOT, record.artifactPath)) !== record.artifactSha256) fail(`artifact bytes drift: ${record.requirementId}`);
  if (artifact.outputSha256 !== sha256Canonical(coreWithoutOutput(artifact))) fail(`artifact output hash drift: ${record.requirementId}`);
  verifyG003PublicEvidence(unsignedPublic(artifact), artifact.publicSignature, { purpose: 'g003:public-review-artifact', schemaSha256: G003_SCHEMA_BINDINGS[1].normalizedSha256 });
  assertGenerationRunId(artifact?.generationRunId, `public artifact ${record.requirementId} generationRunId`);
  if (!artifact.requirementId || !artifact.review || !artifact.privateMaterialBinding) fail(`artifact lacks signed routing/material bindings: ${record.requirementId}`);
  if (artifact.schemaVersion !== 'continuity-g003-public-review-artifact-v4' || artifact.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256) fail(`${record.requirementId}: public artifact is not review protocol v4`);
  for (const descriptor of [artifact.review, artifact.privateMaterialBinding, artifact.packageManifest, artifact.materialBinding, artifact.inputAllowlist, artifact.prompt, ...artifact.votes,
    ...artifact.reviewerAssignments, ...artifact.reviewerRunAttestations, ...artifact.rawObservations, ...artifact.childPixels, ...artifact.eiluPixels]) {
    if (sha256Bytes(await readContainedFile(ROOT, descriptor.path)) !== descriptor.sha256) fail(`public artifact dependency drift: ${descriptor.path}`);
  }
  const publicBinding = await readJson(ROOT, artifact.materialBinding.path);
  assertGenerationRunId(publicBinding?.generationRunId, `public material binding ${record.requirementId} generationRunId`);
  if (artifact.privateMaterialBinding.sha256 !== artifact.materialBinding.sha256
      || artifact.privateMaterialBinding.materialBindingSha256 !== candidateMaterialBindingSha256(publicBinding)
      || publicBinding.candidateId !== artifact.requirementId || publicBinding.generationRunId !== artifact.generationRunId
      || canonicalStringify(artifact.reviewPolicy) !== canonicalStringify(publicBinding.reviewContract?.reviewPolicy)) fail(`${record.requirementId}: private/public material binding or review policy differs from signed artifact identity`);
  assertPublicParentEvidence(artifact.parentEvidence, publicBinding, `${record.requirementId} public parent evidence`);
  if (artifact.votes.length !== 2) fail(`${record.requirementId}: public artifact must bind exactly two votes`);
  const voteValues = [];
  for (const voteDescriptor of artifact.votes) {
    const vote = await readJson(ROOT, voteDescriptor.path); const voteCore = structuredClone(vote); delete voteCore.outputSha256; delete voteCore.conductorHmacSha256;
    assertGenerationRunId(vote?.generationRunId, `${record.requirementId} vote generationRunId`);
    if (vote.schemaVersion !== 'continuity-candidate-primary-vote-v4' || vote.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || vote.generationRunId !== artifact.generationRunId) fail(`${record.requirementId}: vote protocol/authority/generationRunId differs from signed artifact`);
    if (vote.outputSha256 !== sha256Canonical(voteCore) || !SHA.test(vote.conductorHmacSha256 ?? '')) fail(`${record.requirementId}: vote output/HMAC binding is malformed`);
    validateCandidateObservationAgainstBinding(vote.observation, vote.confidence, publicBinding);
    const assignmentDescriptor = artifact.reviewerAssignments.find((item) => item.path.endsWith(`pass-${vote.passNumber}.json`));
    const runDescriptor = artifact.reviewerRunAttestations.find((item) => item.path.endsWith(`pass-${vote.passNumber}.json`));
    const rawDescriptor = artifact.rawObservations.find((item) => item.path.endsWith(`pass-${vote.passNumber}.json`));
    if (!assignmentDescriptor || !runDescriptor || !rawDescriptor || vote.assignmentManifestSha256 !== assignmentDescriptor.sha256
        || vote.reviewerRunAttestationSha256 !== runDescriptor.sha256) fail(`${record.requirementId}: public assignment/run descriptors do not bind vote`);
    const assignment = await readJson(ROOT, assignmentDescriptor.path); const run = await readJson(ROOT, runDescriptor.path); const raw = await readJson(ROOT, rawDescriptor.path);
    verifyAuthorityPublic(assignment, 'public reviewer assignment'); verifyAuthorityPublic(run, 'public reviewer run attestation');
    assertGenerationRunId(assignment?.generationRunId, `${record.requirementId} assignment generationRunId`);
    assertGenerationRunId(run?.generationRunId, `${record.requirementId} run attestation generationRunId`);
    if (assignment.generationRunId !== artifact.generationRunId || run.generationRunId !== artifact.generationRunId) fail(`${record.requirementId}: reviewer authority generationRunId differs from artifact`);
    if (sha256Canonical(raw) !== vote.rawObservationSha256 || run.rawObservationSha256 !== vote.rawObservationSha256
        || run.assignmentManifestSha256 !== vote.assignmentManifestSha256 || canonicalStringify(raw.observation) !== canonicalStringify(vote.observation)) fail(`${record.requirementId}: public raw observation binding mismatch`);
    voteValues.push(vote);
  }
  if (JSON.stringify(voteValues.map((vote) => vote.passNumber).sort()) !== JSON.stringify([1, 2])) fail(`${record.requirementId}: votes must be pass 1 and pass 2`);
  for (const field of ['reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) {
    if (new Set(voteValues.map((vote) => vote[field])).size !== 2) fail(`${record.requirementId}: votes share ${field}`);
  }
  const persistedReview = await readJson(ROOT, artifact.review.path);
  assertGenerationRunId(persistedReview?.generationRunId, `${record.requirementId} persisted review generationRunId`);
  if (persistedReview.schemaVersion !== 'continuity-candidate-review-v4' || persistedReview.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || persistedReview.generationRunId !== artifact.generationRunId
      || canonicalStringify([...persistedReview.votes].sort((a, b) => a.passNumber - b.passNumber)) !== canonicalStringify([...voteValues].sort((a, b) => a.passNumber - b.passNumber))) fail(`${record.requirementId}: persisted review differs from signed public votes`);
  return artifact;
}
export function assertAcceptedRecordBinding(record, artifact, artifactRawSha256, reviewRawSha256) {
  if (record.requirementKind === 'queue' && record.requirementId !== artifact.candidateId) fail('accepted record requirement/artifact identity mismatch');
  if (record.requirementKind === 'edge' && record.requirementId !== artifact.edgeId) fail('accepted record edge/artifact identity mismatch');
  if (record.artifactSha256 !== artifactRawSha256 || record.reviewSha256 !== reviewRawSha256
      || canonicalStringify(record.childPixels) !== canonicalStringify(artifact.childPixels)) fail('accepted record raw SHA/child pixel binding mismatch');
}

function baseEvidence(record, artifact, review) {
  const first = review.votes.find((vote) => vote.passNumber === 1);
  return {
    candidateId: artifact.candidateId, reviewArtifactPath: record.artifactPath, reviewArtifactSha256: record.artifactSha256,
    packageManifestSha256: record.packageManifestSha256, materialBindingSha256: record.materialBindingSha256,
    inputAllowlistSha256: record.inputAllowlistSha256, promptSha256: record.promptSha256,
    reviewPolicy: artifact.reviewPolicy,
    parentEvidence: artifact.parentEvidence.map((parent) => ({
      evidenceRole: parent.evidenceRole, parentRole: parent.parentRole, parentId: parent.parentId,
      parentPixelSha256s: parent.pixelSha256s, approvedParentCandidateId: parent.approvedParentCandidateId,
      approvedParentReviewSha256: parent.approvedParentReviewSha256, anchors: parent.anchors,
    })),
    approvedChildPixelSha256s: artifact.childPixels.map((item) => item.sha256),
    sourceReviewIds: review.votes.map((vote) => vote.reviewId),
    sourceReviewOutputSha256s: review.votes.map((vote) => vote.outputSha256),
    sourceReviewSignatureSha256s: review.votes.map((vote) => sha256Canonical({ conductorHmacSha256: vote.conductorHmacSha256 })),
    eiluEvidence: {
      benchmarkId: 'eilu-comparative-visual-v1', passed: true,
      inputAssetSha256s: artifact.eiluPixels.map((item) => item.sha256),
      perStageScores: first.observation.eiluComparison.stageObservations.map((item) => item.continuityScore),
      minimumScore: Math.min(...first.observation.eiluComparison.stageObservations.map((item) => item.continuityScore)),
    },
  };
}
export function assertCurrentGeneratedParentBinding(edgeId, parentId, publishedParent, parentRecord, parentArtifact) {
  const expectedCandidateId = `g003-candidate:${parentId}`;
  const expectedPixels = parentArtifact?.childPixels.map((pixel) => pixel.sha256).sort();
  if (!parentRecord || !parentArtifact || !publishedParent || publishedParent.approvedParentCandidateId !== expectedCandidateId
      || publishedParent.approvedParentReviewSha256 !== parentArtifact.review?.sha256
      || JSON.stringify([...(publishedParent.pixelSha256s ?? [])].sort()) !== JSON.stringify(expectedPixels)) fail(`${edgeId}: generated parent review/pixels differ from current signed queue artifact`);
}

async function rebuildCoverageUnlocked(key) {
  const locked = await loadLockedG003Gate();
  await reconstructDependencies(key);
  const records = await readVerifiedRecords(key);
  const queueRecords = new Map(); const edgeRecords = new Map();
  for (const record of records) {
    const target = record.requirementKind === 'queue' ? queueRecords : edgeRecords;
    if (target.has(record.requirementId)) fail(`multiple accepted records for ${record.requirementId}`);
    target.set(record.requirementId, record);
  }
  const passedQueue = queueRecords.size; const passedEdges = edgeRecords.size;
  const progress = { schemaVersion: 'continuity-g003-progress-v2', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, requiredQueueCandidates: G003_COUNTS.regenerate, passedQueueCandidates: passedQueue, requiredFinalEdges: G003_COUNTS.edges, passedFinalEdges: passedEdges, missingCoverage: G003_COUNTS.obligations - passedQueue - passedEdges };
  if (passedQueue !== G003_COUNTS.regenerate || passedEdges !== G003_COUNTS.edges) fail(`coverage incomplete: queue=${passedQueue}/${G003_COUNTS.regenerate} edges=${passedEdges}/${G003_COUNTS.edges}`);
  const lockedQueueIds = locked.queueCandidates.map((item) => item.candidateId).sort();
  const lockedEdgeIds = locked.edgeCandidates.map((item) => item.edgeId).sort();
  assertExactCoverageIds(lockedQueueIds, [...queueRecords.keys()], 'accepted queue records');
  assertExactCoverageIds(lockedEdgeIds, [...edgeRecords.keys()], 'accepted edge records');

  const output = structuredClone(locked);
  const verifiedQueueArtifacts = new Map();
  for (const item of output.queueCandidates) {
    const record = queueRecords.get(item.candidateId); const artifact = await verifyArtifact(record);
    const reviewBytes = await readContainedFile(ROOT, record.reviewPath); const review = JSON.parse(reviewBytes); assertAcceptedRecordBinding(record, artifact, record.artifactSha256, sha256Bytes(reviewBytes));
    const expectedEilu = locked.eiluBenchmark.pixelBindings.flatMap((binding) => [binding.masterSha256, binding.runtimeSha256]).sort();
    if (JSON.stringify(artifact.eiluPixels.map((pixel) => pixel.sha256).sort()) !== JSON.stringify(expectedEilu)) fail(`${item.candidateId}: Eilu pixel set differs from six G002-locked pixels`);
    verifiedQueueArtifacts.set(item.candidateId, artifact);
    item.status = 'PASS'; item.reviewEvidence = baseEvidence(record, artifact, review);
  }
  const dependentQueueItems = output.queueCandidates.filter((item) => item.requiredParentCandidateIds.length > 0);
  if (dependentQueueItems.length !== G003_COUNTS.dependentQueue) fail(`locked generated-parent queue topology drifted from ${G003_COUNTS.dependentQueue} candidates`);
  for (const item of dependentQueueItems) {
    const artifact = verifiedQueueArtifacts.get(item.candidateId);
    for (const parentCandidateId of item.requiredParentCandidateIds) {
      const parentId = parentCandidateId.slice('g003-candidate:'.length);
      const publishedParent = artifact.parentEvidence.find((entry) => entry.parentId === parentId && entry.approvedParentCandidateId === parentCandidateId);
      assertCurrentGeneratedParentBinding(item.candidateId, parentId, publishedParent, queueRecords.get(parentCandidateId), verifiedQueueArtifacts.get(parentCandidateId));
    }
  }
  for (const item of output.edgeCandidates) {
    const record = edgeRecords.get(item.edgeId); const artifact = await verifyArtifact(record);
    const reviewBytes = await readContainedFile(ROOT, record.reviewPath); const review = JSON.parse(reviewBytes); assertAcceptedRecordBinding(record, artifact, record.artifactSha256, sha256Bytes(reviewBytes));
    const expectedEilu = locked.eiluBenchmark.pixelBindings.flatMap((binding) => [binding.masterSha256, binding.runtimeSha256]).sort();
    if (JSON.stringify(artifact.eiluPixels.map((pixel) => pixel.sha256).sort()) !== JSON.stringify(expectedEilu)) fail(`${item.edgeId}: Eilu pixel set differs from six G002-locked pixels`);
    const evidence = baseEvidence(record, artifact, review);
    evidence.edgeId = item.edgeId;
    evidence.parentEvidence = item.allowedParentAnchors.map((parent) => {
      const publishedParent = artifact.parentEvidence.find((entry) => entry.parentRole === parent.parentRole && entry.parentId === parent.parentId);
      if (!publishedParent || publishedParent.pixelSha256s?.length !== 2) fail(`${item.edgeId}: public parent pixel evidence is incomplete`);
      if (parent.sourceKind === 'generated-parent-candidate' || publishedParent.approvedParentCandidateId) {
        const expectedCandidateId = `g003-candidate:${parent.parentId}`; const parentRecord = queueRecords.get(expectedCandidateId);
        const parentArtifact = verifiedQueueArtifacts.get(expectedCandidateId);
        assertCurrentGeneratedParentBinding(item.edgeId, parent.parentId, publishedParent, parentRecord, parentArtifact);
      }
      return ({
      evidenceRole: publishedParent.evidenceRole, parentRole: parent.parentRole, parentId: parent.parentId,
      parentPixelSha256s: publishedParent.pixelSha256s,
      approvedParentCandidateId: publishedParent.approvedParentCandidateId,
      approvedParentReviewSha256: publishedParent.approvedParentReviewSha256,
      anchors: publishedParent.anchors,
    }); });
    item.status = 'PASS'; item.reviewEvidence = evidence;
  }
  output.state = 'PASS'; output.completionAllowed = true;
  output.coverage = { requiredQueueCandidates: G003_COUNTS.regenerate, passedQueueCandidates: G003_COUNTS.regenerate, requiredFinalEdges: G003_COUNTS.edges, passedFinalEdges: G003_COUNTS.edges, missingCoverage: 0 };
  await writeCanonicalFile(path.join(ROOT, `${EVIDENCE}/progress-summary.json`), progress, { containmentRoot: ROOT, mode: 0o644, allowedBasenames: new Set(['progress-summary.json']) });
  await writeCanonicalFile(path.join(ROOT, `${EVIDENCE}/review-coverage.json`), output, { containmentRoot: ROOT, mode: 0o644, allowedBasenames: new Set(['review-coverage.json']) });
  return { status: 'PASS', coverage: output.coverage };
}
async function rebuildCoverage(key) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('rebuild-coverage', () => rebuildCoverageUnlocked(key));
}

async function rejectUnlocked(rejectionPath, key) {
  const request = await readJson(ROOT, rejectionPath);
  exactKeys(request, ['candidateId', 'generationRunId', 'materialSha256s', 'reasonCodes', 'sourcePaths', 'associatedReviewSha256s', 'rejectedAt', 'nonce'], 'rejection request');
  assertGenerationRunId(request.generationRunId, 'rejection request generationRunId');
  if (!/^(g003-candidate:PG-[0-9]{3}|g003-edge:PG-[0-9]{3}:PG-[0-9]{3})$/.test(request.candidateId)
      || !Array.isArray(request.reasonCodes) || request.reasonCodes.length === 0
      || new Set(request.reasonCodes).size !== request.reasonCodes.length || request.reasonCodes.some((reason) => !/^[a-z0-9][a-z0-9._:-]+$/.test(reason))
      || !Array.isArray(request.materialSha256s) || request.materialSha256s.length !== 2 || new Set(request.materialSha256s).size !== 2 || request.materialSha256s.some((digest) => !SHA.test(digest))
      || !Array.isArray(request.sourcePaths) || request.sourcePaths.length === 0
      || new Set(request.sourcePaths).size !== request.sourcePaths.length || !Array.isArray(request.associatedReviewSha256s)
      || new Set(request.associatedReviewSha256s).size !== request.associatedReviewSha256s.length
      || request.associatedReviewSha256s.some((digest) => !SHA.test(digest)) || Number.isNaN(Date.parse(request.rejectedAt))
      || typeof request.nonce !== 'string' || request.nonce.length < 16) fail('invalid rejection request');
  const files = [];
  for (const source of request.sourcePaths ?? []) {
    assertRejectionSource(source);
    const bytes = await readContainedFile(ROOT, source); files.push({ path: source, sha256: sha256Bytes(bytes), bytes });
  }
  if (files.length === 0) fail('rejection requires sourcePaths');
  if (request.materialSha256s.some((digest) => !files.some((file) => file.sha256 === digest))) fail('rejection material hashes must be present in source files');
  const archiveBinding = rejectionArchiveBinding(request, files);
  const archiveId = sha256Canonical(archiveBinding);
  const archiveRoot = `assets/creatures/biological-continuity-v3/rejected/${request.generationRunId}/${archiveId}`;
  const rejectedRelativeRoot = `assets/creatures/biological-continuity-v3/rejected/${request.generationRunId}`;
  try {
    for (const name of (await listContainedRegularFiles(ROOT, rejectedRelativeRoot)).filter((entry) => entry.endsWith('/rejection.json'))) {
      const existingPath = `${rejectedRelativeRoot}/${name}`; const existingBytes = await readContainedFile(ROOT, existingPath); const existing = JSON.parse(existingBytes);
      if (existing.nonce !== request.nonce) continue;
      verifyAuthority(existing, AUTHORITY_DOMAINS.rejection, key, 'rejection archive');
      assertRejectionValue(existing);
      if (existing.archiveId === archiveId && canonicalStringify(existing.archiveBinding) === canonicalStringify(archiveBinding)) {
        await publishRejectionTombstone(existing, existingBytes, key);
        return { status: 'REJECTED_ARCHIVED_IDEMPOTENT', archiveRoot: `${rejectedRelativeRoot}/${name.slice(0, -'/rejection.json'.length)}` };
      }
      fail('rejection nonce already exists with different immutable fields');
    }
  } catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  try {
    const existingBytes = await readContainedFile(ROOT, `${archiveRoot}/rejection.json`); const existing = JSON.parse(existingBytes); verifyAuthority(existing, AUTHORITY_DOMAINS.rejection, key, 'rejection archive');
    assertRejectionValue(existing);
    if (existing.archiveId !== archiveId || canonicalStringify(existing.archiveBinding) !== canonicalStringify(archiveBinding)) fail('rejection nonce already exists with different immutable fields');
    await publishRejectionTombstone(existing, existingBytes, key);
    return { status: 'REJECTED_ARCHIVED_IDEMPOTENT', archiveRoot };
  } catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  const { transactionRoot, parentIdentity } = await createAtomicPublishTransaction(path.join(ROOT, archiveRoot), { prefix: '.reject-transaction-' });
  try {
    const archived = [];
    for (const [index, file] of files.entries()) {
      const basename = `${String(index + 1).padStart(2, '0')}-${path.basename(file.path)}`;
      await writeFileAtomicNoFollow(path.join(transactionRoot, basename), file.bytes, { containmentRoot: transactionRoot, mode: 0o644, allowedBasenames: new Set([basename]) });
      archived.push({ path: `${archiveRoot}/${basename}`, sha256: file.sha256 });
    }
    const rejectionCore = {
    schemaVersion: 'continuity-rejected-candidate-v1', candidateId: request.candidateId, generationRunId: request.generationRunId,
      archiveId, archiveBinding, materialSha256s: archiveBinding.materialSha256s, reasonCodes: archiveBinding.reasonCodes, sourceFiles: archived,
      associatedReviewSha256s: archiveBinding.associatedReviewSha256s, rejectedAt: request.rejectedAt, nonce: request.nonce,
    };
    const rejection = finalizeAuthority(rejectionCore, AUTHORITY_DOMAINS.rejection, key);
    const rejectionBytes = Buffer.from(canonicalStringify(rejection));
    await writeFileAtomicNoFollow(path.join(transactionRoot, 'rejection.json'), rejectionBytes, { containmentRoot: transactionRoot, mode: 0o644, allowedBasenames: new Set(['rejection.json']) });
    await publishArchiveThenTombstone(
      () => atomicPublishDirectory(transactionRoot, path.join(ROOT, archiveRoot), { parentIdentity }),
      () => publishRejectionTombstone(rejection, rejectionBytes, key),
    );
    return { status: 'REJECTED_ARCHIVED', archiveRoot };
  } catch (error) { await cleanupAtomicTransaction(transactionRoot, parentIdentity); throw error; }
}
async function reject(rejectionPath, key) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('reject', () => rejectUnlocked(rejectionPath, key));
}

/**
 * Fail-closed v5 rejection boundary. Validation is deliberately separate from
 * v4 `reject`: free-text v4 requests cannot be promoted into v5 evidence, and
 * this scaffold performs no write until a verified v5 authority is injected.
 */
async function attestRejectionUnlocked(observationPath, assignmentRelative, packageRelative, key) {
  const context = await packageAuthorityContext(packageRelative, key);
  const assignmentBytes = await readContainedFile(ROOT, assignmentRelative);
  const assignment = JSON.parse(assignmentBytes);
  verifyAuthority(assignment, AUTHORITY_DOMAINS.assignment, key, 'reviewer assignment');
  assertAssignmentContext(assignment, context);
  const observation = await readReviewerAuthoredObservation(ROOT, observationPath);
  const packageContext = {
    opaqueCandidateId: context.binding.opaqueCandidateId,
    generationRunId: context.binding.generationRunId,
    packageManifestSha256: context.binding.packageManifestSha256,
    materialBindingSha256: candidateMaterialBindingSha256(context.binding),
    inputAllowlistSha256: context.binding.allowlistSha256,
    promptSha256: context.binding.promptSha256,
    inputAssetSha256s: context.inputAssetSha256s,
    requiredChildTaxonomy: context.binding.reviewContract.reviewPolicy.requiredChildTaxonomy,
    parentRoles: context.binding.parents.map((_, index) => `parent-${index + 1}`),
    requiredAnchors: context.binding.reviewContract.anchorSets.flatMap((set) => set.anchors.map((anchor) => ({ parentRole: set.role, anchorId: anchor.anchorId, description: anchor.description }))),
    eiluBenchmarkId: context.binding.reviewContract.eiluBenchmark.benchmarkId,
    canonicalMode: context.binding.reviewContract.reviewPolicy.assessmentMode === 'canonical-root-replacement',
  };
  const validated = assertRejectionObservationV2(observation.value, { assignment, assignmentBytes, packageContext });
  return { status: 'V5_REJECTION_VALIDATED_UNATTESTED', ...validated, mutationPerformed: false };
}
async function attestRejection(observationPath, assignmentRelative, packageRelative, key) {
  assertG003ConductorKeyPinned(key);
  return withExclusiveG003Operation('attest-rejection', () => attestRejectionUnlocked(observationPath, assignmentRelative, packageRelative, key));
}

// Programmatic v5 entrypoint. The caller must inject lane A's verified
// signature verifier; quarantine adjudication is intentionally zero-credit
// and cannot publish acceptance or satisfy a continuity obligation.
function adjudicateQuarantine(input, { verifySignature }) {
  const result = adjudicateQuarantineInvalidityV1({ ...input, verifySignature });
  if (result.obligationCredit !== 0 || result.pixelDisposition !== 'UNCHANGED' || result.requiredFreshContinuityReviews !== 2) {
    fail('quarantine adjudication attempted to create review credit or accept pixels');
  }
  return result;
}
export function rejectionArchiveBinding(request, files) {
  assertGenerationRunId(request?.generationRunId, 'rejection archive binding generationRunId');
  return { candidateId: request.candidateId, generationRunId: request.generationRunId, materialSha256s: [...request.materialSha256s].sort(), reasonCodes: [...request.reasonCodes].sort(),
    sourceFiles: files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })), associatedReviewSha256s: [...request.associatedReviewSha256s].sort(),
    rejectedAt: request.rejectedAt, nonce: request.nonce };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 2 && args[1] === '--conductor-key-stdin') console.log(JSON.stringify(await prepare(args[0], await conductorKey())));
  else if (command === 'prepare' && args.length === 4 && args[1] === '--supersession' && args[3] === '--conductor-key-stdin') console.log(JSON.stringify(await prepare(args[0], await conductorKey(), { supersessionRelative: args[2] })));
  else if (command === 'issue-assignment' && args.length === 3 && args[2] === '--conductor-key-stdin') console.log(JSON.stringify(await issueAssignment(args[0], args[1], await conductorKey())));
  else if (command === 'attest-vote' && args.length === 4 && args[3] === '--conductor-key-stdin') console.log(JSON.stringify(await attestVote(args[0], args[1], args[2], await conductorKey())));
  else if (command === 'assemble-review' && args.length === 1) console.log(JSON.stringify(await assembleReview(args[0])));
  else if (command === 'accept' && args.length === 3 && args[2] === '--conductor-key-stdin') console.log(JSON.stringify(await accept(args[0], args[1], await conductorKey())));
  else if (command === 'accept' && args.length === 5 && args[2] === '--supersession' && args[4] === '--conductor-key-stdin') console.log(JSON.stringify(await accept(args[0], args[1], await conductorKey(), { supersessionRelative: args[3] })));
  else if (command === 'authorize-supersession' && args.length === 2 && args[1] === '--conductor-key-stdin') console.log(JSON.stringify(await authorizeSupersession(args[0], await conductorKey())));
  else if (command === 'rebuild-coverage' && args.length === 1 && args[0] === '--conductor-key-stdin') console.log(JSON.stringify(await rebuildCoverage(await conductorKey())));
  else if (command === 'reject' && args.length === 2 && args[1] === '--conductor-key-stdin') console.log(JSON.stringify(await reject(args[0], await conductorKey())));
  else if (command === 'attest-rejection' && args.length === 4 && args[3] === '--conductor-key-stdin') console.log(JSON.stringify(await attestRejection(args[0], args[1], args[2], await conductorKey())));
  else fail('usage: prepare <descriptor.json> [--supersession <signed.json>] --conductor-key-stdin | issue-assignment <identity.json> <package-root> --conductor-key-stdin | attest-vote <raw.json> <assignment.json> <package-root> --conductor-key-stdin | assemble-review <package-root> | accept <review.json> <package-root> [--supersession <signed.json>] --conductor-key-stdin | authorize-supersession <request.json> --conductor-key-stdin | rebuild-coverage --conductor-key-stdin | reject <request.json> --conductor-key-stdin | attest-rejection <observation.json> <assignment.json> <package-root> --conductor-key-stdin');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

export { accept, adjudicateQuarantine, assembleReview, assertExactCoverageIds, assertG003ActiveBaseline, assertRejectionSource, attestRejection, attestVote, authorizeSupersession, issueAssignment, prepare, rebuildCoverage, reject, verifyArtifact, verifyReviewAuthority };
