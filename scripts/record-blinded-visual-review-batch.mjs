#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { isStrictRfc3339, validateAttestation } from './attest-blinded-visual-review-run.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_BUNDLE_ROOT = 'production/reports/biological-continuity-v3/blinded-inputs/g001-baseline-v1';
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BIOLOGICAL_CLASSES = new Set(['mammal', 'bird', 'fish', 'reptile', 'amphibian', 'arthropod', 'mollusk', 'annelid', 'cnidarian', 'plant', 'fungus', 'spirit', 'construct', 'unknown']);
const SPECIES_FAMILIES = new Set(['bear', 'canid', 'feline', 'mustelid', 'rodent', 'rabbit', 'deer', 'bovine', 'equine', 'bat', 'bird-owl', 'bird-raptor', 'bird-songbird', 'bird-waterfowl', 'bird-penguin', 'bird-other', 'serpent', 'lizard', 'turtle', 'frog', 'salamander', 'fish-bony', 'fish-shark', 'cetacean', 'pinniped', 'arachnid', 'insect-larva', 'insect-beetle', 'insect-lepidopteran', 'crustacean', 'cephalopod', 'gastropod', 'plant-flower', 'fungus', 'spirit', 'construct', 'unknown-family']);
const CORE_ANATOMIES = new Set(['quadruped', 'biped', 'winged-biped', 'serpentine', 'fishlike', 'cephalopod', 'arachnid', 'hexapod', 'multiped', 'radial', 'plantlike', 'amorphous', 'construct', 'unknown']);
const LOCOMOTION_PLANS = new Set(['quadrupedal', 'bipedal', 'flight', 'swimming', 'serpentine', 'crawling', 'burrowing', 'rooted', 'floating', 'amorphous', 'unknown']);
const ANSWERS = new Set(['yes', 'no', 'undetermined']);
const DEVELOPMENTAL_DELTAS = new Set(['size-increase', 'limb-development', 'appendage-development', 'armor-development', 'silhouette-change', 'locomotion-change']);
const FORBIDDEN_KEYS = new Set(['pgid', 'id', 'name', 'lineage', 'evolutionfrom', 'parent', 'parentids', 'graph', 'stage', 'category', 'priorverdict', 'verdict', 'summary', 'pass', 'hash', 'sha256', 'provenance', 'reviewer', 'reviewid', 'voterreviewrunid', 'agenttaskid']);
const VOTE_HMAC_DOMAIN = 'punchgrow:visual-review-v1:conductor-hmac\0';

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const args = { bundleRoot: DEFAULT_BUNDLE_ROOT, role: 'primary' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--bundle-root') args.bundleRoot = argv[++index];
    else if (value === '--assignment') args.assignment = argv[++index];
    else if (value === '--observations') args.observations = argv[++index];
    else if (value === '--package-manifest') args.packageManifest = argv[++index];
    else if (value === '--attestation') args.attestation = argv[++index];
    else if (value === '--output-root') args.outputRoot = argv[++index];
    else if (value === '--submitted-at') args.submittedAt = argv[++index];
    else if (value === '--key-file') args.keyFile = argv[++index];
    else if (value === '--conductor-key-stdin') args.conductorKeyStdin = true;
    else if (value === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function fail(message) { throw new Error(message); }
function resolveRepoPath(value) { return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value); }
function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: expected object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail(`${label}: unexpected or forbidden field(s): ${extras.join(', ')}`);
}
function findForbidden(value, location = '$') {
  if (Array.isArray(value)) return value.forEach((entry, index) => findForbidden(entry, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail(`forbidden context field ${key} at ${location}`);
    findForbidden(entry, `${location}.${key}`);
  }
}
function assertOpaque(value, label) { if (typeof value !== 'string' || !OPAQUE_ID.test(value)) fail(`${label}: invalid opaque identifier`); }
function assertSlug(value, label) { if (typeof value !== 'string' || value.length < 2 || value.length > 80 || !SLUG.test(value)) fail(`${label}: invalid controlled slug`); }
function assertAnswer(value, label) { if (!ANSWERS.has(value)) fail(`${label}: invalid continuity answer`); }
function assertDeltas(value, label) {
  if (!Array.isArray(value)) fail(`${label}: expected array`);
  value.forEach((item, index) => assertSlug(item, `${label}[${index}]`));
  if (value.some((item) => !DEVELOPMENTAL_DELTAS.has(item))) fail(`${label}: value is outside controlled developmental vocabulary`);
  if (new Set(value).size !== value.length) fail(`${label}: duplicate value`);
}
function assertObservationText(value, label) { if (typeof value !== 'string' || value.trim().length < 3 || value.length > 500) fail(`${label}: invalid observation text`); }
function assertAnchor(anchor, label, edge) {
  assertExactKeys(anchor, edge ? ['anchorId', 'sourceSlots', 'visibleInChild', 'observation'] : ['anchorId', 'visible', 'observation'], label);
  assertSlug(anchor.anchorId, `${label}.anchorId`);
  assertObservationText(anchor.observation, `${label}.observation`);
  if (edge) {
    if (!Array.isArray(anchor.sourceSlots) || anchor.sourceSlots.length < 1 || anchor.sourceSlots.length > 2 || new Set(anchor.sourceSlots).size !== anchor.sourceSlots.length) fail(`${label}.sourceSlots: invalid`);
    if (anchor.sourceSlots.some((slot) => !['parent-a', 'parent-b'].includes(slot))) fail(`${label}.sourceSlots: invalid slot`);
    if (typeof anchor.visibleInChild !== 'boolean') fail(`${label}.visibleInChild: expected boolean`);
  } else if (typeof anchor.visible !== 'boolean') fail(`${label}.visible: expected boolean`);
}
function validateAssetObservation(value, label) {
  assertExactKeys(value, ['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan', 'faceAnchors', 'bodyAnchors', 'developmentalDeltas', 'masterRuntimeContinuity'], label);
  if (!BIOLOGICAL_CLASSES.has(value.biologicalClass)) fail(`${label}.biologicalClass: invalid`);
  assertSlug(value.speciesFamily, `${label}.speciesFamily`);
  if (!SPECIES_FAMILIES.has(value.speciesFamily)) fail(`${label}.speciesFamily: outside controlled visual family vocabulary`);
  if (!CORE_ANATOMIES.has(value.coreAnatomy)) fail(`${label}.coreAnatomy: invalid`);
  if (!LOCOMOTION_PLANS.has(value.locomotionPlan)) fail(`${label}.locomotionPlan: invalid`);
  if (!Array.isArray(value.faceAnchors) || value.faceAnchors.length < 1 || !Array.isArray(value.bodyAnchors) || value.bodyAnchors.length < 2) fail(`${label}: missing anchor observations`);
  value.faceAnchors.forEach((anchor, index) => assertAnchor(anchor, `${label}.faceAnchors[${index}]`, false));
  value.bodyAnchors.forEach((anchor, index) => assertAnchor(anchor, `${label}.bodyAnchors[${index}]`, false));
  if (canonicalize(value.faceAnchors.map((x) => x.anchorId)) !== canonicalize(['face-geometry']) || canonicalize(value.bodyAnchors.map((x) => x.anchorId)) !== canonicalize(['body-silhouette', 'signature-organ'])) fail(`${label}: asset anchor IDs must use the fixed review vocabulary`);
  assertDeltas(value.developmentalDeltas, `${label}.developmentalDeltas`);
  assertAnswer(value.masterRuntimeContinuity, `${label}.masterRuntimeContinuity`);
}
function validateEdgeObservation(value, label, mixed) {
  assertExactKeys(value, ['sameCreatureContinuity', 'coreAnatomyAgreement', 'locomotionAgreement', 'inheritedAnchors', 'developmentalDeltas'], label);
  assertAnswer(value.sameCreatureContinuity, `${label}.sameCreatureContinuity`);
  assertAnswer(value.coreAnatomyAgreement, `${label}.coreAnatomyAgreement`);
  assertAnswer(value.locomotionAgreement, `${label}.locomotionAgreement`);
  if (!Array.isArray(value.inheritedAnchors) || value.inheritedAnchors.length < 3) fail(`${label}.inheritedAnchors: at least three required`);
  value.inheritedAnchors.forEach((anchor, index) => assertAnchor(anchor, `${label}.inheritedAnchors[${index}]`, true));
  const expectedAnchors = mixed ? ['parent-a-face', 'parent-a-body', 'parent-b-face', 'parent-b-body'] : ['ancestry-face', 'ancestry-body', 'ancestry-signature'];
  if (canonicalize(value.inheritedAnchors.map((x) => x.anchorId)) !== canonicalize(expectedAnchors)) fail(`${label}: edge anchor IDs must use the fixed review vocabulary`);
  if (mixed) {
    for (const slot of ['parent-a', 'parent-b']) {
      if (value.inheritedAnchors.filter((anchor) => anchor.sourceSlots.includes(slot)).length < 2) fail(`${label}: mixed edge requires two anchors from ${slot}`);
    }
  }
  assertDeltas(value.developmentalDeltas, `${label}.developmentalDeltas`);
}

function voteAssets(input) {
  const surface = ({ sha256: digest, width, height }) => ({ sha256: digest, width, height });
  if (input.targetKind === 'asset') return [{ slot: 'asset', master: surface(input.surfaces.master), runtime: surface(input.surfaces.runtime) }];
  return [
    ...input.parents.map((parent) => ({ slot: parent.slot, master: surface(parent.surfaces.master), runtime: surface(parent.surfaces.runtime) })),
    { slot: 'child', master: surface(input.child.surfaces.master), runtime: surface(input.child.surfaces.runtime) },
  ];
}

async function writeImmutable(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(destination);
    if (!existing.equals(Buffer.from(bytes))) fail(`Immutable raw vote differs: ${destination}`);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`Raw vote output must be an atomic regular non-symlink file with nlink=1: ${destination}`);
}

