#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildPixelAnchorConsensus } from './build-g002-review-evidence.mjs';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { assertExactIds, fail, readContainedFile, readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { deriveAuthority, signPublicEvidence } from './lib/g002-public-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ROOT = 'production/reports/biological-continuity-v3';
const TAXONOMY_ROOT = `${REPORT_ROOT}/g002-evidence-v1/taxonomy-reviews`;
const AUTHORITY_CONTRACT_PATH = 'production/contracts/g002-public-authority-v1.json';
const CANONICAL_ANCHOR_IDS = ['body-silhouette', 'face-geometry', 'signature-organ'];
const DOMAINS = {
  assignment: 'punchgrow:g002-taxonomy-review-assignment-v1:hmac\0',
  runAttestation: 'punchgrow:g002-taxonomy-review-run-attestation-v1:hmac\0',
  primaryVote: 'punchgrow:g002-taxonomy-primary-vote-v1:conductor-hmac\0',
  adjudication: 'punchgrow:g002-taxonomy-adjudication-v1:conductor-hmac\0',
};

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (extras.length || missing.length) fail(`${label} fields mismatch: missing=${missing.join(',') || 'none'} extra=${extras.join(',') || 'none'}`);
}

function requireKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  if (key.length < 32) fail('taxonomy review conductor key must contain at least 32 bytes');
  return key;
}

function hmacFor(domain, value, conductorKey) {
  return createHmac('sha256', requireKey(conductorKey)).update(domain).update(sha256Canonical(value)).digest('hex');
}

export function taxonomyAssignmentHmac(value, conductorKey) { return hmacFor(DOMAINS.assignment, value, conductorKey); }
export function taxonomyRunAttestationHmac(value, conductorKey) { return hmacFor(DOMAINS.runAttestation, value, conductorKey); }

export function taxonomyVoteHmac(voteWithOutputHash, conductorKey) {
  return hmacFor(DOMAINS.primaryVote, voteWithOutputHash, conductorKey);
}

export function taxonomyAdjudicationHmac(voteWithOutputHash, conductorKey) {
  return hmacFor(DOMAINS.adjudication, voteWithOutputHash, conductorKey);
}

function finalizeAuthorityDocument(core, domain, conductorKey) {
  const withOutput = { ...core, outputSha256: sha256Canonical(core) };
  const withHmac = { ...withOutput, conductorHmacSha256: hmacFor(domain, withOutput, conductorKey) };
  return { ...withHmac, publicSignature: signPublicEvidence(withHmac, conductorKey) };
}

function assertIdentity(raw) {
  for (const field of ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) {
    if (typeof raw[field] !== 'string' || raw[field].length < 8) fail(`raw taxonomy observation lacks ${field}`);
  }
}

function assertTaxonomy(taxonomy) {
  exactKeys(taxonomy, ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'], 'raw taxonomy');
  if (Object.values(taxonomy).some((value) => typeof value !== 'string' || value.length < 2 || /^unknown(?:-|$)/i.test(value))) fail('raw taxonomy must contain four exact non-unknown fields');
}

function validatePrimaryRaw(raw) {
  exactKeys(raw, ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'passNumber', 'taxonomy', 'anchors', 'confidence'], 'raw primary taxonomy observation');
  assertIdentity(raw); assertTaxonomy(raw.taxonomy);
  if (![1, 2].includes(raw.passNumber)) fail('raw primary taxonomy pass is invalid');
  if (!Array.isArray(raw.anchors) || raw.anchors.length !== 3) fail('raw primary taxonomy observation requires exactly three anchors');
  for (const anchor of raw.anchors) {
    exactKeys(anchor, ['anchorId', 'description'], 'raw primary taxonomy anchor');
    if (typeof anchor.description !== 'string' || anchor.description.trim().length < 3) fail('raw primary taxonomy anchor description is not concrete');
  }
  assertExactIds(raw.anchors.map((anchor) => anchor.anchorId), CANONICAL_ANCHOR_IDS, 'raw primary taxonomy anchor IDs');
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0.85 || raw.confidence > 1) fail('raw primary taxonomy confidence is invalid');
}

function validateAdjudicationRaw(raw) {
  exactKeys(raw, ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'role', 'taxonomy', 'confidence', 'rationale'], 'raw taxonomy-only adjudication');
  assertIdentity(raw); assertTaxonomy(raw.taxonomy);
  if (raw.role !== 'taxonomy-only-adjudicator') fail('taxonomy adjudication role is invalid');
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length < 8) fail('taxonomy adjudication rationale is invalid');
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0.85 || raw.confidence > 1) fail('taxonomy adjudication confidence is invalid');
}

