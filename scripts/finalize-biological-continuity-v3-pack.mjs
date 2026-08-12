#!/usr/bin/env node

/** Build the isolated v3 pack. This script never edits the pack registry or deployed roots. */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { listContainedRegularFiles, readContainedFile, readJson, writeFileAtomicNoFollow } from './lib/continuity-assignment/evidence.mjs';
import { assertG003ConductorKeyPinned, signG003PublicEvidence } from './lib/g003-public-authority.mjs';
import { acceptedTipSet, assertExactPackInventory, assertPackComposition, discoverCurrentAcceptedArtifacts, verifyCoverageArtifacts, verifyG003FinalizingState, verifyG003TerminalState } from './verify-biological-continuity-v3-pack.mjs';
import { G003_FINALIZING_STATE, G003_TERMINAL_STATE, assertG003ActiveBaseline, withExclusiveG003Operation } from './conduct-g003-reviews.mjs';
import { G003_COUNTS, G003_PROTOCOL_AUTHORITY_SHA256, G003_SCHEMA_BINDINGS, G003_V4_EVIDENCE } from './lib/g003-v4-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = G003_V4_EVIDENCE;
const COVERAGE = `${EVIDENCE}/review-coverage.json`;
const MASTER_ROOT = 'assets/creatures/biological-continuity-v3/approved/generated';
const MOBILE_ROOT = 'assets/creatures/biological-continuity-v3/approved/mobile';
const ACTIVE_MANIFEST = 'production/manifests/creature-asset-packs/cute-redesign-v2.json';
const MANIFEST = 'production/manifests/creature-asset-packs/biological-continuity-v3.json';
const LOCK = 'production/manifests/creature-asset-packs/biological-continuity-v3.lock.json';

function fail(message) { throw new Error(`v3 pack finalizer: ${message}`); }
async function keyFromStdin() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const key = Buffer.concat(chunks); if (key.length < 32) fail('conductor key must contain at least 32 bytes'); assertG003ConductorKeyPinned(key); return key; }
async function writeAsset(destinationRelative, bytes) {
  try {
    const existing = await readContainedFile(ROOT, destinationRelative);
    if (!existing.equals(bytes)) fail(`refusing to replace immutable approved asset: ${destinationRelative}`);
    return;
  } catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  await writeFileAtomicNoFollow(path.join(ROOT, destinationRelative), bytes, { containmentRoot: ROOT, mode: 0o644, allowedBasenames: new Set([path.basename(destinationRelative)]) });
}
async function writeImmutableCanonical(relativePath, value) {
  const bytes = Buffer.from(canonicalStringify(value));
  try { const current = await readContainedFile(ROOT, relativePath); if (!current.equals(bytes)) fail(`refusing to replace immutable final artifact: ${relativePath}`); return; }
  catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  await writeFileAtomicNoFollow(path.join(ROOT, relativePath), bytes, { containmentRoot: ROOT, mode: 0o644, allowedBasenames: new Set([path.basename(relativePath)]) });
}

function signedState(core, conductorKey) {
  const withOutput = { ...core, outputSha256: sha256Canonical(core) };
  const profile = { purpose: `g003:${withOutput.schemaVersion}`, schemaSha256: sha256Canonical({ schemaVersion: withOutput.schemaVersion, fields: Object.keys(withOutput).sort() }) };
  return { ...withOutput, publicSignature: signG003PublicEvidence(withOutput, conductorKey, profile) };
}
async function exists(relativePath) {
  try { await readContainedFile(ROOT, relativePath); return true; }
  catch (error) { if (/ENOENT|does not exist/.test(error.message)) return false; throw error; }
}

