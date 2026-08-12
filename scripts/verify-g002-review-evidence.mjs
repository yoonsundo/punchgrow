#!/usr/bin/env node

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { assertExactIds, listContainedRegularFiles, readContainedFile, readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { buildPixelAnchorConsensus } from './build-g002-review-evidence.mjs';
import {
  taxonomyAdjudicationHmac, taxonomyAssignmentHmac, taxonomyRunAttestationHmac, taxonomyVoteHmac,
} from './attest-g002-taxonomy-review.mjs';
import {
  PINNED_AUTHORITY_FINGERPRINT, PINNED_PUBLIC_KEY_SPKI_DER_BASE64, signPublicEvidence, verifyPublicEvidence,
} from './lib/g002-public-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ROOT = 'production/reports/biological-continuity-v3';
const G002_ROOT = `${REPORT_ROOT}/g002-evidence-v1`;
const TAXONOMY_ROOT = `${G002_ROOT}/taxonomy-reviews`;
const ANCHOR_PATH = `${REPORT_ROOT}/g001-primary-pixel-anchor-consensus-v1.json`;
const CENSUS_PATH = `${REPORT_ROOT}/g001-unblinded-image-first-census-v1.json`;
const AUTHORITY_CONTRACT_PATH = 'production/contracts/g002-public-authority-v1.json';
const FORBIDDEN_PUBLIC_KEYS = new Set(['name', 'names', 'koname', 'enname', 'shapedna', 'lore', 'catalog', 'category', 'lineageid']);
const CANONICAL_ANCHOR_IDS = ['body-silhouette', 'face-geometry', 'signature-organ'];
const TAXONOMY_FIELDS = ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan'];
const CLASS_ALIASES = new Map([['insecta', 'insect'], ['mammalia', 'mammal']]);

const fail = (message) => { throw new Error(`G002 review evidence: ${message}`); };
function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be object`);
  const extras = Object.keys(value).filter((key) => !keys.includes(key)); const missing = keys.filter((key) => !(key in value));
  if (extras.length || missing.length) fail(`${label} fields mismatch missing=${missing.join(',') || 'none'} extra=${extras.join(',') || 'none'}`);
}
function findForbidden(value, location = '$') {
  if (Array.isArray(value)) return value.forEach((entry, index) => findForbidden(entry, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) fail(`catalog/name/shapeDNA field leaked at ${location}.${key}`);
    findForbidden(child, `${location}.${key}`);
  }
}
function normalizeTaxonomy(taxonomy) {
  const normalized = Object.fromEntries(TAXONOMY_FIELDS.map((field) => [field, taxonomy[field]]));
  normalized.biologicalClass = CLASS_ALIASES.get(normalized.biologicalClass.toLowerCase()) ?? normalized.biologicalClass;
  return normalized;
}
function taxonomyEqual(a, b) { return sha256Canonical(normalizeTaxonomy(a)) === sha256Canonical(normalizeTaxonomy(b)); }
function authorityParts(value, label) {
  const signed = structuredClone(value); delete signed.publicSignature;
  verifyPublicEvidence(signed, value.publicSignature);
  const withOutput = structuredClone(signed); delete withOutput.conductorHmacSha256;
  const core = structuredClone(withOutput); delete core.outputSha256;
  if (withOutput.outputSha256 !== sha256Canonical(core)) fail(`${label} output hash drift`);
  return { core, withOutput, signed };
}

async function verifyAuthorityContract(repoRoot, lock) {
  const bytes = await readContainedFile(repoRoot, AUTHORITY_CONTRACT_PATH);
  const contract = JSON.parse(bytes);
  assertExactKeys(contract, ['schemaVersion', 'algorithm', 'authorityFingerprint', 'publicKeySpkiDerBase64', 'derivationPolicy', 'mutableArtifactOverrideAllowed'], 'public authority contract');
  if (contract.schemaVersion !== 'g002-public-authority-v1' || contract.algorithm !== 'Ed25519'
      || contract.authorityFingerprint !== PINNED_AUTHORITY_FINGERPRINT || contract.publicKeySpkiDerBase64 !== PINNED_PUBLIC_KEY_SPKI_DER_BASE64
      || contract.mutableArtifactOverrideAllowed !== false || lock.publicAuthority.contractPath !== AUTHORITY_CONTRACT_PATH
      || lock.publicAuthority.contractSha256 !== sha256Bytes(bytes) || lock.publicAuthority.authorityFingerprint !== PINNED_AUTHORITY_FINGERPRINT) fail('public authority contract differs from hard-pinned verifier authority');
}

async function verifyPackage(repoRoot, binding) {
  const manifest = await readJson(repoRoot, `${binding.packagePath}/package-manifest.json`);
  const allowlist = await readJson(repoRoot, `${binding.packagePath}/allowlist.json`);
  const promptBytes = await readContainedFile(repoRoot, `${binding.packagePath}/prompt.txt`);
  const contractBytes = await readContainedFile(repoRoot, `${binding.packagePath}/review-contract.schema.json`);
  const voteTemplate = await readJson(repoRoot, `${binding.packagePath}/vote-template.json`);
  if (sha256Canonical(manifest) !== binding.packageManifestSha256 || sha256Canonical(allowlist) !== binding.inputAllowlistSha256
      || sha256Bytes(promptBytes) !== binding.promptSha256 || sha256Bytes(contractBytes) !== binding.contractSha256
      || sha256Canonical(voteTemplate) !== binding.voteTemplateSha256 || manifest.contractSha256 !== binding.contractSha256) fail(`${binding.pgId}: taxonomy package binding drift`);
  assertExactIds(allowlist.files.map((file) => file.sha256), binding.inputAssetSha256s, `${binding.pgId} taxonomy allowlist hashes`);
  for (const file of allowlist.files) if (sha256Bytes(await readContainedFile(repoRoot, `${binding.packagePath}/${file.path}`)) !== file.sha256) fail(`${binding.pgId}: taxonomy pixel drift`);
  assertExactIds(await listContainedRegularFiles(repoRoot, binding.packagePath), ['allowlist.json', 'inputs/master.png', 'inputs/runtime.png', 'package-manifest.json', 'prompt.txt', 'review-contract.schema.json', 'vote-template.json'], `${binding.pgId} taxonomy package files`);
  if (/PG-\d{3}|koName|enName|shapeDNA|lineage|catalog/i.test(`${JSON.stringify(manifest)}${JSON.stringify(allowlist)}`)) fail(`${binding.pgId}: blinded package leaks product metadata`);
}

function validateTaxonomy(value, label) {
  assertExactKeys(value, TAXONOMY_FIELDS, label);
  if (Object.values(value).some((entry) => typeof entry !== 'string' || entry.length < 2 || /^unknown(?:-|$)/i.test(entry))) fail(`${label} contains missing/unknown taxonomy`);
}

function validateAssignment(assignment, binding, expected, { conductorKey, trusted }) {
  assertExactKeys(assignment, ['schemaVersion', 'assignmentId', 'role', 'passNumber', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'opaqueTaxonomyTargetId', 'packageManifestSha256', 'inputAllowlistSha256', 'promptSha256', 'contractSha256', 'inputAssetSha256s', 'assignedAt', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], 'taxonomy reviewer assignment');
  const parts = authorityParts(assignment, 'taxonomy reviewer assignment');
  if (trusted && assignment.conductorHmacSha256 !== taxonomyAssignmentHmac(parts.withOutput, conductorKey)) fail('taxonomy reviewer assignment HMAC failed');
  if (assignment.schemaVersion !== 'g002-taxonomy-review-assignment-v1' || assignment.role !== expected.role || assignment.passNumber !== expected.passNumber
      || assignment.opaqueTaxonomyTargetId !== binding.opaqueTaxonomyTargetId || assignment.packageManifestSha256 !== binding.packageManifestSha256
      || assignment.inputAllowlistSha256 !== binding.inputAllowlistSha256 || assignment.promptSha256 !== binding.promptSha256 || assignment.contractSha256 !== binding.contractSha256
      || sha256Canonical(assignment.inputAssetSha256s) !== sha256Canonical(binding.inputAssetSha256s)) fail('taxonomy reviewer assignment package/role binding mismatch');
  return assignment;
}

function validateRunAttestation(attestation, assignment, rawObservationSha256, { conductorKey, trusted }) {
  assertExactKeys(attestation, ['schemaVersion', 'assignmentManifestSha256', 'assignmentId', 'role', 'passNumber', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'opaqueTaxonomyTargetId', 'packageManifestSha256', 'rawObservationSha256', 'fresh', 'blinded', 'createdAt', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], 'taxonomy reviewer run attestation');
  const parts = authorityParts(attestation, 'taxonomy reviewer run attestation');
  if (trusted && attestation.conductorHmacSha256 !== taxonomyRunAttestationHmac(parts.withOutput, conductorKey)) fail('taxonomy reviewer run attestation HMAC failed');
  if (attestation.schemaVersion !== 'g002-taxonomy-review-run-attestation-v1' || attestation.assignmentManifestSha256 !== sha256Canonical(assignment)
      || attestation.assignmentId !== assignment.assignmentId || attestation.role !== assignment.role || attestation.passNumber !== assignment.passNumber
      || attestation.reviewerInstanceId !== assignment.reviewerInstanceId || attestation.agentTaskId !== assignment.agentTaskId
      || attestation.voterReviewRunId !== assignment.voterReviewRunId || attestation.rawObservationSha256 !== rawObservationSha256
      || attestation.fresh !== true || attestation.blinded !== true) fail('taxonomy reviewer run attestation identity/assignment/raw-observation binding mismatch');
  return attestation;
}

export function validateTaxonomyVote(vote, binding, passNumber, { conductorKey, trusted = false, assignment, runAttestation } = {}) {
  assertExactKeys(vote, ['schemaVersion', 'reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'role', 'fresh', 'blinded', 'opaqueTaxonomyTargetId', 'packageManifestSha256', 'inputAllowlistSha256', 'promptSha256', 'contractSha256', 'inputAssetSha256s', 'assignmentManifestSha256', 'reviewerRunAttestationSha256', 'taxonomy', 'confidence', 'submittedAt', 'passNumber', 'anchors', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], 'taxonomy vote');
  const parts = authorityParts(vote, 'taxonomy vote');
  if (trusted && vote.conductorHmacSha256 !== taxonomyVoteHmac(parts.withOutput, conductorKey)) fail('taxonomy vote conductor HMAC verification failed');
  if (vote.schemaVersion !== 'g002-taxonomy-primary-vote-v1' || vote.passNumber !== passNumber || vote.role !== 'primary' || vote.fresh !== true || vote.blinded !== true) fail('taxonomy vote is not a fresh blinded primary for its pass');
  if (vote.opaqueTaxonomyTargetId !== binding.opaqueTaxonomyTargetId || vote.packageManifestSha256 !== binding.packageManifestSha256
      || vote.inputAllowlistSha256 !== binding.inputAllowlistSha256 || vote.promptSha256 !== binding.promptSha256 || vote.contractSha256 !== binding.contractSha256
      || sha256Canonical(vote.inputAssetSha256s) !== sha256Canonical(binding.inputAssetSha256s)) fail('taxonomy vote package/pixel binding mismatch');
  validateTaxonomy(vote.taxonomy, 'taxonomy vote taxonomy');
  if (!Array.isArray(vote.anchors) || vote.anchors.length !== 3) fail('taxonomy vote requires exactly three image anchors');
  for (const anchor of vote.anchors) { assertExactKeys(anchor, ['anchorId', 'description'], 'taxonomy anchor'); if (typeof anchor.description !== 'string' || anchor.description.trim().length < 3) fail('taxonomy anchor is not concrete'); }
  assertExactIds(vote.anchors.map((anchor) => anchor.anchorId), CANONICAL_ANCHOR_IDS, 'taxonomy vote canonical anchor IDs');
  if (vote.confidence < 0.85 || vote.confidence > 1 || Number.isNaN(Date.parse(vote.submittedAt))) fail('taxonomy vote confidence/timestamp invalid');
  if (!assignment || !runAttestation || vote.assignmentManifestSha256 !== sha256Canonical(assignment) || vote.reviewerRunAttestationSha256 !== sha256Canonical(runAttestation)
      || ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId'].some((field) => vote[field] !== assignment[field])) fail('taxonomy vote identity is not bound to assignment/run attestation');
  return vote;
}

function validateAdjudication(vote, binding, { conductorKey, trusted, assignment, runAttestation }) {
  assertExactKeys(vote, ['schemaVersion', 'reviewId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'role', 'fresh', 'blinded', 'opaqueTaxonomyTargetId', 'packageManifestSha256', 'inputAllowlistSha256', 'promptSha256', 'contractSha256', 'inputAssetSha256s', 'assignmentManifestSha256', 'reviewerRunAttestationSha256', 'taxonomy', 'confidence', 'submittedAt', 'passNumber', 'adjudicationScope', 'rationale', 'outputSha256', 'conductorHmacSha256', 'publicSignature'], 'taxonomy adjudication');
  const parts = authorityParts(vote, 'taxonomy adjudication');
  if (trusted && vote.conductorHmacSha256 !== taxonomyAdjudicationHmac(parts.withOutput, conductorKey)) fail('taxonomy adjudication HMAC failed');
  if (vote.schemaVersion !== 'g002-taxonomy-adjudication-v1' || vote.role !== 'taxonomy-only-adjudicator' || vote.passNumber !== 3
      || vote.adjudicationScope !== 'taxonomy-only' || vote.fresh !== true || vote.blinded !== true || vote.confidence < 0.85 || vote.confidence > 1
      || typeof vote.rationale !== 'string' || vote.rationale.trim().length < 8) fail('taxonomy-only adjudication role/scope/freshness/confidence invalid');
  validateTaxonomy(vote.taxonomy, 'taxonomy adjudication taxonomy');
  if (vote.opaqueTaxonomyTargetId !== binding.opaqueTaxonomyTargetId || vote.packageManifestSha256 !== binding.packageManifestSha256
      || vote.assignmentManifestSha256 !== sha256Canonical(assignment) || vote.reviewerRunAttestationSha256 !== sha256Canonical(runAttestation)
      || ['reviewerInstanceId', 'agentTaskId', 'voterReviewRunId'].some((field) => vote[field] !== assignment[field])) fail('taxonomy adjudication package/identity binding mismatch');
  return vote;
}

export function deriveLockedTaxonomyConsensus(lock, evidenceByTarget, { conductorKey } = {}) {
  const assets = lock.packages.map((binding) => {
    const evidence = evidenceByTarget.get(binding.opaqueTaxonomyTargetId);
    if (!evidence) return { pgId: binding.pgId, opaqueTaxonomyTargetId: binding.opaqueTaxonomyTargetId, packageManifestSha256: binding.packageManifestSha256, status: 'PENDING', sourceReviewIds: [] };
    const [first, second] = evidence.primaries;
    if (first.reviewerInstanceId === second.reviewerInstanceId || first.agentTaskId === second.agentTaskId || first.voterReviewRunId === second.voterReviewRunId) fail(`${binding.pgId}: taxonomy primary reviews are not independent`);
    const normalizedAgree = taxonomyEqual(first.taxonomy, second.taxonomy);
    if (normalizedAgree && evidence.adjudication) fail(`${binding.pgId}: taxonomy adjudication is forbidden when normalized primaries agree`);
    if (!normalizedAgree && !evidence.adjudication) fail(`${binding.pgId}: normalized primary taxonomy disagreement requires exactly one adjudicator`);
    if (evidence.adjudication && [first, second].some((vote) => vote.reviewerInstanceId === evidence.adjudication.reviewerInstanceId || vote.agentTaskId === evidence.adjudication.agentTaskId || vote.voterReviewRunId === evidence.adjudication.voterReviewRunId)) fail(`${binding.pgId}: taxonomy adjudicator is not independent`);
    const firstAnchors = new Map(first.anchors.map((anchor) => [anchor.anchorId, anchor.description]));
    const secondAnchors = new Map(second.anchors.map((anchor) => [anchor.anchorId, anchor.description]));
    assertExactIds([...firstAnchors.keys()], CANONICAL_ANCHOR_IDS, `${binding.pgId} pass-1 anchor IDs`); assertExactIds([...secondAnchors.keys()], CANONICAL_ANCHOR_IDS, `${binding.pgId} pass-2 anchor IDs`);
    const anchors = CANONICAL_ANCHOR_IDS.map((anchorId) => ({ anchorId, sources: [first, second].map((vote, index) => ({
      reviewId: vote.reviewId, reviewOutputSha256: vote.outputSha256, reviewSignatureSha256: sha256Canonical(vote.publicSignature), rawVoteSha256: vote.rawVoteSha256,
      description: index === 0 ? firstAnchors.get(anchorId) : secondAnchors.get(anchorId),
    })) }));
    const selected = normalizeTaxonomy(evidence.adjudication?.taxonomy ?? first.taxonomy);
    return {
      pgId: binding.pgId, opaqueTaxonomyTargetId: binding.opaqueTaxonomyTargetId, packageManifestSha256: binding.packageManifestSha256, status: 'PASS', taxonomy: selected,
      primaryTaxonomies: [first, second].map((vote) => ({ reviewId: vote.reviewId, rawTaxonomy: vote.taxonomy, normalizedTaxonomy: normalizeTaxonomy(vote.taxonomy) })),
      adjudication: evidence.adjudication ? { reviewId: evidence.adjudication.reviewId, taxonomy: normalizeTaxonomy(evidence.adjudication.taxonomy), reviewOutputSha256: evidence.adjudication.outputSha256, reviewSignatureSha256: sha256Canonical(evidence.adjudication.publicSignature) } : null,
      anchors, sourceReviewIds: [first.reviewId, second.reviewId], sourceReviewOutputSha256s: [first.outputSha256, second.outputSha256],
    };
  });
  const complete = assets.every((asset) => asset.status === 'PASS');
  const core = { schemaVersion: 'g002-taxonomy-consensus-v1', runId: 'g002-v1', state: complete ? 'PASS' : 'PENDING', completionAllowed: complete, requiredPrimaryReviewsPerAsset: 2, assets };
  const unsigned = { ...core, outputSha256: sha256Canonical(core) };
  return conductorKey && complete ? { ...unsigned, publicSignature: signPublicEvidence(unsigned, conductorKey) } : unsigned;
}

async function loadOneEvidence(repoRoot, binding, basename, role, options) {
  const assignment = await readJson(repoRoot, `${TAXONOMY_ROOT}/reviewer-assignments/${binding.opaqueTaxonomyTargetId}/${basename}`);
  const runAttestation = await readJson(repoRoot, `${TAXONOMY_ROOT}/reviewer-run-attestations/${binding.opaqueTaxonomyTargetId}/${basename}`);
  const votePath = `${TAXONOMY_ROOT}/votes/${binding.opaqueTaxonomyTargetId}/${basename}`;
  const voteBytes = await readContainedFile(repoRoot, votePath); const vote = JSON.parse(voteBytes);
  const expected = { role: role === 'primary' ? 'primary' : 'taxonomy-only-adjudicator', passNumber: role === 'primary' ? vote.passNumber : 3 };
  validateAssignment(assignment, binding, expected, options);
  validateRunAttestation(runAttestation, assignment, runAttestation.rawObservationSha256, options);
  const validated = role === 'primary'
    ? validateTaxonomyVote(vote, binding, vote.passNumber, { ...options, assignment, runAttestation })
    : validateAdjudication(vote, binding, { ...options, assignment, runAttestation });
  return { ...validated, rawVoteSha256: sha256Bytes(voteBytes) };
}

async function loadEvidenceFiles(repoRoot, lock, options) {
  const result = new Map();
  for (const binding of lock.packages) {
    const relativeRoot = `${TAXONOMY_ROOT}/votes/${binding.opaqueTaxonomyTargetId}`; let entries = [];
    try { entries = await readdir(path.join(repoRoot, relativeRoot), { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entries.length === 0) continue;
    if (entries.some((entry) => !entry.isFile() || !/^(pass-[12]|adjudication)\.json$/.test(entry.name))) fail(`${binding.pgId}: taxonomy votes directory contains unexpected entry`);
    for (const entry of entries) { const info = await lstat(path.join(repoRoot, relativeRoot, entry.name)); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${binding.pgId}: taxonomy evidence is symlinked/hardlinked`); }
    const names = entries.map((entry) => entry.name); if (!names.includes('pass-1.json') || !names.includes('pass-2.json')) fail(`${binding.pgId}: exactly two primaries are required`);
    const primaries = [await loadOneEvidence(repoRoot, binding, 'pass-1.json', 'primary', options), await loadOneEvidence(repoRoot, binding, 'pass-2.json', 'primary', options)];
    const adjudication = names.includes('adjudication.json') ? await loadOneEvidence(repoRoot, binding, 'adjudication.json', 'adjudication', options) : null;
    result.set(binding.opaqueTaxonomyTargetId, { primaries, adjudication });
  }
  return result;
}

