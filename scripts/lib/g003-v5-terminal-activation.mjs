import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath } from './continuity-assignment/evidence.mjs';
import { G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256 } from './g003-v4-authority.mjs';
import { G003_V4_FREEZE_SCHEMA_VERSION } from './g003-v4-freeze-inventory.mjs';
import { G003_V5_PROTOCOL, assertConcreteG003V5TerminalVerifierHooks } from './g003-v5-authority.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from './g003-transition-integrity.mjs';

export const G003_V5_TERMINAL_SCHEMA_VERSION = 'continuity-g003-v5-terminal-candidate-v1';
export const G003_V5_TERMINAL_BASELINE_VERSION = 'continuity-g003-v5-terminal-baseline-v1';
export const G003_V5_ACTIVE_POINTER_VERSION = 'continuity-g003-v5-active-pointer-v1';
const DEFAULT_G003_V5_STATE_ROOT = 'production/reports/biological-continuity-v3/g003-terminal-v5';
export const G003_V5_ACTIVATION_FILENAMES = Object.freeze({
  predecessor: '01-predecessor.json', freeze: '02-v4-freeze.json', delegation: '03-delegation.json',
  successor: '04-successor.json', v5: '05-v5-terminal.json', baseline: 'terminal-baseline.json',
});

const SHA = /^[a-f0-9]{64}$/;
const TEST_HARNESSES = new WeakSet();
const fail = (message) => { throw new Error(`G003-v5 terminal activation: ${message}`); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(`${label} fields mismatch`);
};
const assertSha = (value, label) => { if (!SHA.test(value ?? '')) fail(`${label} is not a SHA-256`); };

export function assertG003V5TerminalCandidate(value, bindings) {
  exactKeys(value, [
    'schemaVersion', 'state', 'reviewProtocol', 'priorProtocolAuthoritySha256', 'protocolAuthoritySha256',
    'predecessorFileSha256', 'freezeOutputSha256', 'freezeFileSha256', 'delegationOutputSha256',
    'delegationFileSha256', 'successorOutputSha256', 'successorFileSha256', 'outputSha256', 'publicSignature',
  ], 'terminal candidate');
  if (value.schemaVersion !== G003_V5_TERMINAL_SCHEMA_VERSION || value.state !== 'TERMINAL'
      || value.reviewProtocol !== G003_V5_PROTOCOL || value.priorProtocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256) fail('terminal candidate protocol/state is partial or a downgrade');
  for (const key of ['protocolAuthoritySha256', 'predecessorFileSha256', 'freezeOutputSha256', 'freezeFileSha256', 'delegationOutputSha256', 'delegationFileSha256', 'successorOutputSha256', 'successorFileSha256', 'outputSha256']) assertSha(value[key], key);
  for (const [key, expected] of Object.entries(bindings)) if (value[key] !== expected) fail(`terminal candidate ${key} binding changed`);
  const unsigned = structuredClone(value); delete unsigned.publicSignature;
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (value.outputSha256 !== sha256Canonical(core)) fail('terminal candidate output hash mismatch');
  return unsigned;
}

function copyInputBuffers(input) {
  const required = ['predecessor', 'freeze', 'delegation', 'successor', 'v5'];
  exactKeys(input, required, 'activation input');
  return Object.fromEntries(required.map((key) => {
    if (!Buffer.isBuffer(input[key]) && !(input[key] instanceof Uint8Array)) fail(`${key} input must be exact bytes`);
    const bytes = Buffer.from(input[key]);
    if (bytes.length === 0) fail(`${key} input is empty`);
    return [key, bytes];
  }));
}

function parseInputsOnce(buffers) {
  return Object.fromEntries(Object.entries(buffers).map(([key, bytes]) => {
    try { return [key, JSON.parse(bytes)]; } catch { fail(`${key} input is not JSON`); }
  }));
}

async function invokeVerifier(verifiers, key, context) {
  if (typeof verifiers?.[key] !== 'function') fail(`${key} public verifier is required`);
  const isolated = { ...context, value: structuredClone(context.value), bytes: Buffer.from(context.bytes) };
  if (await verifiers[key](isolated) !== true) fail(`${key} public verification failed`);
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o444);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function readIndependent(file) {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1) fail(`published tree contains unsafe file: ${file}`);
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail(`published file changed while reading: ${file}`);
    return bytes;
  } finally { await handle.close(); }
}

