#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { validateCanonicalRootRedesignCore, validateSignedCanonicalRootRedesignTargets } from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';
import { signPublicEvidence } from './lib/g002-public-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_INPUT = 'production/reports/biological-continuity-v3/g002-evidence-v1/canonical-root-redesign-targets-v1.unsigned.json';
export const DEFAULT_OUTPUT = 'production/reports/biological-continuity-v3/g002-evidence-v1/canonical-root-redesign-targets-v1.json';

async function readConductorKey() {
  if (process.stdin.isTTY) throw new Error('--conductor-key-stdin requires piped or inherited non-TTY stdin');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const key = Buffer.concat(chunks);
  if (key.length < 32) throw new Error('canonical target signing key must contain at least 32 bytes');
  return key;
}

export async function attestCanonicalRootRedesignTargets({ repoRoot = REPO_ROOT, input = DEFAULT_INPUT, output = DEFAULT_OUTPUT, conductorKey }) {
  if (output !== DEFAULT_OUTPUT) throw new Error('signed canonical targets must use the fixed public versioned output path');
  const core = await readJson(repoRoot, input);
  validateCanonicalRootRedesignCore(core);
  const withOutput = { ...core, outputSha256: sha256Canonical(core) };
  const signed = { ...withOutput, publicSignature: signPublicEvidence(withOutput, conductorKey) };
  validateSignedCanonicalRootRedesignTargets(signed);
  await writeCanonicalFile(path.join(repoRoot, output), signed, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set([path.basename(DEFAULT_OUTPUT)]) });
  return { status: 'SIGNED', input, output, outputSha256: signed.outputSha256, authorityFingerprint: signed.publicSignature.authorityFingerprint };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let input = DEFAULT_INPUT; let output = DEFAULT_OUTPUT; let keyStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--input') input = args[++index];
    else if (args[index] === '--output') output = args[++index];
    else if (args[index] === '--conductor-key-stdin') keyStdin = true;
    else throw new Error(`unknown canonical target attestation argument: ${args[index]}`);
  }
  if (!keyStdin) throw new Error('--conductor-key-stdin is required');
  console.log(JSON.stringify(await attestCanonicalRootRedesignTargets({ input, output, conductorKey: await readConductorKey() })));
}
