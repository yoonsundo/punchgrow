#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { assertExactIds, listContainedRegularFiles, readContainedFile, readJson } from './lib/continuity-assignment/evidence.mjs';
import { PINNED_AUTHORITY_FINGERPRINT, PINNED_PUBLIC_KEY_SPKI_DER_BASE64, verifyPublicEvidence } from './lib/g002-public-authority.mjs';
import { validateSignedCanonicalRootRedesignTargets } from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';
import { verifyG002ReviewEvidence } from './verify-g002-review-evidence.mjs';
import {
  ASSET_CENSUS_PATH, AUTHORITY_CONTRACT_PATH, EVIDENCE_ROOT, FIXED_ASSIGNMENT_OUTPUTS,
  G001_ANCHORS_PATH, G001_CENSUS_PATH, INPUT_LOCK_PATH, PACK_PATH, PG_IDS, PIXEL_CLUSTERS_PATH,
  OUTPUT_ATTESTATION_PATH, SIGNED_MANIFEST_PATH, TAXONOMY_CONSENSUS_PATH, TAXONOMY_LOCK_PATH, TAXONOMY_ROOT,
  assertEvidenceRootInventory, assertExactKeys, expectedCoveredPaths, fail, indexByPgId, pngDescriptor, taxonomyEvidencePaths,
} from './lib/g002-public-evidence-manifest-v2.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;

function assertFileBinding(binding, label) {
  assertExactKeys(binding, ['path', 'sha256'], label);
  if (typeof binding.path !== 'string' || !SHA256.test(binding.sha256)) fail(`${label} is invalid`);
}

function assertSurfaceBinding(binding, expectedPath, label) {
  assertExactKeys(binding, ['path', 'sha256', 'width', 'height', 'bytes'], label);
  if (binding.path !== expectedPath || !SHA256.test(binding.sha256)
      || !Number.isInteger(binding.width) || !Number.isInteger(binding.height) || !Number.isInteger(binding.bytes)
      || binding.width < 1 || binding.height < 1 || binding.bytes < 24) fail(`${label} is invalid`);
}

export function assertManifestShape(manifest, { requireSignature = true } = {}) {
  assertExactKeys(manifest, requireSignature
    ? ['schemaVersion', 'authorityMode', 'files', 'runtimeAssets', 'outputSha256', 'publicSignature']
    : ['schemaVersion', 'authorityMode', 'files', 'runtimeAssets', 'outputSha256'], 'public evidence manifest');
  if (manifest.schemaVersion !== 'g002-public-evidence-manifest-v2' || manifest.authorityMode !== 'PUBLIC_ED25519') fail('manifest identity or authority mode is invalid');
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.runtimeAssets)) fail('manifest file/runtime lists are invalid');
  manifest.files.forEach((entry, index) => assertFileBinding(entry, `files[${index}]`));
  assertExactIds(manifest.files.map((entry) => entry.path), [...new Set(manifest.files.map((entry) => entry.path))], 'manifest file paths');
  for (const required of [AUTHORITY_CONTRACT_PATH, INPUT_LOCK_PATH, TAXONOMY_LOCK_PATH, TAXONOMY_CONSENSUS_PATH, OUTPUT_ATTESTATION_PATH]) {
    if (!manifest.files.some((entry) => entry.path === required)) fail(`manifest omits mandatory evidence: ${required}`);
  }
  assertExactIds(manifest.runtimeAssets.map((entry) => entry.pgId), PG_IDS, 'manifest runtime PG IDs');
  for (const entry of manifest.runtimeAssets) {
    assertExactKeys(entry, ['pgId', 'master', 'mobile', 'macos'], `${entry.pgId} runtime descriptor`);
    assertExactKeys(entry.master, ['sha256'], `${entry.pgId} master descriptor`);
    if (!SHA256.test(entry.master.sha256)) fail(`${entry.pgId} master digest is invalid`);
    assertSurfaceBinding(entry.mobile, `assets/creatures/mobile/${entry.pgId}.png`, `${entry.pgId} mobile runtime descriptor`);
    assertSurfaceBinding(entry.macos, `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${entry.pgId}.png`, `${entry.pgId} macOS runtime descriptor`);
  }
  const core = { schemaVersion: manifest.schemaVersion, authorityMode: manifest.authorityMode, files: manifest.files, runtimeAssets: manifest.runtimeAssets };
  if (manifest.outputSha256 !== sha256Canonical(core)) fail('manifest output hash drift');
  return core;
}