async function beginFinalizationLocked(conductorKey) {
  const coverage = await readJson(ROOT, COVERAGE);
  if (await exists(G003_TERMINAL_STATE)) return { terminal: true, coverage };
  if (await exists(G003_FINALIZING_STATE)) return { terminal: false, coverage, ...(await verifyG003FinalizingState({ coverage })) };
  if (coverage.state !== 'PASS' || coverage.completionAllowed !== true || coverage.queueCandidates?.length !== G003_COUNTS.regenerate
      || coverage.edgeCandidates?.length !== G003_COUNTS.edges || coverage.coverage?.missingCoverage !== 0) fail('complete review coverage is required before entering FINALIZING');
  const discovered = await discoverCurrentAcceptedArtifacts();
  await verifyCoverageArtifacts(coverage, { discovered });
  const acceptedTips = acceptedTipSet(discovered); const startedAt = new Date().toISOString();
  const core = {
    schemaVersion: 'continuity-g003-finalizing-state-v3', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, state: 'FINALIZING',
    coverage: { path: COVERAGE, sha256: sha256Bytes(await readContainedFile(ROOT, COVERAGE)) },
    acceptedTipCount: G003_COUNTS.obligations, acceptedTipSetSha256: sha256Canonical(acceptedTips), acceptedTips,
    terminalStatePath: G003_TERMINAL_STATE, startedAt, terminalCompletedAt: startedAt,
    nonce: randomBytes(16).toString('hex'),
  };
  await writeImmutableCanonical(G003_FINALIZING_STATE, signedState(core, conductorKey));
  return { terminal: false, coverage, ...(await verifyG003FinalizingState({ discovered, coverage })) };
}