async function loadPackageBinding(repoRoot, packageRelative) {
  const lock = await readJson(repoRoot, `${TAXONOMY_ROOT}/taxonomy-review-lock.json`);
  const binding = lock.packages.find((entry) => entry.packagePath === packageRelative);
  if (!binding) fail('taxonomy package is not in the locked G002 package set');
  const [manifest, allowlist, promptBytes, contractBytes, authorityBytes] = await Promise.all([
    readJson(repoRoot, `${packageRelative}/package-manifest.json`), readJson(repoRoot, `${packageRelative}/allowlist.json`),
    readContainedFile(repoRoot, `${packageRelative}/prompt.txt`), readContainedFile(repoRoot, `${packageRelative}/review-contract.schema.json`),
    readContainedFile(repoRoot, AUTHORITY_CONTRACT_PATH),
  ]);
  if (sha256Canonical(manifest) !== binding.packageManifestSha256 || sha256Canonical(allowlist) !== binding.inputAllowlistSha256
      || sha256Bytes(promptBytes) !== binding.promptSha256 || sha256Bytes(contractBytes) !== binding.contractSha256
      || manifest.contractSha256 !== binding.contractSha256 || lock.publicAuthority.contractPath !== AUTHORITY_CONTRACT_PATH
      || lock.publicAuthority.contractSha256 !== sha256Bytes(authorityBytes)) fail('taxonomy package authority hashes differ from the locked package');
  assertExactIds(allowlist.files.map((file) => file.sha256), binding.inputAssetSha256s, 'taxonomy package input hashes');
  for (const file of allowlist.files) if (sha256Bytes(await readContainedFile(repoRoot, `${packageRelative}/${file.path}`)) !== file.sha256) fail(`taxonomy package pixel hash drift: ${file.path}`);
  return binding;
}

