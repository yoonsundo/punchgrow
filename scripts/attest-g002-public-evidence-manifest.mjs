#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { signPublicEvidence } from './lib/g002-public-authority.mjs';
import { SIGNED_MANIFEST_PATH, UNSIGNED_MANIFEST_PATH } from './lib/g002-public-evidence-manifest-v2.mjs';
import { assertManifestShape, verifyPublicEvidenceManifestMaterial } from './verify-g002-public-evidence-manifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readConductorKey() {
  if (process.stdin.isTTY) throw new Error('--conductor-key-stdin requires piped or inherited non-TTY stdin');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const key = Buffer.concat(chunks);
  if (key.length < 32) throw new Error('G002 public evidence signing key must contain at least 32 bytes');
  return key;
}

export async function attestPublicEvidenceManifest({ repoRoot = REPO_ROOT, conductorKey }) {
  const unsigned = await readJson(repoRoot, UNSIGNED_MANIFEST_PATH);
  assertManifestShape(unsigned, { requireSignature: false });
  await verifyPublicEvidenceManifestMaterial(unsigned, { repoRoot });
  const signed = { ...unsigned, publicSignature: signPublicEvidence(unsigned, conductorKey) };
  await writeCanonicalFile(path.join(repoRoot, SIGNED_MANIFEST_PATH), signed, {
    containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set([path.basename(SIGNED_MANIFEST_PATH)]),
  });
  return { status: 'SIGNED', input: UNSIGNED_MANIFEST_PATH, output: SIGNED_MANIFEST_PATH,
    outputSha256: signed.outputSha256, authorityFingerprint: signed.publicSignature.authorityFingerprint };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--conductor-key-stdin') throw new Error('--conductor-key-stdin is required');
  console.log(JSON.stringify(await attestPublicEvidenceManifest({ conductorKey: await readConductorKey() })));
}
