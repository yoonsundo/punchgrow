#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalStringify, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { assertExactIds, assertHash, fail, hashContainedFile, readContainedFile, readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { extractPixelFeatures } from './lib/continuity-assignment/pixel-features.mjs';
import { buildTopology } from './lib/continuity-assignment/topology.mjs';
import { validateSignedCanonicalRootRedesignTargets } from './lib/continuity-assignment/canonical-root-redesign-targets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = 'g002-v1';
export const G002_PUBLIC_ROOT = 'production/reports/biological-continuity-v3/g002-evidence-v1';
const DEFAULT_OUTPUT = G002_PUBLIC_ROOT;
const APPROVED_OUTPUTS = new Set(['inputs.lock.json', 'asset-census.json', 'pixel-clusters.json', 'pins.json', 'topology-before.json']);
const execFileAsync = promisify(execFile);
const SOURCES = Object.freeze({
  registry: 'config/creature-assets.json',
  catalog: 'production/catalog/creatures.json',
  pack: 'production/manifests/creature-asset-packs/cute-redesign-v2.json',
  census: 'production/reports/biological-continuity-v3/g001-unblinded-image-first-census-v1.json',
  conflicts: 'production/reports/biological-continuity-v3/g001-unblinded-conflict-ledger-v1.json',
  anchorConsensus: 'production/reports/biological-continuity-v3/g001-primary-pixel-anchor-consensus-v1.json',
  lockedTaxonomyConsensus: `${G002_PUBLIC_ROOT}/taxonomy-reviews/consensus.json`,
  canonicalRootRedesignTargets: `${G002_PUBLIC_ROOT}/canonical-root-redesign-targets-v1.json`,
});
const FIXTURES = Object.freeze([
  { fixtureId: 'norzed', screenshotPath: `${G002_PUBLIC_ROOT}/screenshots/norzed.png`, screenshotSha256: '3470b42077bfb4d8bb45f31da1e15c080c128b56eb284c261bb9f3cf20040e2c', rootId: 'PG-059', slotIds: ['PG-059', 'PG-160', 'PG-165'] },
  { fixtureId: 'conipo', screenshotPath: `${G002_PUBLIC_ROOT}/screenshots/conipo.png`, screenshotSha256: 'ab427afe3d004dc14d83fc8e2c6bcb981acca3f3dcbc6f025ee5ebfbd28831a2', rootId: 'PG-010', slotIds: ['PG-010', 'PG-070', 'PG-225', 'PG-190'] },
  { fixtureId: 'tirsha', screenshotPath: `${G002_PUBLIC_ROOT}/screenshots/tirsha.png`, screenshotSha256: '0b0dbc615c701241557840a09dc73d894a57a0e624003d55c77933c84bc3743d', rootId: 'PG-038', slotIds: ['PG-038', 'PG-132', 'PG-133', 'PG-208', 'PG-134'] },
  { fixtureId: 'danjuri', screenshotPath: `${G002_PUBLIC_ROOT}/screenshots/danjuri.png`, screenshotSha256: '9905afcae32c0738804bdff929c658fba70ebf299f1058f2ab0bd4ce71a43799', rootId: 'PG-024', slotIds: ['PG-024', 'PG-090', 'PG-200', 'PG-235', 'PG-091', 'PG-092'] },
  { fixtureId: 'kirikong', screenshotPath: `${G002_PUBLIC_ROOT}/screenshots/kirikong.png`, screenshotSha256: '70acaf1912cff093a4056049fb08c0591f732bbf541e1a97d9613f70ec6f736d', rootId: 'PG-019', slotIds: ['PG-019', 'PG-079', 'PG-197'] },
  { fixtureId: 'ritoni', screenshotPath: `${G002_PUBLIC_ROOT}/screenshots/ritoni.png`, screenshotSha256: '1362360eec93ef650e99f0d96c90035a4de4a84bd6711aaff1a8466abaeef194', rootId: 'PG-025', slotIds: ['PG-025', 'PG-102', 'PG-200', 'PG-103', 'PG-104'] },
]);

function compareObjects(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function hammingHex(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let value = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (value) { distance += value & 1; value >>= 1; }
  }
  return distance;
}

