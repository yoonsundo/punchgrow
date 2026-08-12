#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertExactEvidenceFileSet,
  assertTrustedDirectoryRoot,
  canonicalize,
  listPackageFiles,
  validateAuthorizationIdentityConstraints,
  validateVoteAuthenticity,
} from './verify-blinded-visual-review.mjs';
import { validateAttestation } from './attest-blinded-visual-review-run.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = 'g001-baseline-v1';
const EVIDENCE_ROOT = `.omx/evidence/visual-census/${RUN_ID}`;
const BLINDED_ROOT = `production/reports/biological-continuity-v3/blinded-inputs/${RUN_ID}`;
const REPORT_ROOT = 'production/reports/biological-continuity-v3';
const APPROVED_REPORTS = new Set([
  'g001-unblinded-image-first-census-v1.json',
  'g001-unblinded-conflict-ledger-v1.json',
  'g001-unblinded-census-summary-v1.md',
]);
const EXPECTED = Object.freeze({ assets: 240, edges: 190, blocked: 115, primaryVotes: 430, adjudications: 34 });
const TAXONOMY_FIELDS = Object.freeze(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']);
const SUBSTANTIVE_ASSET_REASONS = /substantive|continuity|core-anatomy|locomotion|required-anchor/i;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compareText = (a, b) => a.localeCompare(b, 'en');
const fail = (message) => { throw new Error(message); };

async function ensureSafeDirectory(containmentRoot, targetDirectory, label) {
  const root = path.resolve(containmentRoot);
  const target = path.resolve(targetDirectory);
  const relation = path.relative(root, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label}: directory escapes approved containment`);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`${label}: containment root is substituted`);
  let cursor = root;
  for (const component of relation ? relation.split(path.sep) : []) {
    cursor = path.join(cursor, component);
    try { await mkdir(cursor); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label}: ancestor is symlinked or non-directory`);
  }
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  const resolvedRelation = path.relative(resolvedRoot, resolvedTarget);
  if (resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) fail(`${label}: ancestor resolves outside approved containment`);
}

async function readRegularNoFollow(destination, label, { allowMissing = false } = {}) {
  let pathInfo;
  try { pathInfo = await lstat(destination); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (pathInfo.isSymbolicLink()) fail(`${label}: symlink destination rejected`);
  if (!pathInfo.isFile()) fail(`${label}: destination must be a regular file`);
  if (pathInfo.nlink !== 1) fail(`${label}: hard-linked destination rejected`);
  let handle;
  try {
    handle = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error.code)) fail(`${label}: symlink destination rejected`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(`${label}: destination must be a regular file`);
    if (info.nlink !== 1) fail(`${label}: hard-linked destination rejected`);
    return { bytes: await handle.readFile(), info };
  } finally {
    await handle.close();
  }
}

async function writeAtomicNoFollow({ containmentRoot, outputRoot, relativePath, bytes, approvedNames, beforeCommit }) {
  const normalizedBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\')
      || path.dirname(relativePath) !== '.' || !approvedNames.has(relativePath)) fail('report output path is not approved');
  const base = path.resolve(containmentRoot);
  const root = path.resolve(outputRoot);
  const destination = path.join(root, relativePath);
  await ensureSafeDirectory(base, path.dirname(destination), relativePath);
  const temporary = path.join(root, `.${relativePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let published = false;
  try {
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(normalizedBytes);
      await handle.chmod(0o644);
      await handle.sync();
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${relativePath}: staged output is not an independent regular file`);
    } finally {
      await handle.close();
    }
    const existing = await readRegularNoFollow(destination, relativePath, { allowMissing: true });
    if (existing?.bytes.equals(normalizedBytes)) return { changed: false, sha256: sha256(normalizedBytes) };
    // Existing symlink/non-regular/hard-link destinations are rejected above. A final-name
    // substitution after this check is replaced as a directory entry by rename, never followed.
    if (beforeCommit) await beforeCommit();
    await ensureSafeDirectory(base, path.dirname(destination), `${relativePath} pre-commit`);
    await rename(temporary, destination);
    published = true;
    await ensureSafeDirectory(base, path.dirname(destination), `${relativePath} post-commit`);
    const verified = await readRegularNoFollow(destination, `${relativePath} published`);
    if (!verified.bytes.equals(normalizedBytes) || sha256(verified.bytes) !== sha256(normalizedBytes)) fail(`${relativePath}: published bytes/hash mismatch`);
    return { changed: true, sha256: sha256(normalizedBytes) };
  } finally {
    if (!published) {
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

async function writeApprovedReport(filename, bytes) {
  return writeAtomicNoFollow({
    containmentRoot: REPO_ROOT, outputRoot: path.join(REPO_ROOT, REPORT_ROOT), relativePath: filename, bytes, approvedNames: APPROVED_REPORTS,
  });
}

export async function writeAtomicNoFollowForTest({ containmentRoot, relativePath, bytes, beforeCommit }) {
  return writeAtomicNoFollow({
    containmentRoot: path.dirname(path.resolve(containmentRoot)), outputRoot: containmentRoot,
    relativePath, bytes, beforeCommit, approvedNames: new Set([relativePath]),
  });
}

async function readContained(relativePath, label = relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\')) fail(`${label}: non-canonical path`);
  const absolute = path.resolve(REPO_ROOT, relativePath);
  const relation = path.relative(REPO_ROOT, absolute);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label}: path escapes repository root`);
  let cursor = REPO_ROOT;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`${label}: symlinked path rejected`);
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label}: expected regular non-symlink file`);
  const [resolvedRoot, resolved] = await Promise.all([realpath(REPO_ROOT), realpath(absolute)]);
  const resolvedRelation = path.relative(resolvedRoot, resolved);
  if (!resolvedRelation || resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) fail(`${label}: resolved path escapes repository root`);
  return readFile(absolute);
}

