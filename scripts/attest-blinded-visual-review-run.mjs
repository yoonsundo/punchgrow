#!/usr/bin/env node

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(message) { throw new Error(message); }
function resolveRepoPath(value) { return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value); }
function assertOpaque(value, label) { if (typeof value !== 'string' || !OPAQUE_ID.test(value)) fail(`${label}: invalid opaque identifier`); }

function parseArgs(argv) {
  const args = { role: 'primary', attempt: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--package-manifest') args.packageManifest = argv[++index];
    else if (value === '--assignment-manifest') args.assignmentManifest = argv[++index];
    else if (value === '--batch-id') args.batchId = argv[++index];
    else if (value === '--output') args.output = argv[++index];
    else if (value === '--reviewer-instance-id') args.reviewerInstanceId = argv[++index];
    else if (value === '--agent-task-id') args.agentTaskId = argv[++index];
    else if (value === '--voter-review-run-id') args.voterReviewRunId = argv[++index];
    else if (value === '--role') args.role = argv[++index];
    else if (value === '--attempt') args.attempt = Number(argv[++index]);
    else if (value === '--created-at') args.createdAt = argv[++index];
    else if (value === '--key-file') args.keyFile = argv[++index];
    else if (value === '--conductor-key-stdin') args.conductorKeyStdin = true;
    else if (value === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function writeImmutable(destination, bytes) {
  const parent = path.dirname(destination);
  const assertAncestors = async (allowMissing) => {
    let cursor = REPO_ROOT;
    for (const part of path.relative(REPO_ROOT, parent).split(path.sep)) {
      cursor = path.join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) fail(`Symlinked authorization output ancestor rejected: ${cursor}`); }
      catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    }
  };
  await assertAncestors(true); await mkdir(parent, { recursive: true }); await assertAncestors(false);
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(destination);
    if (!existing.equals(Buffer.from(bytes))) fail(`Immutable reviewer-run attestation differs: ${destination}`);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('Authorization output must be an atomic regular non-symlink file with nlink=1');
}

export function isStrictRfc3339(value) {
  if (typeof value !== 'string' || !RFC3339.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function hmac(core, key) { return createHmac('sha256', key).update(canonicalize(core)).digest('hex'); }

export function validateAttestation(attestation, key) {
  const allowed = ['schemaVersion', 'authorizationId', 'bundleGenerationRunId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'role', 'passId', 'attempt', 'assignmentSha256', 'batchId', 'assignedOpaqueInputIds', 'batchPackageManifestSha256', 'fileSetSha256', 'targetManifestSha256s', 'createdAt', 'outputSha256', 'conductorHmacSha256'];
  const extras = Object.keys(attestation ?? {}).filter((key) => !allowed.includes(key));
  if (extras.length) fail(`Attestation has unexpected field(s): ${extras.join(', ')}`);
  if (attestation.schemaVersion !== 'blinded-visual-review-run-attestation-v1') fail('Unsupported attestation schema');
  for (const field of ['authorizationId', 'bundleGenerationRunId', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId', 'batchId']) assertOpaque(attestation[field], field);
  if (!['primary', 'adjudicator'].includes(attestation.role)) fail('Attestation role is invalid');
  if (!/^pass-[1-9][0-9]*$/.test(attestation.passId)) fail('Attestation passId is invalid');
  if (!Number.isInteger(attestation.attempt) || attestation.attempt < 1) fail('Attestation attempt is invalid');
  for (const field of ['assignmentSha256', 'batchPackageManifestSha256', 'fileSetSha256', 'outputSha256', 'conductorHmacSha256']) if (!/^[a-f0-9]{64}$/.test(attestation[field])) fail(`Attestation ${field} is invalid`);
  if (!Array.isArray(attestation.assignedOpaqueInputIds) || attestation.assignedOpaqueInputIds.length < 1 || new Set(attestation.assignedOpaqueInputIds).size !== attestation.assignedOpaqueInputIds.length) fail('Attestation assignedOpaqueInputIds is invalid');
  attestation.assignedOpaqueInputIds.forEach((value, index) => assertOpaque(value, `assignedOpaqueInputIds[${index}]`));
  if (!attestation.targetManifestSha256s || typeof attestation.targetManifestSha256s !== 'object' || Array.isArray(attestation.targetManifestSha256s)) fail('Attestation targetManifestSha256s is invalid');
  if (canonicalize(Object.keys(attestation.targetManifestSha256s).sort()) !== canonicalize([...attestation.assignedOpaqueInputIds].sort())) fail('Attestation target manifest coverage mismatch');
  for (const digest of Object.values(attestation.targetManifestSha256s)) if (!/^[a-f0-9]{64}$/.test(digest)) fail('Attestation target manifest hash is invalid');
  if (!isStrictRfc3339(attestation.createdAt)) fail('Attestation createdAt is invalid RFC 3339');
  const core = structuredClone(attestation);
  delete core.outputSha256; delete core.conductorHmacSha256;
  if (sha256(canonicalize(core)) !== attestation.outputSha256) fail('Attestation output hash drift');
  if (!key || !Buffer.from(key).length) fail('Conductor HMAC key is required');
  const expected = Buffer.from(hmac({ ...core, outputSha256: attestation.outputSha256 }, key), 'hex');
  const actual = Buffer.from(attestation.conductorHmacSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('Conductor HMAC verification failed');
  return attestation;
}

export async function createAttestation(args) {
  for (const field of ['packageManifest', 'assignmentManifest', 'batchId', 'output', 'reviewerInstanceId', 'agentTaskId', 'voterReviewRunId']) if (!args[field]) fail(`Missing ${field}`);
  if (!args.conductorKey && !args.keyFile) fail('Missing conductor key');
  const [packageManifestBytes, assignmentManifestBytes, conductorKey] = await Promise.all([readFile(resolveRepoPath(args.packageManifest)), readFile(resolveRepoPath(args.assignmentManifest)), args.conductorKey ? Buffer.from(args.conductorKey) : readFile(resolveRepoPath(args.keyFile))]);
  const packageManifest = JSON.parse(packageManifestBytes);
  const assignmentManifest = JSON.parse(assignmentManifestBytes);
  if (packageManifest.schemaVersion !== 'blinded-reviewer-batch-package-v1') fail('Unsupported reviewer batch package manifest');
  if (assignmentManifest.schemaVersion !== 'blinded-visual-review-assignment-set-v1') fail('Unsupported pass assignment manifest');
  const batch = assignmentManifest.batches?.find((entry) => entry.batchId === args.batchId);
  if (!batch || canonicalize(batch.opaqueInputIds) !== canonicalize(packageManifest.targets?.map((target) => target.opaqueInputId))) fail('Reviewer package is outside the conductor batch assignment');
  if (assignmentManifest.passId === 'pass-3' && args.role !== 'adjudicator') fail('pass-3 authorizations require adjudicator role');
  if (['pass-1', 'pass-2'].includes(assignmentManifest.passId) && (args.role ?? 'primary') !== 'primary') fail('pass-1/pass-2 authorizations require primary role');
  const core = {
    schemaVersion: 'blinded-visual-review-run-attestation-v1',
    authorizationId: `auth-${sha256(`${assignmentManifest.assignmentSha256}\0${args.batchId}\0${args.attempt ?? 1}\0${args.reviewerInstanceId}\0${args.agentTaskId}\0${args.voterReviewRunId}`).slice(0, 32)}`,
    bundleGenerationRunId: packageManifest.bundleGenerationRunId,
    reviewerInstanceId: args.reviewerInstanceId,
    agentTaskId: args.agentTaskId,
    voterReviewRunId: args.voterReviewRunId,
    role: args.role ?? 'primary',
    passId: assignmentManifest.passId,
    attempt: args.attempt ?? 1,
    assignmentSha256: assignmentManifest.assignmentSha256,
    batchId: args.batchId,
    assignedOpaqueInputIds: batch.opaqueInputIds,
    batchPackageManifestSha256: sha256(packageManifestBytes),
    fileSetSha256: sha256(canonicalize(packageManifest.files)),
    targetManifestSha256s: Object.fromEntries(packageManifest.targets.map((target) => [target.opaqueInputId, target.targetManifestSha256])),
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
  const outputSha256 = sha256(canonicalize(core));
  const attestation = { ...core, outputSha256, conductorHmacSha256: hmac({ ...core, outputSha256 }, conductorKey) };
  validateAttestation(attestation, conductorKey);
  const output = resolveRepoPath(args.output);
  const approved = path.join(REPO_ROOT, '.omx/evidence/visual-census', packageManifest.bundleGenerationRunId, 'authorizations', assignmentManifest.passId, `${args.batchId}.json`);
  if (!args.testOnlyAllowOutput && path.resolve(output) !== path.resolve(approved)) fail('Authorization output must be the approved run/pass/batch evidence path');
  if (args.testOnlyAllowOutput) {
    await mkdir(path.dirname(output), { recursive: true });
    try { await writeFile(output, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; const existing = await readFile(output); if (!existing.equals(Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`))) fail('Immutable test authorization differs'); }
  } else await writeImmutable(output, `${JSON.stringify(attestation, null, 2)}\n`);
  return attestation;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: printf KEY | node scripts/attest-blinded-visual-review-run.mjs --conductor-key-stdin --package-manifest REVIEWER_BATCH_MANIFEST --assignment-manifest PASS_ASSIGNMENT_MANIFEST --batch-id BATCH --output FILE --reviewer-instance-id ID --agent-task-id ID --voter-review-run-id ID [--role primary] [--attempt 1] [--created-at RFC3339]');
    return;
  }
  if (args.keyFile) fail('--key-file is restricted to programmatic self-tests; production CLI must use --conductor-key-stdin');
  if (!args.conductorKeyStdin || process.stdin.isTTY) fail('--conductor-key-stdin with piped/inherited stdin is required');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const conductorKey = Buffer.concat(chunks);
  if (conductorKey.length < 32) fail('Conductor key from stdin must contain at least 32 bytes');
  const attestation = await createAttestation({ ...args, conductorKey });
  console.log(JSON.stringify({ status: 'PASS', outputSha256: attestation.outputSha256 }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