async function rejectSymlinkAncestors(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Output path escapes approved evidence root');
  let cursor = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) fail(`Symlinked output ancestor rejected: ${cursor}`); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

async function listPackageFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`Reviewer package contains symlink: ${absolute}`);
    if (entry.isDirectory()) files.push(...await listPackageFiles(root, absolute));
    else if (entry.isFile()) {
      const info = await lstat(absolute);
      if (info.nlink !== 1) fail(`Reviewer package contains hard link: ${absolute}`);
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else fail(`Reviewer package contains non-regular entry: ${absolute}`);
  }
  return files.sort();
}

async function readContainedRegular(root, relativePath, label) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) fail(`${label}: non-canonical path`);
  const absoluteRoot = path.resolve(root); const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`${label}: package root must be a real non-symlink directory`);
  const absolute = path.resolve(absoluteRoot, relativePath);
  if (path.relative(absoluteRoot, absolute).startsWith('..')) fail(`${label}: path escapes package`);
  let cursor = absoluteRoot;
  for (const part of relativePath.split('/')) { cursor = path.join(cursor, part); const info = await lstat(cursor); if (info.isSymbolicLink()) fail(`${label}: symlinked path component`); }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${label}: expected regular non-symlink nlink=1 file`);
  const [realRoot, realFile] = await Promise.all([realpath(absoluteRoot), realpath(absolute)]);
  if (path.relative(realRoot, realFile).startsWith('..')) fail(`${label}: resolved path escapes package`);
  return { bytes: await readFile(absolute), absolute, info };
}

function sourcePixelSurfaces(input) {
  if (input.targetKind === 'asset') return [input.surfaces.master, input.surfaces.runtime];
  return [...input.parents.flatMap((parent) => [parent.surfaces.master, parent.surfaces.runtime]), input.child.surfaces.master, input.child.surfaces.runtime];
}

export async function verifyReviewerPackageSources(packageRoot, packageManifest, sourceRecords) {
  for (const target of packageManifest.targets) {
    const source = sourceRecords.get(target.opaqueInputId);
    if (!source) fail(`${target.opaqueInputId}: missing trusted source package`);
    const expectedFiles = new Map([
      ['bundle-manifest.json', source.sourceManifestBytes], ['REVIEW_PROMPT.md', source.promptBytes],
      ['input-allowlist.json', source.allowlistBytes], ['vote-template.json', source.templateBytes],
      ['review-contract.schema.json', source.contractBytes],
    ]);
    for (const surface of sourcePixelSurfaces(source.sourceManifest.input)) {
      expectedFiles.set(surface.path, (await readContainedRegular(source.sourceRoot, surface.path, `${target.opaqueInputId}:${surface.path}`)).bytes);
    }
    for (const [relative, trustedBytes] of expectedFiles) {
      const copiedPath = `${target.relativePackagePath}/${relative}`;
      const copied = await readContainedRegular(packageRoot, copiedPath, `${target.opaqueInputId}:${copiedPath}`);
      const committed = packageManifest.files.find((entry) => entry.path === copiedPath);
      if (!committed || committed.sha256 !== sha256(trustedBytes) || committed.bytes !== trustedBytes.length || !copied.bytes.equals(trustedBytes)) fail(`${target.opaqueInputId}: reviewer package copied file differs from trusted source: ${relative}`);
      if (relative.endsWith('.png')) {
        const surface = sourcePixelSurfaces(source.sourceManifest.input).find((entry) => entry.path === relative);
        if (committed.width !== surface.width || committed.height !== surface.height || committed.sha256 !== surface.sha256 || committed.bytes !== surface.bytes) fail(`${target.opaqueInputId}: reviewer package pixel metadata differs from source manifest: ${relative}`);
      }
    }
  }
}

export async function verifyReviewerPackage(packageManifestPath, packageManifest, packageManifestBytes) {
  const root = path.dirname(packageManifestPath);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('Reviewer package root must be a real non-symlink directory');
  const [resolvedRoot, resolvedManifest] = await Promise.all([realpath(root), realpath(packageManifestPath)]);
  if (path.dirname(resolvedManifest) !== resolvedRoot) fail('Reviewer package manifest escapes package root');
  const committed = packageManifest.files;
  if (!Array.isArray(committed) || committed.length < 1) fail('Reviewer package file manifest is missing');
  const expected = ['package-manifest.json', ...committed.map((entry) => entry.path)].sort();
  const actual = await listPackageFiles(root);
  if (canonicalize(actual) !== canonicalize(expected)) fail('Reviewer package exact file set mismatch');
  const seen = new Set();
  for (const entry of committed) {
    assertExactKeys(entry, entry.path?.endsWith('.png') ? ['path', 'sha256', 'bytes', 'width', 'height'] : ['path', 'sha256', 'bytes'], 'reviewer package file');
    if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(entry.path)) fail('Reviewer package contains non-canonical/duplicate file path');
    seen.add(entry.path);
    const absolute = path.resolve(root, entry.path);
    const relation = path.relative(root, absolute);
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('Reviewer package path traversal');
    const bytes = await readFile(absolute);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail(`Reviewer package file hash/length drift: ${entry.path}`);
    if (entry.path.endsWith('.png')) {
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(`Reviewer package PNG invalid: ${entry.path}`);
      if (bytes.readUInt32BE(16) !== entry.width || bytes.readUInt32BE(20) !== entry.height) fail(`Reviewer package PNG dimensions drift: ${entry.path}`);
    }
  }
  if (sha256(packageManifestBytes) !== sha256(await readFile(packageManifestPath))) fail('Reviewer package manifest read drift');
  return true;
}

export async function recordBatch(args) {
  for (const key of ['assignment', 'observations', 'packageManifest', 'attestation', 'outputRoot']) {
    if (!args[key]) fail(`Missing required --${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`);
  }
  if (!args.conductorKey && !args.keyFile) fail('Missing conductor key');
  const submittedAt = args.submittedAt ?? new Date().toISOString();
  if (!isStrictRfc3339(submittedAt)) fail('submittedAt must be a strict RFC 3339 timestamp');

  const bundleRoot = resolveRepoPath(args.bundleRoot ?? DEFAULT_BUNDLE_ROOT);
  const assignmentPath = resolveRepoPath(args.assignment);
  const packageManifestPath = resolveRepoPath(args.packageManifest);
  const [orchestrationBytes, assignmentBytes, assignmentSetBytes, packageManifestBytes, attestationBytes, observationBytes, conductorKey] = await Promise.all([
    readFile(path.join(bundleRoot, 'orchestration-index.json')),
    readFile(assignmentPath),
    readFile(path.join(path.dirname(assignmentPath), 'assignment-manifest.json')),
    readFile(packageManifestPath),
    readFile(resolveRepoPath(args.attestation)),
    readFile(resolveRepoPath(args.observations)),
    args.conductorKey ? Buffer.from(args.conductorKey) : readFile(resolveRepoPath(args.keyFile)),
  ]);
  const orchestration = JSON.parse(orchestrationBytes);
  const assignment = JSON.parse(assignmentBytes);
  const assignmentSet = JSON.parse(assignmentSetBytes);
  const packageManifest = JSON.parse(packageManifestBytes);
  const parsedAttestations = JSON.parse(attestationBytes);
  const attestations = (Array.isArray(parsedAttestations) ? parsedAttestations : [parsedAttestations]).map((value) => validateAttestation(value, conductorKey));
  const observations = JSON.parse(observationBytes);
  assertExactKeys(assignment, ['schemaVersion', 'bundleGenerationRunId', 'bundleManifestSha256', 'passId', 'assignmentSha256', 'batchId', 'opaqueInputIds', 'sourceAssignmentIds'], 'assignment');
  if (assignment.schemaVersion !== 'blinded-visual-review-assignment-batch-v1') fail('Unsupported assignment batch schema');
  if (assignment.bundleGenerationRunId !== orchestration.bundleGenerationRunId) fail('Assignment bundle run mismatch');
  if (assignment.bundleManifestSha256 !== sha256(orchestrationBytes)) fail('Assignment orchestration hash drift');
  if (!SHA256.test(assignment.assignmentSha256)) fail('Assignment set hash is invalid');
  if (!Array.isArray(assignment.opaqueInputIds) || assignment.opaqueInputIds.length < 1 || new Set(assignment.opaqueInputIds).size !== assignment.opaqueInputIds.length) fail('Assignment targets are missing or duplicated');
  if (!Array.isArray(assignment.sourceAssignmentIds) || assignment.sourceAssignmentIds.length !== assignment.opaqueInputIds.length || new Set(assignment.sourceAssignmentIds).size !== assignment.sourceAssignmentIds.length) fail('Source assignment IDs are missing or duplicated');
  assignment.opaqueInputIds.forEach((id, index) => assertOpaque(id, `assignment.opaqueInputIds[${index}]`));
  assertExactKeys(assignmentSet, ['schemaVersion', 'bundleGenerationRunId', 'bundleManifestSha256', 'passId', 'batchSize', 'targetCount', 'shuffleSha256', 'batches', 'assignmentSha256'], 'assignmentSet');
  const assignmentSetCore = structuredClone(assignmentSet);
  delete assignmentSetCore.assignmentSha256;
  if (sha256(canonicalize(assignmentSetCore)) !== assignmentSet.assignmentSha256) fail('Trusted assignment set hash drift');
  if (assignmentSet.assignmentSha256 !== assignment.assignmentSha256 || assignmentSet.passId !== assignment.passId) fail('Assignment batch does not belong to its assignment set');
  const trustedBatch = assignmentSet.batches?.find((batch) => batch.batchId === assignment.batchId);
  if (!trustedBatch || canonicalize(trustedBatch.opaqueInputIds) !== canonicalize(assignment.opaqueInputIds)) fail('Assignment batch targets differ from trusted assignment set');
  assertExactKeys(packageManifest, ['schemaVersion', 'bundleGenerationRunId', 'orchestrationIndexSha256', 'passId', 'assignmentSha256', 'batchId', 'targetCount', 'observationContractSha256', 'observationDependencySha256', 'targets', 'files'], 'packageManifest');
  if (packageManifest.schemaVersion !== 'blinded-reviewer-batch-package-v1') fail('Unsupported reviewer batch package manifest');
  const packageIds = packageManifest.targets?.map((input) => input.opaqueInputId);
  if (packageManifest.targetCount !== packageIds?.length || canonicalize(packageIds) !== canonicalize(assignment.opaqueInputIds)) fail('Reviewer package targets differ from trusted assignment');
  if (packageManifest.bundleGenerationRunId !== orchestration.bundleGenerationRunId || packageManifest.orchestrationIndexSha256 !== sha256(orchestrationBytes)) fail('Reviewer package bundle provenance mismatch');
  if (packageManifest.passId !== assignment.passId || packageManifest.assignmentSha256 !== assignment.assignmentSha256 || packageManifest.batchId !== assignment.batchId) fail('Reviewer package assignment mismatch');
  await verifyReviewerPackage(packageManifestPath, packageManifest, packageManifestBytes);
  const fileByPath = new Map(packageManifest.files.map((entry) => [entry.path, entry]));
  if (fileByPath.get('observation-contract.schema.json')?.sha256 !== packageManifest.observationContractSha256 || fileByPath.get('visual-review-v1.schema.json')?.sha256 !== packageManifest.observationDependencySha256) fail('Packaged schema commitment mismatch');
  const [trustedBatchSchema, trustedVoteSchema] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-batch-v1.schema.json')),
    readFile(path.join(REPO_ROOT, 'production/contracts/visual-review-v1.schema.json')),
  ]);
  JSON.parse(trustedBatchSchema); JSON.parse(trustedVoteSchema);
  if (packageManifest.observationContractSha256 !== sha256(trustedBatchSchema) || packageManifest.observationDependencySha256 !== sha256(trustedVoteSchema)) fail('Packaged schema differs from trusted contract');
  const orchestrationEntries = new Map(orchestration.assignments.map((entry) => [entry.assignmentId, entry]));
  const sourceRecords = new Map();
  for (let index = 0; index < assignment.opaqueInputIds.length; index += 1) {
    const opaqueInputId = assignment.opaqueInputIds[index];
    const assignmentId = assignment.sourceAssignmentIds[index];
    const orchestrationEntry = orchestrationEntries.get(assignmentId);
    if (!orchestrationEntry) fail(`Untrusted source assignment: ${assignmentId}`);
    const sourceRoot = path.join(bundleRoot, orchestrationEntry.relativePackagePath);
    const [sourceManifestFile, promptFile, allowlistFile, templateFile, contractFile] = await Promise.all([
      readContainedRegular(sourceRoot, 'bundle-manifest.json', `${assignmentId}:manifest`),
      readContainedRegular(sourceRoot, 'REVIEW_PROMPT.md', `${assignmentId}:prompt`),
      readContainedRegular(sourceRoot, 'input-allowlist.json', `${assignmentId}:allowlist`),
      readContainedRegular(sourceRoot, 'vote-template.json', `${assignmentId}:template`),
      readContainedRegular(sourceRoot, 'review-contract.schema.json', `${assignmentId}:contract`),
    ]);
    const sourceManifestBytes = sourceManifestFile.bytes; const promptBytes = promptFile.bytes; const allowlistBytes = allowlistFile.bytes; const templateBytes = templateFile.bytes;
    if (sha256(sourceManifestBytes) !== orchestrationEntry.bundleManifestSha256) fail(`${assignmentId}: source bundle manifest hash drift`);
    const sourceManifest = JSON.parse(sourceManifestBytes);
    if (sourceManifest.assignmentId !== assignmentId || sourceManifest.input?.opaqueInputId !== opaqueInputId) fail(`${assignmentId}: source target mismatch`);
    if (sha256(promptBytes) !== sourceManifest.promptSha256 || sha256(allowlistBytes) !== sourceManifest.allowlistSha256 || sha256(templateBytes) !== sourceManifest.templateSha256) fail(`${assignmentId}: source provenance hash drift`);
    const packageTarget = packageManifest.targets.find((target) => target.opaqueInputId === opaqueInputId);
    if (!packageTarget || packageTarget.assignmentId !== assignmentId || packageTarget.targetManifestSha256 !== sha256(sourceManifestBytes) || packageTarget.bundleManifestSha256 !== sha256(sourceManifestBytes)) fail(`${assignmentId}: reviewer package target manifest commitment drift`);
    sourceRecords.set(opaqueInputId, { assignmentId, sourceManifest, sourceManifestBytes, sourceRoot, promptBytes, allowlistBytes, templateBytes, contractBytes: contractFile.bytes });
  }
  await verifyReviewerPackageSources(path.dirname(packageManifestPath), packageManifest, sourceRecords);
  if (attestations.length !== 1) fail('Exactly one signed reviewer-run attestation is required per batch');
  for (const attestation of attestations) {
    if (attestation.bundleGenerationRunId !== orchestration.bundleGenerationRunId) fail('Attestation bundle run mismatch');
    if (attestation.passId !== assignment.passId) fail('Attestation pass mismatch');
    if (attestation.assignmentSha256 !== assignment.assignmentSha256) fail('Attestation assignment mismatch');
    if (attestation.batchId !== assignment.batchId) fail('Attestation batch mismatch');
    if (canonicalize(attestation.assignedOpaqueInputIds) !== canonicalize(assignment.opaqueInputIds)) fail('Attestation target coverage mismatch');
    if (attestation.batchPackageManifestSha256 !== sha256(packageManifestBytes)) fail('Attestation batch package manifest hash drift');
    if (attestation.fileSetSha256 !== sha256(canonicalize(packageManifest.files))) fail('Attestation reviewer package file-set hash drift');
    const expectedTargetHashes = Object.fromEntries([...sourceRecords].map(([id, source]) => [id, sha256(source.sourceManifestBytes)]));
    if (canonicalize(attestation.targetManifestSha256s) !== canonicalize(expectedTargetHashes)) fail('Attestation target manifest commitments drift');
  }
  const authorization = attestations[0];
  if (!Array.isArray(observations)) fail('Batch observations must be a raw JSON array');
  findForbidden(observations);
  const allowedIds = new Set(assignment.opaqueInputIds);
  const observedIds = new Set();
  const inputs = new Map([...sourceRecords].map(([id, record]) => [id, record.sourceManifest.input]));
  for (const [index, observation] of observations.entries()) {
    assertExactKeys(observation, ['opaqueInputId', 'confidence', 'assetObservation', 'edgeObservation'], `observations[${index}]`);
    assertOpaque(observation.opaqueInputId, `observations[${index}].opaqueInputId`);
    if (!allowedIds.has(observation.opaqueInputId)) fail(`Target outside assigned batch: ${observation.opaqueInputId}`);
    if (observedIds.has(observation.opaqueInputId)) fail(`Duplicate observation target: ${observation.opaqueInputId}`);
    observedIds.add(observation.opaqueInputId);
    if (typeof observation.confidence !== 'number' || observation.confidence < 0 || observation.confidence > 1) fail(`${observation.opaqueInputId}: confidence must be 0..1`);
    const input = inputs.get(observation.opaqueInputId);
    if (!input) fail(`Assigned target is absent from trusted bundle: ${observation.opaqueInputId}`);
    if (input.targetKind === 'asset') {
      if (!observation.assetObservation || observation.edgeObservation !== undefined) fail(`${observation.opaqueInputId}: wrong observation kind`);
      validateAssetObservation(observation.assetObservation, `${observation.opaqueInputId}.assetObservation`);
    } else {
      if (!observation.edgeObservation || observation.assetObservation !== undefined) fail(`${observation.opaqueInputId}: wrong observation kind`);
      validateEdgeObservation(observation.edgeObservation, `${observation.opaqueInputId}.edgeObservation`, input.parents.length === 2);
    }
  }
  if (observedIds.size !== allowedIds.size || [...allowedIds].some((id) => !observedIds.has(id))) fail('Batch observations are missing assigned target(s)');

  const approvedOutputRoot = path.join(REPO_ROOT, '.omx/evidence/visual-census', orchestration.bundleGenerationRunId, 'raw-votes');
  const outputRoot = resolveRepoPath(args.outputRoot);
  if (!args.testOnlyAllowOutputRoot && path.resolve(outputRoot) !== path.resolve(approvedOutputRoot)) fail('Raw vote output root must be the approved run evidence raw-votes root');
  if (!args.testOnlyAllowOutputRoot) await rejectSymlinkAncestors(REPO_ROOT, path.join(outputRoot, assignment.passId, assignment.batchId, 'vote.json'));
  const votes = [];
  for (const observation of observations) {
    const input = inputs.get(observation.opaqueInputId);
    const sourceManifest = sourceRecords.get(observation.opaqueInputId).sourceManifest;
    const provenance = {
      bundleGenerationRunId: sourceManifest.bundleGenerationRunId,
      promptSha256: sourceManifest.promptSha256,
      allowlistSha256: sourceManifest.allowlistSha256,
      templateSha256: sourceManifest.templateSha256,
      bundleManifestSha256: sourceRecords.get(observation.opaqueInputId).sourceManifestBytes ? sha256(sourceRecords.get(observation.opaqueInputId).sourceManifestBytes) : sourceManifest.bundleManifestSha256,
      privateSidecarSha256: sourceManifest.privateSidecarSha256,
      authorizationId: attestations[0].authorizationId,
      batchPackageManifestSha256: attestations[0].batchPackageManifestSha256,
      fileSetSha256: attestations[0].fileSetSha256,
    };
    const reviewId = `review-${sha256(`${authorization.voterReviewRunId}\0${authorization.reviewerInstanceId}\0${observation.opaqueInputId}`).slice(0, 32)}`;
    const withoutDigest = {
      schemaVersion: 'visual-review-v1',
      reviewId,
      voterReviewRunId: authorization.voterReviewRunId,
      reviewTarget: { kind: input.targetKind, opaqueInputId: observation.opaqueInputId },
      reviewer: { reviewerInstanceId: authorization.reviewerInstanceId, agentTaskId: authorization.agentTaskId, role: authorization.role },
      provenance,
      assets: voteAssets(input),
      ...(input.targetKind === 'asset' ? { assetObservation: observation.assetObservation } : { edgeObservation: observation.edgeObservation }),
      confidence: observation.confidence,
      submittedAt,
    };
    const voteWithDigest = { ...withoutDigest, outputSha256: sha256(canonicalize(withoutDigest)) };
    const vote = {
      ...voteWithDigest,
      conductorHmacSha256: createHmac('sha256', conductorKey).update(VOTE_HMAC_DOMAIN).update(canonicalize(voteWithDigest)).digest('hex'),
    };
    const bytes = `${JSON.stringify(vote, null, 2)}\n`;
    await writeImmutable(path.join(outputRoot, assignment.passId, assignment.batchId, `${observation.opaqueInputId}.json`), bytes);
    votes.push(vote);
  }
  return votes;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: printf KEY | node scripts/record-blinded-visual-review-batch.mjs --conductor-key-stdin --assignment FILE --package-manifest FILE --attestation FILE --observations FILE --output-root DIR [--submitted-at RFC3339]');
    return;
  }
  if (args.keyFile) fail('--key-file is restricted to programmatic self-tests; production CLI must use --conductor-key-stdin');
  if (!args.conductorKeyStdin || process.stdin.isTTY) fail('--conductor-key-stdin with piped/inherited stdin is required');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const conductorKey = Buffer.concat(chunks);
  if (conductorKey.length < 32) fail('Conductor key from stdin must contain at least 32 bytes');
  const votes = await recordBatch({ ...args, conductorKey });
  console.log(JSON.stringify({ status: 'PASS', votesWritten: votes.length }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
