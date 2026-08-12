#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { blockedEvidenceSets, stableJson } from './lib/continuity-assignment/compatibility.mjs';
import { buildSaveRevisionMap } from './lib/continuity-assignment/save-space.mjs';
import { solveContinuityAssignment } from './lib/continuity-assignment/solver.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT_ROOT = 'production/reports/biological-continuity-v3/g002-evidence-v1';
export const OUTPUT_NAMES = Object.freeze([
  'compatibility-ledger.json', 'topology-after.json', 'assignment-manifest.json',
  'save-revision-map.json', 'regeneration-queue.json', 'feasibility-report.json', 'output-attestation.json',
]);
export const INPUTS = Object.freeze({
  catalog: 'production/catalog/creatures.json',
  census: 'production/reports/biological-continuity-v3/g001-unblinded-image-first-census-v1.json',
  conflictLedger: 'production/reports/biological-continuity-v3/g001-unblinded-conflict-ledger-v1.json',
  inputLock: `${DEFAULT_OUTPUT_ROOT}/inputs.lock.json`,
  taxonomyConsensus: `${DEFAULT_OUTPUT_ROOT}/asset-census.json`,
  pixelClusters: `${DEFAULT_OUTPUT_ROOT}/pixel-clusters.json`,
  anchorConsensus: 'production/reports/biological-continuity-v3/g001-primary-pixel-anchor-consensus-v1.json',
  lockedTaxonomyConsensus: `${DEFAULT_OUTPUT_ROOT}/taxonomy-reviews/consensus.json`,
  canonicalRootRedesignTargets: `${DEFAULT_OUTPUT_ROOT}/canonical-root-redesign-targets-v1.json`,
  topologyContract: `${DEFAULT_OUTPUT_ROOT}/topology-before.json`,
  pins: `${DEFAULT_OUTPUT_ROOT}/pins.json`,
});

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readInput(relativePath) {
  const bytes = await readFile(path.join(REPO_ROOT, relativePath));
  return { bytes, json: JSON.parse(bytes), sha256: hash(bytes) };
}

