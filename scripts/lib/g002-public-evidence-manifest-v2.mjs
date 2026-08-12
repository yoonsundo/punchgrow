import { sha256Bytes } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, assertExactIds, listContainedRegularFiles } from './continuity-assignment/evidence.mjs';

export const EVIDENCE_ROOT = 'production/reports/biological-continuity-v3/g002-evidence-v1';
export const TAXONOMY_ROOT = `${EVIDENCE_ROOT}/taxonomy-reviews`;
export const UNSIGNED_MANIFEST_PATH = `${EVIDENCE_ROOT}/public-evidence-manifest.unsigned.json`;
export const SIGNED_MANIFEST_PATH = `${EVIDENCE_ROOT}/public-evidence-manifest.json`;
export const CANONICAL_TARGETS_UNSIGNED_PATH = `${EVIDENCE_ROOT}/canonical-root-redesign-targets-v1.unsigned.json`;
export const EVIDENCE_ROOT_INVENTORY_EXCEPTIONS = [CANONICAL_TARGETS_UNSIGNED_PATH, SIGNED_MANIFEST_PATH, UNSIGNED_MANIFEST_PATH];
export const AUTHORITY_CONTRACT_PATH = 'production/contracts/g002-public-authority-v1.json';
export const PACK_PATH = 'production/manifests/creature-asset-packs/cute-redesign-v2.json';
export const G001_CENSUS_PATH = 'production/reports/biological-continuity-v3/g001-unblinded-image-first-census-v1.json';
export const G001_CONFLICT_PATH = 'production/reports/biological-continuity-v3/g001-unblinded-conflict-ledger-v1.json';
export const G001_ANCHORS_PATH = 'production/reports/biological-continuity-v3/g001-primary-pixel-anchor-consensus-v1.json';
export const INPUT_LOCK_PATH = `${EVIDENCE_ROOT}/inputs.lock.json`;
export const ASSET_CENSUS_PATH = `${EVIDENCE_ROOT}/asset-census.json`;
export const PIXEL_CLUSTERS_PATH = `${EVIDENCE_ROOT}/pixel-clusters.json`;
export const TAXONOMY_LOCK_PATH = `${TAXONOMY_ROOT}/taxonomy-review-lock.json`;
export const TAXONOMY_CONSENSUS_PATH = `${TAXONOMY_ROOT}/consensus.json`;
export const OUTPUT_ATTESTATION_PATH = `${EVIDENCE_ROOT}/output-attestation.json`;
export const FIXED_ASSIGNMENT_OUTPUTS = [
  'assignment-manifest.json', 'compatibility-ledger.json', 'feasibility-report.json',
  'regeneration-queue.json', 'save-revision-map.json', 'topology-after.json',
];
export const PG_IDS = Array.from({ length: 240 }, (_, index) => `PG-${String(index + 1).padStart(3, '0')}`);
export const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function fail(message) { throw new Error(`G002 public evidence v2: ${message}`); }

export function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !keys.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}

export function pngDescriptor(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.toString('ascii', 12, 16) !== 'IHDR') fail(`${label} is not a valid PNG with an IHDR header`);
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) fail(`${label} has invalid PNG dimensions`);
  return { sha256: sha256Bytes(bytes), width, height, bytes: bytes.length };
}

export function taxonomyEvidencePaths(taxonomyLock, taxonomyConsensus) {
  assertExactIds(taxonomyLock.packages.map((entry) => entry.pgId), ['PG-007', 'PG-028', 'PG-034', 'PG-041', 'PG-055'], 'G002 taxonomy package PG IDs');
  const consensusById = new Map(taxonomyConsensus.assets.map((entry) => [entry.pgId, entry]));
  const paths = [TAXONOMY_LOCK_PATH, TAXONOMY_CONSENSUS_PATH];
  for (const binding of taxonomyLock.packages) {
    assertCanonicalRelativePath(binding.packagePath, `${binding.pgId} taxonomy package path`);
    const expectedPackagePath = `${TAXONOMY_ROOT}/packages/${binding.opaqueTaxonomyTargetId}`;
    if (binding.packagePath !== expectedPackagePath) fail(`${binding.pgId} taxonomy package path is not canonical`);
    for (const name of ['allowlist.json', 'inputs/master.png', 'inputs/runtime.png', 'package-manifest.json', 'prompt.txt', 'review-contract.schema.json', 'vote-template.json']) paths.push(`${binding.packagePath}/${name}`);
    const basenames = ['pass-1.json', 'pass-2.json'];
    if (consensusById.get(binding.pgId)?.adjudication) basenames.push('adjudication.json');
    for (const area of ['reviewer-assignments', 'reviewer-run-attestations', 'votes']) {
      for (const basename of basenames) paths.push(`${TAXONOMY_ROOT}/${area}/${binding.opaqueTaxonomyTargetId}/${basename}`);
    }
  }
  return paths.sort();
}

export function expectedCoveredPaths(inputLock, taxonomyLock, taxonomyConsensus) {
  const fixed = [AUTHORITY_CONTRACT_PATH, INPUT_LOCK_PATH, OUTPUT_ATTESTATION_PATH,
    ...FIXED_ASSIGNMENT_OUTPUTS.map((name) => `${EVIDENCE_ROOT}/${name}`)];
  const lockedInputs = inputLock.inputs.map((entry) => entry.path);
  const generated = inputLock.generatedArtifacts.map((entry) => `${EVIDENCE_ROOT}/${entry.path}`);
  const paths = [...new Set([...fixed, ...lockedInputs, ...generated, ...taxonomyEvidencePaths(taxonomyLock, taxonomyConsensus)])].sort();
  for (const relative of paths) {
    assertCanonicalRelativePath(relative, 'covered evidence path');
    if (relative.startsWith('.omx/') || relative.startsWith('assets/creatures/redesign-v2/')
        || relative === SIGNED_MANIFEST_PATH || relative === UNSIGNED_MANIFEST_PATH) fail(`forbidden or recursive covered path: ${relative}`);
  }
  return paths;
}

export function expectedEvidenceRootInventory(coveredPaths) {
  const insideRoot = coveredPaths.filter((entry) => entry.startsWith(`${EVIDENCE_ROOT}/`));
  return [...new Set([...insideRoot, ...EVIDENCE_ROOT_INVENTORY_EXCEPTIONS])]
    .map((entry) => entry.slice(`${EVIDENCE_ROOT}/`.length)).sort();
}

export async function assertEvidenceRootInventory(repoRoot, coveredPaths) {
  const actual = await listContainedRegularFiles(repoRoot, EVIDENCE_ROOT);
  const expected = expectedEvidenceRootInventory(coveredPaths);
  assertExactIds(actual, expected, 'G002 evidence-root exact inventory');
  return { files: actual.length, covered: coveredPaths.filter((entry) => entry.startsWith(`${EVIDENCE_ROOT}/`)).length,
    recursiveExceptions: EVIDENCE_ROOT_INVENTORY_EXCEPTIONS.length };
}

export function indexByPgId(entries, label, idKey = 'pgId') {
  assertExactIds(entries.map((entry) => entry[idKey]), PG_IDS, label);
  return new Map(entries.map((entry) => [entry[idKey], entry]));
}
