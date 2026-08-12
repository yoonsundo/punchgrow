#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_BUNDLE_ROOT = 'production/reports/biological-continuity-v3/blinded-inputs/g001-baseline-v1';
const DEFAULT_BATCH_SIZE = 24;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = { bundleRoot: DEFAULT_BUNDLE_ROOT, batchSize: DEFAULT_BATCH_SIZE };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--bundle-root') args.bundleRoot = argv[++index];
    else if (value === '--output-root') args.outputRoot = argv[++index];
    else if (value === '--batch-size') args.batchSize = Number(argv[++index]);
    else if (value === '--adjudication-targets') args.adjudicationTargetsFile = argv[++index];
    else if (value === '--append-adjudication') args.appendAdjudication = true;
    else if (value === '--conductor-key-stdin') args.conductorKeyStdin = true;
    else if (value === '--key-file') args.keyFile = argv[++index];
    else if (value === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

async function writeImmutable(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(destination);
    const expected = Buffer.from(bytes);
    if (!existing.equals(expected)) throw new Error(`Immutable assignment differs: ${destination}`);
  }
}

function containedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error(`Package source path must be relative: ${relativePath}`);
  const destination = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Package source escapes bundle: ${relativePath}`);
  return destination;
}

async function copyIndependentImmutable(source, destination, sourceRoot) {
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(source));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Reviewer package source escapes assignment package: ${source}`);
  let cursor = path.resolve(sourceRoot);
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const component = await lstat(cursor);
    if (component.isSymbolicLink()) throw new Error(`Reviewer package source contains symlinked path component: ${cursor}`);
  }
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Reviewer package source must be a regular non-symlink file: ${source}`);
  if (sourceStat.nlink !== 1) throw new Error(`Reviewer package source must have link count 1: ${source}`);
  const [resolvedRoot, resolvedSource] = await Promise.all([realpath(sourceRoot), realpath(source)]);
  if (path.relative(resolvedRoot, resolvedSource).startsWith('..')) throw new Error(`Reviewer package source resolves outside assignment package: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    try { await copyFile(source, destination, fsConstants.COPYFILE_FICLONE_FORCE); }
    catch { await copyFile(source, destination, fsConstants.COPYFILE_FICLONE); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const [sourceBytes, destinationBytes] = await Promise.all([readFile(source), readFile(destination)]);
    if (!sourceBytes.equals(destinationBytes)) throw new Error(`Immutable reviewer package file differs: ${destination}`);
  }
  const destinationStat = await lstat(destination);
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw new Error(`Reviewer package output must be a regular non-symlink file: ${destination}`);
  if (destinationStat.nlink !== 1) throw new Error(`Reviewer package output must have link count 1: ${destination}`);
  if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) throw new Error(`Reviewer package pixel must be an independent copy: ${destination}`);
}

async function rejectSymlinkAncestors(absolutePath) {
  const parsed = path.parse(path.resolve(absolutePath));
  let cursor = parsed.root;
  for (const component of path.resolve(absolutePath).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`Symlinked path component rejected: ${cursor}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertContainedDirectoryRoot(containmentRoot, directory, label) {
  const base = path.resolve(containmentRoot); const target = path.resolve(directory);
  const relation = path.relative(base, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`${label}: root escapes containment`);
  let cursor = base;
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error(`${label}: containment root must be a real directory`);
  for (const part of relation.split(path.sep)) {
    cursor = path.join(cursor, part); const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}: directory root contains symlink or non-directory component`);
  }
  const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
  if (path.relative(realBase, realTarget).startsWith('..')) throw new Error(`${label}: directory root resolves outside containment`);
}

