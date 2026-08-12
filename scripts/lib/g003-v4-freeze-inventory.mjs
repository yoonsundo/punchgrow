import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, readContainedFile } from './continuity-assignment/evidence.mjs';
import { signG003PublicEvidence, verifyG003PublicEvidence } from './g003-public-authority.mjs';
import { G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256 } from './g003-v4-authority.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from './g003-transition-integrity.mjs';

export const G003_V4_FREEZE_SCHEMA_VERSION = 'continuity-g003-v4-freeze-inventory-v1';
export const G003_V4_FREEZE_PURPOSE = 'g003:v4-freeze-inventory';
export const G003_V4_FREEZE_SCHEMA_PATH = 'production/contracts/g003-v4-freeze-inventory-v1.schema.json';
export const G003_V4_FREEZE_PATH = 'production/reports/biological-continuity-v3/g003-v4-freeze-inventory.json';
export const G003_V4_FREEZE_ROOTS = Object.freeze([
  Object.freeze({ kind: 'public-evidence', path: 'production/reports/biological-continuity-v3/g003-evidence-v3' }),
  Object.freeze({ kind: 'rejection-archive', path: 'assets/creatures/biological-continuity-v3/rejected' }),
]);

const SHA = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(`G003-v4 freeze: ${message}`); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(`${label} fields mismatch`);
};

