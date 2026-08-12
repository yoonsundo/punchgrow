#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { listContainedRegularFiles, readContainedFile, readJson, writeCanonicalFile, writeFileAtomicNoFollow } from './lib/continuity-assignment/evidence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ROOT = 'production/reports/biological-continuity-v3';
const G002_ROOT = `${REPORT_ROOT}/g002-evidence-v1`;
const TAXONOMY_ROOT = `${G002_ROOT}/taxonomy-reviews`;
const CENSUS_PATH = `${REPORT_ROOT}/g001-unblinded-image-first-census-v1.json`;
const TAXONOMY_SLOTS = ['PG-007', 'PG-028', 'PG-034', 'PG-041', 'PG-055'];

function visibleAnchors(observation) {
  return [...observation.faceAnchors, ...observation.bodyAnchors].filter((anchor) => anchor.visible);
}

export async function buildPixelAnchorConsensus({ repoRoot = REPO_ROOT } = {}) {
  const censusBytes = await readContainedFile(repoRoot, CENSUS_PATH);
  const census = JSON.parse(censusBytes);
  const assets = census.assets.map((asset) => {
    if (asset.primaryObservations.length !== 2) throw new Error(`${asset.pgId}: expected exactly two primary observations`);
    const sources = asset.primaryObservations.map((record) => {
      return {
        reviewId: record.reviewId, reviewerInstanceId: record.reviewerInstanceId, voterReviewRunId: record.voterReviewRunId,
        confidence: record.confidence, censusObservationSha256: sha256Canonical(record.observation), observation: record.observation,
      };
    });
    if (sources[0].reviewerInstanceId === sources[1].reviewerInstanceId || sources[0].voterReviewRunId === sources[1].voterReviewRunId) throw new Error(`${asset.pgId}: primary reviews are not independent`);
    const anchorsBySource = sources.map((source) => new Map(visibleAnchors(source.observation).map((anchor) => [anchor.anchorId, anchor.observation])));
    const commonIds = [...anchorsBySource[0].keys()].filter((id) => anchorsBySource[1].has(id)).sort();
    const anchors = commonIds.map((anchorId) => ({
      anchorId,
      sources: sources.map((source, index) => ({
        reviewId: source.reviewId, censusObservationSha256: source.censusObservationSha256,
        description: anchorsBySource[index].get(anchorId),
      })),
    }));
    return {
      pgId: asset.pgId,
      surfaces: {
        master: { sha256: asset.surfaces.master.sha256, width: asset.surfaces.master.width, height: asset.surfaces.master.height },
        runtime: { sha256: asset.surfaces.runtime.sha256, width: asset.surfaces.runtime.width, height: asset.surfaces.runtime.height },
      },
      status: anchors.length >= 3 ? 'TWO_PRIMARY_PIXEL_ANCHOR_CONSENSUS' : 'BLOCKED_INSUFFICIENT_COMMON_ANCHORS',
      sourceReviews: sources.map(({ observation, ...source }) => source),
      anchors,
    };
  });
  const core = {
    schemaVersion: 'g001-pixel-anchor-consensus-v1', runId: 'g001-baseline-v1', sourceCensusSha256: sha256Bytes(censusBytes),
    policy: { pixelsOnly: true, catalogMetadataAllowed: false, requiredPrimaryReviews: 2, minimumCommonVisibleAnchors: 3, publicRebuildSource: 'TRACKED_G001_CENSUS_ONLY' },
    counts: { assets: assets.length, withAnchorConsensus: assets.filter((asset) => asset.status === 'TWO_PRIMARY_PIXEL_ANCHOR_CONSENSUS').length }, assets,
  };
  return { ...core, outputSha256: sha256Canonical(core) };
}

function taxonomyPrompt() {
  return Buffer.from([
    'PunchGrow blinded pending-root pixel taxonomy review v1.',
    'Review only the supplied native master and runtime pixels. Product IDs, names, catalog fields, lineage, lore, shapeDNA, and prior labels are forbidden evidence.',
    'Return exact non-unknown biologicalClass, speciesFamily, coreAnatomy, and locomotionPlan.',
    'Record at least three concrete image-derived anchors with stable anchor IDs and literal visible descriptions.',
    'Use exactly face-geometry, body-silhouette, and signature-organ once each; do not invent anchor IDs.',
    'This must be a fresh independent primary review. Confidence must be at least 0.85.',
    'Do not create outputSha256 or conductorHmacSha256. The trusted stdin-key intake derives both authority fields.',
  ].join('\n') + '\n');
}

