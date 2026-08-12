import { createHash } from 'node:crypto';

export const TAXONOMY_FIELDS = Object.freeze([
  'biologicalClass',
  'speciesFamily',
  'coreAnatomy',
  'locomotionPlan',
]);

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const canonicalString = (value) => JSON.stringify(canonicalize(value));

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function fail(message) {
  throw new Error(message);
}

export function assertUnique(items, keyOf, label) {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) fail(`duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

export function taxonomyTuple(taxonomy) {
  if (!taxonomy || TAXONOMY_FIELDS.some((field) => typeof taxonomy[field] !== 'string'
      || taxonomy[field].length === 0 || taxonomy[field].startsWith('unknown'))) return null;
  return TAXONOMY_FIELDS.map((field) => taxonomy[field]);
}

export function exactTaxonomyCompatible(...taxonomies) {
  const tuples = taxonomies.map(taxonomyTuple);
  return tuples.every(Boolean) && tuples.every((tuple) => canonicalString(tuple) === canonicalString(tuples[0]));
}

export function parentIdsFor(creature, catalog) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const byLineageStage = new Map();
  for (const item of catalog) {
    const key = `${item.lineageId}:S${item.stage}`;
    if (byLineageStage.has(key)) fail(`ambiguous lineage-stage reference: ${key}`);
    byLineageStage.set(key, item);
  }
  return (creature.evolutionFrom == null ? []
    : Array.isArray(creature.evolutionFrom) ? creature.evolutionFrom : [creature.evolutionFrom])
    .map((reference) => byId.get(reference) ?? byLineageStage.get(reference) ?? fail(`missing parent ${reference}`))
    .map((item) => item.id);
}

export function edgeKey(parentIds, childId) {
  return `${[...parentIds].sort().join('+')}=>${childId}`;
}

export function blockedEvidenceSets(census, conflictLedger) {
  const assetById = new Map(census.assets.map((asset) => [asset.pgId, asset]));
  const blockedAssetIds = new Set();
  const blockedHashes = new Set();
  const blockedEdges = new Set();
  for (const conflict of conflictLedger.conflicts) {
    if (conflict.kind === 'asset') {
      blockedAssetIds.add(conflict.pgId);
      const asset = assetById.get(conflict.pgId);
      for (const surface of Object.values(asset?.surfaces ?? {})) if (surface?.sha256) blockedHashes.add(surface.sha256);
    } else if (conflict.kind === 'edge') {
      const parents = Object.values(conflict.parentSlots ?? {}).map((parent) => parent.pgId);
      blockedEdges.add(edgeKey(parents, conflict.child.pgId));
    }
  }
  for (const asset of census.assets) {
    if (asset.derived?.verdict !== 'PASS' || !taxonomyTuple(asset.selectedTaxonomy)) {
      blockedAssetIds.add(asset.pgId);
      for (const surface of Object.values(asset.surfaces ?? {})) if (surface?.sha256) blockedHashes.add(surface.sha256);
    }
  }
  return { assetById, blockedAssetIds, blockedHashes, blockedEdges };
}
