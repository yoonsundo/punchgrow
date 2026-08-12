#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { listContainedRegularFiles, readContainedFile, readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import {
  EVIDENCE_ROOT, PG_IDS, SIGNED_MANIFEST_PATH, TAXONOMY_ROOT, UNSIGNED_MANIFEST_PATH,
  assertEvidenceRootInventory, expectedCoveredPaths, pngDescriptor, taxonomyEvidencePaths,
} from './lib/g002-public-evidence-manifest-v2.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT_LOCK_PATH = `${EVIDENCE_ROOT}/inputs.lock.json`;
const TAXONOMY_LOCK_PATH = `${TAXONOMY_ROOT}/taxonomy-review-lock.json`;
const TAXONOMY_CONSENSUS_PATH = `${TAXONOMY_ROOT}/consensus.json`;

export async function buildPublicEvidenceManifest({ repoRoot = REPO_ROOT, write = true } = {}) {
  const [inputLock, taxonomyLock, taxonomyConsensus] = await Promise.all([
    readJson(repoRoot, INPUT_LOCK_PATH), readJson(repoRoot, TAXONOMY_LOCK_PATH), readJson(repoRoot, TAXONOMY_CONSENSUS_PATH),
  ]);
  const expectedTaxonomy = taxonomyEvidencePaths(taxonomyLock, taxonomyConsensus).map((entry) => entry.slice(`${TAXONOMY_ROOT}/`.length));
  const actualTaxonomy = await listContainedRegularFiles(repoRoot, TAXONOMY_ROOT);
  if (JSON.stringify(actualTaxonomy) !== JSON.stringify(expectedTaxonomy)) throw new Error('G002 public evidence v2: taxonomy evidence contains missing, extra, or unmanifested material');

  const coveredPaths = expectedCoveredPaths(inputLock, taxonomyLock, taxonomyConsensus);
  const files = [];
  for (const relative of coveredPaths) {
    files.push({ path: relative, sha256: sha256Bytes(await readContainedFile(repoRoot, relative)) });
  }
  await assertEvidenceRootInventory(repoRoot, coveredPaths);
  const activeById = new Map(inputLock.activeAssets.map((entry) => [entry.pgId, entry]));
  const runtimeAssets = [];
  for (const pgId of PG_IDS) {
    const active = activeById.get(pgId);
    if (!active) throw new Error(`G002 public evidence v2: input lock is missing ${pgId}`);
    const mobilePath = `assets/creatures/mobile/${pgId}.png`;
    const macosPath = `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${pgId}.png`;
    const [mobileBytes, macosBytes] = await Promise.all([readContainedFile(repoRoot, mobilePath), readContainedFile(repoRoot, macosPath)]);
    runtimeAssets.push({
      pgId,
      master: { sha256: active.master.sha256 },
      mobile: { path: mobilePath, ...pngDescriptor(mobileBytes, `${pgId} tracked mobile runtime`) },
      macos: { path: macosPath, ...pngDescriptor(macosBytes, `${pgId} tracked macOS runtime`) },
    });
  }
  const core = { schemaVersion: 'g002-public-evidence-manifest-v2', authorityMode: 'PUBLIC_ED25519', files, runtimeAssets };
  const unsigned = { ...core, outputSha256: sha256Canonical(core) };
  if (write) await writeCanonicalFile(path.join(repoRoot, UNSIGNED_MANIFEST_PATH), unsigned, {
    containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set([path.basename(UNSIGNED_MANIFEST_PATH)]),
  });
  return unsigned;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await buildPublicEvidenceManifest();
  console.log(JSON.stringify({ status: 'PASS', schemaVersion: manifest.schemaVersion, files: manifest.files.length,
    runtimeAssets: manifest.runtimeAssets.length, output: UNSIGNED_MANIFEST_PATH, signedOutput: SIGNED_MANIFEST_PATH }));
}