export async function verifyG002ReviewEvidence({ repoRoot = REPO_ROOT, requireComplete = false, conductorKey, trusted = false, publishConsensus = false } = {}) {
  const [publishedAnchors, rebuiltAnchors, lock, publishedConsensus, censusBytes, inputLock] = await Promise.all([
    readJson(repoRoot, ANCHOR_PATH), buildPixelAnchorConsensus({ repoRoot }), readJson(repoRoot, `${TAXONOMY_ROOT}/taxonomy-review-lock.json`),
    readJson(repoRoot, `${TAXONOMY_ROOT}/consensus.json`), readContainedFile(repoRoot, CENSUS_PATH), readJson(repoRoot, `${G002_ROOT}/inputs.lock.json`),
  ]);
  await verifyAuthorityContract(repoRoot, lock);
  const unsignedPublishedAnchors = structuredClone(publishedAnchors); delete unsignedPublishedAnchors.publicSignature;
  if (sha256Canonical(unsignedPublishedAnchors) !== sha256Canonical(rebuiltAnchors)) fail('public anchor consensus differs from tracked G001 census rebuild');
  verifyPublicEvidence(unsignedPublishedAnchors, publishedAnchors.publicSignature);
  if (rebuiltAnchors.sourceCensusSha256 !== sha256Bytes(censusBytes)) fail('public anchor consensus source census hash drift');
  const censusBinding = inputLock.inputs.find((entry) => entry.path === CENSUS_PATH);
  if (!censusBinding || censusBinding.sha256 !== sha256Bytes(censusBytes)) fail('tracked G001 census is not bound by public G002 input lock');
  findForbidden(unsignedPublishedAnchors);
  if (publishedAnchors.assets.length !== 240 || publishedAnchors.assets.some((asset) => asset.sourceReviews.length !== 2 || asset.anchors.some((anchor) => anchor.sources.length !== 2))) fail('pixel anchor consensus coverage/provenance incomplete');
  const lockCore = structuredClone(lock); delete lockCore.outputSha256; if (lock.outputSha256 !== sha256Canonical(lockCore)) fail('taxonomy review lock output hash drift');
  for (const binding of lock.packages) await verifyPackage(repoRoot, binding);
  if ((requireComplete || publishConsensus) && !trusted) fail('completion/publish requires trusted conductor verification');
  const evidenceByTarget = await loadEvidenceFiles(repoRoot, lock, { conductorKey, trusted });
  const derived = deriveLockedTaxonomyConsensus(lock, evidenceByTarget, { conductorKey: publishConsensus ? conductorKey : undefined });
  if (publishConsensus) await writeCanonicalFile(path.join(repoRoot, `${TAXONOMY_ROOT}/consensus.json`), derived, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['consensus.json']) });
  else {
    const unsignedPublished = structuredClone(publishedConsensus); delete unsignedPublished.publicSignature;
    const unsignedDerived = structuredClone(derived); delete unsignedDerived.publicSignature;
    if (sha256Canonical(unsignedPublished) !== sha256Canonical(unsignedDerived)) fail('published taxonomy consensus differs from verified votes');
    if (publishedConsensus.state === 'PASS') verifyPublicEvidence(unsignedPublished, publishedConsensus.publicSignature);
  }
  if (requireComplete && derived.state !== 'PASS') fail('pending taxonomy reviews cannot satisfy completion gate');
  return {
    status: derived.state, authenticationMode: trusted ? 'PUBLIC_ED25519_AND_TRUSTED_HMAC' : 'PUBLIC_ED25519_ONLY',
    hmacAuthorityClaimed: trusted, publicAuthority: PINNED_AUTHORITY_FINGERPRINT, anchorConsensusAssets: 240,
    taxonomyPackages: lock.packages.length, completedTaxonomyAssets: derived.assets.filter((asset) => asset.status === 'PASS').length,
  };
}

async function readKeyFromStdin() {
  if (process.stdin.isTTY) fail('--conductor-key-stdin with piped/inherited stdin is required');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const trusted = process.argv.includes('--trusted'); const keyStdin = process.argv.includes('--conductor-key-stdin');
  if (trusted !== keyStdin) fail('trusted verification requires both --trusted and --conductor-key-stdin');
  const conductorKey = trusted ? await readKeyFromStdin() : undefined;
  console.log(JSON.stringify(await verifyG002ReviewEvidence({ requireComplete: process.argv.includes('--require-complete'), conductorKey, trusted, publishConsensus: process.argv.includes('--publish-consensus') })));
}