export async function verifyRuntimeFileBinding(repoRoot, binding, label, { onRead } = {}) {
  onRead?.(binding.path);
  const bytes = await readContainedFile(repoRoot, binding.path, label);
  const actual = pngDescriptor(bytes, label);
  if (actual.sha256 !== binding.sha256 || actual.width !== binding.width || actual.height !== binding.height || actual.bytes !== binding.bytes) {
    fail(`${label} byte hash, dimensions, or length drift`);
  }
  return actual;
}

export async function verifyCoveredFileBinding(repoRoot, binding, { onRead } = {}) {
  onRead?.(binding.path);
  const bytes = await readContainedFile(repoRoot, binding.path);
  if (sha256Bytes(bytes) !== binding.sha256) fail(`${binding.path} covered-file hash drift`);
  return bytes;
}

function jsonFrom(bytes, label) {
  try { return JSON.parse(bytes); } catch { fail(`${label} is not valid JSON`); }
}

function sameValues(values, expected, label) {
  if (values.some((value) => value !== expected)) fail(`${label} cross-binding mismatch`);
}

function verifyOutputAttestation(attestation, fileMap) {
  if (attestation.schemaVersion !== 'continuity-output-attestation-g002-v1' || attestation.runId !== 'g002-v1') fail('output attestation identity drift');
  assertExactIds(Object.keys(attestation.outputHashes), FIXED_ASSIGNMENT_OUTPUTS, 'attested assignment output names');
  for (const [name, digest] of Object.entries(attestation.outputHashes)) {
    if (fileMap.get(`${EVIDENCE_ROOT}/${name}`) !== digest) fail(`${name} is not cross-bound by output attestation`);
  }
  for (const binding of Object.values(attestation.inputHashes)) {
    if (fileMap.get(binding.path) !== binding.sha256) fail(`${binding.path} is not cross-bound by output attestation`);
  }
}

function verifyInputLockBindings(inputLock, fileMap) {
  for (const binding of inputLock.inputs) if (fileMap.get(binding.path) !== binding.sha256) fail(`${binding.path} differs from signed input lock`);
  for (const binding of inputLock.generatedArtifacts) {
    if (fileMap.get(`${EVIDENCE_ROOT}/${binding.path}`) !== binding.sha256) fail(`${binding.path} differs from signed generated-artifact lock`);
  }
}

async function verifyTaxonomyPackages(repoRoot, taxonomyLock, taxonomyConsensus, descriptorById, bytesByPath, { onRead } = {}) {
  const consensusById = new Map(taxonomyConsensus.assets.map((entry) => [entry.pgId, entry]));
  if (taxonomyLock.packages.length !== 5 || taxonomyConsensus.assets.length !== 5) fail('exactly five blinded taxonomy packages are required');
  for (const binding of taxonomyLock.packages) {
    const descriptor = descriptorById.get(binding.pgId);
    const allowlistPath = `${binding.packagePath}/allowlist.json`;
    const packagePath = `${binding.packagePath}/package-manifest.json`;
    const allowlist = jsonFrom(bytesByPath.get(allowlistPath), allowlistPath);
    const packageManifest = jsonFrom(bytesByPath.get(packagePath), packagePath);
    if (sha256Canonical(allowlist) !== binding.inputAllowlistSha256 || sha256Canonical(packageManifest) !== binding.packageManifestSha256
        || packageManifest.opaqueTaxonomyTargetId !== binding.opaqueTaxonomyTargetId
        || packageManifest.inputAllowlistSha256 !== binding.inputAllowlistSha256) fail(`${binding.pgId} taxonomy package binding drift`);
    assertExactIds(allowlist.files.map((entry) => entry.path), ['inputs/master.png', 'inputs/runtime.png'], `${binding.pgId} blinded taxonomy pixels`);
    const master = allowlist.files.find((entry) => entry.path === 'inputs/master.png');
    const runtime = allowlist.files.find((entry) => entry.path === 'inputs/runtime.png');
    sameValues([master.sha256, binding.inputAssetSha256s[0]], descriptor.master.sha256, `${binding.pgId} taxonomy master`);
    sameValues([runtime.sha256, binding.inputAssetSha256s[1]], descriptor.mobile.sha256, `${binding.pgId} taxonomy runtime`);
    for (const pixel of [master, runtime]) {
      const relative = `${binding.packagePath}/${pixel.path}`; onRead?.(relative);
      const actual = pngDescriptor(await readContainedFile(repoRoot, relative), `${binding.pgId} blinded ${pixel.path}`);
      if (actual.sha256 !== pixel.sha256 || actual.width !== pixel.width || actual.height !== pixel.height) fail(`${binding.pgId} blinded taxonomy pixel drift`);
    }
    if (!consensusById.has(binding.pgId)) fail(`${binding.pgId} taxonomy consensus is missing`);
    if (/PG-\d{3}|koName|enName|shapeDNA|lineage|catalog/i.test(`${JSON.stringify(allowlist)}${JSON.stringify(packageManifest)}`)) fail(`${binding.pgId} taxonomy package is not blinded`);
  }
}