async function readFlatTreeOnce(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const files = []; const buffers = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`activation tree contains non-regular entry: ${entry.name}`);
    const bytes = await readIndependent(path.join(directory, entry.name));
    buffers.set(entry.name, bytes);
    files.push({ path: entry.name, size: bytes.length, sha256: sha256Bytes(bytes) });
  }
  return Object.freeze({ buffers, files: Object.freeze(files), fileCount: files.length, byteCount: files.reduce((sum, file) => sum + file.size, 0), treeSha256: sha256Canonical(files) });
}
const rehashFlatTree = readFlatTreeOnce;

async function readJsonIfExists(file) {
  try { return JSON.parse(await readIndependent(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function captureDirectoryIdentity(directory) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) fail('state root has a symlinked or non-directory ancestor');
  const resolved = await realpath(directory);
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    fail('state root ancestor identity changed while inspecting it');
  }
  return Object.freeze({ directory, resolved, dev: after.dev, ino: after.ino });
}

async function ensureContainedDirectory(repository, target) {
  const relation = path.relative(repository, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('state root escapes repository');
  let cursor = repository;
  const identities = [await captureDirectoryIdentity(cursor)];
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    try { await mkdir(cursor, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    identities.push(await captureDirectoryIdentity(cursor));
  }
  return Object.freeze(identities);
}

async function revalidateDirectoryIdentities(identities) {
  for (const expected of identities) {
    let actual;
    try { actual = await captureDirectoryIdentity(expected.directory); }
    catch (error) { if (error.code === 'ENOENT') fail('state root ancestor identity changed before commit'); throw error; }
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.resolved !== expected.resolved) {
      fail('state root ancestor identity changed before commit');
    }
  }
}

async function listBaselineTips(baselines) {
  const entries = await readdir(baselines, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) fail('baseline store contains a special or non-directory entry');
  return entries.map((entry) => entry.name).sort();
}

function crash(crashAt, boundary) { if (crashAt === boundary) { const error = new Error(`injected crash at ${boundary}`); error.code = 'G003_CRASH_INJECTED'; throw error; } }

export async function createTestOnlyG003V5TerminalHarness({ repoRoot, stateRoot = 'state', verifiers, hooks = null } = {}) {
  if (process.env.NODE_ENV !== 'test') fail('test-only terminal harness requires NODE_ENV=test');
  if (!repoRoot) fail('test-only terminal harness requires repoRoot');
  assertCanonicalRelativePath(stateRoot, 'test-only terminal state root');
  const [repository, temporaryRoot] = await Promise.all([realpath(repoRoot), realpath(os.tmpdir())]);
  const relation = path.relative(temporaryRoot, repository);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('test-only terminal harness repoRoot must be a dedicated directory below the system temporary root');
  if (!verifiers || ['predecessor', 'freeze', 'delegation', 'supersession', 'v5'].some((key) => typeof verifiers[key] !== 'function')) {
    fail('test-only terminal harness requires all verifier callbacks');
  }
  if (hooks !== null && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || Object.keys(hooks).some((key) => key !== 'beforePointerCommit')
      || (hooks.beforePointerCommit !== undefined && typeof hooks.beforePointerCommit !== 'function'))) {
    fail('test-only terminal harness hooks are invalid');
  }
  const harness = Object.freeze({ repoRoot: repository, stateRoot, verifiers, hooks });
  TEST_HARNESSES.add(harness);
  return harness;
}

async function assertVerifierAccess({ repoRoot, stateRoot, verifiers, testHarness, testHooks = null }) {
  if (!testHarness) {
    if (testHooks !== null) fail('test-only terminal hooks require a branded harness');
    assertConcreteG003V5TerminalVerifierHooks(verifiers);
    return;
  }
  if (!TEST_HARNESSES.has(testHarness)) fail('unbranded test-only terminal harness');
  const repository = await realpath(repoRoot);
  if (repository !== testHarness.repoRoot || stateRoot !== testHarness.stateRoot || verifiers !== testHarness.verifiers
      || testHooks !== testHarness.hooks) {
    fail('test-only terminal harness binding changed');
  }
}

async function activateG003V5TerminalUnlocked({ repoRoot, stateRoot = DEFAULT_G003_V5_STATE_ROOT, input, verifiers, crashAt = null, testHarness = null, testHooks = null } = {}) {
  if (!repoRoot) fail('repoRoot is required');
  assertCanonicalRelativePath(stateRoot, 'terminal activation state root');
  await assertVerifierAccess({ repoRoot, stateRoot, verifiers, testHarness, testHooks });
  const root = path.resolve(repoRoot, stateRoot); const repository = path.resolve(repoRoot);
  const rootIdentities = await ensureContainedDirectory(repository, root);
  const token = randomBytes(16).toString('hex'); let stage = null;
  try {
    const buffers = copyInputBuffers(input); const values = parseInputsOnce(buffers);
    const hashes = Object.fromEntries(Object.entries(buffers).map(([key, bytes]) => [key, sha256Bytes(bytes)]));
    await invokeVerifier(verifiers, 'predecessor', { value: values.predecessor, bytes: buffers.predecessor, sha256: hashes.predecessor });
    crash(crashAt, 'predecessor');
    if (values.freeze.schemaVersion !== G003_V4_FREEZE_SCHEMA_VERSION || values.freeze.reviewProtocol !== G003_PROTOCOL
        || values.freeze.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || values.freeze.state !== 'FROZEN') fail('freeze is partial, altered, or from another protocol');
    await invokeVerifier(verifiers, 'freeze', { value: values.freeze, bytes: buffers.freeze, sha256: hashes.freeze });
    crash(crashAt, 'freeze');
    await invokeVerifier(verifiers, 'delegation', { value: values.delegation, bytes: buffers.delegation, sha256: hashes.delegation });
    crash(crashAt, 'delegation');
    if (Array.isArray(values.successor) || Array.isArray(values.successor?.tips) && values.successor.tips.length !== 1) fail('successor has multiple tips');
    await invokeVerifier(verifiers, 'supersession', { value: values.successor, bytes: buffers.successor, sha256: hashes.successor });
    crash(crashAt, 'successor');
    const bindings = {
      predecessorFileSha256: hashes.predecessor, freezeOutputSha256: values.freeze.outputSha256, freezeFileSha256: hashes.freeze,
      delegationOutputSha256: values.delegation.outputSha256, delegationFileSha256: hashes.delegation,
      successorOutputSha256: values.successor.outputSha256, successorFileSha256: hashes.successor,
    };
    assertG003V5TerminalCandidate(values.v5, bindings);
    await invokeVerifier(verifiers, 'v5', { value: values.v5, bytes: buffers.v5, sha256: hashes.v5, bindings });
    const activePath = path.join(root, 'active.json'); const existing = await readJsonIfExists(activePath);
    if (existing) {
      const active = await verifyG003V5ActiveTerminal({ repoRoot, stateRoot, verifiers, testHarness });
      if (active.pointer.terminalOutputSha256 === values.v5.outputSha256 && active.pointer.terminalFileSha256 === hashes.v5) return Object.freeze({ status: 'ALREADY_ACTIVE', pointer: active.pointer });
      fail('terminal v5 is already active; multiple tips and downgrade are forbidden');
    }
    const baselines = path.join(root, 'baselines'); const staging = path.join(root, '.staging');
    await mkdir(baselines, { recursive: true }); await mkdir(staging, { recursive: true });
    const commitDirectoryIdentities = Object.freeze([
      ...rootIdentities,
      await captureDirectoryIdentity(baselines),
      await captureDirectoryIdentity(staging),
    ]);
    stage = path.join(staging, `${values.v5.outputSha256}-${token}`); await mkdir(stage, { recursive: false, mode: 0o700 });
    for (const key of ['predecessor', 'freeze', 'delegation', 'successor', 'v5']) await writeExclusive(path.join(stage, G003_V5_ACTIVATION_FILENAMES[key]), buffers[key]);
    crash(crashAt, 'stage');
    const payloadTree = await rehashFlatTree(stage);
    const expectedPayload = Object.entries(G003_V5_ACTIVATION_FILENAMES).filter(([key]) => key !== 'baseline').map(([key, filename]) => ({ path: filename, size: buffers[key].length, sha256: hashes[key] }));
    if (canonicalStringify(payloadTree.files) !== canonicalStringify(expectedPayload)) fail('staged activation bytes differ from verified buffers');
    const baseline = {
      schemaVersion: G003_V5_TERMINAL_BASELINE_VERSION, state: 'TERMINAL', reviewProtocol: G003_V5_PROTOCOL,
      priorReviewProtocol: G003_PROTOCOL, priorProtocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
      terminalProtocolAuthoritySha256: values.v5.protocolAuthoritySha256, terminalOutputSha256: values.v5.outputSha256,
      terminalFileSha256: hashes.v5, freezeOutputSha256: values.freeze.outputSha256, freezeFileSha256: hashes.freeze,
      payloadFileCount: payloadTree.fileCount, payloadByteCount: payloadTree.byteCount, payloadTreeSha256: payloadTree.treeSha256,
    };
    const baselineBytes = Buffer.from(canonicalStringify(baseline)); await writeExclusive(path.join(stage, G003_V5_ACTIVATION_FILENAMES.baseline), baselineBytes);
    const fullTree = await rehashFlatTree(stage);
    if (fullTree.fileCount !== 6) fail('terminal baseline tree is partial');
    crash(crashAt, 'baseline');
    const baselineId = `${values.v5.outputSha256}-${fullTree.treeSha256}`; const published = path.join(baselines, baselineId);
    const dormantTips = await listBaselineTips(baselines);
    if (dormantTips.some((tip) => tip !== baselineId)) fail('a different dormant terminal tip exists');
    if (dormantTips.includes(baselineId)) {
      const dormantTree = await rehashFlatTree(published);
      if (dormantTree.treeSha256 !== fullTree.treeSha256 || canonicalStringify(dormantTree.files) !== canonicalStringify(fullTree.files)) fail('dormant terminal tip differs from verified bytes');
      await rm(stage, { recursive: true }); stage = null;
    } else {
      await revalidateDirectoryIdentities(commitDirectoryIdentities);
      await fsyncDirectory(stage); await rename(stage, published); stage = null; await fsyncDirectory(baselines);
    }
    const publishedTree = await rehashFlatTree(published);
    if (publishedTree.treeSha256 !== fullTree.treeSha256 || canonicalStringify(publishedTree.files) !== canonicalStringify(fullTree.files)) fail('published terminal tree changed');
    const pointer = {
      schemaVersion: G003_V5_ACTIVE_POINTER_VERSION, state: 'TERMINAL', reviewProtocol: G003_V5_PROTOCOL,
      baselineId, baselinePath: `${stateRoot}/baselines/${baselineId}`, baselineTreeSha256: fullTree.treeSha256,
      terminalOutputSha256: values.v5.outputSha256, terminalFileSha256: hashes.v5,
    };
    crash(crashAt, 'pointer');
    if (testHooks?.beforePointerCommit) await testHooks.beforePointerCommit(Object.freeze({ root, activePath, baselineId }));
    await revalidateDirectoryIdentities(commitDirectoryIdentities);
    await publishBytesNoReplace(repository, activePath, Buffer.from(canonicalStringify(pointer)));
    await fsyncDirectory(root);
    return Object.freeze({ status: 'ACTIVATED', pointer: Object.freeze(pointer), baseline: Object.freeze(baseline), fullTree });
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}

export async function activateG003V5Terminal(options = {}) {
  if (!options.repoRoot) fail('repoRoot is required');
  const stateRoot = options.stateRoot ?? DEFAULT_G003_V5_STATE_ROOT;
  await assertVerifierAccess({ ...options, stateRoot });
  return withG003TransitionLock(options.repoRoot, () => activateG003V5TerminalUnlocked(options));
}

export async function verifyG003V5ActiveTerminal({ repoRoot, stateRoot = DEFAULT_G003_V5_STATE_ROOT, verifiers, testHarness = null } = {}) {
  assertCanonicalRelativePath(stateRoot, 'terminal activation state root');
  const root = path.resolve(repoRoot, stateRoot); const pointer = await readJsonIfExists(path.join(root, 'active.json'));
  if (!pointer) return Object.freeze({ state: 'UNFROZEN_V4' });
  await assertVerifierAccess({ repoRoot, stateRoot, verifiers, testHarness });
  exactKeys(pointer, ['schemaVersion', 'state', 'reviewProtocol', 'baselineId', 'baselinePath', 'baselineTreeSha256', 'terminalOutputSha256', 'terminalFileSha256'], 'active pointer');
  if (pointer.schemaVersion !== G003_V5_ACTIVE_POINTER_VERSION || pointer.state !== 'TERMINAL' || pointer.reviewProtocol !== G003_V5_PROTOCOL) fail('active pointer is partial or downgraded');
  for (const key of ['baselineTreeSha256', 'terminalOutputSha256', 'terminalFileSha256']) assertSha(pointer[key], key);
  const expectedBaselineId = `${pointer.terminalOutputSha256}-${pointer.baselineTreeSha256}`;
  if (pointer.baselineId !== expectedBaselineId || pointer.baselinePath !== `${stateRoot}/baselines/${expectedBaselineId}`) fail('active pointer baseline binding is invalid');
  const baselines = path.join(root, 'baselines');
  const tips = await listBaselineTips(baselines);
  if (tips.length !== 1 || tips[0] !== pointer.baselineId) fail('multiple or mismatched terminal tips');
  const tree = await readFlatTreeOnce(path.join(baselines, pointer.baselineId));
  if (tree.treeSha256 !== pointer.baselineTreeSha256 || tree.fileCount !== 6) fail('active terminal baseline is partial or altered');
  const expectedNames = Object.values(G003_V5_ACTIVATION_FILENAMES).sort();
  if (canonicalStringify([...tree.buffers.keys()]) !== canonicalStringify(expectedNames)) fail('active terminal baseline file set is partial or extended');
  const sourceBuffers = Object.fromEntries(Object.entries(G003_V5_ACTIVATION_FILENAMES).filter(([key]) => key !== 'baseline').map(([key, filename]) => [key, tree.buffers.get(filename)]));
  const values = parseInputsOnce(sourceBuffers); const hashes = Object.fromEntries(Object.entries(sourceBuffers).map(([key, bytes]) => [key, sha256Bytes(bytes)]));
  if (values.freeze.schemaVersion !== G003_V4_FREEZE_SCHEMA_VERSION || values.freeze.reviewProtocol !== G003_PROTOCOL
      || values.freeze.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || values.freeze.state !== 'FROZEN') fail('active freeze is partial, altered, or from another protocol');
  if (Array.isArray(values.successor) || Array.isArray(values.successor?.tips) && values.successor.tips.length !== 1) fail('active successor has multiple tips');
  const bindings = {
    predecessorFileSha256: hashes.predecessor, freezeOutputSha256: values.freeze.outputSha256, freezeFileSha256: hashes.freeze,
    delegationOutputSha256: values.delegation.outputSha256, delegationFileSha256: hashes.delegation,
    successorOutputSha256: values.successor.outputSha256, successorFileSha256: hashes.successor,
  };
  assertG003V5TerminalCandidate(values.v5, bindings);
  for (const key of ['predecessor', 'freeze', 'delegation']) await invokeVerifier(verifiers, key, { value: values[key], bytes: sourceBuffers[key], sha256: hashes[key], bindings });
  await invokeVerifier(verifiers, 'supersession', { value: values.successor, bytes: sourceBuffers.successor, sha256: hashes.successor, bindings });
  await invokeVerifier(verifiers, 'v5', { value: values.v5, bytes: sourceBuffers.v5, sha256: hashes.v5, bindings });
  if (hashes.v5 !== pointer.terminalFileSha256 || values.v5.outputSha256 !== pointer.terminalOutputSha256) fail('active terminal v5 binding changed');
  const baseline = JSON.parse(tree.buffers.get(G003_V5_ACTIVATION_FILENAMES.baseline));
  exactKeys(baseline, ['schemaVersion', 'state', 'reviewProtocol', 'priorReviewProtocol', 'priorProtocolAuthoritySha256', 'terminalProtocolAuthoritySha256', 'terminalOutputSha256', 'terminalFileSha256', 'freezeOutputSha256', 'freezeFileSha256', 'payloadFileCount', 'payloadByteCount', 'payloadTreeSha256'], 'terminal baseline');
  if (baseline.schemaVersion !== G003_V5_TERMINAL_BASELINE_VERSION || baseline.state !== 'TERMINAL'
      || baseline.reviewProtocol !== G003_V5_PROTOCOL || baseline.priorReviewProtocol !== G003_PROTOCOL
      || baseline.priorProtocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256
      || baseline.terminalOutputSha256 !== pointer.terminalOutputSha256 || baseline.terminalFileSha256 !== pointer.terminalFileSha256
      || baseline.terminalProtocolAuthoritySha256 !== values.v5.protocolAuthoritySha256 || baseline.payloadFileCount !== 5) fail('terminal baseline binding is partial or altered');
  const payloadFiles = tree.files.filter((file) => file.path !== G003_V5_ACTIVATION_FILENAMES.baseline);
  if (baseline.payloadTreeSha256 !== sha256Canonical(payloadFiles) || baseline.payloadByteCount !== payloadFiles.reduce((sum, file) => sum + file.size, 0)) fail('terminal baseline payload tree binding changed');
  return Object.freeze({ state: 'TERMINAL_V5', pointer, tree });
}
