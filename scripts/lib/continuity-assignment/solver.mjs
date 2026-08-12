import {
  assertUnique,
  canonicalString,
  edgeKey,
  fail,
  parentIdsFor,
  taxonomyTuple,
} from './compatibility.mjs';
import { buildTopology, EXPECTED_CHOICE_PROFILE } from './topology.mjs';
import { sha256Canonical } from './canonical-json.mjs';
import { resolveCanonicalRootAuthorityV1, selectCanonicalRootTarget } from './canonical-root-redesign-targets.mjs';

export const EXPECTED_COUNTS = Object.freeze({
  slots: 240, roots: 60, singleParentEdges: 170, mixedSlots: 10, edges: 190,
  categories: Object.freeze({ start: 60, normal_evolution: 121, branch: 14, mixed: 10, special: 10, mutant: 25 }),
  stages: Object.freeze({ 1: 60, 2: 93, 3: 64, 4: 23 }),
  rootChoiceProfile: EXPECTED_CHOICE_PROFILE,
});

const CONTINUITY_SUPERSESSION_SCOPE = 'continuity-g002-v2-supersession-v1';
const MIXED_SCOPE_SLOT_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => `PG-${String(196 + index).padStart(3, '0')}`));

const TAXONOMY_FIELDS = Object.freeze(['biologicalClass', 'speciesFamily', 'coreAnatomy', 'locomotionPlan']);
const compareText = (a, b) => a.localeCompare(b, 'en');
const concreteTuple = (taxonomy) => {
  const tuple = TAXONOMY_FIELDS.map((field) => taxonomy?.[field]);
  return tuple.every((value) => typeof value === 'string' && value.length > 0 && !/^unknown(?:-|$)/i.test(value)) ? tuple : null;
};
const taxonomyObject = (tuple) => Object.fromEntries(TAXONOMY_FIELDS.map((field, index) => [field, tuple[index]]));
const tupleKey = (value) => canonicalString(Array.isArray(value) ? value : concreteTuple(value));

function countsBy(items, keyOf) {
  const result = {};
  for (const item of items) result[keyOf(item)] = (result[keyOf(item)] ?? 0) + 1;
  return result;
}

function assertCounts(actual, expected, label) {
  if (canonicalString(actual) !== canonicalString(expected)) fail(`${label} mismatch: ${canonicalString(actual)}`);
}

export function assertFrozenTopology(catalog, baseline = catalog) {
  assertUnique(catalog, (item) => item.id, 'slot ID');
  if (catalog.length !== EXPECTED_COUNTS.slots) fail('catalog must have 240 slots');
  const base = new Map(baseline.map((item) => [item.id, item]));
  for (const slot of catalog) {
    const frozen = base.get(slot.id) ?? fail(`new slot is forbidden: ${slot.id}`);
    for (const field of ['category', 'stage', 'rarity']) if (slot[field] !== frozen[field]) fail(`${slot.id}: frozen ${field} changed`);
    if (slot.category !== 'mixed' && canonicalString(slot.evolutionFrom) !== canonicalString(frozen.evolutionFrom)) fail(`${slot.id}: single-parent adjacency changed`);
  }
  assertCounts(countsBy(catalog, (item) => item.category), EXPECTED_COUNTS.categories, 'category counts');
  assertCounts(countsBy(catalog, (item) => item.stage), EXPECTED_COUNTS.stages, 'stage counts');
  if (catalog.filter((item) => item.evolutionFrom == null).length !== EXPECTED_COUNTS.roots) fail('root count mismatch');
  if (catalog.filter((item) => !Array.isArray(item.evolutionFrom) && item.evolutionFrom != null).length !== EXPECTED_COUNTS.singleParentEdges) fail('single-parent edge count mismatch');
  return true;
}

function observationsFor(asset) {
  return (asset?.primaryObservations ?? []).flatMap((review) => {
    const tuple = concreteTuple(review.observation);
    return tuple ? [{ tuple, confidence: review.confidence, observation: review.observation, reviewId: review.reviewId }] : [];
  });
}

export function visualAnchors(asset) {
  if (asset?.status !== 'TWO_PRIMARY_PIXEL_ANCHOR_CONSENSUS') fail(`${asset?.pgId}: authenticated pixel-anchor consensus is unavailable`);
  const reviews = new Map(asset.sourceReviews.map((review) => [review.reviewId, review]));
  const selected = asset.anchors.map((anchor) => {
    const source = [...anchor.sources].sort((a, b) => {
      const confidenceDelta = reviews.get(b.reviewId).confidence - reviews.get(a.reviewId).confidence;
      return confidenceDelta || compareText(a.reviewId, b.reviewId);
    })[0];
    return { anchorId: anchor.anchorId, name: anchor.anchorId, description: source.description, sourceReviewId: source.reviewId, sourceConfidence: reviews.get(source.reviewId).confidence };
  });
  if (selected.length < 3) fail(`${asset?.pgId}: authenticated pixel-anchor consensus contains fewer than three concrete anchors`);
  return selected.sort((a, b) => compareText(a.anchorId, b.anchorId));
}

function validateAnchorConsensus(anchorConsensus, census) {
  if (anchorConsensus?.schemaVersion !== 'g001-pixel-anchor-consensus-v1' || anchorConsensus.runId !== 'g001-baseline-v1'
      || anchorConsensus.policy?.pixelsOnly !== true || anchorConsensus.policy?.catalogMetadataAllowed !== false
      || anchorConsensus.policy?.requiredPrimaryReviews !== 2 || anchorConsensus.policy?.minimumCommonVisibleAnchors !== 3
      || anchorConsensus.assets?.length !== 240) fail('authenticated pixel-anchor consensus input is missing or unsafe');
  const unsigned = structuredClone(anchorConsensus); delete unsigned.publicSignature;
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (unsigned.outputSha256 !== sha256Canonical(core)) fail('pixel-anchor consensus output hash mismatch');
  assertUnique(anchorConsensus.assets, (asset) => asset.pgId, 'pixel-anchor consensus PG ID');
  const censusById = new Map(census.assets.map((asset) => [asset.pgId, asset]));
  for (const asset of anchorConsensus.assets) {
    const censusAsset = censusById.get(asset.pgId) ?? fail(`${asset.pgId}: anchor consensus has no G001 census row`);
    if (asset.surfaces?.master?.sha256 !== censusAsset.surfaces.master.sha256 || asset.surfaces?.runtime?.sha256 !== censusAsset.surfaces.runtime.sha256
        || asset.sourceReviews?.length !== 2 || asset.anchors?.length < 3 || asset.status !== 'TWO_PRIMARY_PIXEL_ANCHOR_CONSENSUS') fail(`${asset.pgId}: anchor consensus pixel binding or coverage mismatch`);
    const observations = new Map(censusAsset.primaryObservations.map((review) => [review.reviewId, review]));
    const reviewerIds = new Set(); const runIds = new Set();
    for (const source of asset.sourceReviews) {
      const observation = observations.get(source.reviewId);
      if (!observation || observation.confidence !== source.confidence || observation.reviewerInstanceId !== source.reviewerInstanceId
          || observation.voterReviewRunId !== source.voterReviewRunId) fail(`${asset.pgId}: anchor consensus source review is not authenticated`);
      reviewerIds.add(source.reviewerInstanceId); runIds.add(source.voterReviewRunId);
    }
    if (reviewerIds.size !== 2 || runIds.size !== 2) fail(`${asset.pgId}: anchor consensus reviews are not independent`);
    for (const anchor of asset.anchors) {
      if (anchor.sources?.length !== 2) fail(`${asset.pgId}: anchor consensus lacks two-source agreement`);
      for (const source of anchor.sources) {
        const observation = observations.get(source.reviewId)?.observation;
        const visible = [...(observation?.faceAnchors ?? []), ...(observation?.bodyAnchors ?? [])]
          .some((item) => item.visible && item.anchorId === anchor.anchorId && item.observation === source.description);
        if (!visible) fail(`${asset.pgId}: anchor consensus description is not present in authenticated visual vote`);
      }
    }
  }
  return new Map(anchorConsensus.assets.map((asset) => [asset.pgId, asset]));
}

