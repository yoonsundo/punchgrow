#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { link, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireG003TransitionLock, publishBytesNoReplace, releaseG003TransitionLock, withG003TransitionLock } from './lib/g003-transition-integrity.mjs';

const SELF = fileURLToPath(import.meta.url);
const mode = process.argv[2]; const childRoot = process.argv[3];
if (mode === 'hold') {
  const lock = await acquireG003TransitionLock(childRoot); process.stdout.write('LOCKED\n');
  setTimeout(async () => { await releaseG003TransitionLock(lock); process.exit(0); }, 400);
} else if (mode === 'try') {
  try { await withG003TransitionLock(childRoot, async () => true); process.exit(0); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
} else if (mode === 'crash') {
  await acquireG003TransitionLock(childRoot); process.exit(23);
} else if (mode === 'recover-hold') {
  try {
    const lock = await acquireG003TransitionLock(childRoot); process.stdout.write('LOCKED\n');
    setTimeout(async () => { await releaseG003TransitionLock(lock); process.exit(0); }, 250);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
} else if (mode === 'publish') {
  try {
    await withG003TransitionLock(childRoot, () => publishBytesNoReplace(childRoot, path.join(childRoot, 'tip.json'), Buffer.from(process.argv[4])));
    process.exit(0);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(3); }
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-transition-process-'));
  const run = (args) => new Promise((resolve) => { const child = spawn(process.execPath, [SELF, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; child.stdout.on('data', (data) => { out += data; }); child.stderr.on('data', (data) => { err += data; }); child.on('exit', (code) => resolve({ code, out, err })); });
  const holder = spawn(process.execPath, [SELF, 'hold', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { holder.stdout.on('data', (data) => data.toString().includes('LOCKED') && resolve()); holder.on('exit', () => reject(new Error('holder exited before lock evidence'))); });
  const competitor = await run(['try', root]); assert.equal(competitor.code, 2); assert.match(competitor.err, /shared lock/);
  await new Promise((resolve) => holder.on('exit', resolve));
  assert.equal((await run(['crash', root])).code, 23);
  const reclaimers = await Promise.all([run(['recover-hold', root]), run(['recover-hold', root])]);
  assert.equal(reclaimers.filter((result) => result.code === 0 && result.out.includes('LOCKED')).length, 1,
    'exactly one concurrent stale-lock reclaimer may enter the protected operation');
  assert.equal(reclaimers.filter((result) => result.code === 2).length, 1);
  assert.match(reclaimers.find((result) => result.code === 2).err, /shared lock|lock acquisition/);
  const recovered = await acquireG003TransitionLock(root); await releaseG003TransitionLock(recovered);
  const [left, right] = await Promise.all([run(['publish', root, 'A']), run(['publish', root, 'B'])]);
  assert.equal([left, right].filter((result) => result.code === 0).length, 1); assert.match([left, right].find((result) => result.code !== 0).err, /shared lock|lock acquisition|different bytes/);
  const winner = await readFile(path.join(root, 'tip.json'));
  assert.equal(await publishBytesNoReplace(root, path.join(root, 'tip.json'), winner), 'ALREADY_PUBLISHED');
  await assert.rejects(publishBytesNoReplace(root, path.join(root, 'tip.json'), Buffer.from(winner.equals(Buffer.from('A')) ? 'B' : 'A')), /different bytes/);
  await symlink(path.join(root, 'tip.json'), path.join(root, 'symlink-tip.json'));
  await assert.rejects(publishBytesNoReplace(root, path.join(root, 'symlink-tip.json'), winner), /ELOOP|symlink/i);
  await writeFile(path.join(root, 'hard-source.json'), winner); await link(path.join(root, 'hard-source.json'), path.join(root, 'hard-tip.json'));
  await assert.rejects(publishBytesNoReplace(root, path.join(root, 'hard-tip.json'), winner), /hard-linked/);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-transition-outside-'));
  await symlink(outside, path.join(root, 'linked-parent'));
  await assert.rejects(publishBytesNoReplace(root, path.join(root, 'linked-parent', 'escaped-tip.json'), winner), /publication parent.*symlink/i);
  await assert.rejects(readFile(path.join(outside, 'escaped-tip.json')), { code: 'ENOENT' });
  console.log(JSON.stringify({ status: 'PASS', actualProcesses: 5, crashRecovered: true, competingPublications: 2, parentSymlinkEscapes: 0 }));
}