export function classificationOf(asset, conflictById) {
  const conflict = conflictById.get(asset.pgId);
  const substantive = conflict?.reasonClasses?.includes('substantive-biological-dissent') ?? false;
  const unknownFamily = /^unknown(?:-|$)/.test(asset.selectedTaxonomy?.speciesFamily ?? '');
  if (asset.derived?.verdict === 'PASS' && !unknownFamily) return { disposition: 'reusable', dispositionReason: 'two-primary-known-consensus' };
  if (asset.derived?.verdict === 'PASS' && unknownFamily) return { disposition: 'review-required', dispositionReason: 'pass-unknown-family' };
  if (asset.derived?.verdict === 'BLOCKED' && substantive) return { disposition: 'regenerate-required', dispositionReason: 'substantive-biological-dissent' };
  if (asset.derived?.verdict === 'BLOCKED' && conflict) return { disposition: 'review-required', dispositionReason: 'evidence-only-conflict' };
  fail(`${asset.pgId} has an unclassifiable G001 verdict`);
}

export function assertUniqueSurfaceHash(seen, digest, pgId, surface) {
  if (seen.has(digest)) fail(`duplicate ${surface} PNG assigned to ${seen.get(digest)} and ${pgId}`);
  seen.set(digest, pgId);
}

function assertAuthenticatedG001(census, conflicts, sourceBindings) {
  if (census.schemaVersion !== 'g001-unblinded-image-first-census-v1' || conflicts.schemaVersion !== 'g001-unblinded-conflict-ledger-v1') fail('G001 public artifact schema mismatch');
  if (census.runId !== 'g001-baseline-v1' || conflicts.runId !== census.runId || census.provenance?.runId !== census.runId || conflicts.provenance?.runId !== census.runId) fail('G001 run binding mismatch');
  if (census.verdict !== 'BLOCKED' || conflicts.verdict !== 'BLOCKED' || census.counts?.assets !== 240 || census.counts?.edges !== 190 || census.counts?.blocked !== 115) fail('G001 derived verdict/count drift');
  if (!compareObjects(census.provenance?.sourceInputs, sourceBindings) || !compareObjects(conflicts.provenance?.sourceInputs, sourceBindings)) fail('G001 public artifacts are stale against catalog/registry/pack');
  for (const artifact of [census, conflicts]) {
    const paths = new Set((artifact.provenance?.evidenceInputs ?? []).map((item) => item.path));
    if (![...paths].some((item) => item.endsWith('/assignment-attestation.json'))
        || ![...paths].some((item) => item.includes('/raw-votes/pass-1/'))
        || ![...paths].some((item) => item.includes('/raw-votes/pass-2/'))
        || ![...paths].some((item) => item.endsWith('/derived-verdict.json'))) fail('G001 artifact lacks authenticated vote/attestation provenance');
  }
}

function dispositionCounts(assets) {
  return {
    reusable: assets.filter((item) => item.disposition === 'reusable').length,
    reviewRequired: assets.filter((item) => item.disposition === 'review-required').length,
    reviewEvidenceOnly: assets.filter((item) => item.dispositionReason === 'evidence-only-conflict').length,
    reviewPassUnknown: assets.filter((item) => item.dispositionReason === 'pass-unknown-family').length,
    regenerateRequired: assets.filter((item) => item.disposition === 'regenerate-required').length,
  };
}

async function extractFeatureBatch(repoRoot, batch) {
  return Promise.all(batch.map(async (row) => {
    const [masterBytes, runtimeBytes] = await Promise.all([readContainedFile(repoRoot, row.master.path), readContainedFile(repoRoot, row.runtime.path)]);
    return {
      pgId: row.pgId,
      master: extractPixelFeatures(masterBytes, { expectedWidth: row.master.width, expectedHeight: row.master.height, label: `${row.pgId} master` }),
      runtime: extractPixelFeatures(runtimeBytes, { expectedWidth: row.runtime.width, expectedHeight: row.runtime.height, label: `${row.pgId} runtime` }),
    };
  }));
}

async function extractFeaturesIsolated(repoRoot, requests) {
  const results = new Map();
  for (let offset = 0; offset < requests.length; offset += 2) {
    const batch = requests.slice(offset, offset + 2);
    const encoded = Buffer.from(JSON.stringify(batch)).toString('base64url');
    const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), '--feature-batch', encoded], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    for (const item of JSON.parse(stdout)) results.set(item.pgId, item);
  }
  return results;
}