export async function preparePendingTaxonomyPackages({ repoRoot = REPO_ROOT } = {}) {
  const pixelClusters = await readJson(repoRoot, `${G002_ROOT}/pixel-clusters.json`);
  const anchorConsensus = await buildPixelAnchorConsensus({ repoRoot });
  const prompt = taxonomyPrompt();
  const contractBytes = await readContainedFile(repoRoot, 'production/contracts/g002-taxonomy-review-v1.schema.json');
  const authorityContractPath = 'production/contracts/g002-public-authority-v1.json';
  const authorityContractBytes = await readContainedFile(repoRoot, authorityContractPath);
  const authorityContract = JSON.parse(authorityContractBytes);
  const packages = [];
  for (const pgId of TAXONOMY_SLOTS) {
    const asset = pixelClusters.entries.find((entry) => entry.pgId === pgId);
    const anchorSource = anchorConsensus.assets.find((entry) => entry.pgId === pgId);
    if (!asset || !anchorSource) throw new Error(`${pgId}: missing pixel cluster/anchor evidence`);
    const opaqueTaxonomyTargetId = `taxonomy-${sha256Canonical({ master: asset.surfaces.master.sha256, runtime: asset.surfaces.runtime.sha256 }).slice(0, 24)}`;
    const packageRelative = `${TAXONOMY_ROOT}/packages/${opaqueTaxonomyTargetId}`;
    const packageRoot = path.join(repoRoot, packageRelative);
    const files = [];
    for (const [surfaceName, source] of Object.entries({ master: asset.surfaces.master, runtime: asset.surfaces.runtime })) {
      const bytes = await readContainedFile(repoRoot, source.path);
      if (sha256Bytes(bytes) !== source.sha256) throw new Error(`${pgId}: ${surfaceName} pixel hash drift`);
      const relative = `inputs/${surfaceName}.png`;
      await writeFileAtomicNoFollow(path.join(packageRoot, relative), bytes, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set([`${surfaceName}.png`]) });
      files.push({ path: relative, sha256: source.sha256, width: source.features.width, height: source.features.height });
    }
    const allowlist = { schemaVersion: 'g002-taxonomy-allowlist-v1', opaqueTaxonomyTargetId, files };
    const allowlistSha256 = sha256Canonical(allowlist); const promptSha256 = sha256Bytes(prompt); const contractSha256 = sha256Bytes(contractBytes);
    const manifest = {
      schemaVersion: 'g002-taxonomy-package-v1', opaqueTaxonomyTargetId, inputAllowlistSha256: allowlistSha256,
      promptSha256, contractSha256, inputAssetSha256s: files.map((file) => file.sha256),
    };
    const packageManifestSha256 = sha256Canonical(manifest);
    const template = {
      schemaVersion: 'g002-taxonomy-primary-vote-v1', reviewId: '{{REVIEW_ID}}', reviewerInstanceId: '{{REVIEWER_INSTANCE_ID}}', agentTaskId: '{{AGENT_TASK_ID}}', voterReviewRunId: '{{VOTER_REVIEW_RUN_ID}}',
      passNumber: '{{1|2}}', role: 'primary', fresh: true, blinded: true, opaqueTaxonomyTargetId,
      packageManifestSha256, inputAllowlistSha256: allowlistSha256, promptSha256, contractSha256, inputAssetSha256s: manifest.inputAssetSha256s,
      assignmentManifestSha256: '{{TRUSTED_INTAKE_ONLY}}', reviewerRunAttestationSha256: '{{TRUSTED_INTAKE_ONLY}}',
      taxonomy: { biologicalClass: '{{NON_UNKNOWN}}', speciesFamily: '{{NON_UNKNOWN}}', coreAnatomy: '{{NON_UNKNOWN}}', locomotionPlan: '{{NON_UNKNOWN}}' },
      anchors: [
        { anchorId: 'face-geometry', description: '{{VISIBLE_FACE_DESCRIPTION}}' },
        { anchorId: 'body-silhouette', description: '{{VISIBLE_BODY_DESCRIPTION}}' },
        { anchorId: 'signature-organ', description: '{{VISIBLE_SIGNATURE_DESCRIPTION}}' },
      ], confidence: 0.85, submittedAt: '{{ISO_8601}}', outputSha256: '{{TRUSTED_INTAKE_ONLY}}', conductorHmacSha256: '{{TRUSTED_INTAKE_ONLY}}', publicSignature: '{{TRUSTED_INTAKE_ONLY}}',
    };
    await writeCanonicalFile(path.join(packageRoot, 'allowlist.json'), allowlist, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['allowlist.json']) });
    await writeCanonicalFile(path.join(packageRoot, 'package-manifest.json'), manifest, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['package-manifest.json']) });
    await writeCanonicalFile(path.join(packageRoot, 'vote-template.json'), template, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['vote-template.json']) });
    await writeFileAtomicNoFollow(path.join(packageRoot, 'prompt.txt'), prompt, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['prompt.txt']) });
    await writeFileAtomicNoFollow(path.join(packageRoot, 'review-contract.schema.json'), contractBytes, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['review-contract.schema.json']) });
    packages.push({ pgId, opaqueTaxonomyTargetId, packagePath: packageRelative, packageManifestSha256, inputAllowlistSha256: allowlistSha256, promptSha256, contractSha256, voteTemplateSha256: sha256Canonical(template), inputAssetSha256s: manifest.inputAssetSha256s, sourceAnchorConsensusSha256: anchorConsensus.outputSha256 });
  }
  const lockCore = {
    schemaVersion: 'g002-taxonomy-review-lock-v1', runId: 'g002-v1', state: 'PENDING_INDEPENDENT_PRIMARY_REVIEWS', requiredSlots: TAXONOMY_SLOTS,
    publicAuthority: { contractPath: authorityContractPath, contractSha256: sha256Bytes(authorityContractBytes), algorithm: authorityContract.algorithm, authorityFingerprint: authorityContract.authorityFingerprint },
    packages,
  };
  const lock = { ...lockCore, outputSha256: sha256Canonical(lockCore) };
  const consensusCore = { schemaVersion: 'g002-taxonomy-consensus-v1', runId: 'g002-v1', state: 'PENDING', completionAllowed: false, requiredPrimaryReviewsPerAsset: 2, assets: packages.map(({ pgId, opaqueTaxonomyTargetId, packageManifestSha256 }) => ({ pgId, opaqueTaxonomyTargetId, packageManifestSha256, status: 'PENDING', sourceReviewIds: [] })) };
  const consensus = { ...consensusCore, outputSha256: sha256Canonical(consensusCore) };
  await writeCanonicalFile(path.join(repoRoot, `${TAXONOMY_ROOT}/taxonomy-review-lock.json`), lock, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['taxonomy-review-lock.json']) });
  let publishedConsensus = consensus;
  try {
    const voteFiles = await listContainedRegularFiles(repoRoot, `${TAXONOMY_ROOT}/votes`);
    if (voteFiles.length > 0) publishedConsensus = await readJson(repoRoot, `${TAXONOMY_ROOT}/consensus.json`);
    else await writeCanonicalFile(path.join(repoRoot, `${TAXONOMY_ROOT}/consensus.json`), consensus, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['consensus.json']) });
  } catch (error) {
    if (!/ENOENT|no such file/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) throw error;
    await writeCanonicalFile(path.join(repoRoot, `${TAXONOMY_ROOT}/consensus.json`), consensus, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['consensus.json']) });
  }
  return { anchorConsensus, lock, consensus: publishedConsensus };
}

export async function buildG002ReviewEvidence({ repoRoot = REPO_ROOT } = {}) {
  const result = await preparePendingTaxonomyPackages({ repoRoot });
  const anchorPath = `${REPORT_ROOT}/g001-primary-pixel-anchor-consensus-v1.json`;
  let publishedAnchorConsensus = result.anchorConsensus;
  try {
    const existing = await readJson(repoRoot, anchorPath);
    const unsignedExisting = structuredClone(existing); delete unsignedExisting.publicSignature;
    if (sha256Canonical(unsignedExisting) === sha256Canonical(result.anchorConsensus)) publishedAnchorConsensus = existing;
  } catch (error) { if (error.code !== 'ENOENT' && !/no such file/i.test(error.message)) throw error; }
  await writeCanonicalFile(path.join(repoRoot, anchorPath), publishedAnchorConsensus, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['g001-primary-pixel-anchor-consensus-v1.json']) });
  return { anchorConsensusSha256: result.anchorConsensus.outputSha256, taxonomyPackages: result.lock.packages, taxonomyState: result.consensus.state };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildG002ReviewEvidence(), null, 2));
