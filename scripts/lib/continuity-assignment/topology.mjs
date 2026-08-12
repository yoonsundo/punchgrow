import { assertExactIds, fail } from './evidence.mjs';

export const EXPECTED_CATEGORY_COUNTS = Object.freeze({ start: 60, normal_evolution: 121, branch: 14, mixed: 10, special: 10, mutant: 25 });
export const EXPECTED_CHOICE_PROFILE = Object.freeze({ noChoice: 32, stageOneChoice: 10, stageTwoChoice: 18 });

function referencesOf(creature) {
  if (creature.evolutionFrom == null) return [];
  return Array.isArray(creature.evolutionFrom) ? creature.evolutionFrom : [creature.evolutionFrom];
}
export function buildTopology(catalog) {
  if (!Array.isArray(catalog)) fail('catalog must be an array');
  const ids = catalog.map((item) => item.id);
  assertExactIds(ids, Array.from({ length: 240 }, (_, index) => `PG-${String(index + 1).padStart(3, '0')}`), 'catalog IDs');
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const byPort = new Map();
  for (const item of catalog) {
    const port = `${item.lineageId}:S${item.stage}`;
    if (byPort.has(port)) fail(`duplicate topology port ${port}`);
    byPort.set(port, item.id);
  }
  const parents = new Map(catalog.map((item) => [item.id, []]));
  const children = new Map(catalog.map((item) => [item.id, []]));
  for (const item of catalog) {
    for (const reference of referencesOf(item)) {
      const parentId = byId.has(reference) ? reference : byPort.get(reference);
      if (!parentId) fail(`${item.id} has an unresolved parent reference ${reference}`);
      const parent = byId.get(parentId);
      if (parent.stage !== item.stage - 1) fail(`${item.id} parent ${parentId} is not from the previous stage`);
      if (parents.get(item.id).includes(parentId)) fail(`${item.id} contains a duplicate parent ${parentId}`);
      parents.get(item.id).push(parentId); children.get(parentId).push(item.id);
    }
    const requiredParents = item.category === 'mixed' ? 2 : item.category === 'start' ? 0 : 1;
    if (parents.get(item.id).length !== requiredParents) fail(`${item.id} must have exactly ${requiredParents} parent(s)`);
  }

  const categoryCounts = Object.fromEntries(Object.keys(EXPECTED_CATEGORY_COUNTS).map((key) => [key, catalog.filter((item) => item.category === key).length]));
  if (JSON.stringify(categoryCounts) !== JSON.stringify(EXPECTED_CATEGORY_COUNTS)) fail(`category counts drifted: ${JSON.stringify(categoryCounts)}`);
  const roots = catalog.filter((item) => item.stage === 1);
  if (roots.length !== 60 || roots.some((item) => item.category !== 'start')) fail('all 60 root slots must remain stage-one starts');

  const rootProfiles = [];
  for (const root of roots) {
    const visited = new Set([root.id]); const queue = [root.id]; const choiceStages = [];
    while (queue.length) {
      const currentId = queue.shift(); const current = byId.get(currentId);
      const selectable = children.get(currentId).filter((id) => byId.get(id).category !== 'mutant');
      if (selectable.length > 2) fail(`${currentId} has more than two selectable candidates`);
      if (selectable.length > 1) choiceStages.push(current.stage);
      for (const childId of selectable) if (!visited.has(childId)) { visited.add(childId); queue.push(childId); }
    }
    if (choiceStages.length > 1) fail(`${root.id} exposes more than one choice node on its reachable topology`);
    const stages = [...visited].map((id) => byId.get(id).stage);
    const cardsPerStage = Object.fromEntries([1, 2, 3, 4].map((stage) => [stage, stages.filter((value) => value === stage).length]));
    const profile = choiceStages[0] === 1 ? 'stageOneChoice' : choiceStages[0] === 2 ? 'stageTwoChoice' : 'noChoice';
    if (Math.max(...stages) > 4 || visited.size > 6 || Math.max(...Object.values(cardsPerStage)) > 3) fail(`${root.id} violates dex topology ceilings`);
    rootProfiles.push({ rootId: root.id, profile, choiceStages, reachableSlotIds: [...visited].sort(), maxStage: Math.max(...stages), cardsTotal: visited.size, cardsPerStage });
  }
  const choiceProfile = Object.fromEntries(Object.keys(EXPECTED_CHOICE_PROFILE).map((key) => [key, rootProfiles.filter((item) => item.profile === key).length]));
  if (JSON.stringify(choiceProfile) !== JSON.stringify(EXPECTED_CHOICE_PROFILE)) fail(`choice profile drifted: ${JSON.stringify(choiceProfile)}`);

  const edges = catalog.flatMap((child) => parents.get(child.id).map((parentId) => ({ parentId, childId: child.id, category: child.category, parentPort: `${byId.get(parentId).lineageId}:S${byId.get(parentId).stage}`, eitherParentEligible: child.category === 'mixed' })));
  if (edges.length !== 190) fail(`edge count drifted: ${edges.length}`);
  return { schemaVersion: 'continuity-topology-before-v1', counts: { slots: 240, roots: 60, edges: 190, categories: categoryCounts, choiceProfile }, constraints: { maxStages: 4, maxCardsTotal: 6, maxCardsPerStage: 3, maxChoiceNodesPerPath: 1, maxSelectableCandidates: 2, mixedSemantics: 'either-parent' }, rootSlotIds: roots.map((item) => item.id), edges, roots: rootProfiles };
}