async function buildArtifacts(repoRoot = REPO_ROOT) {
  let sourceValues;
  try { sourceValues = await Promise.all(Object.values(SOURCES).map((source) => readJson(repoRoot, source))); }
  catch (error) {
    if (error.code === 'ENOENT') fail('signed canonical root redesign targets are missing; run npm run continuity:g002:canonical-targets:sign with the pinned authority key on stdin');
    throw error;
  }
  const [registry, catalog, pack, census, conflicts, anchorConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets] = sourceValues;
  if (registry.activePack !== pack.packId || registry.packs?.[registry.activePack] !== SOURCES.pack || pack.status !== 'active') fail('registry does not select the current active pack');
  const sourceBindings = await Promise.all([SOURCES.registry, SOURCES.catalog, SOURCES.pack].map(async (sourcePath) => ({ path: sourcePath, sha256: await hashContainedFile(repoRoot, sourcePath) })));
  assertAuthenticatedG001(census, conflicts, sourceBindings);
  const unsignedAnchorConsensus = structuredClone(anchorConsensus); delete unsignedAnchorConsensus.publicSignature;
  const anchorConsensusCore = structuredClone(unsignedAnchorConsensus); delete anchorConsensusCore.outputSha256;
  if (anchorConsensus.schemaVersion !== 'g001-pixel-anchor-consensus-v1' || anchorConsensus.runId !== census.runId
      || anchorConsensus.sourceCensusSha256 !== await hashContainedFile(repoRoot, SOURCES.census)
      || unsignedAnchorConsensus.outputSha256 !== sha256Canonical(anchorConsensusCore) || anchorConsensus.assets?.length !== 240
      || anchorConsensus.counts?.withAnchorConsensus !== 240) fail('G001 pixel-anchor consensus is stale, incomplete, or unauthenticated');
  const unsignedLockedTaxonomy = structuredClone(lockedTaxonomyConsensus); delete unsignedLockedTaxonomy.publicSignature;
  const lockedTaxonomyCore = structuredClone(unsignedLockedTaxonomy); delete lockedTaxonomyCore.outputSha256;
  if (lockedTaxonomyConsensus.schemaVersion !== 'g002-taxonomy-consensus-v1' || lockedTaxonomyConsensus.runId !== RUN_ID
      || lockedTaxonomyConsensus.state !== 'PASS' || lockedTaxonomyConsensus.completionAllowed !== true
      || lockedTaxonomyConsensus.requiredPrimaryReviewsPerAsset !== 2 || lockedTaxonomyConsensus.assets?.length !== 5
      || unsignedLockedTaxonomy.outputSha256 !== sha256Canonical(lockedTaxonomyCore)) fail('G002 reviewed taxonomy consensus is stale or incomplete');
  validateSignedCanonicalRootRedesignTargets(canonicalRootRedesignTargets);
  assertExactIds(census.assets.map((item) => item.pgId), catalog.map((item) => item.id), 'G001 asset census');
  assertExactIds(pack.entries.map((item) => item.id), catalog.map((item) => item.id), 'active pack');
  const conflictAssets = conflicts.conflicts.filter((item) => item.kind === 'asset');
  const conflictById = new Map(conflictAssets.map((item) => [item.pgId, item]));
  if (conflictById.size !== 83) fail(`G001 conflict asset count drifted: ${conflictById.size}`);
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const packById = new Map(pack.entries.map((item) => [item.id, item]));
  const seenMasterHashes = new Map(); const seenRuntimeHashes = new Map();
  const featureRows = [];
  const featureRequests = [];
  const assets = [];

  for (const source of [...census.assets].sort((a, b) => a.pgId.localeCompare(b.pgId))) {
    const catalogEntry = catalogById.get(source.pgId); const packEntry = packById.get(source.pgId);
    if (!catalogEntry || !packEntry) fail(`${source.pgId} is missing from catalog or pack`);
    if (source.surfaces.master.path !== packEntry.path || source.surfaces.master.sha256 !== packEntry.sha256
        || source.surfaces.runtime.sourcePath !== packEntry.mobilePath || source.surfaces.runtime.sha256 !== packEntry.mobileSha256
        || source.surfaces.runtime.path !== packEntry.deploymentPaths?.mobile) fail(`${source.pgId} G001 surface binding drifted from active pack`);
    const [masterSha256, runtimeSha256, deployedRuntimeSha256] = await Promise.all([
      hashContainedFile(repoRoot, source.surfaces.master.path), hashContainedFile(repoRoot, source.surfaces.runtime.sourcePath), hashContainedFile(repoRoot, source.surfaces.runtime.path),
    ]);
    if (masterSha256 !== source.surfaces.master.sha256 || runtimeSha256 !== source.surfaces.runtime.sha256 || deployedRuntimeSha256 !== runtimeSha256) fail(`${source.pgId} has a stale master/runtime/deployment hash`);
    for (const [seen, digest, surface] of [[seenMasterHashes, masterSha256, 'master'], [seenRuntimeHashes, runtimeSha256, 'runtime']]) assertUniqueSurfaceHash(seen, digest, source.pgId, surface);
    const classification = classificationOf(source, conflictById);
    const taxonomy = source.selectedTaxonomy ?? { biologicalClass: 'unknown', speciesFamily: 'unknown-family', coreAnatomy: 'unknown', locomotionPlan: 'unknown', basis: 'g001-no-consensus' };
    assets.push({
      pgId: source.pgId, lineageId: catalogEntry.lineageId, stage: catalogEntry.stage, category: catalogEntry.category,
      ...classification, g001Verdict: source.derived.verdict, taxonomy,
      visibleAnchorIds: source.selectedVisualContract?.commonVisibleAnchorIds ?? [], surfaces: source.surfaces,
    });
    featureRows.push({ pgId: source.pgId, disposition: classification.disposition, taxonomy, surfaces: { master: { path: source.surfaces.master.path, sha256: masterSha256 }, runtime: { path: source.surfaces.runtime.sourcePath, deployedPath: source.surfaces.runtime.path, sha256: runtimeSha256 } } });
    featureRequests.push({ pgId: source.pgId, master: { path: source.surfaces.master.path, width: source.surfaces.master.width, height: source.surfaces.master.height }, runtime: { path: source.surfaces.runtime.sourcePath, width: source.surfaces.runtime.width, height: source.surfaces.runtime.height } });
  }
  const extractedFeatures = await extractFeaturesIsolated(repoRoot, featureRequests);
  for (const row of featureRows) {
    const extracted = extractedFeatures.get(row.pgId);
    if (!extracted) fail(`${row.pgId} pixel feature extraction is missing`);
    row.surfaces.master.features = extracted.master; row.surfaces.runtime.features = extracted.runtime;
  }
  const counts = dispositionCounts(assets);
  const expectedCounts = { reusable: 145, reviewRequired: 33, reviewEvidenceOnly: 21, reviewPassUnknown: 12, regenerateRequired: 62 };
  if (!compareObjects(counts, expectedCounts)) fail(`G002 disposition counts drifted: ${JSON.stringify(counts)}`);
  const blockedHashes = new Set(census.assets.filter((item) => item.derived.verdict === 'BLOCKED').flatMap((item) => [item.surfaces.master.sha256, item.surfaces.runtime.sha256]));
  if (assets.some((item) => item.disposition === 'reusable' && [item.surfaces.master.sha256, item.surfaces.runtime.sha256].some((digest) => blockedHashes.has(digest)))) fail('G001 blocked hash entered reusable inventory');

  for (const row of featureRows) {
    row.shortlist = featureRows.filter((candidate) => candidate.pgId !== row.pgId)
      .map((candidate) => ({ pgId: candidate.pgId, masterPerceptualDistance: hammingHex(row.surfaces.master.features.perceptualHash, candidate.surfaces.master.features.perceptualHash), runtimePerceptualDistance: hammingHex(row.surfaces.runtime.features.perceptualHash, candidate.surfaces.runtime.features.perceptualHash) }))
      .sort((a, b) => (a.masterPerceptualDistance + a.runtimePerceptualDistance) - (b.masterPerceptualDistance + b.runtimePerceptualDistance) || a.pgId.localeCompare(b.pgId)).slice(0, 12);
  }
  const assetCensus = { schemaVersion: 'taxonomy-consensus-v1', runId: RUN_ID, policy: { pixelFeaturesAreApprovalEvidence: false, unknownTaxonomyReusable: false, blockedHashReusable: false }, counts, assets };
  const pixelClusters = { schemaVersion: 'continuity-pixel-shortlists-v1', runId: RUN_ID, policy: { purpose: 'deterministic-shortlist-metadata-only', biologicalApprovalAllowed: false, features: ['foreground-bounds', 'foreground-centroid', 'foreground-occupancy', 'silhouette-bitmap', 'silhouette-hash', 'perceptual-hash', 'quantized-palette'] }, entries: featureRows };
  const topologyBefore = buildTopology(catalog);

  const fixturePins = [];
  for (const fixture of FIXTURES) {
    await assertHash(repoRoot, { path: fixture.screenshotPath, sha256: fixture.screenshotSha256 }, `${fixture.fixtureId} screenshot`);
    fixturePins.push({ ...fixture, slots: fixture.slotIds.map((pgId) => { const item = assets.find((asset) => asset.pgId === pgId); if (!item) fail(`${fixture.fixtureId} pin references missing slot ${pgId}`); return { pgId, masterSha256: item.surfaces.master.sha256, runtimeSha256: item.surfaces.runtime.sha256 }; }) });
  }
  const pins = {
    schemaVersion: 'continuity-pins-v1', runId: RUN_ID,
    positiveControl: { controlId: 'eilu', rootId: 'PG-001', slotIds: ['PG-001', 'PG-061', 'PG-181'], slots: ['PG-001', 'PG-061', 'PG-181'].map((pgId) => { const item = assets.find((asset) => asset.pgId === pgId); return { pgId, masterSha256: item.surfaces.master.sha256, runtimeSha256: item.surfaces.runtime.sha256 }; }) },
    fixtures: fixturePins,
  };
  const consumedInputs = await Promise.all([...Object.values(SOURCES), ...FIXTURES.map((item) => item.screenshotPath)].map(async (sourcePath) => ({ path: sourcePath, sha256: await hashContainedFile(repoRoot, sourcePath) })));
  const lock = { schemaVersion: 'continuity-input-lock-v1', runId: RUN_ID, inputs: consumedInputs, activeAssets: assets.map((item) => ({ pgId: item.pgId, master: { path: item.surfaces.master.path, sha256: item.surfaces.master.sha256 }, runtime: { path: item.surfaces.runtime.sourcePath, deployedPath: item.surfaces.runtime.path, sha256: item.surfaces.runtime.sha256 } })), generatedArtifacts: [
    { path: 'asset-census.json', sha256: sha256Canonical(assetCensus) }, { path: 'pixel-clusters.json', sha256: sha256Canonical(pixelClusters) }, { path: 'pins.json', sha256: sha256Canonical(pins) }, { path: 'topology-before.json', sha256: sha256Canonical(topologyBefore) },
  ] };
  return { 'inputs.lock.json': lock, 'asset-census.json': assetCensus, 'pixel-clusters.json': pixelClusters, 'pins.json': pins, 'topology-before.json': topologyBefore };
}