function validateLockedTaxonomyConsensus(lockedTaxonomyConsensus, pixelById) {
  if (lockedTaxonomyConsensus?.schemaVersion !== 'g002-taxonomy-consensus-v1' || lockedTaxonomyConsensus.runId !== 'g002-v1'
      || lockedTaxonomyConsensus.state !== 'PASS' || lockedTaxonomyConsensus.completionAllowed !== true
      || lockedTaxonomyConsensus.requiredPrimaryReviewsPerAsset !== 2 || lockedTaxonomyConsensus.assets?.length !== 5) fail('locked G002 taxonomy consensus is missing or incomplete');
  const unsigned = structuredClone(lockedTaxonomyConsensus); delete unsigned.publicSignature;
  const core = structuredClone(unsigned); delete core.outputSha256;
  if (unsigned.outputSha256 !== sha256Canonical(core)) fail('locked G002 taxonomy consensus output hash mismatch');
  assertUnique(lockedTaxonomyConsensus.assets, (asset) => asset.pgId, 'locked taxonomy consensus PG ID');
  if (canonicalString(lockedTaxonomyConsensus.assets.map((asset) => asset.pgId).sort(compareText)) !== canonicalString(['PG-007', 'PG-028', 'PG-034', 'PG-041', 'PG-055'])) fail('locked taxonomy consensus target coverage mismatch');
  for (const asset of lockedTaxonomyConsensus.assets) {
    if (asset.status !== 'PASS' || !concreteTuple(asset.taxonomy) || Object.values(asset.taxonomy).some((value) => /^designed-/i.test(value))
        || !/^[a-f0-9]{64}$/.test(asset.packageManifestSha256)
        || asset.sourceReviewIds?.length !== 2 || new Set(asset.sourceReviewIds).size !== 2
        || asset.sourceReviewOutputSha256s?.length !== 2 || asset.sourceReviewOutputSha256s.some((digest) => !/^[a-f0-9]{64}$/.test(digest))
        || canonicalString(asset.anchors?.map((anchor) => anchor.anchorId).sort(compareText)) !== canonicalString(['body-silhouette', 'face-geometry', 'signature-organ'])
        || asset.anchors.some((anchor) => anchor.sources?.length !== 2
          || canonicalString(anchor.sources.map((source) => source.reviewId).sort(compareText)) !== canonicalString([...asset.sourceReviewIds].sort(compareText))
          || anchor.sources.some((source) => !asset.sourceReviewOutputSha256s.includes(source.reviewOutputSha256)
            || !/^[a-f0-9]{64}$/.test(source.rawVoteSha256) || typeof source.description !== 'string' || source.description.length < 3))) fail(`${asset.pgId}: locked taxonomy consensus proof is incomplete`);
    if (!pixelById.has(asset.pgId)) fail(`${asset.pgId}: locked taxonomy consensus lacks a pixel binding`);
  }
  return new Map(lockedTaxonomyConsensus.assets.map((asset) => [asset.pgId, asset]));
}

function validatePixelEvidence(pixelClusters, taxonomyConsensus) {
  if (pixelClusters?.schemaVersion !== 'continuity-pixel-shortlists-v1' || pixelClusters.policy?.biologicalApprovalAllowed !== false
      || pixelClusters.entries?.length !== 240) fail('pixel evidence input is missing or permits biological self-approval');
  assertUnique(pixelClusters.entries, (entry) => entry.pgId, 'pixel evidence PG ID');
  const consensusById = new Map(taxonomyConsensus.assets.map((item) => [item.pgId, item]));
  for (const entry of pixelClusters.entries) {
    const consensus = consensusById.get(entry.pgId) ?? fail(`${entry.pgId}: pixel evidence has no taxonomy census row`);
    for (const surface of ['master', 'runtime']) {
      const pixel = entry.surfaces?.[surface]; const expected = consensus.surfaces?.[surface];
      if (!pixel || pixel.sha256 !== expected?.sha256 || pixel.path !== (surface === 'runtime' ? expected.sourcePath : expected.path)
          || !pixel.features?.silhouetteSha256 || !pixel.features?.perceptualHash) fail(`${entry.pgId}: pixel ${surface} binding is stale or incomplete`);
    }
  }
  return new Map(pixelClusters.entries.map((entry) => [entry.pgId, entry]));
}

function scoreTarget(tuple, slotIds, consensusById, censusById) {
  let retained = 0; let totalConfidence = 0; let minimumConfidence = 1;
  for (const id of slotIds) {
    const consensus = consensusById.get(id);
    if (consensus?.disposition === 'reusable' && tupleKey(consensus.taxonomy) === tupleKey(tuple)) retained += 1;
    for (const observation of observationsFor(censusById.get(id))) {
      if (tupleKey(observation.tuple) === tupleKey(tuple)) {
        totalConfidence += observation.confidence;
        minimumConfidence = Math.min(minimumConfidence, observation.confidence);
      }
    }
  }
  return { retained, totalConfidence, minimumConfidence };
}

function targetCandidates(slotIds, consensusById, censusById) {
  const cleanCandidates = new Map(); const observedCandidates = new Map();
  for (const id of slotIds) {
    const clean = consensusById.get(id);
    const cleanTuple = clean?.disposition === 'reusable' ? concreteTuple(clean.taxonomy) : null;
    if (cleanTuple) cleanCandidates.set(tupleKey(cleanTuple), cleanTuple);
    for (const observation of observationsFor(censusById.get(id))) observedCandidates.set(tupleKey(observation.tuple), observation.tuple);
  }
  const candidates = cleanCandidates.size ? cleanCandidates : observedCandidates;
  return [...candidates.values()].map((tuple) => ({ tuple, ...scoreTarget(tuple, slotIds, consensusById, censusById) }))
    .sort((a, b) => b.minimumConfidence - a.minimumConfidence || b.totalConfidence - a.totalConfidence
      || b.retained - a.retained || compareText(tupleKey(a.tuple), tupleKey(b.tuple)));
}

function chooseFamilyTarget(rootId, slotIds, consensusById, censusById) {
  const candidates = targetCandidates(slotIds, consensusById, censusById);
  if (!candidates.length) return {
    rootId, targetStatus: 'pending-pixel-taxonomy', targetTaxonomy: null,
    selection: null, candidates: [],
    evidenceRequirement: { independentPrimaryPixelReviews: 2, requiredFields: [...TAXONOMY_FIELDS], minimumConfidence: 0.85 },
  };
  return { rootId, targetTaxonomy: taxonomyObject(candidates[0].tuple), selection: candidates[0], candidates };
}

function chooseActualPixelTarget(slotId, consensusById, censusById, lockedTaxonomyById) {
  const locked = lockedTaxonomyById.get(slotId);
  if (locked) return {
    targetTaxonomy: locked.taxonomy,
    rootPixelEvidence: {
      sourceKind: 'locked-independent-root-pixel-taxonomy', sourcePgId: slotId,
      sourceReviewIds: [...locked.sourceReviewIds], sourceReviewOutputSha256s: [...locked.sourceReviewOutputSha256s],
    },
  };
  const consensus = consensusById.get(slotId); const concreteConsensus = concreteTuple(consensus?.taxonomy);
  const observations = observationsFor(censusById.get(slotId));
  const selected = concreteConsensus
    ? observations.find((entry) => tupleKey(entry.tuple) === tupleKey(concreteConsensus)) ?? { tuple: concreteConsensus, confidence: 1, reviewId: 'g001-taxonomy-adjudication' }
    : [...observations].sort((a, b) => b.confidence - a.confidence || compareText(tupleKey(a.tuple), tupleKey(b.tuple)))[0];
  if (!selected?.tuple) fail(`${slotId}: stage-1 root lacks exact authenticated pixel taxonomy`);
  return {
    targetTaxonomy: taxonomyObject(selected.tuple),
    rootPixelEvidence: {
      sourceKind: 'authenticated-stage-1-root-pixel-taxonomy', sourcePgId: slotId,
      sourceReviewIds: selected.reviewId === 'g001-taxonomy-adjudication' ? [] : [selected.reviewId],
      selectedConfidence: selected.confidence,
    },
  };
}