async function readJson(relativePath) {
  return JSON.parse(await readContained(relativePath));
}

async function hashFile(relativePath) {
  return sha256(await readContained(relativePath));
}

async function listFiles(relativeRoot) {
  const absoluteRoot = path.join(REPO_ROOT, relativeRoot);
  await assertTrustedDirectoryRoot(absoluteRoot, `${relativeRoot} evidence root`);
  return (await listPackageFiles(absoluteRoot)).map((relative) => path.posix.join(relativeRoot, relative));
}

function uniqueMap(items, keyOf, label) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (typeof key !== 'string' || key.length === 0) fail(`${label} has an invalid key`);
    if (result.has(key)) fail(`duplicate ${label}: ${key}`);
    result.set(key, item);
  }
  return result;
}

export function assertExactCoverage(actualIds, expectedIds, label) {
  const actual = [...actualIds];
  const expected = [...expectedIds];
  if (new Set(actual).size !== actual.length) fail(`duplicate ${label} coverage`);
  const actualSet = new Set(actual);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !new Set(expected).has(id));
  if (missing.length || extra.length || actual.length !== expected.length) {
    fail(`${label} coverage mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
  }
}

function taxonomyOf(vote) {
  return Object.fromEntries(TAXONOMY_FIELDS.map((field) => [field, vote.assetObservation?.[field]]));
}

function taxonomyMatches(a, b) {
  return TAXONOMY_FIELDS.every((field) => a?.assetObservation?.[field] === b?.assetObservation?.[field]);
}

function assetHasSubstantiveDissent(vote) {
  return vote.assetObservation?.masterRuntimeContinuity !== 'yes';
}

export function assertAdjudicationCannotOverride({ primaryVotes, adjudication, derivedTarget }) {
  if (!adjudication) return;
  if (adjudication.reviewTarget?.kind !== 'asset' || adjudication.edgeObservation) {
    fail('pass-3 adjudication must be asset-only taxonomy evidence');
  }
  const substantiveDissent = primaryVotes.some(assetHasSubstantiveDissent)
    || (derivedTarget?.reasons ?? []).some((reason) => SUBSTANTIVE_ASSET_REASONS.test(reason));
  if (substantiveDissent && derivedTarget?.verdict !== 'BLOCKED') {
    fail('pass-3 adjudication attempted to resolve substantive dissent');
  }
}

export function validateVoteIdentity(vote, { passNumber, batchNumber, opaqueInputId, targetKind, runId = RUN_ID }) {
  const primary = passNumber === 1 || passNumber === 2;
  const expectedRole = primary ? 'primary' : 'adjudicator';
  const padded = String(batchNumber).padStart(3, '0');
  const expectedRun = `vision-run-pass${passNumber}-batch${padded}`;
  const expectedReviewer = primary ? `vision-reviewer-pass${passNumber}-batch${padded}` : `vision-adjudicator-pass3-batch${padded}`;
  if (vote.schemaVersion !== 'visual-review-v1') fail('vote schema mismatch');
  if (vote.provenance?.bundleGenerationRunId !== runId) fail('vote bundle run mismatch');
  if (vote.voterReviewRunId !== expectedRun) fail('vote review run mismatch');
  if (vote.reviewer?.role !== expectedRole) fail('vote role mismatch');
  if (vote.reviewer?.reviewerInstanceId !== expectedReviewer) fail('vote reviewer instance mismatch');
  if (vote.reviewTarget?.opaqueInputId !== opaqueInputId || vote.reviewTarget?.kind !== targetKind) fail('vote target mismatch');
  if (!Number.isFinite(vote.confidence) || vote.confidence < 0 || vote.confidence > 1) fail('vote confidence mismatch');
  if (passNumber === 3 && (targetKind !== 'asset' || vote.edgeObservation)) fail('pass-3 may adjudicate taxonomy assets only');
}

export function assertVoteAuthorizationBinding(vote, authorization, {
  passId,
  batchId,
  opaqueInputId,
  targetKind,
  runId = RUN_ID,
} = {}) {
  if (!authorization || authorization.bundleGenerationRunId !== runId || vote.provenance?.bundleGenerationRunId !== runId) fail('vote/authorization bundle run mismatch');
  if (authorization.passId !== passId || authorization.batchId !== batchId) fail('vote/authorization pass or batch mismatch');
  if (vote.reviewTarget?.opaqueInputId !== opaqueInputId || vote.reviewTarget?.kind !== targetKind) fail('vote/authorization target mismatch');
  if (!authorization.assignedOpaqueInputIds?.includes(opaqueInputId)) fail('vote target is outside signed batch authorization');
  if (authorization.role !== vote.reviewer?.role
      || authorization.reviewerInstanceId !== vote.reviewer?.reviewerInstanceId
      || authorization.agentTaskId !== vote.reviewer?.agentTaskId
      || authorization.voterReviewRunId !== vote.voterReviewRunId) fail('vote identity does not match signed batch authorization');
  if (vote.provenance.authorizationId !== authorization.authorizationId
      || vote.provenance.batchPackageManifestSha256 !== authorization.batchPackageManifestSha256
      || vote.provenance.fileSetSha256 !== authorization.fileSetSha256
      || vote.provenance.bundleManifestSha256 !== authorization.targetManifestSha256s?.[opaqueInputId]) fail('vote package provenance does not match signed batch authorization');
}

async function runTrustedVerifier(conductorKey) {
  if (!conductorKey || Buffer.from(conductorKey).length < 32) fail('conductor key must contain at least 32 bytes');
  const verifierPath = path.join(REPO_ROOT, 'scripts/verify-blinded-visual-review.mjs');
  const child = spawn(process.execPath, [
    verifierPath,
    '--run-root', BLINDED_ROOT,
    '--mode', 'final',
    '--conductor-key-stdin',
  ], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(Buffer.from(conductorKey));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const output = Buffer.concat(stdout).toString('utf8');
  let result;
  try { result = JSON.parse(output); }
  catch { fail(`trusted verifier failed before producing a verdict: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`); }
  // The trusted verifier intentionally exits 1 for a valid fail-closed BLOCKED verdict.
  if (!((code === 0 && ['PASS', 'READY_FOR_REVIEW'].includes(result.verdict)) || (code === 1 && result.verdict === 'BLOCKED'))) {
    fail(`trusted verifier rejected G001 evidence: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`);
  }
  return result;
}

function selectedEvidence(primaryVotes, adjudication, derivedTarget) {
  if (derivedTarget.verdict !== 'PASS') return {};
  if (primaryVotes.some((vote) => vote.confidence < 0.85 || assetHasSubstantiveDissent(vote))) return {};
  let taxonomy;
  let taxonomyBasis;
  if (taxonomyMatches(primaryVotes[0], primaryVotes[1])) {
    taxonomy = taxonomyOf(primaryVotes[0]);
    taxonomyBasis = 'primary-consensus';
  } else if (adjudication && adjudication.confidence >= 0.85
      && primaryVotes.some((vote) => taxonomyMatches(vote, adjudication))) {
    taxonomy = taxonomyOf(adjudication);
    taxonomyBasis = 'taxonomy-adjudication-matching-primary';
  }
  if (!taxonomy || Object.values(taxonomy).some((value) => typeof value !== 'string' || value.length === 0)) return {};

  const commonAnchorIds = ['faceAnchors', 'bodyAnchors'].flatMap((group) => {
    const left = new Set((primaryVotes[0].assetObservation[group] ?? []).filter((a) => a.visible).map((a) => a.anchorId));
    return [...new Set((primaryVotes[1].assetObservation[group] ?? []).filter((a) => a.visible).map((a) => a.anchorId))]
      .filter((id) => left.has(id));
  }).sort(compareText);
  if (commonAnchorIds.length === 0) return { selectedTaxonomy: { ...taxonomy, basis: taxonomyBasis } };
  return {
    selectedTaxonomy: { ...taxonomy, basis: taxonomyBasis },
    selectedVisualContract: {
      masterRuntimeContinuity: 'yes',
      commonVisibleAnchorIds: commonAnchorIds,
      basis: 'two-primary-observation-consensus',
    },
  };
}

function classifyReasons(reasons) {
  const classes = new Set();
  for (const reason of reasons) {
    if (/confidence below/i.test(reason)) classes.add('low-confidence');
    if (/taxonomy/i.test(reason)) classes.add('taxonomy-conflict');
    if (/adjudicator/i.test(reason)) classes.add('invalid-taxonomy-adjudication');
    if (/continuity|core anatomy|locomotion|substantive/i.test(reason)) classes.add('substantive-biological-dissent');
    if (/anchor/i.test(reason)) classes.add('required-anchor-deficit');
    if (/master.*runtime/i.test(reason)) classes.add('master-runtime-discontinuity');
  }
  if (classes.size === 0) classes.add('unclassified-blocker');
  return [...classes].sort(compareText);
}

function pngDimensions(bytes, relativePath) {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail(`not a PNG: ${relativePath}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function verifySurface(relativePath, expectedSha256, expectedWidth, expectedHeight, label) {
  const bytes = await readContained(relativePath, label);
  if (sha256(bytes) !== expectedSha256) fail(`${label} hash drift: ${relativePath}`);
  const dimensions = pngDimensions(bytes, relativePath);
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) fail(`${label} dimension drift: ${relativePath}`);
}

async function loadAuthorizations(conductorKey, assignmentSets) {
  const authorizationRoot = `${EVIDENCE_ROOT}/authorizations`;
  const expected = assignmentSets.flatMap((set) => set.batches.map((batch) => `${set.passId}/${batch.batchId}.json`)).sort(compareText);
  const actual = (await listFiles(authorizationRoot)).map((relative) => path.posix.relative(authorizationRoot, relative));
  assertExactEvidenceFileSet(actual, expected, 'G001 authorization');
  const authorizations = [];
  const provenance = [];
  for (const relative of expected) {
    const relativePath = path.posix.join(authorizationRoot, relative);
    const authorization = validateAttestation(await readJson(relativePath), conductorKey);
    authorizations.push(authorization);
    provenance.push({ path: relativePath, sha256: await hashFile(relativePath) });
  }
  validateAuthorizationIdentityConstraints(authorizations);
  return {
    byBatch: uniqueMap(authorizations, (authorization) => `${authorization.passId}/${authorization.batchId}`, 'authorization batch'),
    authorizations,
    provenance,
  };
}

async function loadVotes(aliasTargets, conductorKey, authorizationData) {
  const passes = { 1: [], 2: [], 3: [] };
  const provenance = [];
  for (const passNumber of [1, 2, 3]) {
    const root = `${EVIDENCE_ROOT}/raw-votes/pass-${passNumber}`;
    const files = await listFiles(root);
    for (const relativePath of files) {
      if (!relativePath.endsWith('.json')) fail(`unexpected raw vote file: ${relativePath}`);
      const match = relativePath.match(new RegExp(`/pass-${passNumber}-batch-(\\d{3})/(asset|edge)-[a-f0-9]+\\.json$`));
      if (!match) fail(`raw vote path mismatch: ${relativePath}`);
      const vote = await readJson(relativePath);
      const target = aliasTargets.get(vote.reviewTarget?.opaqueInputId);
      if (!target) fail(`vote references unknown target: ${vote.reviewTarget?.opaqueInputId}`);
      validateVoteIdentity(vote, { passNumber, batchNumber: Number(match[1]), opaqueInputId: target.opaqueInputId, targetKind: target.kind });
      validateVoteAuthenticity(vote, conductorKey);
      const batchId = `pass-${passNumber}-batch-${match[1]}`;
      const authorization = authorizationData.byBatch.get(`pass-${passNumber}/${batchId}`);
      assertVoteAuthorizationBinding(vote, authorization, {
        passId: `pass-${passNumber}`, batchId, opaqueInputId: target.opaqueInputId, targetKind: target.kind,
      });
      passes[passNumber].push({ relativePath, vote });
      provenance.push({ path: relativePath, sha256: await hashFile(relativePath) });
    }
  }
  const expectedVoteFiles = authorizationData.authorizations.flatMap((authorization) => authorization.assignedOpaqueInputIds.map(
    (opaqueInputId) => `${authorization.passId}/${authorization.batchId}/${opaqueInputId}.json`,
  )).sort(compareText);
  const actualVoteFiles = Object.values(passes).flat().map(({ relativePath }) => path.posix.relative(`${EVIDENCE_ROOT}/raw-votes`, relativePath)).sort(compareText);
  assertExactEvidenceFileSet(actualVoteFiles, expectedVoteFiles, 'G001 raw vote');
  return { passes, provenance };
}

function observationRecord(vote) {
  return {
    reviewId: vote.reviewId,
    voterReviewRunId: vote.voterReviewRunId,
    reviewerInstanceId: vote.reviewer.reviewerInstanceId,
    confidence: vote.confidence,
    observation: vote.assetObservation ?? vote.edgeObservation,
  };
}

async function build({ conductorKey } = {}) {
  const trustedVerdict = await runTrustedVerifier(conductorKey);
  const aliasPath = `${EVIDENCE_ROOT}/alias-map.json`;
  const verdictPath = `${EVIDENCE_ROOT}/derived-verdict.json`;
  const adjudicationTargetsPath = `${EVIDENCE_ROOT}/adjudication-targets.json`;
  const assignmentAttestationPath = `${EVIDENCE_ROOT}/assignment-attestation.json`;
  const orchestrationPath = `${BLINDED_ROOT}/orchestration-index.json`;
  const assignmentSetPaths = [1, 2, 3].map((pass) => `${BLINDED_ROOT}/review-batches/pass-${pass}/assignment-manifest.json`);
  const [alias, derived, adjudicationTargets, assignmentAttestation, orchestration, ...assignmentSets] = await Promise.all([
    readJson(aliasPath), readJson(verdictPath), readJson(adjudicationTargetsPath), readJson(assignmentAttestationPath), readJson(orchestrationPath),
    ...assignmentSetPaths.map(readJson),
  ]);
  if (canonicalize(trustedVerdict) !== canonicalize(derived)) fail('approved derived verdict differs from freshly authenticated trusted derivation');
  if (alias.bundleGenerationRunId !== RUN_ID || adjudicationTargets.bundleGenerationRunId !== RUN_ID
      || assignmentAttestation.bundleGenerationRunId !== RUN_ID || orchestration.bundleGenerationRunId !== RUN_ID) fail('evidence run mismatch');
  if (derived.verdict !== 'BLOCKED') fail('final G001 verdict must be BLOCKED');
  for (const [field, expected] of Object.entries({ assets: EXPECTED.assets, edges: EXPECTED.edges, blocked: EXPECTED.blocked })) {
    if (derived.counts?.[field] !== expected) fail(`final ${field} count mismatch`);
  }
  if (alias.counts?.assets !== EXPECTED.assets || alias.counts?.edges !== EXPECTED.edges || alias.counts?.assignments !== EXPECTED.primaryVotes) fail('alias count mismatch');
  if (orchestration.counts?.assets !== EXPECTED.assets || orchestration.counts?.edges !== EXPECTED.edges || orchestration.counts?.assignments !== EXPECTED.primaryVotes) fail('immutable orchestration count mismatch');
  if (adjudicationTargets.targets?.length !== EXPECTED.adjudications) fail('adjudication target count mismatch');

  const registry = await readJson(alias.registryPath);
  if (registry.activePack !== alias.activePackId || registry.packs?.[alias.activePackId] !== alias.packManifestPath) fail('active registry path mismatch');
  const [catalog, pack] = await Promise.all([readJson(alias.catalogPath), readJson(alias.packManifestPath)]);
  const sourceHashes = {
    registry: { path: alias.registryPath, sha256: await hashFile(alias.registryPath) },
    pack: { path: alias.packManifestPath, sha256: await hashFile(alias.packManifestPath) },
    catalog: { path: alias.catalogPath, sha256: await hashFile(alias.catalogPath) },
  };
  if (sourceHashes.registry.sha256 !== alias.registrySha256 || sourceHashes.registry.sha256 !== derived.trustedRun?.hashes?.registrySha256) fail('registry hash drift');
  if (sourceHashes.pack.sha256 !== alias.packSha256 || sourceHashes.pack.sha256 !== derived.trustedRun?.hashes?.packSha256) fail('pack hash drift');
  if (sourceHashes.catalog.sha256 !== alias.catalogSha256 || sourceHashes.catalog.sha256 !== derived.trustedRun?.hashes?.catalogSha256) fail('catalog hash drift');
  if (await hashFile(orchestrationPath) !== derived.trustedRun?.hashes?.orchestrationSha256) fail('immutable orchestration hash drift');
  if (await hashFile(assignmentAttestationPath) !== derived.trustedRun?.hashes?.assignmentAttestationSha256) fail('assignment attestation hash drift');

  const assetAliases = uniqueMap(alias.assets, (item) => item.opaqueInputId, 'asset alias');
  const edgeAliases = uniqueMap(alias.edges, (item) => item.opaqueInputId, 'edge alias');
  if (assetAliases.size !== EXPECTED.assets || edgeAliases.size !== EXPECTED.edges) fail('alias coverage count mismatch');
  const aliasTargets = new Map([
    ...[...assetAliases.values()].map((item) => [item.opaqueInputId, { ...item, kind: 'asset' }]),
    ...[...edgeAliases.values()].map((item) => [item.opaqueInputId, { ...item, kind: 'edge' }]),
  ]);
  const expectedTargetIds = [...aliasTargets.keys()];
  const aliasAssignments = uniqueMap(alias.assignments, (item) => item.assignmentId, 'alias assignment');
  const attestedAssignments = uniqueMap(assignmentAttestation.assignments, (item) => item.assignmentId, 'attested assignment');
  const orchestratedAssignments = uniqueMap(orchestration.assignments, (item) => item.assignmentId, 'orchestrated assignment');
  assertExactCoverage([...aliasAssignments.keys()], [...orchestratedAssignments.keys()], 'alias assignment');
  assertExactCoverage([...attestedAssignments.keys()], [...orchestratedAssignments.keys()], 'attested assignment');
  for (const [assignmentId, aliasAssignment] of aliasAssignments) {
    const attested = attestedAssignments.get(assignmentId);
    const orchestrated = orchestratedAssignments.get(assignmentId);
    if (aliasAssignment.opaqueInputId !== attested.opaqueInputId || aliasAssignment.targetKind !== attested.targetKind) fail(`assignment target drift: ${assignmentId}`);
    if (attested.relativePackagePath !== orchestrated.relativePackagePath || attested.bundleManifestSha256 !== orchestrated.bundleManifestSha256) fail(`immutable assignment drift: ${assignmentId}`);
  }
  const derivedMap = uniqueMap(derived.targets, (item) => item.opaqueInputId, 'derived target');
  assertExactCoverage([...derivedMap.keys()], expectedTargetIds, 'derived target');
  if ([...derivedMap.values()].filter((target) => target.verdict === 'BLOCKED').length !== EXPECTED.blocked) fail('blocked target count mismatch');

  const catalogMap = uniqueMap(catalog, (item) => item.id, 'catalog creature');
  const packMap = uniqueMap(pack.entries, (item) => item.id, 'pack entry');
  assertExactCoverage([...catalogMap.keys()], [...assetAliases.values()].map((item) => item.assetId), 'catalog asset');
  assertExactCoverage([...packMap.keys()], [...assetAliases.values()].map((item) => item.assetId), 'pack asset');

  const authorizationData = await loadAuthorizations(conductorKey, assignmentSets);
  const { passes, provenance: rawVoteProvenance } = await loadVotes(aliasTargets, conductorKey, authorizationData);
  if (passes[1].length !== EXPECTED.primaryVotes || passes[2].length !== EXPECTED.primaryVotes || passes[3].length !== EXPECTED.adjudications) fail('vote count mismatch');
  const voteMaps = {};
  for (const passNumber of [1, 2, 3]) {
    voteMaps[passNumber] = uniqueMap(passes[passNumber].map((item) => item.vote), (vote) => vote.reviewTarget.opaqueInputId, `pass-${passNumber} vote`);
  }
  assertExactCoverage([...voteMaps[1].keys()], expectedTargetIds, 'pass-1 vote');
  assertExactCoverage([...voteMaps[2].keys()], expectedTargetIds, 'pass-2 vote');
  assertExactCoverage([...voteMaps[3].keys()], adjudicationTargets.targets, 'pass-3 adjudication');

  const reviewIds = new Set();
  for (const vote of [...voteMaps[1].values(), ...voteMaps[2].values(), ...voteMaps[3].values()]) {
    if (reviewIds.has(vote.reviewId)) fail(`duplicate review ID: ${vote.reviewId}`);
    reviewIds.add(vote.reviewId);
  }
  for (const [opaqueInputId, derivedTarget] of derivedMap) {
    const primaryReviewIds = [voteMaps[1].get(opaqueInputId).reviewId, voteMaps[2].get(opaqueInputId).reviewId];
    const adjudicatorReviewId = voteMaps[3].get(opaqueInputId)?.reviewId ?? null;
    if (JSON.stringify(derivedTarget.primaryReviewIds) !== JSON.stringify(primaryReviewIds)) fail(`derived primary review IDs mismatch: ${opaqueInputId}`);
    if ((derivedTarget.adjudicatorReviewId ?? null) !== adjudicatorReviewId) fail(`derived adjudicator review ID mismatch: ${opaqueInputId}`);
  }

  const assetSurface = new Map();
  const assets = [];
  for (const aliasAsset of [...assetAliases.values()].sort((a, b) => compareText(a.assetId, b.assetId))) {
    const id = aliasAsset.assetId;
    const catalogItem = catalogMap.get(id);
    const packItem = packMap.get(id);
    if (catalogItem.imagePath !== packItem.deploymentPaths?.catalog) fail(`catalog deployment path mismatch: ${id}`);
    if (!packItem.path.startsWith(`${pack.masterRoot}/`) || !packItem.mobilePath.startsWith(`${pack.mobileRoot}/`)) fail(`pack path drift: ${id}`);
    if (packItem.deploymentPaths.mobile !== `assets/creatures/mobile/${id}.png`
        || packItem.deploymentPaths.catalog !== `assets/creatures/generated/${id}.png`) fail(`active deployment path drift: ${id}`);
    const primaryVotes = [voteMaps[1].get(aliasAsset.opaqueInputId), voteMaps[2].get(aliasAsset.opaqueInputId)];
    const adjudication = voteMaps[3].get(aliasAsset.opaqueInputId) ?? null;
    const derivedTarget = derivedMap.get(aliasAsset.opaqueInputId);
    assertAdjudicationCannotOverride({ primaryVotes, adjudication, derivedTarget });

    const surfaces = primaryVotes.flatMap((vote) => vote.assets);
    for (const surface of surfaces) if (surface.slot !== 'asset') fail(`asset surface slot mismatch: ${id}`);
    const expectedMaster = surfaces[0].master;
    const expectedRuntime = surfaces[0].runtime;
    for (const surface of surfaces.slice(1)) {
      if (JSON.stringify(surface.master) !== JSON.stringify(expectedMaster) || JSON.stringify(surface.runtime) !== JSON.stringify(expectedRuntime)) fail(`primary surface evidence mismatch: ${id}`);
    }
    if (packItem.sha256 !== expectedMaster.sha256 || packItem.mobileSha256 !== expectedRuntime.sha256) fail(`pack surface hash mismatch: ${id}`);
    await verifySurface(packItem.path, expectedMaster.sha256, expectedMaster.width, expectedMaster.height, `${id} master`);
    await verifySurface(packItem.mobilePath, expectedRuntime.sha256, expectedRuntime.width, expectedRuntime.height, `${id} versioned runtime`);
    await verifySurface(packItem.deploymentPaths.mobile, expectedRuntime.sha256, expectedRuntime.width, expectedRuntime.height, `${id} active runtime`);
    await verifySurface(packItem.deploymentPaths.catalog, expectedMaster.sha256, expectedMaster.width, expectedMaster.height, `${id} active catalog`);
    assetSurface.set(id, { master: expectedMaster, runtime: expectedRuntime });

    assets.push({
      pgId: id,
      names: { ko: catalogItem.koName, en: catalogItem.enName },
      lineageId: catalogItem.lineageId,
      stage: catalogItem.stage,
      category: catalogItem.category,
      surfaces: {
        master: { path: packItem.path, ...expectedMaster },
        runtime: { path: packItem.deploymentPaths.mobile, sourcePath: packItem.mobilePath, ...expectedRuntime },
      },
      primaryObservations: primaryVotes.map(observationRecord),
      ...(adjudication ? { taxonomyAdjudication: observationRecord(adjudication) } : {}),
      derived: { verdict: derivedTarget.verdict, reasons: [...derivedTarget.reasons] },
      ...selectedEvidence(primaryVotes, adjudication, derivedTarget),
    });
  }

  const conflicts = [];
  for (const derivedTarget of [...derivedMap.values()].filter((item) => item.verdict === 'BLOCKED').sort((a, b) => compareText(a.opaqueInputId, b.opaqueInputId))) {
    const aliasTarget = aliasTargets.get(derivedTarget.opaqueInputId);
    const primaryVotes = [voteMaps[1].get(derivedTarget.opaqueInputId), voteMaps[2].get(derivedTarget.opaqueInputId)];
    if (aliasTarget.kind === 'asset') {
      const creature = catalogMap.get(aliasTarget.assetId);
      conflicts.push({
        kind: 'asset', opaqueInputId: aliasTarget.opaqueInputId, pgId: creature.id,
        names: { ko: creature.koName, en: creature.enName },
        reasonClasses: classifyReasons(derivedTarget.reasons), reasons: [...derivedTarget.reasons],
        primaryReviewIds: primaryVotes.map((vote) => vote.reviewId),
        ...(derivedTarget.adjudicatorReviewId ? { taxonomyAdjudicatorReviewId: derivedTarget.adjudicatorReviewId } : {}),
        requiredAction: 'reassign-or-regenerate',
      });
    } else {
      const slots = Object.fromEntries(Object.entries(aliasTarget.parentSlots).sort(([a], [b]) => compareText(a, b)).map(([slot, pgId]) => {
        const creature = catalogMap.get(pgId);
        return [slot, { pgId, names: { ko: creature.koName, en: creature.enName } }];
      }));
      const child = catalogMap.get(aliasTarget.childId);
      for (const vote of primaryVotes) {
        for (const surface of vote.assets) {
          const pgId = surface.slot === 'child' ? aliasTarget.childId : aliasTarget.parentSlots[surface.slot];
          const expected = assetSurface.get(pgId);
          if (!expected || JSON.stringify(surface.master) !== JSON.stringify(expected.master) || JSON.stringify(surface.runtime) !== JSON.stringify(expected.runtime)) fail(`edge surface evidence mismatch: ${aliasTarget.opaqueInputId}/${surface.slot}`);
        }
      }
      conflicts.push({
        kind: 'edge', opaqueInputId: aliasTarget.opaqueInputId, parentSlots: slots,
        child: { pgId: child.id, names: { ko: child.koName, en: child.enName } },
        reasonClasses: classifyReasons(derivedTarget.reasons), reasons: [...derivedTarget.reasons],
        primaryReviewIds: primaryVotes.map((vote) => vote.reviewId), requiredAction: 'reassign-or-regenerate',
      });
    }
  }
  if (conflicts.length !== EXPECTED.blocked || conflicts.some((item) => item.requiredAction !== 'reassign-or-regenerate')) fail('conflict ledger mismatch');

  const evidencePaths = [aliasPath, verdictPath, adjudicationTargetsPath, assignmentAttestationPath, orchestrationPath, ...assignmentSetPaths];
  const evidenceInputs = [
    ...await Promise.all(evidencePaths.map(async (relativePath) => ({ path: relativePath, sha256: await hashFile(relativePath) }))),
    ...authorizationData.provenance,
    ...rawVoteProvenance,
  ].sort((a, b) => compareText(a.path, b.path));
  const provenance = {
    runId: RUN_ID,
    evidenceInputs,
    sourceInputs: Object.values(sourceHashes).sort((a, b) => compareText(a.path, b.path)),
  };
  const census = {
    schemaVersion: 'g001-unblinded-image-first-census-v1',
    runId: RUN_ID,
    verdict: 'BLOCKED',
    counts: { assets: assets.length, edges: EXPECTED.edges, blocked: conflicts.length, primaryVotesPerPass: EXPECTED.primaryVotes, taxonomyAdjudications: EXPECTED.adjudications },
    policy: { confidenceFloor: 0.85, pass3Scope: 'taxonomy-only', blockedAction: 'reassign-or-regenerate', selfAssertPassAllowed: false },
    provenance,
    assets,
  };
  const ledger = {
    schemaVersion: 'g001-unblinded-conflict-ledger-v1', runId: RUN_ID, verdict: 'BLOCKED',
    supersedes: 'production/reports/evolution-runtime-visual-audit.json (permissive pre-G001 ledger)',
    counts: { blocked: conflicts.length, assets: conflicts.filter((item) => item.kind === 'asset').length, edges: conflicts.filter((item) => item.kind === 'edge').length },
    policy: { requiredAction: 'reassign-or-regenerate', selfAssertPassAllowed: false }, provenance, conflicts,
  };
  const summary = `# G001 unblinded biological-continuity census\n\n`+
    `Final verdict: **BLOCKED**. This report and its conflict ledger supersede the prior permissive \`production/reports/evolution-runtime-visual-audit.json\` ledger for biological-continuity release decisions.\n\n`+
    `- Reviewed assets: ${assets.length}\n- Reviewed evolution edges: ${EXPECTED.edges}\n- Blocked targets: ${conflicts.length} (${ledger.counts.assets} assets, ${ledger.counts.edges} edges)\n`+
    `- Primary controlled observations: ${EXPECTED.primaryVotes} in pass 1 and ${EXPECTED.primaryVotes} in pass 2\n- Taxonomy-only adjudications: ${EXPECTED.adjudications}\n\n`+
    `Blocked targets require **reassign-or-regenerate**. Neither this builder nor a later reviewer may self-assert PASS; a fresh controlled review is required after the asset or lineage assignment changes. Pass 3 may select taxonomy only and cannot erase continuity, anatomy, locomotion, confidence, or inherited-anchor dissent.\n\n`+
    `Machine-readable artifacts: \`g001-unblinded-image-first-census-v1.json\` and \`g001-unblinded-conflict-ledger-v1.json\`. Both embed SHA-256 provenance for every evidence and active source input.\n`;

  await Promise.all([
    writeApprovedReport('g001-unblinded-image-first-census-v1.json', stableJson(census)),
    writeApprovedReport('g001-unblinded-conflict-ledger-v1.json', stableJson(ledger)),
    writeApprovedReport('g001-unblinded-census-summary-v1.md', summary),
  ]);
  return { census, ledger };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (canonicalize(args) !== canonicalize(['--conductor-key-stdin'])) {
    console.error('Usage: <hidden-key-producer> | node scripts/build-g001-unblinded-census.mjs --conductor-key-stdin');
    process.exitCode = 1;
  } else if (process.stdin.isTTY) {
    console.error('--conductor-key-stdin requires piped/inherited non-TTY stdin');
    process.exitCode = 1;
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const conductorKey = Buffer.concat(chunks);
    build({ conductorKey }).then(({ census, ledger }) => {
    console.log(JSON.stringify({ runId: RUN_ID, verdict: census.verdict, assets: census.counts.assets, edges: census.counts.edges, blocked: ledger.counts.blocked, status: 'PASS' }));
    }).catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
  }
}

export { build };