async function publish(outputRelative, artifacts) {
  const destination = path.resolve(REPO_ROOT, outputRelative);
  const relation = path.relative(REPO_ROOT, destination);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('output path escapes repository');
  for (const [filename, value] of Object.entries(artifacts)) {
    if (!APPROVED_OUTPUTS.has(filename)) fail(`unexpected G002 input artifact ${filename}`);
    await writeCanonicalFile(path.join(destination, filename), value, { containmentRoot: REPO_ROOT, mode: 0o644, allowedBasenames: APPROVED_OUTPUTS });
  }
}

export async function buildG002ContinuityInputs({ repoRoot = REPO_ROOT, outputRelative = DEFAULT_OUTPUT, write = true } = {}) {
  const artifacts = await buildArtifacts(repoRoot);
  if (write) await publish(outputRelative, artifacts);
  return artifacts;
}

export async function assertDeterministicRebuild() {
  const first = await buildArtifacts(REPO_ROOT); const second = await buildArtifacts(REPO_ROOT);
  if (canonicalStringify(first) !== canonicalStringify(second)) fail('G002 rebuild is not deterministic');
  return first;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--feature-batch') {
  const batch = JSON.parse(Buffer.from(process.argv[3], 'base64url'));
  extractFeatureBatch(REPO_ROOT, batch).then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== '--check')) {
    console.error('Usage: node scripts/build-g002-continuity-inputs.mjs [--check]'); process.exitCode = 2;
  } else {
    const checkOnly = args[0] === '--check';
    buildG002ContinuityInputs({ write: !checkOnly }).then(async (artifacts) => {
      if (checkOnly) {
        for (const [filename, value] of Object.entries(artifacts)) {
          const current = await readFile(path.join(REPO_ROOT, DEFAULT_OUTPUT, filename));
          if (!current.equals(Buffer.from(canonicalStringify(value)))) fail(`${filename} differs from deterministic rebuild`);
        }
      }
      console.log(JSON.stringify({ runId: RUN_ID, status: 'PASS', mode: checkOnly ? 'check' : 'write', counts: artifacts['asset-census.json'].counts, topology: artifacts['topology-before.json'].counts }));
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
