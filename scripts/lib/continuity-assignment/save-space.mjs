import { assertUnique, canonicalString, fail } from './compatibility.mjs';

const compareText = (a, b) => a.localeCompare(b, 'en');
const stateKey = (state) => canonicalString(state);

export function possibleRootsFromTopology(catalog, topology) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const parents = new Map(catalog.map((item) => [item.id, []]));
  for (const edge of topology.edges) {
    if (!parents.has(edge.childId) || !parents.has(edge.parentId)) fail(`save topology contains unknown edge ${edge.parentId}=>${edge.childId}`);
    parents.get(edge.childId).push(edge.parentId);
  }
  const memo = new Map();
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) fail(`save topology cycle at ${id}`);
    if (byId.get(id).category === 'start') return new Set([id]);
    const result = new Set(); const next = new Set(stack).add(id);
    for (const parentId of parents.get(id)) for (const rootId of visit(parentId, next)) result.add(rootId);
    if (!result.size) fail(`${id}: non-root progress state has no origin`);
    memo.set(id, result); return result;
  };
  return new Map(catalog.map((item) => [item.id, [...visit(item.id)].sort(compareText)]));
}

function assertBijection(entries, label) {
  assertUnique(entries, (entry) => stateKey(entry.from), `${label} forward key`);
  assertUnique(entries, (entry) => stateKey(entry.to), `${label} reverse key`);
  const forward = new Map(entries.map((entry) => [stateKey(entry.from), entry.to]));
  const reverse = new Map(entries.map((entry) => [stateKey(entry.to), entry.from]));
  for (const entry of entries) {
    const mapped = forward.get(stateKey(entry.from));
    const roundTrip = reverse.get(stateKey(mapped));
    if (stateKey(roundTrip) !== stateKey(entry.from)) fail(`${label} is not an exact inverse for ${stateKey(entry.from)}`);
  }
}

export function buildSaveRevisionMap(catalog, topologyBefore, topologyAfter) {
  const ids = catalog.map((item) => item.id).sort(compareText);
  const roots = catalog.filter((item) => item.category === 'start').map((item) => item.id).sort(compareText);
  const oldRoots = possibleRootsFromTopology(catalog, topologyBefore);
  const newRoots = possibleRootsFromTopology(catalog, topologyAfter);
  const owned = []; const progress = []; const receipts = [];
  const mixedOrigins = [];
  for (const slot of [...catalog].sort((a, b) => compareText(a.id, b.id))) {
    const before = oldRoots.get(slot.id); const after = newRoots.get(slot.id);
    if (before.length !== after.length) fail(`${slot.id}: old/new ancestry cardinality differs (${before.length}/${after.length})`);
    for (let index = 0; index < before.length; index += 1) {
      const from = { speciesId: slot.id, originKind: 'valid-root', origin: before[index] };
      const to = { speciesId: slot.id, originKind: 'valid-root', origin: after[index] };
      owned.push({ from, to });
      progress.push({
        from: { speciesId: slot.id, origin: before[index], stage: slot.stage, category: slot.category },
        to: { speciesId: slot.id, origin: after[index], stage: slot.stage, category: slot.category },
      });
      if (slot.category === 'mixed') {
        const record = { speciesId: slot.id, oldOrigin: before[index], newOrigin: after[index], changed: before[index] !== after[index] };
        mixedOrigins.push(record);
        receipts.push({ receiptId: `ancestry:${slot.id}:${before[index]}:${after[index]}`, kind: 'mixed-origin-map', ...record, disposition: before[index] === after[index] ? 'identity-preserved' : 'bijective-remap' });
      }
    }
    const nil = { speciesId: slot.id, originKind: 'nil' };
    owned.push({ from: nil, to: nil });
    receipts.push({ receiptId: `origin:nil:${slot.id}`, kind: 'nil-origin', speciesId: slot.id, disposition: 'identity-preserved' });
    const corrupt = { speciesId: slot.id, originKind: 'corrupt', origin: `CORRUPT:${slot.id}` };
    owned.push({ from: corrupt, to: corrupt });
    receipts.push({ receiptId: `origin:corrupt:${slot.id}`, kind: 'corrupt-origin', speciesId: slot.id, disposition: 'identity-preserved' });
  }
  const displayStates = [{ displayKind: 'nil' }, ...ids.map((displaySpeciesId) => ({ displayKind: 'species', displaySpeciesId })), { displayKind: 'corrupt', displaySpeciesId: 'CORRUPT-DISPLAY:preserved' }];
  const display = displayStates.map((state) => ({ from: state, to: state }));
  receipts.push({ receiptId: 'display:nil', kind: 'nil-display', disposition: 'identity-preserved' });
  receipts.push({ receiptId: 'display:corrupt', kind: 'corrupt-display', disposition: 'identity-preserved' });
  const map = {
    schemaVersion: 'catalog-revision-map-v1',
    fromRevision: 'cute-redesign-v2', toRevision: 'biological-continuity-v3',
    domains: {
      oldReachableOwnedStates: [...oldRoots.values()].reduce((sum, values) => sum + values.length, 0),
      newReachableOwnedStates: [...newRoots.values()].reduce((sum, values) => sum + values.length, 0),
      invalidOldStates: 0, missingNewStates: 0,
    },
    mixedOrigins, owned, progress, display,
    collection: ids.map((id) => ({ from: id, to: id })),
    mutationRetryRoots: roots.map((id) => ({ from: id, to: id })),
    receipts: receipts.sort((a, b) => compareText(a.receiptId, b.receiptId)),
  };
  assertLosslessSaveRevisionMap(map, { catalog, topologyBefore, topologyAfter });
  return map;
}