function rootSets(catalog, parents) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const memo = new Map();
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) fail(`topology cycle at ${id}`);
    const slot = byId.get(id);
    if (slot.category === 'start') return new Set([id]);
    const result = new Set(); const next = new Set(stack).add(id);
    for (const parentId of parents.get(id)) for (const rootId of visit(parentId, next)) result.add(rootId);
    memo.set(id, result); return result;
  };
  return new Map(catalog.map((slot) => [slot.id, visit(slot.id)]));
}

function pairAlternative(rootA, rootB, familySlots, familyTargets, consensusById, censusById) {
  if (!familyTargets.get(rootA).targetTaxonomy || !familyTargets.get(rootB).targetTaxonomy) return {
    tuple: null, targetStatus: 'pending-pixel-taxonomy', regenerationCost: familySlots.get(rootA).length + familySlots.get(rootB).length,
    retained: 0, minimumConfidence: 0, totalConfidence: 0,
  };
  const candidates = new Map();
  const lockedTargets = [rootA, rootB].map((rootId) => familyTargets.get(rootId).lockedTaxonomyEvidence ? concreteTuple(familyTargets.get(rootId).targetTaxonomy) : null).filter(Boolean);
  if (new Set(lockedTargets.map(tupleKey)).size > 1) return {
    tuple: null, targetStatus: 'incompatible-locked-taxonomy', regenerationCost: familySlots.get(rootA).length + familySlots.get(rootB).length,
    retained: 0, minimumConfidence: 0, totalConfidence: 0,
  };
  if (lockedTargets.length) candidates.set(tupleKey(lockedTargets[0]), lockedTargets[0]);
  else for (const rootId of [rootA, rootB]) {
    for (const candidate of familyTargets.get(rootId).candidates) candidates.set(tupleKey(candidate.tuple), candidate.tuple);
  }
  return [...candidates.values()].map((tuple) => {
    const scoreA = scoreTarget(tuple, familySlots.get(rootA), consensusById, censusById);
    const scoreB = scoreTarget(tuple, familySlots.get(rootB), consensusById, censusById);
    return {
      tuple, regenerationCost: familySlots.get(rootA).length + familySlots.get(rootB).length - scoreA.retained - scoreB.retained,
      retained: scoreA.retained + scoreB.retained,
      minimumConfidence: Math.min(scoreA.minimumConfidence, scoreB.minimumConfidence),
      totalConfidence: scoreA.totalConfidence + scoreB.totalConfidence,
    };
  }).sort((a, b) => b.minimumConfidence - a.minimumConfidence || b.totalConfidence - a.totalConfidence
    || a.regenerationCost - b.regenerationCost || compareText(tupleKey(a.tuple), tupleKey(b.tuple)))[0];
}

function solvePairing(portIds, currentPairKeys, familySlots, familyTargets, consensusById, censusById) {
  const memo = new Map();
  const solve = (remaining) => {
    const state = [...remaining].sort(compareText); const key = state.join('|');
    if (!state.length) return { minimumConfidence: 1, totalConfidence: 0, cost: 0, retainedEdges: 0, canonical: '', pairs: [] };
    if (memo.has(key)) return memo.get(key);
    const first = state[0]; let best = null;
    for (let index = 1; index < state.length; index += 1) {
      const second = state[index];
      const rest = state.filter((_, itemIndex) => itemIndex !== 0 && itemIndex !== index);
      const tail = solve(rest);
      const alternative = pairAlternative(first, second, familySlots, familyTargets, consensusById, censusById);
      const pairKey = [first, second].sort(compareText).join('+');
      const candidate = {
        minimumConfidence: Math.min(alternative.minimumConfidence, tail.minimumConfidence),
        totalConfidence: alternative.totalConfidence + tail.totalConfidence,
        cost: alternative.regenerationCost + tail.cost,
        retainedEdges: (currentPairKeys.has(pairKey) ? 1 : 0) + tail.retainedEdges,
        canonical: `${pairKey}:${tupleKey(alternative.tuple)}|${tail.canonical}`,
        pairs: [{ roots: [first, second].sort(compareText), ...alternative }, ...tail.pairs],
      };
      if (!best || candidate.minimumConfidence > best.minimumConfidence
          || (candidate.minimumConfidence === best.minimumConfidence && candidate.totalConfidence > best.totalConfidence)
          || (candidate.minimumConfidence === best.minimumConfidence && candidate.totalConfidence === best.totalConfidence && candidate.cost < best.cost)
          || (candidate.minimumConfidence === best.minimumConfidence && candidate.totalConfidence === best.totalConfidence && candidate.cost === best.cost && candidate.retainedEdges > best.retainedEdges)
          || (candidate.minimumConfidence === best.minimumConfidence && candidate.totalConfidence === best.totalConfidence && candidate.cost === best.cost && candidate.retainedEdges === best.retainedEdges && compareText(candidate.canonical, best.canonical) < 0)) best = candidate;
    }
    memo.set(key, best); return best;
  };
  return solve(portIds);
}

function rebuildTopology(catalog, parents) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const children = new Map(catalog.map((item) => [item.id, []]));
  for (const [childId, parentIds] of parents) for (const parentId of parentIds) children.get(parentId).push(childId);
  for (const values of children.values()) values.sort(compareText);
  const roots = catalog.filter((item) => item.category === 'start').sort((a, b) => compareText(a.id, b.id));
  const rootProfiles = roots.map((root) => {
    const visited = new Set([root.id]); const queue = [root.id]; const choiceStages = [];
    while (queue.length) {
      const currentId = queue.shift(); const current = byId.get(currentId);
      const selectable = children.get(currentId).filter((id) => byId.get(id).category !== 'mutant');
      if (selectable.length > 2) fail(`${currentId}: more than two selectable candidates after pairing`);
      if (selectable.length > 1) choiceStages.push(current.stage);
      for (const childId of selectable) if (!visited.has(childId)) { visited.add(childId); queue.push(childId); }
    }
    if (choiceStages.length > 1) fail(`${root.id}: more than one choice node after pairing`);
    const stages = [...visited].map((id) => byId.get(id).stage);
    const cardsPerStage = Object.fromEntries([1, 2, 3, 4].map((stage) => [stage, stages.filter((value) => value === stage).length]));
    if (visited.size > 6 || Math.max(...stages) > 4 || Math.max(...Object.values(cardsPerStage)) > 3) fail(`${root.id}: topology ceiling exceeded`);
    return {
      rootId: root.id, profile: choiceStages[0] === 1 ? 'stageOneChoice' : choiceStages[0] === 2 ? 'stageTwoChoice' : 'noChoice',
      choiceStages, reachableSlotIds: [...visited].sort(compareText), maxStage: Math.max(...stages), cardsTotal: visited.size, cardsPerStage,
    };
  });
  const choiceProfile = Object.fromEntries(Object.keys(EXPECTED_CHOICE_PROFILE).map((key) => [key, rootProfiles.filter((item) => item.profile === key).length]));
  assertCounts(choiceProfile, EXPECTED_CHOICE_PROFILE, 'topology-after choice profile');
  const edges = catalog.flatMap((child) => parents.get(child.id).map((parentId) => ({
    parentId, childId: child.id, category: child.category,
    parentPort: `${byId.get(parentId).lineageId}:S${byId.get(parentId).stage}`,
    eitherParentEligible: child.category === 'mixed',
  })));
  if (edges.length !== EXPECTED_COUNTS.edges) fail('topology-after edge count mismatch');
  return {
    schemaVersion: 'continuity-topology-after-v1',
    counts: { slots: 240, roots: 60, edges: 190, categories: EXPECTED_COUNTS.categories, choiceProfile },
    constraints: { maxStages: 4, maxCardsTotal: 6, maxCardsPerStage: 3, maxChoiceNodesPerPath: 1, maxSelectableCandidates: 2, mixedSemantics: 'either-parent' },
    rootSlotIds: roots.map((item) => item.id), edges, roots: rootProfiles,
    slots: catalog.map((slot) => ({ id: slot.id, category: slot.category, stage: slot.stage, rarity: slot.rarity, parentIds: [...parents.get(slot.id)] })),
  };
}

