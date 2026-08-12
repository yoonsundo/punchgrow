#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256 } from './lib/g003-v4-authority.mjs';
import { G003_V4_FREEZE_SCHEMA_VERSION } from './lib/g003-v4-freeze-inventory.mjs';
import { G003_V5_PROTOCOL } from './lib/g003-v5-authority.mjs';
import { G003_V5_TERMINAL_SCHEMA_VERSION, activateG003V5Terminal, createTestOnlyG003V5TerminalHarness, verifyG003V5ActiveTerminal } from './lib/g003-v5-terminal-activation.mjs';

process.env.NODE_ENV = 'test';

const bytes = (value) => Buffer.from(canonicalStringify(value));
const predecessor = { schemaVersion: 'predecessor-v1', outputSha256: '1'.repeat(64) };
const freeze = { schemaVersion: G003_V4_FREEZE_SCHEMA_VERSION, state: 'FROZEN', reviewProtocol: G003_PROTOCOL, protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, outputSha256: '2'.repeat(64) };
const delegation = { schemaVersion: 'delegation-v1', outputSha256: '3'.repeat(64) };
const successor = { schemaVersion: 'successor-v1', outputSha256: '4'.repeat(64), tips: ['tip'] };
const baseInput = { predecessor: bytes(predecessor), freeze: bytes(freeze), delegation: bytes(delegation), successor: bytes(successor) };
const bindings = {
  predecessorFileSha256: sha256Bytes(baseInput.predecessor), freezeOutputSha256: freeze.outputSha256, freezeFileSha256: sha256Bytes(baseInput.freeze),
  delegationOutputSha256: delegation.outputSha256, delegationFileSha256: sha256Bytes(baseInput.delegation), successorOutputSha256: successor.outputSha256,
  successorFileSha256: sha256Bytes(baseInput.successor),
};
const terminalCore = {
  schemaVersion: G003_V5_TERMINAL_SCHEMA_VERSION, state: 'TERMINAL', reviewProtocol: G003_V5_PROTOCOL,
  priorProtocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, protocolAuthoritySha256: '5'.repeat(64), ...bindings,
};
const terminalUnsigned = { ...terminalCore, outputSha256: sha256Canonical(terminalCore) };
const terminal = { ...terminalUnsigned, publicSignature: { testOnly: true } };
const input = { ...baseInput, v5: bytes(terminal) };
const verifiers = Object.freeze(Object.fromEntries(['predecessor', 'freeze', 'delegation', 'supersession', 'v5'].map((key) => [key, async ({ bytes: exact }) => Buffer.isBuffer(exact)])));
const testHarness = (repoRoot, verifierSet = verifiers, stateRoot = 'state', hooks = null) => createTestOnlyG003V5TerminalHarness({ repoRoot, stateRoot, verifiers: verifierSet, hooks });
const activateTest = async ({ repoRoot, stateRoot = 'state', verifiers: verifierSet = verifiers, testHooks = null, ...options }) => activateG003V5Terminal({
  repoRoot, stateRoot, verifiers: verifierSet, testHooks,
  testHarness: await testHarness(repoRoot, verifierSet, stateRoot, testHooks), ...options,
});
const verifyTest = async ({ repoRoot, stateRoot = 'state', verifiers: verifierSet = verifiers }) => verifyG003V5ActiveTerminal({
  repoRoot, stateRoot, verifiers: verifierSet, testHarness: await testHarness(repoRoot, verifierSet, stateRoot),
});

if (process.argv[2] === 'hard-exit-before-pointer') {
  const repoRoot = process.argv[3];
  const hardExitHooks = Object.freeze({ beforePointerCommit: async () => process.exit(29) });
  await activateTest({ repoRoot, input, testHooks: hardExitHooks });
  process.exit(30);
}

const unbrandedRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-unbranded-'));
await assert.rejects(activateG003V5Terminal({ repoRoot: unbrandedRoot, stateRoot: 'state', input, verifiers }), /concrete public authority loader/);

const productionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostileStateRoot = 'production/reports/biological-continuity-v3/g003-terminal-v5-test-bypass';
await assert.rejects(activateG003V5Terminal({ repoRoot: productionRoot, stateRoot: hostileStateRoot, input, verifiers,
  testOnlyAllowUnbrandedVerifiers: true }), /concrete public authority loader/);
await assert.rejects(lstat(path.join(productionRoot, hostileStateRoot)), { code: 'ENOENT' });

for (const boundary of ['predecessor', 'freeze', 'delegation', 'successor', 'stage', 'baseline', 'pointer']) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), `punchgrow-g003-v5-${boundary}-`));
  await assert.rejects(activateTest({ repoRoot, input, crashAt: boundary }), new RegExp(`injected crash at ${boundary}`));
  assert.equal((await verifyG003V5ActiveTerminal({ repoRoot, stateRoot: 'state', verifiers })).state, 'UNFROZEN_V4');
  if (boundary === 'pointer') assert.equal((await activateTest({ repoRoot, input })).status, 'ACTIVATED', 'pointer crash must be resumable from exact dormant baseline');
}

const hardExitRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-hard-exit-'));
const hardExitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hard-exit-before-pointer', hardExitRoot], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`hard-exit child terminated by ${signal}: ${stderr}`));
    else resolve(code);
  });
});
assert.equal(hardExitCode, 29, 'hard-exit child must terminate after publishing the dormant baseline and before the pointer');
assert.equal((await activateTest({ repoRoot: hardExitRoot, input })).status, 'ACTIVATED', 'activation must resume after a real process death');
assert.equal((await verifyTest({ repoRoot: hardExitRoot })).state, 'TERMINAL_V5');

const concurrentRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-concurrent-'));
const concurrentVerifiers = { ...verifiers, predecessor: async ({ bytes: exact }) => { await new Promise((resolve) => setTimeout(resolve, 20)); return Buffer.isBuffer(exact); } };
const concurrent = await Promise.allSettled([
  activateTest({ repoRoot: concurrentRoot, input, verifiers: concurrentVerifiers }),
  activateTest({ repoRoot: concurrentRoot, input, verifiers: concurrentVerifiers }),
]);
assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
assert.match(concurrent.find((result) => result.status === 'rejected').reason.message, /shared lock|exclusive lock|lock acquisition/);
assert.equal((await verifyTest({ repoRoot: concurrentRoot })).state, 'TERMINAL_V5');
const forgedVerifiers = { ...verifiers, v5: async () => false };
await assert.rejects(verifyTest({ repoRoot: concurrentRoot, verifiers: forgedVerifiers }), /v5 public verification failed/, 'unsigned or forged terminal bytes must not pass public verification');

const altered = { ...input, freeze: bytes({ ...freeze, outputSha256: '9'.repeat(64) }) };
const alteredRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-altered-'));
await assert.rejects(activateTest({ repoRoot: alteredRoot, input: altered }), /freezeOutputSha256 binding changed/);
const partial = structuredClone(terminal); partial.state = 'FINALIZING'; partial.outputSha256 = sha256Canonical(Object.fromEntries(Object.entries(partial).filter(([key]) => !['outputSha256', 'publicSignature'].includes(key))));
const partialRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-partial-'));
await assert.rejects(activateTest({ repoRoot: partialRoot, input: { ...baseInput, v5: bytes(partial) } }), /partial or a downgrade/);
const forked = { ...successor, tips: ['a', 'b'] }; const forkedRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-fork-'));
await assert.rejects(activateTest({ repoRoot: forkedRoot, input: { ...input, successor: bytes(forked) } }), /multiple tips/);

const swappedAncestorRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-swapped-ancestor-'));
const displacedState = path.join(swappedAncestorRoot, 'state-displaced');
const swapAncestorHooks = Object.freeze({
  beforePointerCommit: async ({ root }) => {
    await rename(root, displacedState);
    await mkdir(root);
  },
});
await assert.rejects(
  activateTest({ repoRoot: swappedAncestorRoot, input, testHooks: swapAncestorHooks }),
  /ancestor identity changed before commit/,
  'swapping a captured ancestor immediately before pointer publication must fail closed',
);
await assert.rejects(lstat(path.join(swappedAncestorRoot, 'state', 'active.json')), { code: 'ENOENT' });
await assert.rejects(lstat(path.join(displacedState, 'active.json')), { code: 'ENOENT' });
assert.equal((await lstat(path.join(displacedState, 'baselines'))).isDirectory(), true, 'verified dormant baseline bytes must survive the rejected pointer commit');

const competingPointerRoot = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v5-competing-pointer-'));
const competingPointerBytes = bytes({ schemaVersion: 'hostile-active-v1', terminalOutputSha256: 'f'.repeat(64) });
const competingPointerHooks = Object.freeze({
  beforePointerCommit: async ({ activePath }) => { await writeFile(activePath, competingPointerBytes, { flag: 'wx', mode: 0o444 }); },
});
await assert.rejects(
  activateTest({ repoRoot: competingPointerRoot, input, testHooks: competingPointerHooks }),
  /fixed-tip publication already exists with different bytes/,
  'a different active pointer created after the initial existence check must never be replaced',
);
assert.deepEqual(await readFile(path.join(competingPointerRoot, 'state', 'active.json')), competingPointerBytes, 'competing active pointer bytes must remain untouched');

console.log(JSON.stringify({ status: 'PASS', crashBoundaries: 7, hardExitRecoveries: 1, concurrentWriters: 2, filesystemRaceRegressions: 2, finalState: 'TERMINAL_V5' }));
