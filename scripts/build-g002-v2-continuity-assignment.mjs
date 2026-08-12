#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedEvidenceSets, stableJson } from './lib/continuity-assignment/compatibility.mjs';
import { buildSaveRevisionMap } from './lib/continuity-assignment/save-space.mjs';
import { solveContinuityAssignment } from './lib/continuity-assignment/solver.mjs';
import { hash, readInput, writeFixedOutputSet } from './build-continuity-assignment.mjs';
import { G002_V2_EFFECTIVE_ROOT_IDS, G002_V2_ROOT, resolveG002V2Authority } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { SIGNED_PATH as CANONICAL_SUCCESSOR_PATH } from './attest-g002-v2-canonical-successor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const V2_OUTPUT_NAMES = Object.freeze(['inputs.lock.json', 'compatibility-ledger.json', 'topology-after.json', 'assignment-manifest.json', 'save-revision-map.json', 'regeneration-queue.json', 'feasibility-report.json', 'output-attestation.json']);
export const V2_INPUTS = Object.freeze({
  catalog: 'production/catalog/creatures.json',
  census: 'production/reports/biological-continuity-v3/g001-unblinded-image-first-census-v1.json',
  conflictLedger: 'production/reports/biological-continuity-v3/g001-unblinded-conflict-ledger-v1.json',
  taxonomyConsensus: 'production/reports/biological-continuity-v3/g002-evidence-v1/asset-census.json',
  pixelClusters: 'production/reports/biological-continuity-v3/g002-evidence-v1/pixel-clusters.json',
  anchorConsensus: 'production/reports/biological-continuity-v3/g001-primary-pixel-anchor-consensus-v1.json',
  lockedTaxonomyConsensus: 'production/reports/biological-continuity-v3/g002-evidence-v1/taxonomy-reviews/consensus.json',
  canonicalRootRedesignTargets: CANONICAL_SUCCESSOR_PATH,
  topologyContract: 'production/reports/biological-continuity-v3/g002-evidence-v1/topology-before.json',
  pins: 'production/reports/biological-continuity-v3/g002-evidence-v1/pins.json',
  basePublicManifest: 'production/reports/biological-continuity-v3/g002-evidence-v1/public-evidence-manifest.json',
  baseCanonicalContract: 'production/reports/biological-continuity-v3/g002-evidence-v1/canonical-root-redesign-targets-v1.json',
});

export function assertG002V2Solution(solution) {
  if (solution.feasibility.regenerationCount !== 177 || solution.feasibility.retainedCount !== 63 || solution.queue.length !== 177) throw new Error('G002-v2 solver count mismatch');
  if (solution.topology.edges.length !== 190 || solution.reviewCoverage.edgeCandidates.length !== 190 || solution.reviewCoverage.queueCandidates.length !== 177) throw new Error('G002-v2 coverage count mismatch');
  if (solution.reviewCoverage.coverage.missingCoverage !== 367) throw new Error('G002-v2 obligation count mismatch');
  const canonical = solution.familyProofs.filter((proof) => proof.proofStatus === 'TARGET_FROM_SIGNED_CANONICAL_ROOT_REDESIGN_CONTRACT').map((proof) => proof.rootId).sort();
  if (JSON.stringify(canonical) !== JSON.stringify(G002_V2_EFFECTIVE_ROOT_IDS)) throw new Error('G002-v2 effective canonical root coverage mismatch');
  if (solution.topology.edges.some((edge) => edge.targetCompatible !== true || !['VERIFIED_PIXEL_VOTE_TARGET', 'VERIFIED_MIXED_PARENT_ANCHOR_CONTRACT'].includes(edge.compatibilityStatus))) throw new Error('G002-v2 contains a relaxed or incompatible edge');
  const queue = new Map(solution.queue.map((entry) => [entry.slotId, entry]));
  for (const [parentId, childId] of [['PG-053', 'PG-145'], ['PG-047', 'PG-155']]) {
    const child = queue.get(childId); const reference = child?.parentReferences.find((entry) => entry.parentId === parentId);
    if (!queue.has(parentId) || !reference || reference.sourceKind !== 'generated-parent-candidate' || reference.requiredCandidateReviewState !== 'PASS'
        || reference.dependencyCandidateId !== `g003-candidate:${parentId}`) throw new Error(`${parentId}=>${childId} is not a strict generated-parent dependency`);
    const inherited = child.inheritedAnchorContracts.filter((anchor) => anchor.parentId === parentId);
    if (inherited.length !== 3 || new Set(inherited.map((anchor) => anchor.anchorKey)).size !== 3
        || inherited.some((anchor) => anchor.sourceKind !== 'generated-parent-candidate' || anchor.resolutionState !== 'PENDING_APPROVED_PARENT_REVIEW')) throw new Error(`${parentId}=>${childId} does not preserve the exact three strict inherited parent anchors`);
  }
  return true;
}

