#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyG002ReviewEvidence } from './verify-g002-review-evidence.mjs';
import { verifyPublicEvidence } from './lib/g002-public-authority.mjs';
import { buildPublicEvidenceManifest } from './build-g002-public-evidence-manifest.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TAXONOMY_ROOT = 'production/reports/biological-continuity-v3/g002-evidence-v1/taxonomy-reviews';

function unsigned(value) {
  const copy = structuredClone(value);
  delete copy.publicSignature;
  return copy;
}

const result = await verifyG002ReviewEvidence({ repoRoot: REPO_ROOT });
const publishedManifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v1/public-evidence-manifest.unsigned.json')));
assert.deepEqual(publishedManifest, await buildPublicEvidenceManifest({ repoRoot: REPO_ROOT, write: false }));
assert.equal(result.status, 'PASS');
assert.equal(result.authenticationMode, 'PUBLIC_ED25519_ONLY');
assert.equal(result.hmacAuthorityClaimed, false);
assert.equal(result.anchorConsensusAssets, 240);
assert.equal(result.taxonomyPackages, 5);
assert.equal(result.completedTaxonomyAssets, 5);

const lock = JSON.parse(await readFile(path.join(REPO_ROOT, TAXONOMY_ROOT, 'taxonomy-review-lock.json')));
const binding = lock.packages[0];
const votePath = path.join(REPO_ROOT, TAXONOMY_ROOT, 'votes', binding.opaqueTaxonomyTargetId, 'pass-1.json');
const vote = JSON.parse(await readFile(votePath));
verifyPublicEvidence(unsigned(vote), vote.publicSignature);

const forgedTaxonomy = structuredClone(vote);
forgedTaxonomy.taxonomy.speciesFamily = 'forged-family';
assert.throws(() => verifyPublicEvidence(unsigned(forgedTaxonomy), forgedTaxonomy.publicSignature), /signature/i);

const forgedIdentity = structuredClone(vote);
forgedIdentity.agentTaskId = 'forged-agent-task';
assert.throws(() => verifyPublicEvidence(unsigned(forgedIdentity), forgedIdentity.publicSignature), /signature/i);

const forgedOutput = structuredClone(vote);
forgedOutput.outputSha256 = '0'.repeat(64);
assert.throws(() => verifyPublicEvidence(unsigned(forgedOutput), forgedOutput.publicSignature), /signature/i);

const cleanRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g002-public-clean-'));
try {
  await cp(path.join(REPO_ROOT, 'production'), path.join(cleanRoot, 'production'), { recursive: true });
  const cleanResult = await verifyG002ReviewEvidence({ repoRoot: cleanRoot });
  assert.equal(cleanResult.status, 'PASS');
  assert.equal(cleanResult.authenticationMode, 'PUBLIC_ED25519_ONLY');
} finally {
  await rm(cleanRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'PASS', checks: 14, publicAuthority: result.publicAuthority }));
