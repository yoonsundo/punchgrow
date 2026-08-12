import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalStringify } from './continuity-assignment/canonical-json.mjs';

export const G003_TRANSITION_LOCK_PATH = 'production/reports/biological-continuity-v3/.g003-transition.lock';
export const G003_TRANSITION_ACQUIRE_GUARD_PATH = `${G003_TRANSITION_LOCK_PATH}.acquire`;
const fail = (message) => { throw new Error(`G003 transition integrity: ${message}`); };

async function readStableNoFollow(file, label) {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1) fail(`${label} is symlinked, hard-linked, or non-regular`);
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail(`${label} changed while reading`);
    return bytes;
  } finally { await handle.close(); }
}

async function captureDirectoryIdentity(directory, label) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) fail(`${label} is symlinked or non-directory`);
  const resolved = await realpath(directory);
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    fail(`${label} changed while inspecting it`);
  }
  return Object.freeze({ directory, resolved, dev: after.dev, ino: after.ino });
}

async function ensureStableContainedParent(containmentRoot, destination) {
  const root = path.resolve(containmentRoot);
  const target = path.resolve(destination);
  const targetRelation = path.relative(root, target);
  if (!targetRelation || targetRelation.startsWith('..') || path.isAbsolute(targetRelation)) {
    fail('publication destination escapes its containment root');
  }
  const parent = path.dirname(target);
  const parentRelation = path.relative(root, parent);
  if (parentRelation.startsWith('..') || path.isAbsolute(parentRelation)) fail('publication parent escapes its containment root');
  const rootIdentity = await captureDirectoryIdentity(root, 'publication containment root');
  const identities = [rootIdentity];
  let cursor = root;
  const components = parentRelation ? parentRelation.split(path.sep) : [];
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    try { await mkdir(cursor, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const identity = await captureDirectoryIdentity(cursor, 'publication parent');
    const expectedResolved = path.join(rootIdentity.resolved, ...components.slice(0, index + 1));
    if (identity.resolved !== expectedResolved) fail('publication parent resolves outside its containment root');
    identities.push(identity);
  }
  return Object.freeze(identities);
}

async function revalidateDirectoryIdentities(identities) {
  for (const expected of identities) {
    let actual;
    try { actual = await captureDirectoryIdentity(expected.directory, 'publication parent'); }
    catch (error) { if (error.code === 'ENOENT') fail('publication parent changed before commit'); throw error; }
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.resolved !== expected.resolved) {
      fail('publication parent changed before commit');
    }
  }
}

async function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function acquireTransitionGuard(repoRoot) {
  const guardPath = path.join(repoRoot, G003_TRANSITION_ACQUIRE_GUARD_PATH);
  await mkdir(path.dirname(guardPath), { recursive: true });
  const token = randomBytes(16).toString('hex');
  let handle;
  try {
    handle = await open(guardPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(canonicalStringify({ pid: process.pid, token }));
    await handle.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readStableNoFollow(guardPath, 'transition acquisition guard')); }
    catch { fail('another transition lock acquisition is in progress or its guard owner is unreadable'); }
    if (await processAlive(owner.pid)) fail('another transition lock acquisition is in progress');
    fail('stale transition acquisition guard requires explicit operator recovery');
  } finally {
    if (handle) await handle.close();
  }
  return Object.freeze({ guardPath, token });
}

async function releaseTransitionGuard(guard) {
  const owner = JSON.parse(await readStableNoFollow(guard.guardPath, 'transition acquisition guard'));
  if (owner.token !== guard.token || owner.pid !== process.pid) fail('transition acquisition guard ownership changed');
  await unlink(guard.guardPath);
}

export async function acquireG003TransitionLock(repoRoot) {
  const guard = await acquireTransitionGuard(repoRoot);
  try {
    const lockPath = path.join(repoRoot, G003_TRANSITION_LOCK_PATH); await mkdir(path.dirname(lockPath), { recursive: true });
    const token = randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const temporary = `${lockPath}.${process.pid}.${token}.tmp`;
      try {
        const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(canonicalStringify({ pid: process.pid, token })); await handle.sync(); } finally { await handle.close(); }
        await link(temporary, lockPath); await unlink(temporary);
        return Object.freeze({ lockPath, token });
      } catch (error) {
        await unlink(temporary).catch((cleanupError) => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readStableNoFollow(lockPath, 'transition lock')); }
        catch (readError) { if (readError.code === 'ENOENT') continue; fail('transition lock exists with an unreadable owner'); }
        if (await processAlive(owner.pid)) fail('another transition writer holds the shared lock');
        const stale = `${lockPath}.stale-${token}`;
        try { await rename(lockPath, stale); await unlink(stale); } catch (reclaimError) { if (reclaimError.code === 'ENOENT') continue; throw reclaimError; }
      }
    }
    fail('could not acquire shared transition lock');
  } finally {
    await releaseTransitionGuard(guard);
  }
}

export async function releaseG003TransitionLock(lock) {
  let owner;
  try { owner = JSON.parse(await readStableNoFollow(lock.lockPath, 'transition lock')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (owner.token !== lock.token || owner.pid !== process.pid) fail('transition lock ownership changed');
  await unlink(lock.lockPath);
}

export async function withG003TransitionLock(repoRoot, operation) {
  const lock = await acquireG003TransitionLock(repoRoot);
  try { return await operation(); } finally { await releaseG003TransitionLock(lock); }
}

export async function publishBytesNoReplace(containmentRoot, destination, bytes) {
  const normalized = Buffer.from(bytes);
  const directoryIdentities = await ensureStableContainedParent(containmentRoot, destination);
  await revalidateDirectoryIdentities(directoryIdentities);
  try {
    const existing = await readStableNoFollow(destination, 'publication destination');
    if (!existing.equals(normalized)) fail('fixed-tip publication already exists with different bytes');
    await revalidateDirectoryIdentities(directoryIdentities);
    return 'ALREADY_PUBLISHED';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(normalized); await handle.sync(); } finally { await handle.close(); }
  try {
    await revalidateDirectoryIdentities(directoryIdentities);
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await revalidateDirectoryIdentities(directoryIdentities);
    const existing = await readStableNoFollow(destination, 'competing publication destination');
    if (!existing.equals(normalized)) fail('competing fixed-tip publication has different bytes');
    return 'ALREADY_PUBLISHED';
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  return 'PUBLISHED';
}
