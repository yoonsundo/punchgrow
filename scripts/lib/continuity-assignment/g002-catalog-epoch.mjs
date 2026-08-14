import { sha256Bytes } from './canonical-json.mjs';

export const G002_CATALOG_EPOCH_SIZE = 240;
export const G002_SIGNED_CATALOG_SHA256 = 'd9a3265d8e8f07d9ce7f3de52affe3420df4d2aa3406a7f4f364ae1380e9e8a0';

export function canonicalCreatureId(index) {
  return `PG-${String(index + 1).padStart(3, '0')}`;
}

export function projectG002CatalogEpoch(catalog) {
  if (!Array.isArray(catalog) || catalog.length < G002_CATALOG_EPOCH_SIZE) {
    throw new Error(`G002 catalog epoch requires at least ${G002_CATALOG_EPOCH_SIZE} entries`);
  }
  for (let index = 0; index < catalog.length; index += 1) {
    const expectedId = canonicalCreatureId(index);
    if (!catalog[index] || typeof catalog[index] !== 'object' || catalog[index].id !== expectedId) {
      throw new Error(`G002 catalog IDs must be canonical and append-only: index ${index} must be ${expectedId}`);
    }
  }
  const epochCatalog = Object.freeze(catalog.slice(0, G002_CATALOG_EPOCH_SIZE));
  const epochBytes = `${JSON.stringify(epochCatalog, null, 2)}\n`;
  const epochSha256 = sha256Bytes(epochBytes);
  if (epochSha256 !== G002_SIGNED_CATALOG_SHA256) {
    throw new Error(`G002 signed catalog prefix hash drift: expected ${G002_SIGNED_CATALOG_SHA256}, received ${epochSha256}`);
  }
  return Object.freeze({
    catalog: epochCatalog,
    bytes: epochBytes,
    sha256: epochSha256,
    currentIds: Object.freeze(catalog.map((entry) => entry.id)),
    suffixIds: Object.freeze(catalog.slice(G002_CATALOG_EPOCH_SIZE).map((entry) => entry.id)),
  });
}
