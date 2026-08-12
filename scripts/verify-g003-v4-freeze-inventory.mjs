#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readContainedFile } from './lib/continuity-assignment/evidence.mjs';
import { G003_V4_FREEZE_PATH, G003_V4_FREEZE_SCHEMA_PATH, verifyG003V4FreezePublic } from './lib/g003-v4-freeze-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function verifyG003V4FreezeInventory({ repoRoot = ROOT, manifestPath = G003_V4_FREEZE_PATH } = {}) {
  const [manifestBytes, schemaBytes] = await Promise.all([readContainedFile(repoRoot, manifestPath), readContainedFile(repoRoot, G003_V4_FREEZE_SCHEMA_PATH)]);
  return verifyG003V4FreezePublic({ repoRoot, manifestBytes, schemaSha256: sha256Canonical(JSON.parse(schemaBytes)) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyG003V4FreezeInventory({ manifestPath: process.argv[2] ?? G003_V4_FREEZE_PATH });
  console.log(JSON.stringify({ status: 'PASS', outputSha256: result.outputSha256, treeSha256: result.treeSha256 }));
}