export function composeG002V2Documents(solution, saveMap, census, ledger, inputLock, authority) {
  const blocked = blockedEvidenceSets(census, ledger);
  const topology = { ...solution.topology, schemaVersion: 'continuity-topology-after-v2', runId: 'g002-v2' };
  const reviewCoverage = { ...solution.reviewCoverage, schemaVersion: 'continuity-g003-review-gate-v2', authority: { effectiveAuthoritySha256: authority.effectiveAuthoritySha256, canonicalSuccessorOutputSha256: authority.outputSha256 } };
  const base = {
    'inputs.lock.json': inputLock,
    'compatibility-ledger.json': { schemaVersion: 'continuity-compatibility-ledger-g002-v2', runId: 'g002-v2', policy: 'fail-closed-root-frozen-family-and-mixed-anchor-contract', blockedAssetIds: [...blocked.blockedAssetIds].sort(), blockedAssetHashes: [...blocked.blockedHashes].sort(), blockedEdges: [...blocked.blockedEdges].sort(), familyProofs: solution.familyProofs, pinsProof: solution.pinsProof, edgeProofs: topology.edges.map((edge) => ({ parentId: edge.parentId, childId: edge.childId, targetCompatible: edge.targetCompatible, compatibilityStatus: edge.compatibilityStatus })), decisions: solution.assignments.map((entry) => ({ slotId: entry.slotId, disposition: entry.sourceKind, source: entry.source, targetTaxonomy: entry.targetTaxonomy })) },
    'topology-after.json': topology,
    'assignment-manifest.json': { schemaVersion: 'continuity-assignment-v2', runId: 'g002-v2', verdict: solution.feasibility.verdict, effectiveAuthoritySha256: authority.effectiveAuthoritySha256, reviewCoverageManifest: reviewCoverage, assignments: solution.assignments },
    'save-revision-map.json': { ...saveMap, schemaVersion: 'catalog-revision-map-v2', runId: 'g002-v2' },
    'regeneration-queue.json': { schemaVersion: 'continuity-regeneration-queue-g002-v2', runId: 'g002-v2', effectiveAuthoritySha256: authority.effectiveAuthoritySha256, entries: solution.queue },
    'feasibility-report.json': { schemaVersion: 'continuity-feasibility-g002-v2', runId: 'g002-v2', effectiveAuthoritySha256: authority.effectiveAuthoritySha256, ...solution.feasibility },
  };
  const outputHashes = Object.fromEntries(Object.entries(base).filter(([name]) => name !== 'inputs.lock.json').map(([name, document]) => [name, hash(stableJson(document))]));
  return { ...base, 'output-attestation.json': { schemaVersion: 'continuity-output-attestation-g002-v2', runId: 'g002-v2', effectiveAuthoritySha256: authority.effectiveAuthoritySha256, inputHashes: Object.fromEntries(inputLock.inputs.map((entry) => [entry.key, { path: entry.path, sha256: entry.sha256 }])), outputHashes, declaredVerdict: solution.feasibility.verdict, generationPolicy: 'deterministic-fail-closed-public-atomic-no-active-mutation-no-v1-fallback' } };
}

export async function buildG002V2ContinuityAssignment({ write = true, includeDocuments = false } = {}) {
  const entries = Object.entries(V2_INPUTS); const inputs = await Promise.all(entries.map(([, relative]) => readInput(relative)));
  const raw = Object.fromEntries(entries.map(([key], index) => [key, inputs[index]]));
  // G002-v2 is a signed review of the immutable PG-001..240 epoch. Runtime
  // append-only additions must not alter the historical solver input or lock.
  const frozenCatalog = raw.catalog.json.slice(0, 240);
  raw.catalog = {
    ...raw.catalog,
    json: frozenCatalog,
    sha256: hash(`${JSON.stringify(frozenCatalog, null, 2)}\n`),
  };
  inputs[entries.findIndex(([key]) => key === 'catalog')].sha256 = raw.catalog.sha256;
  const authority = await resolveG002V2Authority(raw.canonicalRootRedesignTargets.json, { repoRoot: ROOT });
  const solution = solveContinuityAssignment({
    catalog: raw.catalog.json, census: raw.census.json, conflictLedger: raw.conflictLedger.json,
    taxonomyConsensus: raw.taxonomyConsensus.json, pixelClusters: raw.pixelClusters.json, anchorConsensus: raw.anchorConsensus.json,
    lockedTaxonomyConsensus: raw.lockedTaxonomyConsensus.json, canonicalRootRedesignTargets: raw.canonicalRootRedesignTargets.json,
    canonicalAuthorityResolver: () => authority, topologyContract: raw.topologyContract.json, pins: raw.pins.json,
  });
  assertG002V2Solution(solution);
  const saveMap = buildSaveRevisionMap(raw.catalog.json, raw.topologyContract.json, solution.topology);
  const inputLock = { schemaVersion: 'continuity-input-lock-v2', runId: 'g002-v2', fallbackAllowed: false, baseAuthority: raw.canonicalRootRedesignTargets.json.baseAuthority,
    inputs: entries.map(([key, relative], index) => ({ key, path: relative, sha256: inputs[index].sha256 })) };
  const output = composeG002V2Documents(solution, saveMap, raw.census.json, raw.conflictLedger.json, inputLock, authority);
  if (write) await writeFixedOutputSet(G002_V2_ROOT, output, { allowedOutputRoot: G002_V2_ROOT, outputNames: V2_OUTPUT_NAMES });
  return { status: 'PASS', outputRoot: G002_V2_ROOT, regenerationCount: 177, retainedCount: 63, edges: 190, obligations: 367, effectiveAuthoritySha256: authority.effectiveAuthoritySha256, ...(includeDocuments ? { documents: output, solution } : {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildG002V2ContinuityAssignment()));