export function assertLosslessSaveRevisionMap(map, context = null) {
  if (map.fromRevision !== 'cute-redesign-v2' || map.toRevision !== 'biological-continuity-v3') fail('save revision names are not canonical');
  for (const [label, entries] of [['owned', map.owned], ['progress', map.progress], ['display', map.display], ['collection', map.collection], ['mutationRetryRoots', map.mutationRetryRoots]]) assertBijection(entries, label);
  if (map.collection.length !== 240 || map.mutationRetryRoots.length !== 60) fail('save map catalog/root coverage mismatch');
  if (map.mixedOrigins.length !== 20 || new Set(map.mixedOrigins.map((item) => item.speciesId)).size !== 10) fail('save map must cover all 10 old/new mixed ancestry domains');
  if (map.domains.invalidOldStates !== 0 || map.domains.missingNewStates !== 0) fail('save map declares invalid or missing domain states');
  if (context) {
    const oldRoots = possibleRootsFromTopology(context.catalog, context.topologyBefore);
    const newRoots = possibleRootsFromTopology(context.catalog, context.topologyAfter);
    const expectedOld = new Set(); const expectedNew = new Set();
    for (const item of context.catalog) {
      for (const origin of oldRoots.get(item.id)) expectedOld.add(stateKey({ speciesId: item.id, originKind: 'valid-root', origin }));
      for (const origin of newRoots.get(item.id)) expectedNew.add(stateKey({ speciesId: item.id, originKind: 'valid-root', origin }));
    }
    const actualOld = new Set(map.owned.filter((entry) => entry.from.originKind === 'valid-root').map((entry) => stateKey(entry.from)));
    const actualNew = new Set(map.owned.filter((entry) => entry.to.originKind === 'valid-root').map((entry) => stateKey(entry.to)));
    if (canonicalString([...actualOld].sort()) !== canonicalString([...expectedOld].sort())) fail('save map old reachable domain gap');
    if (canonicalString([...actualNew].sort()) !== canonicalString([...expectedNew].sort())) fail('save map new reachable domain gap');
  }
  return true;
}