async function publishImmutable(repoRoot, relativePath, value, { replaceExisting }) {
  try {
    await lstat(path.join(repoRoot, relativePath));
    if (!replaceExisting) fail(`signed taxonomy evidence already exists and cannot be replaced: ${relativePath}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeCanonicalFile(path.join(repoRoot, relativePath), value, { containmentRoot: repoRoot, mode: 0o600, allowedBasenames: new Set([path.basename(relativePath)]) });
  return sha256Canonical(value);
}

function assignmentCore(raw, binding, role, submittedAt) {
  const passNumber = role === 'primary' ? raw.passNumber : 3;
  const assignmentId = `taxonomy-assignment-${sha256Canonical({ packageManifestSha256: binding.packageManifestSha256, role, passNumber, reviewerInstanceId: raw.reviewerInstanceId, agentTaskId: raw.agentTaskId, voterReviewRunId: raw.voterReviewRunId }).slice(0, 32)}`;
  return {
    schemaVersion: 'g002-taxonomy-review-assignment-v1', assignmentId, role: role === 'primary' ? 'primary' : 'taxonomy-only-adjudicator', passNumber,
    reviewerInstanceId: raw.reviewerInstanceId, agentTaskId: raw.agentTaskId, voterReviewRunId: raw.voterReviewRunId,
    opaqueTaxonomyTargetId: binding.opaqueTaxonomyTargetId, packageManifestSha256: binding.packageManifestSha256,
    inputAllowlistSha256: binding.inputAllowlistSha256, promptSha256: binding.promptSha256, contractSha256: binding.contractSha256,
    inputAssetSha256s: binding.inputAssetSha256s, assignedAt: submittedAt,
  };
}

export async function attestTaxonomyObservation(raw, {
  repoRoot = REPO_ROOT, packageRelative, conductorKey, submittedAt, role = 'primary', replaceExisting = false,
} = {}) {
  const binding = await loadPackageBinding(repoRoot, packageRelative);
  if (Number.isNaN(Date.parse(submittedAt))) fail('taxonomy attestation requires an RFC3339 submittedAt');
  if (role === 'primary') validatePrimaryRaw(raw); else if (role === 'taxonomy-only-adjudicator') validateAdjudicationRaw(raw); else fail('unsupported taxonomy review role');

  const assignment = finalizeAuthorityDocument(assignmentCore(raw, binding, role, submittedAt), DOMAINS.assignment, conductorKey);
  const evidenceBasename = role === 'primary' ? `pass-${raw.passNumber}.json` : 'adjudication.json';
  const assignmentRelative = `${TAXONOMY_ROOT}/reviewer-assignments/${binding.opaqueTaxonomyTargetId}/${evidenceBasename}`;
  const assignmentManifestSha256 = await publishImmutable(repoRoot, assignmentRelative, assignment, { replaceExisting });
  const rawObservationSha256 = sha256Canonical(raw);
  const runCore = {
    schemaVersion: 'g002-taxonomy-review-run-attestation-v1', assignmentManifestSha256, assignmentId: assignment.assignmentId,
    role: assignment.role, passNumber: assignment.passNumber, reviewerInstanceId: raw.reviewerInstanceId, agentTaskId: raw.agentTaskId,
    voterReviewRunId: raw.voterReviewRunId, opaqueTaxonomyTargetId: binding.opaqueTaxonomyTargetId,
    packageManifestSha256: binding.packageManifestSha256, rawObservationSha256, fresh: true, blinded: true, createdAt: submittedAt,
  };
  const runAttestation = finalizeAuthorityDocument(runCore, DOMAINS.runAttestation, conductorKey);
  const runRelative = `${TAXONOMY_ROOT}/reviewer-run-attestations/${binding.opaqueTaxonomyTargetId}/${evidenceBasename}`;
  const reviewerRunAttestationSha256 = await publishImmutable(repoRoot, runRelative, runAttestation, { replaceExisting });

  const common = {
    reviewId: `taxonomy-review-${sha256Canonical({ binding: binding.packageManifestSha256, raw, submittedAt, role }).slice(0, 32)}`,
    reviewerInstanceId: raw.reviewerInstanceId, agentTaskId: raw.agentTaskId, voterReviewRunId: raw.voterReviewRunId,
    role: assignment.role, fresh: true, blinded: true, opaqueTaxonomyTargetId: binding.opaqueTaxonomyTargetId,
    packageManifestSha256: binding.packageManifestSha256, inputAllowlistSha256: binding.inputAllowlistSha256,
    promptSha256: binding.promptSha256, contractSha256: binding.contractSha256, inputAssetSha256s: binding.inputAssetSha256s,
    assignmentManifestSha256, reviewerRunAttestationSha256, taxonomy: raw.taxonomy, confidence: raw.confidence, submittedAt,
  };
  const voteCore = role === 'primary'
    ? { schemaVersion: 'g002-taxonomy-primary-vote-v1', ...common, passNumber: raw.passNumber, anchors: [...raw.anchors].sort((a, b) => a.anchorId.localeCompare(b.anchorId)) }
    : { schemaVersion: 'g002-taxonomy-adjudication-v1', ...common, passNumber: 3, adjudicationScope: 'taxonomy-only', rationale: raw.rationale };
  const vote = finalizeAuthorityDocument(voteCore, role === 'primary' ? DOMAINS.primaryVote : DOMAINS.adjudication, conductorKey);
  const voteRelative = `${TAXONOMY_ROOT}/votes/${binding.opaqueTaxonomyTargetId}/${evidenceBasename}`;
  await publishImmutable(repoRoot, voteRelative, vote, { replaceExisting });
  return { status: 'ATTESTED', role: assignment.role, voteRelative, assignmentRelative, runRelative, reviewId: vote.reviewId, outputSha256: vote.outputSha256 };
}

export async function signAnchorConsensus({ repoRoot = REPO_ROOT, conductorKey } = {}) {
  const unsigned = await buildPixelAnchorConsensus({ repoRoot });
  const signed = { ...unsigned, publicSignature: signPublicEvidence(unsigned, conductorKey) };
  const relativePath = `${REPORT_ROOT}/g001-primary-pixel-anchor-consensus-v1.json`;
  await writeCanonicalFile(path.join(repoRoot, relativePath), signed, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['g001-primary-pixel-anchor-consensus-v1.json']) });
  return { status: 'SIGNED', relativePath, outputSha256: signed.outputSha256, fileSha256: sha256Canonical(signed) };
}

async function readKeyFromStdin() {
  if (process.stdin.isTTY) fail('--conductor-key-stdin with piped/inherited stdin is required');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  return requireKey(Buffer.concat(chunks));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--conductor-key-stdin') result.keyStdin = true;
    else if (flag === '--authority-info') result.authorityInfo = true;
    else if (flag === '--sign-anchor-consensus') result.signAnchor = true;
    else if (flag === '--observation') result.observation = argv[++index];
    else if (flag === '--package') result.packageRelative = argv[++index];
    else if (flag === '--submitted-at') result.submittedAt = argv[++index];
    else if (flag === '--role') result.role = argv[++index];
    else if (flag === '--replace-existing') result.replaceExisting = true;
    else fail(`unknown taxonomy attestation argument: ${flag}`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const intake = args.observation && args.packageRelative && args.submittedAt && args.role;
  if (!args.keyStdin || (![args.authorityInfo, args.signAnchor, Boolean(intake)].some(Boolean)) || [args.authorityInfo, args.signAnchor, Boolean(intake)].filter(Boolean).length !== 1) {
    console.error('Usage:\n  <hidden-key-producer> | node scripts/attest-g002-taxonomy-review.mjs --conductor-key-stdin --authority-info\n  <hidden-key-producer> | node scripts/attest-g002-taxonomy-review.mjs --conductor-key-stdin --sign-anchor-consensus\n  <hidden-key-producer> | node scripts/attest-g002-taxonomy-review.mjs --conductor-key-stdin --observation RAW.json --package PACKAGE --submitted-at RFC3339 --role primary|taxonomy-only-adjudicator [--replace-existing]');
    process.exitCode = 2;
  } else {
    const conductorKey = await readKeyFromStdin();
    if (args.authorityInfo) {
      const authority = deriveAuthority(conductorKey);
      console.log(JSON.stringify({ algorithm: 'Ed25519', authorityFingerprint: authority.fingerprintSha256, publicKeySpkiDerBase64: authority.publicKeySpkiDerBase64 }));
    } else if (args.signAnchor) console.log(JSON.stringify(await signAnchorConsensus({ conductorKey })));
    else {
      const raw = await readJson(REPO_ROOT, args.observation);
      console.log(JSON.stringify(await attestTaxonomyObservation(raw, { packageRelative: args.packageRelative, conductorKey, submittedAt: args.submittedAt, role: args.role, replaceExisting: args.replaceExisting })));
    }
  }
}