function generationQueue(catalog, parents, targetBySlot, targetStatusBySlot, targetSourceBySlot, canonicalTargetSource, anchorBlueprintBySlot, clarificationBySlot, regenerate, reasons, censusById, anchorById, consensusById) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const children = new Map(catalog.map((item) => [item.id, []]));
  const indegree = new Map(catalog.map((item) => [item.id, 0]));
  for (const [childId, parentIds] of parents) for (const parentId of parentIds) {
    children.get(parentId).push(childId); indegree.set(childId, indegree.get(childId) + 1);
  }
  const ready = catalog.filter((item) => indegree.get(item.id) === 0).map((item) => item.id).sort(compareText);
  const order = [];
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const childId of children.get(id).sort(compareText)) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) { ready.push(childId); ready.sort(compareText); }
    }
  }
  if (order.length !== catalog.length) fail('generation topology is cyclic');
  const anchorsBySlot = new Map(catalog.map((slot) => [slot.id, anchorBlueprintBySlot.get(slot.id) ?? visualAnchors(anchorById.get(slot.id))]));
  return order.filter((id) => regenerate.has(id)).map((slotId, queueIndex) => {
    const slot = byId.get(slotId); const parentIds = parents.get(slotId);
    const parentReferences = parentIds.map((parentId, parentIndex) => {
      const parentAsset = censusById.get(parentId);
      const parentRole = `parent-${parentIndex + 1}`;
      if (regenerate.has(parentId)) return {
        parentRole, parentId, sourceKind: 'generated-parent-candidate', dependencySlotId: parentId,
        dependencyCandidateId: `g003-candidate:${parentId}`, requiredParentCandidateId: `g003-candidate:${parentId}`, requiredCandidateReviewState: 'PASS',
        approvedParentReviewSha256: null, approvedParentPixelSha256s: null,
      };
      if (tupleKey(consensusById.get(parentId)?.taxonomy) !== tupleKey(targetBySlot.get(parentId))) fail(`${parentId}: retained parent pixel taxonomy differs from its frozen target`);
      return {
        parentRole, parentId, sourceKind: 'existing-image', imagePath: parentAsset.surfaces.master.path,
        imageSha256: parentAsset.surfaces.master.sha256,
        pixelSha256s: [parentAsset.surfaces.master.sha256, parentAsset.surfaces.runtime.sha256],
      };
    });
    const inheritedAnchorContracts = parentIds.flatMap((parentId, parentIndex) => {
      const parentRole = `parent-${parentIndex + 1}`;
      return anchorsBySlot.get(parentId).map((anchor) => regenerate.has(parentId)
        ? {
          anchorKey: `${parentId}:${anchor.anchorId}`, parentRole, parentId, anchorId: anchor.anchorId,
          description: null, sourceReviewId: null, sourceConfidence: null,
          sourceKind: 'generated-parent-candidate', dependencyCandidateId: `g003-candidate:${parentId}`,
          resolutionState: 'PENDING_APPROVED_PARENT_REVIEW',
        }
        : {
          anchorKey: `${parentId}:${anchor.anchorId}`, parentRole, parentId, anchorId: anchor.anchorId,
          description: anchor.description, sourceReviewId: anchor.sourceReviewId, sourceConfidence: anchor.sourceConfidence,
          sourceKind: 'retained-parent-pixels', dependencyCandidateId: null, resolutionState: 'RESOLVED_AUTHENTICATED_PIXELS',
        });
    });
    const inheritedAnchors = inheritedAnchorContracts.filter((anchor) => anchor.description !== null);
    const canonicalTarget = targetSourceBySlot.get(slotId) === canonicalTargetSource;
    const clarifications = clarificationBySlot.get(slotId) ?? [];
    const designAnchors = parentIds.length ? [] : anchorsBySlot.get(slotId).map((anchor) => ({
      ...anchor,
      anchorKey: `${slotId}:${anchor.anchorId}`,
      sourceKind: canonicalTarget ? canonicalTargetSource : 'authenticated-root-pixels',
      resolutionState: canonicalTarget ? 'RESOLVED_SIGNED_CANONICAL_REDESIGN_TARGET' : 'RESOLVED_AUTHENTICATED_PIXELS',
    }));
    const anchorContracts = parentIds.length ? inheritedAnchorContracts : designAnchors;
    const unresolvedParentAnchors = anchorContracts.filter((anchor) => anchor.description === null);
    return {
      slotId, operation: `REGEN(${slotId})`, generationOrder: queueIndex + 1,
      frozen: { category: slot.category, stage: slot.stage, rarity: slot.rarity },
      targetStatus: targetStatusBySlot.get(slotId), exactTaxonomyTarget: targetBySlot.get(slotId),
      taxonomyTargetSource: targetSourceBySlot.get(slotId),
      visibilityClarificationRequirements: clarifications,
      taxonomyEvidenceRequirement: targetBySlot.get(slotId) ? null : { independentPrimaryPixelReviews: 2, requiredFields: [...TAXONOMY_FIELDS], minimumConfidence: 0.85 },
      generationState: unresolvedParentAnchors.length ? 'BLOCKED_PENDING_PARENT_CANDIDATE_APPROVAL' : 'READY_FOR_GENERATION',
      parentIds, parentReferences,
      designAnchors, inheritedAnchors, inheritedAnchorContracts,
      allowedReviewerAnchorIds: anchorContracts.map((anchor) => anchor.anchorKey).sort(compareText),
      allowedAdditiveDeltas: [{ deltaId: `stage-${slot.stage}-refinement`, description: `Add stage-${slot.stage} detail without changing taxonomy, locomotion, or inherited structures.` }],
      reviewRequirement: { independentPrimaryReviews: 2, minimumConfidence: 0.96, sameCreatureRequired: true, parentCandidateApprovalsRequired: parentReferences.filter((reference) => reference.sourceKind === 'generated-parent-candidate').map((reference) => reference.dependencyCandidateId) },
      reasonCodes: [...reasons.get(slotId)].sort(compareText),
      deterministicPrompt: unresolvedParentAnchors.length
        ? `Do not generate slot ${slotId} yet. Exact target taxonomy from ${targetSourceBySlot.get(slotId)}: ${TAXONOMY_FIELDS.map((field) => `${field}=${targetBySlot.get(slotId)[field]}`).join(', ')}. Resolve ${unresolvedParentAnchors.map((item) => item.anchorKey).join(', ')} only from the approved generated-parent candidate reviews ${[...new Set(unresolvedParentAnchors.map((item) => item.dependencyCandidateId))].join(', ')}; old slot pixels and descriptions are forbidden.${clarifications.length ? ` Visibility clarification: ${clarifications.join('; ')}.` : ''}`
        : `Generate slot ${slotId} in order ${queueIndex + 1}. Exact target taxonomy from ${targetSourceBySlot.get(slotId)}: ${TAXONOMY_FIELDS.map((field) => `${field}=${targetBySlot.get(slotId)[field]}`).join(', ')}. Preserve immutable anchors ${anchorContracts.map((item) => `${item.anchorKey} (${item.description})`).join('; ')}.${clarifications.length ? ` Visibility clarification: ${clarifications.join('; ')}.` : ''}`,
    };
  });
}

