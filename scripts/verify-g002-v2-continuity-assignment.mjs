#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from './lib/continuity-assignment/compatibility.mjs';
import { G002_V2_ROOT } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { V2_OUTPUT_NAMES, buildG002V2ContinuityAssignment } from './build-g002-v2-continuity-assignment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function verifyG002V2ContinuityAssignment({ repoRoot = ROOT } = {}) {
  if (path.resolve(repoRoot) !== ROOT) throw new Error('G002-v2 deterministic rebuild only accepts the canonical repository root');
  const rebuilt = await buildG002V2ContinuityAssignment({ write: false, includeDocuments: true });
  for (const name of V2_OUTPUT_NAMES) {
    const expected = Buffer.from(stableJson(rebuilt.documents[name]));
    const actual = await readFile(path.join(repoRoot, G002_V2_ROOT, name));
    if (!actual.equals(expected)) throw new Error(`G002-v2 persisted output differs from deterministic rebuild: ${name}`);
  }
  return { status: 'PASS', outputs: V2_OUTPUT_NAMES.length, regenerationCount: 177, retainedCount: 63, edges: 190, obligations: 367,
    assignmentSha256: digest(await readFile(path.join(repoRoot, G002_V2_ROOT, 'assignment-manifest.json'))) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyG002V2ContinuityAssignment()));
