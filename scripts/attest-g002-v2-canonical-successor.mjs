#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { signPublicEvidence } from './lib/g002-public-authority.mjs';
import { validateSignedG002V2Successor, G002_V2_ROOT } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { UNSIGNED_PATH, verifyG002V2UnsignedSuccessorMaterial } from './build-g002-v2-canonical-successor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SIGNED_PATH = `${G002_V2_ROOT}/canonical-root-redesign-targets-v2.json`;

async function readKey() {
  if (process.stdin.isTTY) throw new Error('--conductor-key-stdin requires non-TTY stdin');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const key = Buffer.concat(chunks); if (key.length < 32) throw new Error('G002-v2 signing key must contain at least 32 bytes'); return key;
}

export async function attestG002V2CanonicalSuccessor({ repoRoot = ROOT, conductorKey, signer = signPublicEvidence }) {
  const unsigned = await readJson(repoRoot, UNSIGNED_PATH);
  return attestG002V2CanonicalSuccessorValue({unsigned,repoRoot,conductorKey,signer,write:true});
}

export async function attestG002V2CanonicalSuccessorValue({unsigned,repoRoot=ROOT,conductorKey,signer=signPublicEvidence,write=false}){
  await verifyG002V2UnsignedSuccessorMaterial(unsigned, { repoRoot });
  const signed = { ...unsigned, publicSignature: signer(unsigned, conductorKey) };
  validateSignedG002V2Successor(signed);
  if(write)await writeCanonicalFile(path.join(repoRoot, SIGNED_PATH), signed, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set([path.basename(SIGNED_PATH)]) });
  return { status: 'SIGNED', output: SIGNED_PATH, outputSha256: signed.outputSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--conductor-key-stdin') throw new Error('--conductor-key-stdin is required');
  console.log(JSON.stringify(await attestG002V2CanonicalSuccessor({ conductorKey: await readKey() })));
}