export function solveContinuityAssignment({ catalog, census, conflictLedger, taxonomyConsensus, pixelClusters, anchorConsensus, lockedTaxonomyConsensus, canonicalRootRedesignTargets, canonicalAuthorityResolver = resolveCanonicalRootAuthorityV1, baselineCatalog = catalog, topologyContract, pins, signedObligationScope = null }) {
  assertFrozenTopology(catalog, baselineCatalog);
  if (!taxonomyConsensus || !pixelClusters || !anchorConsensus || !lockedTaxonomyConsensus || !canonicalRootRedesignTargets || !topologyContract || !pins) fail('locked taxonomy, pixel evidence, pixel-anchor consensus, reviewed taxonomy consensus, signed canonical redesign targets, topology, and pin inputs are required');
  const pixelById = validatePixelEvidence(pixelClusters, taxonomyConsensus);
  const anchorById = validateAnchorConsensus(anchorConsensus, census);
  const lockedTaxonomyById = validateLockedTaxonomyConsensus(lockedTaxonomyConsensus, pixelById);
  const canonicalContract = canonicalAuthorityResolver(canonicalRootRedesignTargets);
  const canonicalTargetSource = canonicalContract.targetSource;
  const canonicalTargetByRoot = canonicalContract.byRootId;
  const canonicalBefore = buildTopology(catalog);
  if (canonicalString(canonicalBefore) !== canonicalString(topologyContract)) fail('topology-before differs from catalog reconstruction');
  const censusById = new Map(census.assets.map((item) => [item.pgId, item]));
  const consensusById = new Map(taxonomyConsensus.assets.map((item) => [item.pgId, item]));
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const parents = new Map(catalog.map((slot) => [slot.id, parentIdsFor(slot, catalog)]));
  const beforeParents = new Map([...parents].map(([id, values]) => [id, [...values]]));
  const rootsBefore = rootSets(catalog, parents);
  const familySlots = new Map(catalog.filter((item) => item.category === 'start').map((root) => [root.id, []]));
  for (const slot of catalog.filter((item) => item.category !== 'mixed')) {
    const roots = rootsBefore.get(slot.id);
    if (roots.size !== 1) fail(`${slot.id}: single-parent slot has ${roots.size} roots`);
    familySlots.get([...roots][0]).push(slot.id);
  }
  for (const values of familySlots.values()) values.sort(compareText);
  let familyTargets = new Map([...familySlots].map(([rootId, slots]) => [rootId, chooseFamilyTarget(rootId, slots, consensusById, censusById)]));
  for (const [rootId, evidence] of lockedTaxonomyById) {
    if (!['PG-007', 'PG-028'].includes(rootId)) continue;
    const tuple = concreteTuple(evidence.taxonomy);
    familyTargets.set(rootId, {
      rootId, targetStatus: 'exact', targetTaxonomy: evidence.taxonomy,
      selection: { tuple, ...scoreTarget(tuple, familySlots.get(rootId), consensusById, censusById) },
      candidates: [{ tuple, ...scoreTarget(tuple, familySlots.get(rootId), consensusById, censusById) }],
      lockedTaxonomyEvidence: {
        consensusOutputSha256: lockedTaxonomyConsensus.outputSha256,
        sourcePgId: evidence.pgId,
        sourceReviewIds: [...evidence.sourceReviewIds],
        sourceReviewOutputSha256s: [...evidence.sourceReviewOutputSha256s],
      },
    });
  }
  for (const [rootId, contract] of canonicalTargetByRoot) {
    const tuple = concreteTuple(contract.canonicalTarget);
    familyTargets.set(rootId, {
      rootId, targetStatus: 'exact', targetTaxonomy: contract.canonicalTarget,
      selection: { tuple, ...scoreTarget(tuple, familySlots.get(rootId), consensusById, censusById) },
      candidates: [{ tuple, ...scoreTarget(tuple, familySlots.get(rootId), consensusById, censusById) }],
      canonicalRedesignEvidence: { contractOutputSha256: canonicalContract.outputSha256, sourceRootId: rootId },
    });
  }

  const fixturePins = pins.fixtures ?? [];
  if (fixturePins.length !== 6) fail('exactly six diagnostic pins are required');
  if (canonicalString(pins.positiveControl?.slotIds) !== canonicalString(['PG-001', 'PG-061', 'PG-181'])) fail('Eilu positive-control contract mismatch');
  const pinnedMixed = new Set(fixturePins.flatMap((pin) => pin.slotIds).filter((id) => catalogById.get(id)?.category === 'mixed'));
  const mixedSlots = catalog.filter((item) => item.category === 'mixed').sort((a, b) => compareText(a.id, b.id));
  const pairBySlot = new Map();
  for (const slot of mixedSlots.filter((item) => pinnedMixed.has(item.id))) {
    const portRoots = beforeParents.get(slot.id).map((parentId) => [...rootsBefore.get(parentId)][0]);
    const alternative = pairAlternative(portRoots[0], portRoots[1], familySlots, familyTargets, consensusById, censusById);
    pairBySlot.set(slot.id, { roots: portRoots, parentIds: [...beforeParents.get(slot.id)], ...alternative });
  }
  for (const childStage of [2, 3]) {
    const slots = mixedSlots.filter((item) => item.stage === childStage && !pinnedMixed.has(item.id));
    const lockedRoots = new Set(mixedSlots.filter((item) => item.stage === childStage && pinnedMixed.has(item.id))
      .flatMap((slot) => beforeParents.get(slot.id).map((parentId) => [...rootsBefore.get(parentId)][0])));
    const portByRoot = new Map();
    for (const slot of mixedSlots.filter((item) => item.stage === childStage)) for (const parentId of beforeParents.get(slot.id)) {
      const rootId = [...rootsBefore.get(parentId)][0];
      if (portByRoot.has(rootId)) fail(`${rootId}: duplicate mixed port`);
      portByRoot.set(rootId, parentId);
    }
    const availableRoots = [...portByRoot.keys()].filter((rootId) => !lockedRoots.has(rootId)).sort(compareText);
    const currentPairKeys = new Set(slots.map((slot) => beforeParents.get(slot.id).map((parentId) => [...rootsBefore.get(parentId)][0]).sort(compareText).join('+')));
    const paired = solvePairing(availableRoots, currentPairKeys, familySlots, familyTargets, consensusById, censusById);
    const pairs = paired.pairs.sort((a, b) => compareText(a.roots.join('+'), b.roots.join('+')));
    if (pairs.length !== slots.length) fail(`stage ${childStage}: mixed pairing coverage mismatch`);
    for (let index = 0; index < slots.length; index += 1) {
      const pair = pairs[index];
      pairBySlot.set(slots[index].id, { ...pair, parentIds: pair.roots.map((rootId) => portByRoot.get(rootId)) });
    }
  }
  for (const [slotId, pair] of pairBySlot) {
    parents.set(slotId, pair.parentIds);
  }
  const legacyFamilyTargets = new Map([...familyTargets].map(([rootId, target]) => [rootId, { ...target }]));
  for (const [slotId, pair] of pairBySlot) if (pair.tuple) for (const rootId of pair.roots) {
    legacyFamilyTargets.set(rootId, { ...legacyFamilyTargets.get(rootId), targetTaxonomy: taxonomyObject(pair.tuple), pairedFor: slotId });
  }
  const legacyTargetBySlot = new Map();
  for (const [rootId, slotIds] of familySlots) for (const slotId of slotIds) legacyTargetBySlot.set(slotId, legacyFamilyTargets.get(rootId).targetTaxonomy ?? null);
  for (const [slotId, pair] of pairBySlot) legacyTargetBySlot.set(slotId, pair.tuple ? taxonomyObject(pair.tuple) : null);
  familyTargets = new Map([...familySlots].map(([rootId, slotIds]) => {
    const canonical = canonicalTargetByRoot.get(rootId);
    if (canonical) return [rootId, {
      rootId, targetStatus: 'exact', targetTaxonomy: selectCanonicalRootTarget(rootId, null, canonicalTargetByRoot),
      rootPixelEvidence: chooseActualPixelTarget(rootId, consensusById, censusById, lockedTaxonomyById).rootPixelEvidence,
      lockedTaxonomyEvidence: null,
      canonicalRedesignEvidence: {
        contractOutputSha256: canonicalContract.outputSha256, sourceRootId: rootId,
        currentPixelAssessment: canonical.currentPixelAssessment,
        reviewerProvenanceIds: [...canonicalContract.reviewerProvenanceIds],
        architectApprovalSource: canonicalContract.architectApprovalSource,
        clarificationRequirements: [...canonical.clarificationRequirements],
      },
      slots: slotIds,
    }];
    const frozen = chooseActualPixelTarget(rootId, consensusById, censusById, lockedTaxonomyById);
    const locked = lockedTaxonomyById.get(rootId);
    return [rootId, {
      rootId, targetStatus: 'exact', targetTaxonomy: frozen.targetTaxonomy, rootPixelEvidence: frozen.rootPixelEvidence,
      lockedTaxonomyEvidence: locked ? {
        consensusOutputSha256: lockedTaxonomyConsensus.outputSha256, sourcePgId: locked.pgId,
        sourceReviewIds: [...locked.sourceReviewIds], sourceReviewOutputSha256s: [...locked.sourceReviewOutputSha256s],
      } : null,
      slots: slotIds,
    }];
  }));

  const targetBySlot = new Map(); const targetStatusBySlot = new Map();
  const targetSourceBySlot = new Map(); const anchorBlueprintBySlot = new Map(); const clarificationBySlot = new Map();
  for (const [rootId, slotIds] of familySlots) for (const slotId of slotIds) {
    const target = familyTargets.get(rootId).targetTaxonomy;
    targetBySlot.set(slotId, target); targetStatusBySlot.set(slotId, target ? 'exact' : 'pending-pixel-taxonomy');
    const canonical = canonicalTargetByRoot.get(rootId);
    targetSourceBySlot.set(slotId, canonical ? canonicalTargetSource : 'authenticated-stage-1-root-pixels');
    if (canonical) anchorBlueprintBySlot.set(slotId, canonical.anchors.map((anchor) => ({
      ...anchor, sourceReviewId: `canonical-root-redesign:${rootId}`, sourceConfidence: 1,
    })));
    if (canonical) clarificationBySlot.set(slotId, [
      ...canonical.clarificationRequirements,
      canonicalContract.visibilityPolicy.surfaceRequirement,
      canonicalContract.visibilityPolicy.appendageCountingRule,
      canonicalContract.visibilityPolicy.ambiguityRule,
      canonicalContract.visibilityPolicy.preservationRule,
    ]);
  }
  for (const [slotId, pair] of pairBySlot) {
    const mixedTarget = targetBySlot.get(pair.parentIds[0]);
    if (!mixedTarget) fail(`${slotId}: mixed target lacks an exact authenticated parent-root taxonomy`);
    targetBySlot.set(slotId, mixedTarget);
    targetStatusBySlot.set(slotId, 'exact');
    targetSourceBySlot.set(slotId, targetSourceBySlot.get(pair.parentIds[0]));
    if (anchorBlueprintBySlot.has(pair.parentIds[0])) anchorBlueprintBySlot.set(slotId, anchorBlueprintBySlot.get(pair.parentIds[0]));
    if (clarificationBySlot.has(pair.parentIds[0])) clarificationBySlot.set(slotId, clarificationBySlot.get(pair.parentIds[0]));
  }
  if (targetBySlot.size !== 240 || [...targetBySlot.values()].some((target) => target && !concreteTuple(target))) fail('target coverage contains an invalid or unknown taxonomy');

  const regenerate = new Set(); const reasons = new Map(catalog.map((slot) => [slot.id, new Set()]));
  for (const slot of catalog) {
    const legacyTarget = legacyTargetBySlot.get(slot.id); const consensus = consensusById.get(slot.id);
    if (!legacyTarget || consensus.disposition !== 'reusable' || tupleKey(consensus.taxonomy) !== tupleKey(legacyTarget)
        || pixelById.get(slot.id).disposition !== consensus.disposition) {
      regenerate.add(slot.id); reasons.get(slot.id).add('pre-root-freeze-regeneration-floor');
    }
  }
  for (const slot of catalog) {
    const consensus = consensusById.get(slot.id);
    if (!targetBySlot.get(slot.id)) { regenerate.add(slot.id); reasons.get(slot.id).add('pending-independent-pixel-taxonomy'); }
    if (consensus.disposition !== 'reusable') { regenerate.add(slot.id); reasons.get(slot.id).add(`input-disposition:${consensus.disposition}`); }
    if (targetBySlot.get(slot.id) && tupleKey(consensus.taxonomy) !== tupleKey(targetBySlot.get(slot.id))) { regenerate.add(slot.id); reasons.get(slot.id).add('family-taxonomy-mismatch'); }
    if (pixelById.get(slot.id).disposition !== consensus.disposition) { regenerate.add(slot.id); reasons.get(slot.id).add('pixel-disposition-mismatch'); }
  }
  for (const rootId of canonicalTargetByRoot.keys()) {
    regenerate.add(rootId); reasons.get(rootId).add(canonicalTargetSource);
  }
  const blockedEdgeChildren = new Set(conflictLedger.conflicts.filter((item) => item.kind === 'edge').map((item) => item.child.pgId));
  for (const childId of blockedEdgeChildren) { regenerate.add(childId); reasons.get(childId).add('g001-blocked-edge'); }
  for (const slot of mixedSlots) {
    if (canonicalString(beforeParents.get(slot.id).sort(compareText)) !== canonicalString(parents.get(slot.id).sort(compareText))) {
      regenerate.add(slot.id); reasons.get(slot.id).add('mixed-parent-repair');
    }
  }
  const children = new Map(catalog.map((item) => [item.id, []]));
  for (const [childId, parentIds] of parents) for (const parentId of parentIds) children.get(parentId).push(childId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const parentId of [...regenerate].sort(compareText)) for (const childId of children.get(parentId)) {
      if (!regenerate.has(childId)) {
        regenerate.add(childId); reasons.get(childId).add(`new-edge-from-regenerated-parent:${parentId}`); changed = true;
      }
    }
  }
  for (const slot of catalog) if (regenerate.has(slot.id) && reasons.get(slot.id).size === 0) reasons.get(slot.id).add('fixed-point-dependent-regeneration');

  const assignments = catalog.map((slot) => {
    const consensus = consensusById.get(slot.id); const censusAsset = censusById.get(slot.id);
    const pixel = pixelById.get(slot.id);
    const base = {
      slotId: slot.id, targetStatus: targetStatusBySlot.get(slot.id), targetTaxonomy: targetBySlot.get(slot.id),
      targetEvidence: { targetSource: targetSourceBySlot.get(slot.id), canonicalContractOutputSha256: targetSourceBySlot.get(slot.id) === canonicalTargetSource ? canonicalContract.outputSha256 : null,
        pixelEntryPgId: slot.id, masterSha256: pixel.surfaces.master.sha256, runtimeSha256: pixel.surfaces.runtime.sha256, visualReviewIds: censusAsset.primaryObservations.map((review) => review.reviewId).sort(compareText) },
    };
    if (regenerate.has(slot.id)) return { ...base, source: `REGEN(${slot.id})`, sourceKind: 'regenerate', assetSha256: null };
    if (!base.targetTaxonomy || consensus.disposition !== 'reusable' || pixel.disposition !== 'reusable' || tupleKey(consensus.taxonomy) !== tupleKey(base.targetTaxonomy)) fail(`${slot.id}: unsafe retained assignment`);
    return { ...base, source: slot.id, sourceKind: 'existing', assetSha256: censusAsset.surfaces.master.sha256 };
  });
  assertUnique(assignments.filter((item) => item.sourceKind === 'existing'), (item) => item.assetSha256, 'retained hash');

  const topology = rebuildTopology(catalog, parents);
  const edges = topology.edges.map((edge) => {
    const parentTarget = targetBySlot.get(edge.parentId); const childTarget = targetBySlot.get(edge.childId);
    const mixedEdge = catalogById.get(edge.childId).category === 'mixed';
    const compatible = Boolean(parentTarget && childTarget && (mixedEdge || tupleKey(parentTarget) === tupleKey(childTarget)));
    const compatibilityStatus = compatible ? mixedEdge ? 'VERIFIED_MIXED_PARENT_ANCHOR_CONTRACT' : 'VERIFIED_PIXEL_VOTE_TARGET'
      : (!parentTarget || !childTarget) ? 'PENDING_PIXEL_TAXONOMY' : 'INCOMPATIBLE';
    if (compatibilityStatus === 'INCOMPATIBLE') fail(`${edge.parentId}=>${edge.childId}: incompatible final target`);
    return { ...edge, targetCompatible: compatible, compatibilityStatus };
  });
  topology.edges = edges;
  topology.mixedProof = mixedSlots.map((slot) => ({
    slotId: slot.id, parentIds: [...parents.get(slot.id)], targetStatus: targetStatusBySlot.get(slot.id), targetTaxonomy: targetBySlot.get(slot.id),
    eitherParentBehavior: true, requiredAnchorsPerParent: 2,
    parentTargets: parents.get(slot.id).map((parentId) => ({ parentId, targetTaxonomy: targetBySlot.get(parentId) })),
    exactCompatible: Boolean(targetBySlot.get(slot.id)) && parents.get(slot.id).every((parentId) => targetBySlot.get(parentId)),
    compatibilityBasis: 'MIXED_BOTH_PARENT_ANCHOR_CONTRACT',
    reviewStatus: 'PENDING_G003_COMPARATIVE_REVIEW',
  }));

  const queue = generationQueue(catalog, parents, targetBySlot, targetStatusBySlot, targetSourceBySlot, canonicalTargetSource, anchorBlueprintBySlot, clarificationBySlot, regenerate, reasons, censusById, anchorById, consensusById);
  const familyProofs = [...familySlots].map(([rootId, slotIds]) => ({
    rootId, targetStatus: familyTargets.get(rootId).targetTaxonomy ? 'exact' : 'pending-pixel-taxonomy', targetTaxonomy: familyTargets.get(rootId).targetTaxonomy,
    taxonomyEvidenceRequirement: familyTargets.get(rootId).evidenceRequirement ?? null,
    lockedTaxonomyEvidence: familyTargets.get(rootId).lockedTaxonomyEvidence ?? null,
    canonicalRedesignEvidence: familyTargets.get(rootId).canonicalRedesignEvidence ?? null,
    rootPixelEvidence: familyTargets.get(rootId).rootPixelEvidence,
    slots: slotIds.map((slotId) => ({ slotId, targetStatus: targetStatusBySlot.get(slotId), targetTaxonomy: targetBySlot.get(slotId), disposition: regenerate.has(slotId) ? 'REGEN' : 'RETAIN' })),
    edgeIds: topology.edges.filter((edge) => slotIds.includes(edge.parentId) && slotIds.includes(edge.childId)).map((edge) => edgeKey([edge.parentId], edge.childId)),
    exactCompatible: Boolean(familyTargets.get(rootId).targetTaxonomy) && slotIds.every((slotId) => targetBySlot.get(slotId) && tupleKey(targetBySlot.get(slotId)) === tupleKey(familyTargets.get(rootId).targetTaxonomy)),
    proofStatus: familyTargets.get(rootId).canonicalRedesignEvidence ? 'TARGET_FROM_SIGNED_CANONICAL_ROOT_REDESIGN_CONTRACT'
      : familyTargets.get(rootId).lockedTaxonomyEvidence ? 'TARGET_FROZEN_FROM_LOCKED_STAGE_1_ROOT_PIXELS'
        : 'TARGET_FROZEN_FROM_AUTHENTICATED_STAGE_1_ROOT_PIXELS',
  })).sort((a, b) => compareText(a.rootId, b.rootId));
  const eiluIds = pins.positiveControl.slotIds;
  if (eiluIds.some((id) => regenerate.has(id)) || eiluIds.some((id) => tupleKey(targetBySlot.get(id)) !== tupleKey(targetBySlot.get('PG-001')))) fail('Eilu positive-control baseline assets failed');
  const eiluAssets = eiluIds.map((id) => censusById.get(id));
  const eiluAnchorAssets = eiluIds.map((id) => anchorById.get(id));
  const eiluBenchmark = {
    benchmarkId: 'eilu-comparative-visual-v1', assetIds: eiluIds,
    minimumConfidence: Math.min(...eiluAssets.flatMap((asset) => asset.primaryObservations.map((review) => review.confidence))),
    minimumRetainedAnchorCount: Math.min(...eiluAnchorAssets.map((asset) => visualAnchors(asset).length)),
    minimumAnchorRetentionRatio: 1,
    comparisonRequirements: { sameCreatureGrownUp: 'yes', compareAgainstBenchmark: true, candidateConfidenceAtLeastBenchmark: true },
    pixelBindings: eiluIds.map((id) => ({ pgId: id, masterSha256: pixelById.get(id).surfaces.master.sha256, runtimeSha256: pixelById.get(id).surfaces.runtime.sha256 })),
  };
  const coverageAnchor = (anchor) => ({
    anchorKey: anchor.anchorKey, parentRole: anchor.parentRole ?? null, parentId: anchor.parentId ?? null,
    anchorId: anchor.anchorId, description: anchor.description, sourceReviewId: anchor.sourceReviewId,
    sourceConfidence: anchor.sourceConfidence, resolutionState: anchor.resolutionState,
    dependencyCandidateId: anchor.dependencyCandidateId ?? null,
  });
  const parentCoverage = (parentId, childId) => {
    const childParents = parents.get(childId); const parentRole = `parent-${childParents.indexOf(parentId) + 1}`;
    const parentRegenerated = regenerate.has(parentId);
    const parentAnchors = anchorBlueprintBySlot.get(parentId) ?? visualAnchors(anchorById.get(parentId));
    const anchors = parentRegenerated
      ? parentAnchors.map((anchor) => coverageAnchor({
        ...anchor, anchorKey: `${parentId}:${anchor.anchorId}`, parentRole, parentId,
        description: null, sourceReviewId: null, sourceConfidence: null,
        resolutionState: 'PENDING_APPROVED_PARENT_REVIEW', dependencyCandidateId: `g003-candidate:${parentId}`,
      }))
      : parentAnchors.map((anchor) => coverageAnchor({
        ...anchor, anchorKey: `${parentId}:${anchor.anchorId}`, parentRole, parentId,
        resolutionState: 'RESOLVED_AUTHENTICATED_PIXELS', dependencyCandidateId: null,
      }));
    return {
      parentRole, parentId, sourceKind: parentRegenerated ? 'generated-parent-candidate' : 'retained-parent-pixels',
      approvedParentCandidateId: parentRegenerated ? `g003-candidate:${parentId}` : null,
      approvedParentReviewSha256: null,
      parentPixelSha256s: parentRegenerated ? null : [pixelById.get(parentId).surfaces.master.sha256, pixelById.get(parentId).surfaces.runtime.sha256],
      anchors,
    };
  };

  const reviewCoverage = {
    schemaVersion: 'continuity-g003-review-gate-v1', state: 'PENDING_G003_REVIEW', completionAllowed: false,
    eiluBenchmark,
    queueCandidates: queue.map((entry) => ({
      candidateId: `g003-candidate:${entry.slotId}`, slotId: entry.slotId,
      status: 'PENDING_COMPARATIVE_VISUAL_REVIEW',
      allowedAnchorIds: entry.allowedReviewerAnchorIds,
      allowedAnchors: (entry.parentIds.length ? entry.inheritedAnchorContracts : entry.designAnchors).map(coverageAnchor),
      requiredParentCandidateIds: entry.parentReferences.filter((reference) => reference.sourceKind === 'generated-parent-candidate').map((reference) => reference.dependencyCandidateId),
      eiluBenchmarkId: eiluBenchmark.benchmarkId,
      comparisonThresholds: { minimumConfidence: eiluBenchmark.minimumConfidence, minimumAnchorRetentionRatio: eiluBenchmark.minimumAnchorRetentionRatio, sameCreatureGrownUp: 'yes' },
      reviewEvidence: null,
    })),
    edgeCandidates: topology.edges.map((edge) => ({
      edgeId: `g003-edge:${edge.parentId}:${edge.childId}`, parentId: edge.parentId, childId: edge.childId,
      status: 'PENDING_COMPARATIVE_VISUAL_REVIEW',
      allowedParentAnchorIds: (catalogById.get(edge.childId).category === 'mixed' ? parents.get(edge.childId) : [edge.parentId])
        .map((parentId) => parentCoverage(parentId, edge.childId)).map((parent) => ({ parentRole: parent.parentRole, parentId: parent.parentId, anchorIds: parent.anchors.map((anchor) => anchor.anchorKey) })),
      allowedParentAnchors: (catalogById.get(edge.childId).category === 'mixed' ? parents.get(edge.childId) : [edge.parentId]).map((parentId) => parentCoverage(parentId, edge.childId)),
      eiluBenchmarkId: eiluBenchmark.benchmarkId,
      comparisonThresholds: { minimumConfidence: eiluBenchmark.minimumConfidence, minimumAnchorRetentionRatio: eiluBenchmark.minimumAnchorRetentionRatio, sameCreatureGrownUp: 'yes' },
      reviewEvidence: null,
    })),
    coverage: { requiredQueueCandidates: queue.length, passedQueueCandidates: 0, requiredFinalEdges: 190, passedFinalEdges: 0, missingCoverage: queue.length + 190 },
  };

  const retainedScores = assignments.filter((item) => item.sourceKind === 'existing').map((item) => {
    const observations = observationsFor(censusById.get(item.slotId)).filter((entry) => tupleKey(entry.tuple) === tupleKey(item.targetTaxonomy));
    return Math.min(...observations.map((entry) => entry.confidence));
  });
  const obligationScope = signedObligationScope === null ? null : buildSignedObligationScope({
    scopeAuthority: signedObligationScope, queue, topology, familyProofs, regenerate,
  });
  return {
    assignments, topology, queue, familyProofs, reviewCoverage,
    ...(obligationScope ? { obligationScope } : {}),
    pinsProof: { positiveControl: pins.positiveControl, fixtures: pins.fixtures, eiluBenchmark },
    feasibility: {
      verdict: regenerate.size ? 'FEASIBLE_WITH_REGENERATION' : 'FEASIBLE',
      assignmentReadiness: 'ASSIGNMENT_READY_PENDING_VISUAL_REVIEW',
      artVerificationState: 'PENDING_G003_REVIEW',
      regenerationCount: regenerate.size, retainedCount: 240 - regenerate.size,
      exactTargetCount: [...targetBySlot.values()].filter(Boolean).length,
      pendingPixelTaxonomySlotCount: [...targetBySlot.values()].filter((target) => !target).length,
      pendingPixelTaxonomyFamilyCount: familyProofs.filter((proof) => !proof.targetTaxonomy).length,
      reviewedTaxonomyRootCount: lockedTaxonomyById.size,
      canonicalRedesignRootCount: canonicalTargetByRoot.size,
      incompatibleEdgeCount: 0, exactCompatibleEdgeCount: topology.edges.filter((edge) => edge.targetCompatible).length,
      pendingTaxonomyEdgeCount: topology.edges.filter((edge) => edge.compatibilityStatus === 'PENDING_PIXEL_TAXONOMY').length,
      objectiveOrder: ['biological-proof', 'minimum-confidence', 'total-confidence', 'minimum-regeneration', 'retain-clean-adjacency', 'minimum-operations', 'source-equals-slot', 'canonical-tuple'],
      objectiveVector: { biologicalProof: familyProofs.some((proof) => !proof.targetTaxonomy) ? 0 : 1, minimumRetainedConfidence: Math.min(...retainedScores), totalRetainedConfidence: retainedScores.reduce((sum, value) => sum + value, 0), regenerationCount: regenerate.size },
      fixedPointReached: true,
      visualReviewGate: { state: reviewCoverage.state, completionAllowed: false, ...reviewCoverage.coverage },
    },
  };
}