async function inspectDeliveredFile(root, relativePath) {
  if (relativePath !== relativePath.split(path.sep).join('/') || relativePath.startsWith('/') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Non-canonical reviewer package path: ${relativePath}`);
  }
  const absolute = containedPath(root, relativePath);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Reviewer package file must be regular, non-symlink, nlink=1: ${relativePath}`);
  const bytes = await readFile(absolute);
  const record = { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
  if (relativePath.endsWith('.png')) {
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid packaged PNG: ${relativePath}`);
    record.width = bytes.readUInt32BE(16);
    record.height = bytes.readUInt32BE(20);
  }
  return record;
}

function packageFilePaths(input) {
  if (input.targetKind === 'asset') return [input.surfaces.master.path, input.surfaces.runtime.path];
  return [
    ...input.parents.flatMap((parent) => [parent.surfaces.master.path, parent.surfaces.runtime.path]),
    input.child.surfaces.master.path,
    input.child.surfaces.runtime.path,
  ];
}

async function materializeReviewerPackage({ passRoot, manifest, manifestSha256, assignment, batch, sourcePackages, observationContractBytes, observationDependencyBytes }) {
  const packageRoot = path.join(passRoot, 'reviewer-packages', batch.batchId);
  const inputById = new Map(manifest.inputs.map((input) => [input.opaqueInputId, input]));
  const inputs = batch.opaqueInputIds.map((id) => inputById.get(id));
  if (inputs.some((input) => !input)) throw new Error(`${batch.batchId}: package target is absent from bundle`);
  const targets = [];
  for (const input of inputs) {
    const sourcePackage = sourcePackages.get(input.opaqueInputId);
    if (!sourcePackage) throw new Error(`${batch.batchId}: source assignment package is absent for ${input.opaqueInputId}`);
    const relativePackagePath = `targets/${sourcePackage.assignmentId}`;
    for (const relativePath of sourcePackage.publicFiles) {
      await copyIndependentImmutable(
        containedPath(sourcePackage.packageRoot, relativePath),
        containedPath(packageRoot, `${relativePackagePath}/${relativePath}`),
        sourcePackage.packageRoot,
      );
    }
    targets.push({
      assignmentId: sourcePackage.assignmentId,
      opaqueInputId: input.opaqueInputId,
      relativePackagePath,
      bundleManifestSha256: sourcePackage.bundleManifestSha256,
      targetManifestSha256: sourcePackage.bundleManifestSha256,
    });
  }
  await writeImmutable(path.join(packageRoot, 'observation-contract.schema.json'), observationContractBytes);
  await writeImmutable(path.join(packageRoot, 'visual-review-v1.schema.json'), observationDependencyBytes);
  const contentPaths = [
    'observation-contract.schema.json',
    'visual-review-v1.schema.json',
    ...targets.flatMap((target) => sourcePackages.get(target.opaqueInputId).publicFiles.map((file) => `${target.relativePackagePath}/${file}`)),
  ].sort();
  const files = await Promise.all(contentPaths.map((file) => inspectDeliveredFile(packageRoot, file)));
  const packageManifest = {
    schemaVersion: 'blinded-reviewer-batch-package-v1',
    bundleGenerationRunId: manifest.bundleGenerationRunId,
    orchestrationIndexSha256: manifestSha256,
    passId: assignment.passId,
    assignmentSha256: assignment.assignmentSha256,
    batchId: batch.batchId,
    targetCount: targets.length,
    observationContractSha256: sha256(observationContractBytes),
    observationDependencySha256: sha256(observationDependencyBytes),
    targets,
    files,
  };
  const packageManifestBytes = pretty(packageManifest);
  await writeImmutable(path.join(packageRoot, 'package-manifest.json'), packageManifestBytes);
  return { packageRoot, packageManifestSha256: sha256(packageManifestBytes) };
}

async function loadBundle(absoluteBundleRoot) {
  const orchestrationPath = path.join(absoluteBundleRoot, 'orchestration-index.json');
  const orchestrationBytes = await readFile(orchestrationPath);
  const orchestration = JSON.parse(orchestrationBytes);
  if (orchestration.schemaVersion !== 'blinded-review-orchestration-v1' || orchestration.counts?.assignments !== 430 || !Array.isArray(orchestration.assignments)) {
    throw new Error('Unsupported or incomplete blinded orchestration index');
  }
  const inputs = [];
  const sourcePackages = new Map();
  for (const entry of orchestration.assignments) {
    const packageRoot = containedPath(absoluteBundleRoot, entry.relativePackagePath);
    let cursor = path.resolve(absoluteBundleRoot);
    for (const component of entry.relativePackagePath.split('/')) {
      cursor = path.join(cursor, component);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`${entry.assignmentId}: assignment package path contains symlinked component`);
      if (cursor === packageRoot && !info.isDirectory()) throw new Error(`${entry.assignmentId}: assignment package root must be a real directory`);
    }
    const [realBundleRoot, realPackageRoot] = await Promise.all([realpath(absoluteBundleRoot), realpath(packageRoot)]);
    if (path.relative(realBundleRoot, realPackageRoot).startsWith('..')) throw new Error(`${entry.assignmentId}: assignment package resolves outside bundle root`);
    const manifestPath = path.join(packageRoot, 'bundle-manifest.json');
    const manifestBytes = await readFile(manifestPath);
    if (sha256(manifestBytes) !== entry.bundleManifestSha256) throw new Error(`${entry.assignmentId}: assignment bundle manifest hash drift`);
    const assignmentManifest = JSON.parse(manifestBytes);
    if (assignmentManifest.assignmentId !== entry.assignmentId || assignmentManifest.input?.opaqueInputId !== assignmentManifest.reviewTarget?.opaqueInputId) throw new Error(`${entry.assignmentId}: malformed assignment package`);
    const opaqueInputId = assignmentManifest.input.opaqueInputId;
    inputs.push(assignmentManifest.input);
    sourcePackages.set(opaqueInputId, {
      assignmentId: entry.assignmentId,
      packageRoot,
      bundleManifestSha256: entry.bundleManifestSha256,
      assignmentManifest,
      publicFiles: ['REVIEW_PROMPT.md', 'review-contract.schema.json', 'input-allowlist.json', 'vote-template.json', 'bundle-manifest.json', ...packageFilePaths(assignmentManifest.input)],
    });
  }
  return {
    manifest: {
      schemaVersion: 'blinded-visual-bundle-v1',
      bundleGenerationRunId: orchestration.bundleGenerationRunId,
      counts: { assets: orchestration.counts.assets, edges: orchestration.counts.edges, total: orchestration.counts.assignments },
      inputs,
    },
    manifestBytes: orchestrationBytes,
    sourcePackages,
  };
}

function assertManifest(manifest) {
  if (manifest?.schemaVersion !== 'blinded-visual-bundle-v1') throw new Error('Unsupported bundle manifest');
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length !== 430) throw new Error('Bundle must contain exactly 430 inputs');
  if (manifest.counts?.assets !== 240 || manifest.counts?.edges !== 190 || manifest.counts?.total !== 430) {
    throw new Error('Bundle counts must be 240 assets, 190 edges, 430 total');
  }
  const ids = new Set();
  for (const input of manifest.inputs) {
    if (!OPAQUE_ID.test(input.opaqueInputId)) throw new Error(`Invalid opaque input ID: ${input.opaqueInputId}`);
    if (!['asset', 'edge'].includes(input.targetKind)) throw new Error(`Invalid target kind: ${input.opaqueInputId}`);
    if (ids.has(input.opaqueInputId)) throw new Error(`Duplicate opaque input ID: ${input.opaqueInputId}`);
    ids.add(input.opaqueInputId);
  }
}

function deterministicOrder(inputs, manifestSha256, passId) {
  return [...inputs].sort((left, right) => {
    const leftKey = sha256(`${manifestSha256}\0${passId}\0${left.opaqueInputId}`);
    const rightKey = sha256(`${manifestSha256}\0${passId}\0${right.opaqueInputId}`);
    return leftKey.localeCompare(rightKey) || left.opaqueInputId.localeCompare(right.opaqueInputId);
  });
}

export function buildPassAssignments(manifest, manifestSha256, passId, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Number.isInteger(batchSize) || batchSize < 12 || batchSize > 48) throw new Error('batchSize must be an integer from 12 through 48');
  const ordered = deterministicOrder(manifest.inputs, manifestSha256, passId);
  const shuffleSha256 = sha256(canonicalize(ordered.map(({ opaqueInputId }) => opaqueInputId)));
  const batchTargets = [];
  for (let index = 0; index < ordered.length; index += batchSize) {
    batchTargets.push(ordered.slice(index, index + batchSize).map(({ opaqueInputId }) => opaqueInputId));
  }
  const assignmentCore = {
    schemaVersion: 'blinded-visual-review-assignment-set-v1',
    bundleGenerationRunId: manifest.bundleGenerationRunId,
    bundleManifestSha256: manifestSha256,
    passId,
    batchSize,
    targetCount: ordered.length,
    shuffleSha256,
    batches: batchTargets.map((opaqueInputIds, index) => ({
      batchId: `${passId}-batch-${String(index + 1).padStart(3, '0')}`,
      targetCount: opaqueInputIds.length,
      opaqueInputIds,
    })),
  };
  const assignmentSha256 = sha256(canonicalize(assignmentCore));
  return { ...assignmentCore, assignmentSha256 };
}

export function buildAdjudicationAssignments(manifest, manifestSha256, opaqueInputIds, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Array.isArray(opaqueInputIds) || opaqueInputIds.length === 0 || new Set(opaqueInputIds).size !== opaqueInputIds.length) throw new Error('pass-3 adjudication targets must be a non-empty unique array');
  const inputs = new Map(manifest.inputs.map((input) => [input.opaqueInputId, input]));
  for (const id of opaqueInputIds) {
    const input = inputs.get(id);
    if (!input) throw new Error(`pass-3 target is outside blinded bundle: ${id}`);
    if (input.targetKind !== 'asset') throw new Error(`pass-3 taxonomy adjudication may include assets only: ${id}`);
  }
  const subset = { ...manifest, inputs: opaqueInputIds.map((id) => inputs.get(id)) };
  return buildPassAssignments(subset, manifestSha256, 'pass-3', batchSize);
}

export function verifyAssignmentSet(assignment, manifest) {
  const allowed = ['schemaVersion', 'bundleGenerationRunId', 'bundleManifestSha256', 'passId', 'batchSize', 'targetCount', 'shuffleSha256', 'batches', 'assignmentSha256'];
  const extras = Object.keys(assignment ?? {}).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`Assignment set has unexpected field(s): ${extras.join(', ')}`);
  if (assignment.schemaVersion !== 'blinded-visual-review-assignment-set-v1') throw new Error('Unsupported assignment schema');
  const core = structuredClone(assignment);
  delete core.assignmentSha256;
  if (sha256(canonicalize(core)) !== assignment.assignmentSha256) throw new Error('Assignment hash drift detected');
  const expectedIds = new Set(manifest.inputs.map((input) => input.opaqueInputId));
  const assigned = [];
  for (const batch of assignment.batches ?? []) {
    const batchAllowed = ['batchId', 'targetCount', 'opaqueInputIds'];
    const batchExtras = Object.keys(batch ?? {}).filter((key) => !batchAllowed.includes(key));
    if (batchExtras.length) throw new Error(`Assignment batch has unexpected field(s): ${batchExtras.join(', ')}`);
    if (!Array.isArray(batch.opaqueInputIds) || batch.targetCount !== batch.opaqueInputIds.length) throw new Error(`${batch.batchId}: target count mismatch`);
    assigned.push(...batch.opaqueInputIds);
  }
  if (assigned.length !== expectedIds.size || assignment.targetCount !== expectedIds.size) throw new Error('Assignment coverage count mismatch');
  if (new Set(assigned).size !== assigned.length) throw new Error('Assignment contains duplicate target(s)');
  if (assigned.some((id) => !expectedIds.has(id)) || [...expectedIds].some((id) => !assigned.includes(id))) {
    throw new Error('Assignment does not exactly cover the bundle');
  }
}

async function writePass({ passRoot, manifest, manifestSha256, assignment, sourcePackages, observationContractBytes, observationDependencyBytes }) {
  await writeImmutable(path.join(passRoot, 'assignment-manifest.json'), pretty(assignment));
  for (const batch of assignment.batches) {
    const batchDocument = {
      schemaVersion: 'blinded-visual-review-assignment-batch-v1', bundleGenerationRunId: manifest.bundleGenerationRunId,
      bundleManifestSha256: manifestSha256, passId: assignment.passId, assignmentSha256: assignment.assignmentSha256,
      batchId: batch.batchId, opaqueInputIds: batch.opaqueInputIds,
      sourceAssignmentIds: batch.opaqueInputIds.map((id) => sourcePackages.get(id).assignmentId),
    };
    await writeImmutable(path.join(passRoot, `${batch.batchId}.json`), pretty(batchDocument));
    await materializeReviewerPackage({ passRoot, manifest, manifestSha256, assignment, batch, sourcePackages, observationContractBytes, observationDependencyBytes });
  }
}

export async function partitionBundle({ bundleRoot, outputRoot, batchSize = DEFAULT_BATCH_SIZE, adjudicationTargets = [] }) {
  if (adjudicationTargets.length) throw new Error('pass-3 cannot be created during initial partition; derive primary evidence then use --append-adjudication');
  const absoluteBundleRoot = resolveRepoPath(bundleRoot);
  const bundleInfo = await lstat(absoluteBundleRoot);
  if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()) throw new Error('Bundle root must be a regular directory');
  const resolvedBundleRoot = await realpath(absoluteBundleRoot);
  const { manifest, manifestBytes, sourcePackages } = await loadBundle(absoluteBundleRoot);
  assertManifest(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const observationContractBytes = await readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-batch-v1.schema.json'));
  const observationDependencyBytes = await readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-v1.schema.json'));
  const approvedOutputRoot = path.join(resolvedBundleRoot, 'review-batches');
  const requestedOutputRoot = path.resolve(resolveRepoPath(outputRoot ?? path.join(absoluteBundleRoot, 'review-batches')));
  if (requestedOutputRoot !== path.join(path.resolve(absoluteBundleRoot), 'review-batches')) throw new Error('Partition output must be the approved bundle review-batches root');
  const absoluteOutputRoot = approvedOutputRoot;
  await rejectSymlinkAncestors(absoluteOutputRoot);
  try { await lstat(absoluteOutputRoot); throw new Error('Review-batches output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stagingRoot = await mkdtemp(path.join(resolvedBundleRoot, '.review-batches-stage-'));
  const assignments = [];
  try {
   for (const passId of ['pass-1', 'pass-2']) {
    const assignment = buildPassAssignments(manifest, manifestSha256, passId, batchSize);
    verifyAssignmentSet(assignment, manifest);
    assignments.push(assignment);
    const passRoot = path.join(stagingRoot, passId);
    await writePass({ passRoot, manifest, manifestSha256, assignment, sourcePackages, observationContractBytes, observationDependencyBytes });
  }
  if (assignments[0].shuffleSha256 === assignments[1].shuffleSha256) throw new Error('Review passes must have different shuffle hashes');
  if (assignments[0].assignmentSha256 === assignments[1].assignmentSha256) throw new Error('Review passes must have different assignment hashes');
  await rename(stagingRoot, absoluteOutputRoot);
  return assignments;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function appendAdjudication({ bundleRoot, adjudicationTargetsFile, batchSize = DEFAULT_BATCH_SIZE, conductorKey, keyFile }) {
  if (!adjudicationTargetsFile) throw new Error('--adjudication-targets is required with --append-adjudication');
  const authorizationKey = conductorKey ? Buffer.from(conductorKey) : keyFile ? await readFile(resolveRepoPath(keyFile)) : null;
  if (!authorizationKey?.length) throw new Error('conductor key is required to verify adjudication targets');
  const absoluteBundleRoot = resolveRepoPath(bundleRoot);
  const { manifest, manifestBytes, sourcePackages } = await loadBundle(absoluteBundleRoot); assertManifest(manifest);
  const orchestrationSha256 = sha256(manifestBytes);
  const approvedTargetsPath = path.join(REPO_ROOT, '.omx/evidence/visual-census', manifest.bundleGenerationRunId, 'adjudication-targets.json');
  if (path.resolve(resolveRepoPath(adjudicationTargetsFile)) !== path.resolve(approvedTargetsPath)) throw new Error('adjudication targets must use the approved derived evidence path');
  const document = JSON.parse(await readFile(approvedTargetsPath, 'utf8'));
  const keys = Object.keys(document).sort();
  if (canonicalize(keys) !== canonicalize(['bundleGenerationRunId', 'conductorHmacSha256', 'orchestrationIndexSha256', 'outputSha256', 'schemaVersion', 'targets'].sort())) throw new Error('adjudication target document has unexpected fields');
  if (document.schemaVersion !== 'blinded-visual-adjudication-targets-v1' || document.bundleGenerationRunId !== manifest.bundleGenerationRunId || document.orchestrationIndexSha256 !== orchestrationSha256) throw new Error('adjudication target document provenance mismatch');
  const core = structuredClone(document); delete core.outputSha256; delete core.conductorHmacSha256;
  if (sha256(canonicalize(core)) !== document.outputSha256) throw new Error('adjudication target document output hash drift');
  const expectedHmac = Buffer.from(createHmac('sha256', authorizationKey).update(canonicalize({ ...core, outputSha256: document.outputSha256 })).digest('hex'), 'hex');
  const actualHmac = Buffer.from(document.conductorHmacSha256 ?? '', 'hex');
  if (actualHmac.length !== expectedHmac.length || !timingSafeEqual(actualHmac, expectedHmac)) throw new Error('adjudication target conductor HMAC verification failed');
  const targets = document.targets;
  const assignment = buildAdjudicationAssignments(manifest, orchestrationSha256, targets, batchSize);
  verifyAssignmentSet(assignment, { ...manifest, inputs: manifest.inputs.filter((input) => targets.includes(input.opaqueInputId)) });
  const reviewRoot = path.join(path.resolve(absoluteBundleRoot), 'review-batches');
  await assertContainedDirectoryRoot(absoluteBundleRoot, reviewRoot, 'review-batches');
  for (const primary of ['pass-1', 'pass-2']) {
    const info = await lstat(path.join(reviewRoot, primary)); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${primary} must remain an immutable real directory`);
  }
  const finalPassRoot = path.join(reviewRoot, 'pass-3');
  try { await lstat(finalPassRoot); throw new Error('pass-3 already exists; repeated append is forbidden'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(path.join(reviewRoot, '.pass-3-stage-'));
  try {
    const [observationContractBytes, observationDependencyBytes] = await Promise.all([
      readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-batch-v1.schema.json')),
      readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-v1.schema.json')),
    ]);
    await writePass({ passRoot: staging, manifest, manifestSha256: orchestrationSha256, assignment, sourcePackages, observationContractBytes, observationDependencyBytes });
    await rename(staging, finalPassRoot);
    return assignment;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/partition-blinded-visual-review.mjs [--bundle-root PATH] [--output-root PATH] [--batch-size 24] | --append-adjudication --adjudication-targets APPROVED_FILE');
    return;
  }
  if (args.appendAdjudication) {
    if (args.keyFile) throw new Error('--key-file is restricted to programmatic self-tests; production CLI must use --conductor-key-stdin');
    if (!args.conductorKeyStdin || process.stdin.isTTY) throw new Error('--conductor-key-stdin with piped/inherited stdin is required for append');
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const conductorKey = Buffer.concat(chunks); if (conductorKey.length < 32) throw new Error('Conductor key from stdin must contain at least 32 bytes');
    const assignment = await appendAdjudication({ ...args, conductorKey });
    console.log(JSON.stringify({ status: 'PASS', appended: { passId: assignment.passId, targets: assignment.targetCount, batches: assignment.batches.length } }, null, 2));
    return;
  }
  if (args.adjudicationTargetsFile) throw new Error('--adjudication-targets requires --append-adjudication');
  const assignments = await partitionBundle(args);
  console.log(JSON.stringify({ status: 'PASS', passes: assignments.map((value) => ({ passId: value.passId, batches: value.batches.length, shuffleSha256: value.shuffleSha256, assignmentSha256: value.assignmentSha256 })) }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
