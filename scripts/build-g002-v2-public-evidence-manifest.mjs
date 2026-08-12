#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readContainedFile, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { G002_V1_BASE } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { V2_AUTHORITATIVE_PATHS, V2_PUBLIC_UNSIGNED, assertV2Inventory, verifyV2PublicMaterial } from './lib/g002-v2-public-evidence.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildG002V2PublicEvidence({ repoRoot = ROOT, write = true } = {}) {
  const files = []; for (const relative of V2_AUTHORITATIVE_PATHS) files.push({ path: relative, sha256: sha256Bytes(await readContainedFile(repoRoot, relative)) });
  const runtimeAssets = JSON.parse(await readContainedFile(repoRoot, G002_V1_BASE.publicManifestPath)).runtimeAssets;
  const core = { schemaVersion: 'g002-public-evidence-manifest-v3', runId: 'g002-v2', authorityMode: 'PUBLIC_ED25519_NO_FALLBACK', baseAuthority: G002_V1_BASE, files, runtimeAssets };
  const unsigned = { ...core, outputSha256: sha256Canonical(core) };
  await verifyV2PublicMaterial(unsigned, { repoRoot });
  if (write) await writeCanonicalFile(path.join(repoRoot, V2_PUBLIC_UNSIGNED), unsigned, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['public-evidence-manifest.unsigned.json']) });
  return { status: 'PASS', output: V2_PUBLIC_UNSIGNED, files: files.length, runtimeAssets: 240, outputSha256: unsigned.outputSha256 };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildG002V2PublicEvidence()));