async function readStableRegularFile(absolute, displayPath) {
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail(`non-regular, symlinked, or hard-linked file: ${displayPath}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail(`file changed while inventorying: ${displayPath}`);
    return Object.freeze({ path: displayPath, size: bytes.length, sha256: sha256Bytes(bytes) });
  } finally { await handle.close(); }
}

async function inventoryRoot(repoRoot, binding) {
  assertCanonicalRelativePath(binding.path, `${binding.kind} root`);
  const repository = path.resolve(repoRoot); const absoluteRoot = path.resolve(repository, binding.path);
  const relation = path.relative(repository, absoluteRoot);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${binding.kind} root escapes repository`);
  let cursor = repository;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${binding.kind} root has a symlinked or non-directory ancestor`);
  }
  const files = [];
  async function walk(directory, relative) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name); const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail(`symlink is forbidden: ${binding.path}/${childRelative}`);
      if (info.isDirectory()) await walk(absolute, childRelative);
      else if (info.isFile()) files.push(await readStableRegularFile(absolute, `${binding.path}/${childRelative}`));
      else fail(`special file is forbidden: ${binding.path}/${childRelative}`);
    }
  }
  await walk(absoluteRoot, '');
  const byteCount = files.reduce((sum, file) => sum + file.size, 0);
  const treeSha256 = sha256Canonical({ kind: binding.kind, path: binding.path, files });
  return Object.freeze({ kind: binding.kind, path: binding.path, fileCount: files.length, byteCount, treeSha256, files: Object.freeze(files) });
}

export async function buildG003V4FreezeInventory({ repoRoot, roots = G003_V4_FREEZE_ROOTS } = {}) {
  if (!repoRoot) fail('repoRoot is required');
  if (!Array.isArray(roots) || roots.length === 0) fail('at least one inventory root is required');
  const inventory = [];
  for (const root of roots) inventory.push(await inventoryRoot(repoRoot, root));
  const totals = Object.freeze({
    fileCount: inventory.reduce((sum, root) => sum + root.fileCount, 0),
    byteCount: inventory.reduce((sum, root) => sum + root.byteCount, 0),
  });
  const treeSha256 = sha256Canonical({ protocol: G003_PROTOCOL, protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, roots: inventory, totals });
  const core = {
    schemaVersion: G003_V4_FREEZE_SCHEMA_VERSION, state: 'FROZEN', reviewProtocol: G003_PROTOCOL,
    protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, roots: inventory, totals, treeSha256,
  };
  return Object.freeze({ ...core, outputSha256: sha256Canonical(core) });
}

export function attachG003V4FreezeSignature(unsignedManifest, conductorKey, schemaSha256) {
  if (!SHA.test(schemaSha256 ?? '')) fail('schema SHA-256 is invalid');
  assertG003V4FreezeShape(unsignedManifest, { allowUnsigned: true });
  if (canonicalStringify(unsignedManifest.roots.map(({ kind, path: rootPath }) => ({ kind, path: rootPath }))) !== canonicalStringify(G003_V4_FREEZE_ROOTS)) fail('production freeze roots are incomplete or reordered');
  return Object.freeze({ ...structuredClone(unsignedManifest), publicSignature: signG003PublicEvidence(unsignedManifest, conductorKey, { purpose: G003_V4_FREEZE_PURPOSE, schemaSha256 }) });
}

export function assertG003V4FreezeShape(value, { allowUnsigned = false } = {}) {
  const keys = ['schemaVersion', 'state', 'reviewProtocol', 'protocolAuthoritySha256', 'roots', 'totals', 'treeSha256', 'outputSha256'];
  exactKeys(value, allowUnsigned || !value.publicSignature ? keys : [...keys, 'publicSignature'], 'freeze manifest');
  if (value.schemaVersion !== G003_V4_FREEZE_SCHEMA_VERSION || value.state !== 'FROZEN'
      || value.reviewProtocol !== G003_PROTOCOL || value.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256) fail('protocol binding mismatch');
  if (!Array.isArray(value.roots) || value.roots.length === 0) fail('roots are missing');
  let totalFiles = 0; let totalBytes = 0;
  for (const root of value.roots) {
    exactKeys(root, ['kind', 'path', 'fileCount', 'byteCount', 'treeSha256', 'files'], 'root');
    assertCanonicalRelativePath(root.path, 'freeze root');
    if (!Array.isArray(root.files) || root.files.length !== root.fileCount || !Number.isSafeInteger(root.byteCount) || root.byteCount < 0) fail('root totals mismatch');
    const sorted = [...root.files].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
    if (canonicalStringify(sorted) !== canonicalStringify(root.files)) fail('file inventory is not canonical');
    const seen = new Set(); let bytes = 0;
    for (const file of root.files) {
      exactKeys(file, ['path', 'size', 'sha256'], 'file'); assertCanonicalRelativePath(file.path, 'inventory file');
      if (!file.path.startsWith(`${root.path}/`) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !SHA.test(file.sha256)) fail('file binding is invalid');
      seen.add(file.path); bytes += file.size;
    }
    if (bytes !== root.byteCount || root.treeSha256 !== sha256Canonical({ kind: root.kind, path: root.path, files: root.files })) fail('root digest mismatch');
    totalFiles += root.fileCount; totalBytes += root.byteCount;
  }
  exactKeys(value.totals, ['fileCount', 'byteCount'], 'totals');
  if (value.totals.fileCount !== totalFiles || value.totals.byteCount !== totalBytes) fail('manifest totals mismatch');
  if (value.treeSha256 !== sha256Canonical({ protocol: value.reviewProtocol, protocolAuthoritySha256: value.protocolAuthoritySha256, roots: value.roots, totals: value.totals })) fail('tree root mismatch');
  const unsigned = structuredClone(value); delete unsigned.publicSignature;
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (value.outputSha256 !== sha256Canonical(core)) fail('output hash mismatch');
  return unsigned;
}

export async function verifyG003V4FreezePublic({ repoRoot, manifest, manifestBytes, schemaSha256 } = {}) {
  if (!repoRoot || !SHA.test(schemaSha256 ?? '')) fail('repoRoot and schema SHA-256 are required');
  const value = manifest ?? JSON.parse(manifestBytes ?? await readContainedFile(repoRoot, G003_V4_FREEZE_PATH));
  const unsigned = assertG003V4FreezeShape(value);
  if (manifestBytes && !Buffer.from(manifestBytes).equals(Buffer.from(canonicalStringify(value)))) fail('freeze manifest bytes are not canonical JSON');
  if (canonicalStringify(value.roots.map(({ kind, path: rootPath }) => ({ kind, path: rootPath }))) !== canonicalStringify(G003_V4_FREEZE_ROOTS)) fail('production freeze roots are incomplete or reordered');
  if (!value.publicSignature) fail('public signature is required');
  verifyG003PublicEvidence(unsigned, value.publicSignature, { purpose: G003_V4_FREEZE_PURPOSE, schemaSha256 });
  const actual = await buildG003V4FreezeInventory({ repoRoot, roots: value.roots.map(({ kind, path: rootPath }) => ({ kind, path: rootPath })) });
  if (actual.outputSha256 !== unsigned.outputSha256 || canonicalStringify(actual) !== canonicalStringify(unsigned)) fail('public evidence bytes changed after freeze');
  return Object.freeze({ manifest: value, manifestBytes: Buffer.from(canonicalStringify(value)), outputSha256: value.outputSha256, treeSha256: value.treeSha256 });
}

export async function verifyPersistedG003V4Freeze(repoRoot) {
  const [manifestBytes, schemaBytes] = await Promise.all([
    readContainedFile(repoRoot, G003_V4_FREEZE_PATH), readContainedFile(repoRoot, G003_V4_FREEZE_SCHEMA_PATH),
  ]);
  return verifyG003V4FreezePublic({ repoRoot, manifestBytes, schemaSha256: sha256Canonical(JSON.parse(schemaBytes)) });
}

export async function publishSignedG003V4Freeze({ repoRoot, conductorKey } = {}) {
  return withG003TransitionLock(repoRoot, async () => {
    for (const relative of [
      'production/reports/biological-continuity-v3/continuity-authority/delegation-v1.json',
      'production/reports/biological-continuity-v3/continuity-authority/g002-v2-supersession-v1.json',
      'production/reports/biological-continuity-v3/g003-terminal-v5/active.json',
    ]) {
      try { await lstat(path.join(repoRoot, relative)); fail(`cannot freeze after transition publication: ${relative}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const schema = JSON.parse(await readContainedFile(repoRoot, G003_V4_FREEZE_SCHEMA_PATH));
    const signed = attachG003V4FreezeSignature(await buildG003V4FreezeInventory({ repoRoot }), conductorKey, sha256Canonical(schema));
    const status = await publishBytesNoReplace(repoRoot, path.join(repoRoot, G003_V4_FREEZE_PATH), Buffer.from(canonicalStringify(signed)));
    await verifyPersistedG003V4Freeze(repoRoot);
    return Object.freeze({ status, manifest: signed });
  });
}

export async function assertG003V4NotFrozen({ repoRoot, freezePath = G003_V4_FREEZE_PATH, activeV5Path = 'production/reports/biological-continuity-v3/g003-terminal-v5/active.json' } = {}) {
  for (const [candidate, label] of [[activeV5Path, 'terminal v5 active pointer'], [freezePath, 'freeze marker']]) {
    try { await readContainedFile(repoRoot, candidate, label); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    fail(`mutation denied because ${label} exists: ${candidate}`);
  }
  return true;
}