async function buildLocked(conductorKey) {
  await assertG003ActiveBaseline();
  const finalization = await beginFinalizationLocked(conductorKey);
  if (finalization.terminal) {
    const { verifyV3Pack } = await import('./verify-biological-continuity-v3-pack.mjs');
    return { ...(await verifyV3Pack()), status: 'FINALIZED_NOT_ACTIVATED_IDEMPOTENT' };
  }
  const coverage = finalization.coverage;
  if (coverage.state !== 'PASS' || coverage.completionAllowed !== true || coverage.queueCandidates.length !== G003_COUNTS.regenerate || coverage.edgeCandidates.length !== G003_COUNTS.edges
      || coverage.coverage?.missingCoverage !== 0) fail(`complete ${G003_COUNTS.regenerate}/${G003_COUNTS.regenerate} queue and ${G003_COUNTS.edges}/${G003_COUNTS.edges} edge review coverage is required`);
  const discovered = finalization.discovered;
  const verifiedCoverage = await verifyCoverageArtifacts(coverage, { discovered });
  const queueArtifacts = new Map(coverage.queueCandidates.map((item) => {
    const artifact = verifiedCoverage.byRequirement.get(item.candidateId);
    return [artifact?.candidateId.replace('g003-candidate:', ''), artifact];
  }));
  if (queueArtifacts.size !== G003_COUNTS.regenerate || [...queueArtifacts.values()].some((artifact) => !artifact)) fail(`verified signed coverage does not contain exact ${G003_COUNTS.regenerate} replacement artifacts`);
  const active = await readJson(ROOT, ACTIVE_MANIFEST);
  const activeById = new Map(active.entries.map((entry) => [entry.id, entry]));
  const entries = [];
  for (let number = 1; number <= 240; number += 1) {
    const id = `PG-${String(number).padStart(3, '0')}`;
    const approvedArtifact = queueArtifacts.get(id); const retained = activeById.get(id);
    if (!retained) fail(`active base pack is missing ${id}`);
    let masterBytes; let runtimeBytes; let sourceKind;
    if (approvedArtifact) {
      const master = approvedArtifact.childPixels.find((item) => item.surface === 'master');
      const runtime = approvedArtifact.childPixels.find((item) => item.surface === 'runtime');
      masterBytes = await readContainedFile(ROOT, master.path); runtimeBytes = await readContainedFile(ROOT, runtime.path);
      sourceKind = 'g003-approved-candidate';
    } else {
      masterBytes = await readContainedFile(ROOT, retained.path); runtimeBytes = await readContainedFile(ROOT, retained.mobilePath);
      sourceKind = 'retained-cute-redesign-v2';
    }
    const masterPath = `${MASTER_ROOT}/${id}.png`; const mobilePath = `${MOBILE_ROOT}/${id}.png`;
    await writeAsset(masterPath, masterBytes); await writeAsset(mobilePath, runtimeBytes);
    entries.push({
      id, path: masterPath, bytes: masterBytes.length, sha256: sha256Bytes(masterBytes),
      mobilePath, mobileBytes: runtimeBytes.length, mobileSha256: sha256Bytes(runtimeBytes), sourceKind,
      deploymentPaths: { catalog: `assets/creatures/generated/${id}.png`, mobile: `assets/creatures/mobile/${id}.png`, macos: `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${id}.png` },
      visualStatus: 'approved',
    });
  }
  assertPackComposition(entries);
  const expectedFiles = entries.map((entry) => `${entry.id}.png`).sort();
  const masterFiles = await listContainedRegularFiles(ROOT, MASTER_ROOT); const mobileFiles = await listContainedRegularFiles(ROOT, MOBILE_ROOT);
  assertExactPackInventory(expectedFiles, masterFiles, mobileFiles);
  const manifest = {
    schemaVersion: 1, packId: 'biological-continuity-v3', basePackId: 'cute-redesign-v2', status: 'qa-passed',
    artDirectionRevision: 'biological-continuity-v3', licenseRef: 'ASSET-LICENSE.md', masterRoot: MASTER_ROOT, mobileRoot: MOBILE_ROOT,
    activationAllowed: true, activationBlockers: [], entries, g003ReviewCoverageReport: COVERAGE, immutableLock: LOCK,
  };
  await writeImmutableCanonical(MANIFEST, manifest);
  const sourceTreeSha256 = sha256Canonical(entries.map((entry) => ({ id: entry.id, sha256: entry.sha256, mobileSha256: entry.mobileSha256 })));
  const lockCore = {
    schemaVersion: 'continuity-pack-lock-v3', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, packId: 'biological-continuity-v3',
    manifest: { path: MANIFEST, sha256: sha256Bytes(await readContainedFile(ROOT, MANIFEST)) },
    reviewCoverage: { path: COVERAGE, sha256: sha256Bytes(await readContainedFile(ROOT, COVERAGE)) },
    finalization: {
      statePath: G003_FINALIZING_STATE, stateSha256: finalization.sha256,
      acceptedTipSetSha256: finalization.value.acceptedTipSetSha256, acceptedTipCount: G003_COUNTS.obligations,
      terminalStatePath: G003_TERMINAL_STATE,
    },
    sourceTreeSha256, entryCount: 240,
  };
  const withOutput = { ...lockCore, outputSha256: sha256Canonical(lockCore) };
  const lock = { ...withOutput, publicSignature: signG003PublicEvidence(withOutput, conductorKey, { purpose: 'g003:pack-lock', schemaSha256: G003_SCHEMA_BINDINGS[2].normalizedSha256 }) };
  await writeImmutableCanonical(LOCK, lock);
  const lockBytes = await readContainedFile(ROOT, LOCK);
  const terminalCore = {
    schemaVersion: 'continuity-g003-terminal-state-v3', protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256, state: 'TERMINAL',
    finalizingState: { path: G003_FINALIZING_STATE, sha256: finalization.sha256 },
    packLock: { path: LOCK, sha256: sha256Bytes(lockBytes) },
    acceptedTipSetSha256: finalization.value.acceptedTipSetSha256, acceptedTipCount: G003_COUNTS.obligations,
    completedAt: finalization.value.terminalCompletedAt,
  };
  await writeImmutableCanonical(G003_TERMINAL_STATE, signedState(terminalCore, conductorKey));
  await verifyG003TerminalState(lock, lockBytes, { discovered, coverage });
  await assertG003ActiveBaseline();
  return { status: 'FINALIZED_NOT_ACTIVATED', manifest: MANIFEST, lock: LOCK, entries: 240 };
}

async function build(conductorKey) {
  assertG003ConductorKeyPinned(conductorKey);
  return withExclusiveG003Operation('finalize', () => buildLocked(conductorKey), { allowFinalizing: true });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    const { verifyV3Pack } = await import('./verify-biological-continuity-v3-pack.mjs');
    console.log(JSON.stringify(await verifyV3Pack())); return;
  }
  if (args.length !== 1 || args[0] !== '--conductor-key-stdin' || process.stdin.isTTY) fail('usage: --conductor-key-stdin | --check');
  console.log(JSON.stringify(await build(await keyFromStdin())));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

export { build };