export async function verifyPublicEvidenceManifestMaterial(manifest, {
  repoRoot = REPO_ROOT, onRead, verifyEmbeddedEvidence = true,
} = {}) {
  assertManifestShape(manifest, { requireSignature: false });
  const bytesByPath = new Map(); const fileMap = new Map();
  for (const binding of manifest.files) {
    const bytes = await verifyCoveredFileBinding(repoRoot, binding, { onRead });
    bytesByPath.set(binding.path, bytes); fileMap.set(binding.path, binding.sha256);
  }
  const inputLock = jsonFrom(bytesByPath.get(INPUT_LOCK_PATH), INPUT_LOCK_PATH);
  const taxonomyLock = jsonFrom(bytesByPath.get(TAXONOMY_LOCK_PATH), TAXONOMY_LOCK_PATH);
  const taxonomyConsensus = jsonFrom(bytesByPath.get(TAXONOMY_CONSENSUS_PATH), TAXONOMY_CONSENSUS_PATH);
  const expectedPaths = expectedCoveredPaths(inputLock, taxonomyLock, taxonomyConsensus);
  assertExactIds(manifest.files.map((entry) => entry.path), expectedPaths, 'signed covered files');
  await assertEvidenceRootInventory(repoRoot, manifest.files.map((entry) => entry.path));
  const actualTaxonomy = (await listContainedRegularFiles(repoRoot, TAXONOMY_ROOT)).map((entry) => `${TAXONOMY_ROOT}/${entry}`);
  assertExactIds(actualTaxonomy, taxonomyEvidencePaths(taxonomyLock, taxonomyConsensus), 'taxonomy evidence directory');
  verifyInputLockBindings(inputLock, fileMap);
  verifyOutputAttestation(jsonFrom(bytesByPath.get(OUTPUT_ATTESTATION_PATH), OUTPUT_ATTESTATION_PATH), fileMap);

  const authority = jsonFrom(bytesByPath.get(AUTHORITY_CONTRACT_PATH), AUTHORITY_CONTRACT_PATH);
  if (authority.authorityFingerprint !== PINNED_AUTHORITY_FINGERPRINT || authority.publicKeySpkiDerBase64 !== PINNED_PUBLIC_KEY_SPKI_DER_BASE64
      || authority.algorithm !== 'Ed25519' || authority.mutableArtifactOverrideAllowed !== false) fail('covered authority contract differs from pinned authority');
  const pack = jsonFrom(bytesByPath.get(PACK_PATH), PACK_PATH);
  const g001 = jsonFrom(bytesByPath.get(G001_CENSUS_PATH), G001_CENSUS_PATH);
  const assetCensus = jsonFrom(bytesByPath.get(ASSET_CENSUS_PATH), ASSET_CENSUS_PATH);
  const pixelClusters = jsonFrom(bytesByPath.get(PIXEL_CLUSTERS_PATH), PIXEL_CLUSTERS_PATH);
  const descriptorById = indexByPgId(manifest.runtimeAssets, 'runtime descriptors');
  const packById = indexByPgId(pack.entries, 'asset pack entries', 'id');
  const g001ById = indexByPgId(g001.assets, 'G001 census assets');
  const lockById = indexByPgId(inputLock.activeAssets, 'input lock assets');
  const censusById = indexByPgId(assetCensus.assets, 'G002 asset census');
  const pixelsById = indexByPgId(pixelClusters.entries, 'G002 pixel clusters');
  const mobileFiles = (await listContainedRegularFiles(repoRoot, 'assets/creatures/mobile')).map((entry) => `assets/creatures/mobile/${entry}`);
  const macosFiles = (await listContainedRegularFiles(repoRoot, 'macos/Sources/PunchGrowMenuBar/Resources/Creatures')).map((entry) => `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${entry}`);
  assertExactIds(mobileFiles, PG_IDS.map((pgId) => `assets/creatures/mobile/${pgId}.png`), 'tracked mobile runtime directory');
  assertExactIds(macosFiles, PG_IDS.map((pgId) => `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${pgId}.png`), 'tracked macOS runtime directory');

  for (const pgId of PG_IDS) {
    const descriptor = descriptorById.get(pgId); const packEntry = packById.get(pgId); const g001Entry = g001ById.get(pgId);
    const lockEntry = lockById.get(pgId); const censusEntry = censusById.get(pgId); const pixelEntry = pixelsById.get(pgId);
    sameValues([packEntry.sha256, g001Entry.surfaces.master.sha256, lockEntry.master.sha256,
      censusEntry.surfaces.master.sha256, pixelEntry.surfaces.master.sha256], descriptor.master.sha256, `${pgId} master digest`);
    sameValues([packEntry.mobileSha256, g001Entry.surfaces.runtime.sha256, lockEntry.runtime.sha256,
      censusEntry.surfaces.runtime.sha256, pixelEntry.surfaces.runtime.sha256], descriptor.mobile.sha256, `${pgId} runtime digest`);
    sameValues([g001Entry.surfaces.master.width, censusEntry.surfaces.master.width, pixelEntry.surfaces.master.features.width], 1254, `${pgId} master width`);
    sameValues([g001Entry.surfaces.master.height, censusEntry.surfaces.master.height, pixelEntry.surfaces.master.features.height], 1254, `${pgId} master height`);
    if (descriptor.mobile.width !== 360 || descriptor.mobile.height !== 360 || descriptor.macos.width !== 360 || descriptor.macos.height !== 360) fail(`${pgId} runtime dimensions are not 360x360`);
    const [mobile, macos] = await Promise.all([
      verifyRuntimeFileBinding(repoRoot, descriptor.mobile, `${pgId} tracked mobile runtime`, { onRead }),
      verifyRuntimeFileBinding(repoRoot, descriptor.macos, `${pgId} tracked macOS runtime`, { onRead }),
    ]);
    if (mobile.sha256 !== macos.sha256 || mobile.bytes !== macos.bytes) fail(`${pgId} tracked mobile/macOS runtime parity failed`);
  }
  await verifyTaxonomyPackages(repoRoot, taxonomyLock, taxonomyConsensus, descriptorById, bytesByPath, { onRead });
  validateSignedCanonicalRootRedesignTargets(jsonFrom(bytesByPath.get(`${EVIDENCE_ROOT}/canonical-root-redesign-targets-v1.json`), 'canonical redesign targets'));
  for (const signedPath of [G001_ANCHORS_PATH, TAXONOMY_CONSENSUS_PATH]) {
    const signed = jsonFrom(bytesByPath.get(signedPath), signedPath); const unsigned = structuredClone(signed); delete unsigned.publicSignature;
    verifyPublicEvidence(unsigned, signed.publicSignature);
  }
  if (verifyEmbeddedEvidence) {
    const embedded = await verifyG002ReviewEvidence({ repoRoot });
    if (embedded.status !== 'PASS' || embedded.completedTaxonomyAssets !== 5) fail('embedded public G001/G002 evidence is incomplete');
  }
  return { status: 'PASS', files: manifest.files.length, runtimeAssets: manifest.runtimeAssets.length, taxonomyPackages: taxonomyLock.packages.length };
}

export async function verifyPublicEvidenceManifest({ repoRoot = REPO_ROOT, manifestPath = SIGNED_MANIFEST_PATH, onRead } = {}) {
  const manifest = await readJson(repoRoot, manifestPath);
  const core = assertManifestShape(manifest);
  verifyPublicEvidence({ ...core, outputSha256: manifest.outputSha256 }, manifest.publicSignature);
  return verifyPublicEvidenceManifestMaterial((({ publicSignature, ...unsigned }) => unsigned)(manifest), { repoRoot, onRead });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyPublicEvidenceManifest()));
