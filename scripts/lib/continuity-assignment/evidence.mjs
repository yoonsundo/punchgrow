import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalStringify } from './canonical-json.mjs';

export function fail(message) {
  throw new Error(`continuity input gate: ${message}`);
}

export function assertCanonicalRelativePath(relativePath, label = 'path') {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)
      || relativePath.includes('\\') || path.posix.normalize(relativePath) !== relativePath
      || relativePath === '..' || relativePath.startsWith('../')) fail(`${label} is not a canonical contained path`);
}

export async function readContainedFile(repoRoot, relativePath, label = relativePath) {
  assertCanonicalRelativePath(relativePath, label);
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label} escapes repository root`);
  let cursor = root;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`${label} contains a symlink`);
  }
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  const resolvedRelation = path.relative(resolvedRoot, resolvedTarget);
  if (!resolvedRelation || resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) fail(`${label} resolves outside repository root`);
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail(`${label} must be an independent regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readJson(repoRoot, relativePath) {
  const bytes = await readContainedFile(repoRoot, relativePath);
  try { return JSON.parse(bytes); } catch { fail(`${relativePath} is not valid JSON`); }
}

export async function hashContainedFile(repoRoot, relativePath) {
  assertCanonicalRelativePath(relativePath);
  const root = path.resolve(repoRoot); const target = path.resolve(root, relativePath); const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${relativePath} escapes repository root`);
  let cursor = root;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`${relativePath} contains a symlink`);
  }
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  const resolvedRelation = path.relative(resolvedRoot, resolvedTarget);
  if (!resolvedRelation || resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) fail(`${relativePath} resolves outside repository root`);
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail(`${relativePath} must be an independent regular file`);
    const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    return digest.digest('hex');
  } finally { await handle.close(); }
}

export async function assertHash(repoRoot, binding, label = binding?.path) {
  if (!binding || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? '')) fail(`${label} has an invalid SHA-256 binding`);
  const actual = await hashContainedFile(repoRoot, binding.path);
  if (actual !== binding.sha256) fail(`${label} hash is stale: expected ${binding.sha256}, received ${actual}`);
  return actual;
}

export async function listContainedRegularFiles(repoRoot, relativeRoot) {
  assertCanonicalRelativePath(relativeRoot, 'evidence directory');
  const root = path.resolve(repoRoot); const directory = path.resolve(root, relativeRoot); const relation = path.relative(root, directory);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('evidence directory escapes repository root');
  let cursor = root;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component); const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('evidence directory contains a symlink or non-directory ancestor');
  }
  const files = [];
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name); const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail(`evidence package contains symlink: ${relative}`);
      if (info.isDirectory()) await walk(absolute, relative);
      else if (info.isFile() && info.nlink === 1) files.push(relative);
      else fail(`evidence package contains non-regular or hard-linked entry: ${relative}`);
    }
  }
  await walk(directory, '');
  return files.sort();
}

export function assertExactIds(actualIds, expectedIds, label) {
  if (new Set(actualIds).size !== actualIds.length) fail(`${label} contains duplicate IDs`);
  const actual = new Set(actualIds);
  const expected = new Set(expectedIds);
  const missing = expectedIds.filter((id) => !actual.has(id));
  const extra = actualIds.filter((id) => !expected.has(id));
  if (missing.length || extra.length || actual.size !== expected.size) {
    fail(`${label} coverage mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
  }
}

export async function ensureSafeDirectory(containmentRoot, directory, label = 'output') {
  const root = path.resolve(containmentRoot); const target = path.resolve(directory); const relation = path.relative(root, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label} directory escapes approved containment`);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('output containment root is symlinked or non-directory');
  let cursor = root;
  for (const component of relation ? relation.split(path.sep) : []) {
    cursor = path.join(cursor, component);
    try { await mkdir(cursor, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('output ancestor is symlinked or non-directory');
  }
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  const resolvedRelation = path.relative(resolvedRoot, resolvedTarget);
  if (resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) fail(`${label} directory resolves outside approved containment`);
}

export async function writeFileAtomicNoFollow(destination, bytes, {
  containmentRoot = path.dirname(destination), mode = 0o600, allowedBasenames = null, beforeCommit = null,
} = {}) {
  const root = path.resolve(containmentRoot); const target = path.resolve(destination); const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('output path escapes approved containment');
  if (allowedBasenames && !allowedBasenames.has(path.basename(target))) fail(`output basename is not approved: ${path.basename(target)}`);
  await ensureSafeDirectory(root, path.dirname(target));
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) fail('output destination is symlinked, hard-linked, or non-regular');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const normalized = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
  try { await handle.writeFile(normalized); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  let published = false;
  try {
    if (beforeCommit) await beforeCommit();
    await ensureSafeDirectory(root, path.dirname(target), 'pre-commit output');
    await rename(temporary, target);
    published = true;
    await ensureSafeDirectory(root, path.dirname(target), 'published output');
    const verified = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const info = await verified.stat();
      if (!info.isFile() || info.nlink !== 1) fail('published output is not an independent regular file');
      if (!(await verified.readFile()).equals(normalized)) fail('published output bytes differ from staged bytes');
    } finally { await verified.close(); }
  } finally { if (!published) try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export async function writeCanonicalFile(destination, value, options = {}) {
  return writeFileAtomicNoFollow(destination, canonicalStringify(value), options);
}

export async function writeAtomicNoFollowForTest(options) {
  return writeFileAtomicNoFollow(options.destination, options.bytes, options);
}