async function assertSafeDirectory(root, target) {
  const relation = path.relative(root, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('output escapes containment');
  let cursor = root;
  for (const component of relation ? relation.split(path.sep) : []) {
    cursor = path.join(cursor, component);
    try { await mkdir(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`output ancestor is substituted: ${cursor}`);
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelation = path.relative(realRoot, realTarget);
  if (realRelation.startsWith('..') || path.isAbsolute(realRelation)) throw new Error('output ancestor resolves outside containment');
}

async function readExistingNoFollow(destination) {
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error(`output destination is symlinked, non-file, or hard-linked: ${destination}`);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const handle = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`output destination changed identity: ${destination}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function writeFixedOutputSet(outputRoot, documents, { beforeCommit, allowedOutputRoot = DEFAULT_OUTPUT_ROOT, outputNames = OUTPUT_NAMES } = {}) {
  const absoluteRoot = path.resolve(REPO_ROOT, outputRoot);
  if (outputRoot !== allowedOutputRoot) throw new Error('continuity outputs must use the selected canonical tracked public root');
  await assertSafeDirectory(REPO_ROOT, absoluteRoot);
  for (const name of Object.keys(documents)) if (!outputNames.includes(name)) throw new Error(`unapproved output name: ${name}`);
  for (const name of outputNames) if (!(name in documents)) throw new Error(`missing fixed output: ${name}`);
  for (const name of outputNames) {
    const destination = path.join(absoluteRoot, name); const bytes = Buffer.from(stableJson(documents[name]));
    const existing = await readExistingNoFollow(destination);
    if (existing?.equals(bytes)) continue;
    const temporary = path.join(absoluteRoot, `.${name}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
    let published = false;
    try {
      const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o644);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (beforeCommit) await beforeCommit({ name, destination });
      await assertSafeDirectory(REPO_ROOT, absoluteRoot);
      await readExistingNoFollow(destination);
      await rename(temporary, destination); published = true;
      const verified = await readExistingNoFollow(destination);
      if (!verified.equals(bytes)) throw new Error(`published output mismatch: ${name}`);
    } finally {
      if (!published) try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

export async function writeAtomicNoFollowForTest({ containmentRoot, outputRoot, name, document, beforeCommit }) {
  const root = path.resolve(containmentRoot); const destinationRoot = path.resolve(outputRoot);
  await assertSafeDirectory(root, destinationRoot);
  const destination = path.join(destinationRoot, name); const bytes = Buffer.from(stableJson(document));
  await readExistingNoFollow(destination);
  const temporary = path.join(destinationRoot, `.${name}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let published = false;
  try {
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (beforeCommit) await beforeCommit({ destination });
    await assertSafeDirectory(root, destinationRoot);
    await readExistingNoFollow(destination);
    await rename(temporary, destination); published = true;
    if (!(await readExistingNoFollow(destination)).equals(bytes)) throw new Error('test output bytes mismatch');
  } finally {
    if (!published) try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function composeDocuments(solution, saveMap, census, conflictLedger) {
  const blocked = blockedEvidenceSets(census, conflictLedger);
  return {
    'compatibility-ledger.json': {
      schemaVersion: 'continuity-compatibility-ledger-g002-v1', policy: 'fail-closed-root-frozen-family-and-mixed-anchor-contract',
      blockedAssetIds: [...blocked.blockedAssetIds].sort(), blockedAssetHashes: [...blocked.blockedHashes].sort(), blockedEdges: [...blocked.blockedEdges].sort(),
      familyProofs: solution.familyProofs, pinsProof: solution.pinsProof,
      edgeProofs: solution.topology.edges.map((edge) => ({ parentId: edge.parentId, childId: edge.childId, targetCompatible: edge.targetCompatible, compatibilityStatus: edge.compatibilityStatus })),
      decisions: solution.assignments.map((entry) => ({ slotId: entry.slotId, disposition: entry.sourceKind, source: entry.source, targetTaxonomy: entry.targetTaxonomy })),
    },
    'topology-after.json': solution.topology,
    'assignment-manifest.json': { schemaVersion: 'continuity-assignment-v1', runId: 'g002-v1', verdict: solution.feasibility.verdict, reviewCoverageManifest: solution.reviewCoverage, assignments: solution.assignments },
    'save-revision-map.json': saveMap,
    'regeneration-queue.json': { schemaVersion: 'continuity-regeneration-queue-g002-v1', runId: 'g002-v1', entries: solution.queue },
    'feasibility-report.json': { schemaVersion: 'continuity-feasibility-g002-v1', runId: 'g002-v1', ...solution.feasibility },
  };
}

export async function buildContinuityAssignment() {
  const inputs = await Promise.all(Object.values(INPUTS).map(readInput));
  const [catalogInput, censusInput, ledgerInput, lockInput, taxonomyInput, pixelInput, anchorInput, lockedTaxonomyInput, canonicalTargetsInput, topologyInput, pinsInput] = inputs;
  if (lockInput.json.runId !== 'g002-v1') throw new Error('G002 input lock run mismatch');
  const anchorLock = lockInput.json.inputs.find((entry) => entry.path === INPUTS.anchorConsensus);
  if (!anchorLock || anchorLock.sha256 !== anchorInput.sha256 || anchorInput.json.sourceCensusSha256 !== censusInput.sha256) throw new Error('G001 pixel-anchor consensus is not bound by the G002 input lock and census');
  const reviewedTaxonomyLock = lockInput.json.inputs.find((entry) => entry.path === INPUTS.lockedTaxonomyConsensus);
  if (!reviewedTaxonomyLock || reviewedTaxonomyLock.sha256 !== lockedTaxonomyInput.sha256) throw new Error('reviewed G002 taxonomy consensus is not bound by the G002 input lock');
  const canonicalTargetsLock = lockInput.json.inputs.find((entry) => entry.path === INPUTS.canonicalRootRedesignTargets);
  if (!canonicalTargetsLock || canonicalTargetsLock.sha256 !== canonicalTargetsInput.sha256) throw new Error('signed canonical root redesign targets are not bound by the G002 input lock');
  const solution = solveContinuityAssignment({
    catalog: catalogInput.json, census: censusInput.json, conflictLedger: ledgerInput.json,
    taxonomyConsensus: taxonomyInput.json, pixelClusters: pixelInput.json, anchorConsensus: anchorInput.json, lockedTaxonomyConsensus: lockedTaxonomyInput.json,
    canonicalRootRedesignTargets: canonicalTargetsInput.json, topologyContract: topologyInput.json, pins: pinsInput.json,
  });
  const saveMap = buildSaveRevisionMap(catalogInput.json, topologyInput.json, solution.topology);
  const base = composeDocuments(solution, saveMap, censusInput.json, ledgerInput.json);
  const outputHashes = Object.fromEntries(Object.entries(base).map(([name, document]) => [name, hash(stableJson(document))]));
  const attestation = {
    schemaVersion: 'continuity-output-attestation-g002-v1', runId: 'g002-v1',
    inputHashes: Object.fromEntries(Object.entries(INPUTS).map(([key, inputPath], index) => [key, { path: inputPath, sha256: inputs[index].sha256 }])),
    outputHashes, declaredVerdict: solution.feasibility.verdict,
    generationPolicy: 'deterministic-fail-closed-public-atomic-no-active-mutation',
  };
  const documents = { ...base, 'output-attestation.json': attestation };
  await writeFixedOutputSet(DEFAULT_OUTPUT_ROOT, documents);
  return { outputRoot: DEFAULT_OUTPUT_ROOT, regenerationCount: solution.feasibility.regenerationCount, retainedCount: solution.feasibility.retainedCount, feasibility: solution.feasibility.verdict, outputHashes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildContinuityAssignment()));
