#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { verifyPublicEvidence } from './lib/g002-public-authority.mjs';
import { EVIDENCE_ROOT, UNSIGNED_MANIFEST_PATH, assertEvidenceRootInventory, pngDescriptor } from './lib/g002-public-evidence-manifest-v2.mjs';
import { assertManifestShape, verifyCoveredFileBinding, verifyPublicEvidenceManifestMaterial, verifyRuntimeFileBinding } from './verify-g002-public-evidence-manifest.mjs';

const manifest = JSON.parse(await readFile(UNSIGNED_MANIFEST_PATH));
const clone = () => structuredClone(manifest);
const refresh = (candidate) => {
  candidate.outputSha256 = sha256Canonical({ schemaVersion: candidate.schemaVersion, authorityMode: candidate.authorityMode,
    files: candidate.files, runtimeAssets: candidate.runtimeAssets });
  return candidate;
};
const rejectMaterial = async (candidate, pattern) => assert.rejects(
  verifyPublicEvidenceManifestMaterial(refresh(candidate), { verifyEmbeddedEvidence: false }), pattern,
);

const readPaths = [];
assert.deepEqual(await verifyPublicEvidenceManifestMaterial(manifest, { verifyEmbeddedEvidence: false, onRead: (entry) => readPaths.push(entry) }),
  { status: 'PASS', files: 99, runtimeAssets: 240, taxonomyPackages: 5 });
assert.equal(readPaths.some((entry) => entry.startsWith('assets/creatures/redesign-v2/')), false, 'public verification read ignored redesign source material');
assert.equal(manifest.files.some((entry) => entry.startsWith?.('assets/creatures/redesign-v2/') || entry.path.startsWith('assets/creatures/redesign-v2/')), false);

// Covered-file tamper, recomputed unsigned content, and authority substitution all fail closed.
const coveredTamper = clone(); coveredTamper.files[0].sha256 = '0'.repeat(64);
await rejectMaterial(coveredTamper, /covered-file hash drift/);
const signedCanonical = JSON.parse(await readFile(`${EVIDENCE_ROOT}/canonical-root-redesign-targets-v1.json`));
const recomputedWithoutKey = refresh(clone()); recomputedWithoutKey.runtimeAssets[0].master.sha256 = '1'.repeat(64); refresh(recomputedWithoutKey);
assert.throws(() => verifyPublicEvidence(recomputedWithoutKey, signedCanonical.publicSignature), /signature verification failed/);
assert.throws(() => verifyPublicEvidence(manifest, { algorithm: 'Ed25519', authorityFingerprint: '0'.repeat(64), signatureBase64: signedCanonical.publicSignature.signatureBase64 }), /authority is invalid/);

// Coverage is exact: missing, extra, duplicate, and escaped paths are rejected.
const missing = clone(); missing.files.pop(); await rejectMaterial(missing, /coverage mismatch/);
const extra = clone(); extra.files.push({ path: 'package.json', sha256: sha256Bytes(await readFile('package.json')) }); await rejectMaterial(extra, /coverage mismatch/);
const duplicate = clone(); duplicate.files.push(structuredClone(duplicate.files[0])); refresh(duplicate);
assert.throws(() => assertManifestShape(duplicate, { requireSignature: false }), /duplicate IDs/);
const escaped = clone(); escaped.files[0].path = '../outside.json'; await rejectMaterial(escaped, /canonical contained path|escapes repository root/);

// PG/digest swaps and tracked runtime tampering cannot be legitimized by recomputing the unsigned manifest.
const pgSwap = clone(); [pgSwap.runtimeAssets[0].master.sha256, pgSwap.runtimeAssets[1].master.sha256] = [pgSwap.runtimeAssets[1].master.sha256, pgSwap.runtimeAssets[0].master.sha256];
await rejectMaterial(pgSwap, /master digest cross-binding mismatch/);
const runtimeSwap = clone(); [runtimeSwap.runtimeAssets[0].mobile.sha256, runtimeSwap.runtimeAssets[1].mobile.sha256] = [runtimeSwap.runtimeAssets[1].mobile.sha256, runtimeSwap.runtimeAssets[0].mobile.sha256];
await rejectMaterial(runtimeSwap, /runtime digest cross-binding mismatch|byte hash/);
const runtimeTamper = clone(); runtimeTamper.runtimeAssets[0].macos.sha256 = 'f'.repeat(64);
await rejectMaterial(runtimeTamper, /byte hash, dimensions, or length drift|runtime parity/);

// An actual unmanifested file anywhere below the evidence root is rejected.
const inventoryRoot = await mkdtemp(path.join(os.tmpdir(), 'g002-public-inventory-v2-'));
try {
  const isolatedEvidenceRoot = path.join(inventoryRoot, EVIDENCE_ROOT);
  await mkdir(path.dirname(isolatedEvidenceRoot), { recursive: true });
  await cp(EVIDENCE_ROOT, isolatedEvidenceRoot, { recursive: true });
  await writeFile(path.join(isolatedEvidenceRoot, 'attacker-extra.json'), '{}');
  await assert.rejects(assertEvidenceRootInventory(inventoryRoot, manifest.files.map((entry) => entry.path)), /exact inventory coverage mismatch.*attacker-extra\.json/);
} finally { await rm(inventoryRoot, { recursive: true, force: true }); }

// Low-level file opening rejects both symlink and hardlink substitution.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'g002-public-manifest-v2-'));
try {
  const bytes = await readFile('assets/creatures/mobile/PG-001.png');
  const evidencePath = path.join(temporary, 'evidence.json'); const originalEvidence = Buffer.from('{"trusted":true}');
  await writeFile(evidencePath, originalEvidence);
  await writeFile(evidencePath, Buffer.from('{"trusted":false}'));
  await assert.rejects(verifyCoveredFileBinding(temporary, { path: 'evidence.json', sha256: sha256Bytes(originalEvidence) }), /covered-file hash drift/);
  const source = path.join(temporary, 'source.png'); await writeFile(source, bytes);
  const descriptor = pngDescriptor(bytes, 'fixture');
  const tamperedRuntime = Buffer.from(bytes); tamperedRuntime[tamperedRuntime.length - 1] ^= 1;
  await writeFile(path.join(temporary, 'tampered.png'), tamperedRuntime);
  await assert.rejects(verifyRuntimeFileBinding(temporary, { path: 'tampered.png', ...descriptor }, 'runtime byte tamper'), /byte hash, dimensions, or length drift/);
  await symlink(source, path.join(temporary, 'symlink.png'));
  await assert.rejects(verifyRuntimeFileBinding(temporary, { path: 'symlink.png', ...descriptor }, 'symlink attack'), /symlink/);
  await link(source, path.join(temporary, 'hardlink.png'));
  await assert.rejects(verifyRuntimeFileBinding(temporary, { path: 'hardlink.png', ...descriptor }, 'hardlink attack'), /independent regular file/);
} finally { await rm(temporary, { recursive: true, force: true }); }

console.log(JSON.stringify({ status: 'PASS', hostileChecks: 16, sourceFreeReads: readPaths.length,
  ignoredSourceReads: 0, coveredFiles: manifest.files.length, runtimeAssets: manifest.runtimeAssets.length }));