export function buildSignedObligationScope({ scopeAuthority, queue, topology, familyProofs, regenerate }) {
  if (scopeAuthority !== CONTINUITY_SUPERSESSION_SCOPE) fail('signed obligation scope authority mismatch');
  const excludedMixedSlotIds = [...MIXED_SCOPE_SLOT_IDS];
  const excluded = new Set(excludedMixedSlotIds);
  const queueSlotIds = queue.map((entry) => entry.slotId).filter((slotId) => !excluded.has(slotId));
  const ordinaryEdges = topology.edges.filter((edge) => !excluded.has(edge.childId))
    .map(({ parentId, childId }) => ({ parentId, childId }));
  const excludedMixedIncidentEdges = topology.edges.filter((edge) => excluded.has(edge.childId))
    .map(({ parentId, childId }) => ({ parentId, childId }));
  const generated = new Set(queueSlotIds);
  const dependentQueueCount = queue.filter((entry) => !excluded.has(entry.slotId)
    && entry.parentReferences.some((reference) => reference.sourceKind === 'generated-parent-candidate')).length;
  const generatedParentEdgeCount = ordinaryEdges.filter((edge) => generated.has(edge.parentId)).length;
  const generatedChildEdgeCount = ordinaryEdges.filter((edge) => generated.has(edge.childId)).length;
  const retainedChildEdgeCount = ordinaryEdges.length - generatedChildEdgeCount;
  const effectiveRootIds = familyProofs.filter((proof) => proof.proofStatus === 'TARGET_FROM_SIGNED_CANONICAL_ROOT_REDESIGN_CONTRACT')
    .map((proof) => proof.rootId).concat(['PG-005', 'PG-018']).sort(compareText);
  const counts = {
    queue: queueSlotIds.length, retained: 240 - queueSlotIds.length, ordinaryEdges: ordinaryEdges.length,
    obligations: queueSlotIds.length + ordinaryEdges.length, dependent: dependentQueueCount,
    generatedParentEdges: generatedParentEdgeCount, generatedChildEdges: generatedChildEdgeCount,
    retainedChildEdges: retainedChildEdgeCount, votes: (queueSlotIds.length + ordinaryEdges.length) * 2,
    effectiveRoots: effectiveRootIds.length,
  };
  if (canonicalString(counts) !== canonicalString({ queue: 167, retained: 73, ordinaryEdges: 170, obligations: 337, dependent: 113, generatedParentEdges: 113, generatedChildEdges: 128, retainedChildEdges: 42, votes: 674, effectiveRoots: 17 })) fail('signed obligation scope count mismatch');
  if (excludedMixedIncidentEdges.length !== 20 || topology.mixedProof.length !== 10
      || excludedMixedSlotIds.some((slotId) => !regenerate.has(slotId))) fail('signed obligation mixed exclusion drift');
  return {
    schemaVersion: 'continuity-signed-obligation-scope-v1', authority: scopeAuthority,
    exclusionPolicy: 'EXCLUDE_MIXED_CHILD_OBLIGATIONS_PRESERVE_FUSION_PROVENANCE',
    queueSlotIds, ordinaryEdges, excludedMixedSlotIds, excludedMixedIncidentEdges,
    fusionProvenance: structuredClone(topology.mixedProof), effectiveRootIds, counts,
  };
}
