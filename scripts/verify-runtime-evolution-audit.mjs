import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import pngjs from 'pngjs';
import {
  ADJUDICATIONS_RELATIVE_PATH,
  LANE_RELATIVE_PATHS,
  MANIFEST_RELATIVE_PATH,
  OUTPUT_RELATIVE_PATH,
  buildRuntimeEvolutionAudit,
  edgeId,
  invariant,
  sha256,
  assertBinding,
  validateLaneBindings,
} from './build-runtime-evolution-audit.mjs';

const { PNG } = pngjs;

const root = process.cwd();
const sourceResourcesRelativePath = 'macos/Sources/PunchGrowMenuBar/Resources';
const runtimeResourcesRelativePath = 'macos/.build/PunchGrow.app/Contents/Resources/PunchGrowMenuBar_PunchGrowMenuBar.bundle';
const runtimeCatalogRelativePath = `${runtimeResourcesRelativePath}/creatures.json`;
const normalCategories = new Set(['start', 'normal_evolution']);
const exceptionalCategories = new Set(['branch', 'mixed', 'special', 'mutant']);

function pngDimensions(contents, label) {
  invariant(contents.length >= 24 && contents.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', `${label}: invalid PNG`);
  invariant(contents.subarray(12, 16).toString('ascii') === 'IHDR', `${label}: missing PNG IHDR`);
  return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
}

function decodedPngEvidence(contents, label) {
  let image;
  try {
    image = PNG.sync.read(contents);
  } catch {
    throw new Error(`${label}: invalid PNG`);
  }
  const pixelSha256 = createHash('sha256')
    .update(`PNG-RGBA\nwidth=${image.width}\nheight=${image.height}\n`, 'utf8')
    .update(image.data)
    .digest('hex');
  return { pixelSha256, width: image.width, height: image.height };
}

function exactIds(records, idFor, expectedIds, label) {
  invariant(Array.isArray(records), `${label}: must be an array`);
  const seen = new Set();
  for (const record of records) {
    const id = idFor(record);
    invariant(typeof id === 'string' && id, `${label}: invalid id`);
    invariant(!seen.has(id), `${label}: duplicate ${id}`);
    seen.add(id);
  }
  const expected = new Set(expectedIds);
  const missing = [...expected].filter((id) => !seen.has(id));
  const unexpected = [...seen].filter((id) => !expected.has(id));
  invariant(missing.length === 0, `${label}: missing ${missing.join(', ')}`);
  invariant(unexpected.length === 0, `${label}: unexpected ${unexpected.join(', ')}`);
}

function assertDeepExact(actual, expected, label) {
  invariant(isDeepStrictEqual(actual, expected), `${label}: deep exact comparison failed`);
}

function assertVerdict(record, label) {
  invariant(record.verdict === 'PASS', `${label}: verdict must be PASS`);
  invariant(Number.isFinite(record.score) && record.score >= 90 && record.score <= 100, `${label}: score must be between 90 and 100`);
  invariant(record.categoryMatch === true, `${label}: categoryMatch must be true`);
  invariant(Array.isArray(record.differences), `${label}: differences must be an array`);
  invariant(Array.isArray(record.suggestions), `${label}: suggestions must be an array`);
  invariant(typeof record.reasoning === 'string' && record.reasoning.trim(), `${label}: reasoning is required`);
  invariant(typeof record.initialVerdict === 'string' && record.initialVerdict, `${label}: initialVerdict is required`);
  invariant(typeof record.adjudicated === 'boolean', `${label}: adjudicated flag is required`);
}

function assertAssetEvidence(evidence, expectedIds, assetsById, label) {
  exactIds(evidence, (asset) => asset.id, expectedIds, `${label} assets`);
  for (const actual of evidence) {
    const expected = assetsById.get(actual.id);
    for (const field of ['path', 'sha256', 'bytes', 'width', 'height']) {
      invariant(actual[field] === expected?.[field], `${label}: ${actual.id} ${field} drift`);
    }
  }
}

function assertSheetEvidence(evidence, unit, sheetsByName, label) {
  exactIds(Object.keys(evidence ?? {}), (field) => field, ['path', 'pixelSha256', 'width', 'height', 'row'], `${label} sheet evidence fields`);
  const expected = sheetsByName.get(unit.sheet);
  invariant(evidence?.path === unit.sheet, `${label}: sheet path drift`);
  invariant(evidence?.pixelSha256 === expected?.pixelSha256, `${label}: sheet pixel SHA-256 drift`);
  invariant(evidence?.width === expected?.width, `${label}: sheet width drift`);
  invariant(evidence?.height === expected?.height, `${label}: sheet height drift`);
  invariant(evidence?.row === unit.row, `${label}: sheet row drift`);
}

function validateEvidenceHashes(report, currentHashesByPath) {
  exactIds(report.laneEvidence, (entry) => entry.path, LANE_RELATIVE_PATHS, 'ledger lane evidence');
  for (const entry of report.laneEvidence) {
    invariant(entry.sha256 === currentHashesByPath.get(entry.path), `${entry.path}: lane evidence SHA-256 drift`);
  }
  invariant(report.adjudicationEvidence?.path === ADJUDICATIONS_RELATIVE_PATH, 'ledger adjudication evidence path drift');
  invariant(report.adjudicationEvidence?.sha256 === currentHashesByPath.get(ADJUDICATIONS_RELATIVE_PATH), 'adjudication evidence SHA-256 drift');
}

function validateRuntimePaths(manifest) {
  invariant(manifest.source === 'runtime-app-bundle', 'manifest source must be runtime-app-bundle');
  invariant(manifest.sourceDirectory === runtimeResourcesRelativePath, 'manifest runtime bundle path must be exact');
  invariant(manifest.catalogPath === runtimeCatalogRelativePath, 'manifest runtime catalog path must be exact');
  const resolvedRuntime = path.resolve(root, manifest.sourceDirectory);
  const resolvedCatalog = path.resolve(root, manifest.catalogPath);
  invariant(resolvedRuntime === path.join(root, runtimeResourcesRelativePath), 'runtime path traversal rejected');
  invariant(resolvedCatalog === path.join(root, runtimeCatalogRelativePath), 'catalog path traversal rejected');
}

function evolutionReferences(entry) {
  if (typeof entry.evolutionFrom === 'string') return [entry.evolutionFrom];
  if (Array.isArray(entry.evolutionFrom)) return entry.evolutionFrom;
  return [];
}

export function reconstructRuntimeUnits(catalog, expectedCounts = { normal: 60, exceptional: 59 }) {
  invariant(Array.isArray(catalog), 'runtime catalog must be an array');
  const byId = new Map();
  const byLineageStage = new Map();
  for (const entry of catalog) {
    invariant(typeof entry.id === 'string' && /^PG-\d{3}$/.test(entry.id), 'runtime catalog contains invalid creature id');
    invariant(!byId.has(entry.id), `runtime catalog duplicate id ${entry.id}`);
    byId.set(entry.id, entry);
    const key = `${entry.lineageId}:S${entry.stage}`;
    const matches = byLineageStage.get(key) ?? [];
    matches.push(entry);
    byLineageStage.set(key, matches);
  }

  function resolveParent(child, reference) {
    if (/^PG-\d{3}$/.test(reference)) {
      const direct = byId.get(reference);
      invariant(direct, `${child.id}: unresolved evolutionFrom reference ${reference}`);
      return direct;
    }
    invariant(/^PG-L\d{3}:S\d+$/.test(reference), `${child.id}: invalid evolutionFrom reference ${reference}`);
    const matches = byLineageStage.get(reference) ?? [];
    invariant(
      matches.length === 1,
      `${child.id}: ${matches.length === 0 ? 'unresolved' : 'ambiguous'} evolutionFrom reference ${reference}`,
    );
    return matches[0];
  }

  const roots = catalog.filter((entry) => entry.category === 'start')
    .sort((left, right) => left.lineageId.localeCompare(right.lineageId));
  invariant(roots.length === expectedCounts.normal, `runtime catalog normal root count must be ${expectedCounts.normal}, got ${roots.length}`);
  const units = [];
  for (const [index, lineageRoot] of roots.entries()) {
    const entries = catalog
      .filter((entry) => entry.lineageId === lineageRoot.lineageId && normalCategories.has(entry.category))
      .sort((left, right) => left.stage - right.stage);
    const stages = entries.map((entry) => entry.stage);
    invariant(new Set(stages).size === stages.length, `${lineageRoot.lineageId}: duplicate normal stage`);
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      invariant(stages[stageIndex] === stageIndex + 1, `${lineageRoot.lineageId}: missing normal stage S${stageIndex + 1}`);
    }
    const rootReferences = evolutionReferences(entries[0]);
    invariant(
      rootReferences.length === 0,
      `${entries[0].id}: normal root S1 must not have evolutionFrom reference(s): ${rootReferences.join(', ')}`,
    );
    for (let entryIndex = 1; entryIndex < entries.length; entryIndex += 1) {
      const child = entries[entryIndex];
      const references = evolutionReferences(child);
      invariant(
        references.length === 1,
        `${child.id}: normal_evolution requires exactly one evolutionFrom reference, got ${references.length}`,
      );
      const reference = references[0];
      const parent = resolveParent(child, reference);
      const expectedParent = entries[entryIndex - 1];
      invariant(
        parent.id === expectedParent.id,
        `${child.id}: evolutionFrom reference ${reference} resolves to ${parent.id}, expected same-lineage previous stage ${expectedParent.id}`,
      );
    }
    const first = String(Math.floor(index / 10) * 10 + 1).padStart(3, '0');
    const last = String(Math.min(Math.floor(index / 10) * 10 + 10, roots.length)).padStart(3, '0');
    units.push({
      unitId: `normal-${lineageRoot.lineageId}`, category: 'normal',
      sheet: `normal-lineages-${first}-${last}.png`, row: (index % 10) + 1,
      creatureIds: entries.map((entry) => entry.id),
      edges: entries.slice(1).map((entry, edgeIndex) => ({ parentId: entries[edgeIndex].id, childId: entry.id })),
    });
  }

  const exceptional = catalog.filter((entry) => !normalCategories.has(entry.category))
    .sort((left, right) => left.id.localeCompare(right.id));
  invariant(exceptional.length === expectedCounts.exceptional, `runtime catalog exceptional count must be ${expectedCounts.exceptional}, got ${exceptional.length}`);
  for (const [index, child] of exceptional.entries()) {
    invariant(exceptionalCategories.has(child.category), `${child.id}: unsupported exceptional category ${child.category}`);
    const references = evolutionReferences(child);
    const expectedParents = child.category === 'mixed' ? 2 : 1;
    invariant(references.length === expectedParents, `${child.id}: ${child.category} requires ${expectedParents} parent reference(s), got ${references.length}`);
    const parents = references.map((reference) => resolveParent(child, reference));
    const first = String(Math.floor(index / 10) * 10 + 1).padStart(3, '0');
    const last = String(Math.min(Math.floor(index / 10) * 10 + 10, exceptional.length)).padStart(3, '0');
    units.push({
      unitId: `${child.category}-${child.id}`, category: child.category,
      sheet: `exceptional-evolutions-${first}-${last}.png`, row: (index % 10) + 1,
      creatureIds: [...parents.map((parent) => parent.id), child.id],
      edges: parents.map((parent) => ({ parentId: parent.id, childId: child.id })),
    });
  }
  return units;
}

function validateManifestAgainstCatalog(manifest, catalog, expectedCounts = { normal: 60, exceptional: 59, units: 119, edges: 190 }) {
  const reconstructed = reconstructRuntimeUnits(catalog, expectedCounts);
  invariant(reconstructed.length === expectedCounts.units, `reconstructed unit count must be ${expectedCounts.units}`);
  const reconstructedEdges = reconstructed.reduce((total, unit) => total + unit.edges.length, 0);
  invariant(reconstructedEdges === expectedCounts.edges, `reconstructed edge count must be ${expectedCounts.edges}`);
  exactIds(manifest.units, (unit) => unit.unitId, reconstructed.map((unit) => unit.unitId), 'catalog/manifest units');
  const actualById = new Map(manifest.units.map((unit) => [unit.unitId, unit]));
  for (const expected of reconstructed) {
    const actual = actualById.get(expected.unitId);
    assertDeepExact(
      { unitId: actual.unitId, category: actual.category, sheet: actual.sheet, row: actual.row, creatureIds: actual.creatureIds, edges: actual.edges },
      expected,
      `${expected.unitId} catalog/manifest mapping`,
    );
  }
  return reconstructed;
}

function validateLedger(manifest, report, expectedCounts = { creatures: 240, units: 119, edges: 190 }) {
  invariant(report.status === 'PASS' && report.acceptanceThreshold === 90, 'ledger status/threshold drift');
  invariant(report.resourcesFingerprint === manifest.resourcesFingerprint, 'ledger resources fingerprint drift');
  invariant(report.catalogSha256 === manifest.catalogSha256, 'ledger catalog SHA-256 drift');
  assertDeepExact(report.summary, expectedCounts, 'ledger summary');
  const assetsById = new Map((manifest.assets ?? []).map((asset) => [asset.id, asset]));
  exactIds(manifest.assets, (asset) => asset.id, manifest.coveredCreatureIds, 'manifest assets');
  invariant(assetsById.size === expectedCounts.creatures, `manifest must contain ${expectedCounts.creatures} assets`);
  const sheetsByName = new Map((manifest.visualArtifacts ?? []).map((sheet) => [sheet.path, sheet]));
  invariant(sheetsByName.size === 12 || expectedCounts.creatures !== 240, 'manifest must bind 12 unique contact sheets');
  const unitsById = new Map((manifest.units ?? []).map((unit) => [unit.unitId, unit]));
  const edgesById = new Map();
  for (const unit of manifest.units ?? []) for (const edge of unit.edges) edgesById.set(edgeId(edge), { ...edge, unitId: unit.unitId });
  invariant(unitsById.size === expectedCounts.units, `manifest must contain ${expectedCounts.units} units`);
  invariant(edgesById.size === expectedCounts.edges, `manifest must contain ${expectedCounts.edges} edges`);
  exactIds(report.units, (unit) => unit.unitId, unitsById.keys(), 'ledger units');
  exactIds(report.edges, edgeId, edgesById.keys(), 'ledger edges');
  for (const actual of report.units) {
    const expected = unitsById.get(actual.unitId);
    assertVerdict(actual, actual.unitId);
    invariant(actual.category === expected.category, `${actual.unitId}: category drift`);
    exactIds(actual.creatureIds, (id) => id, expected.creatureIds, `${actual.unitId} creature ids`);
    assertAssetEvidence(actual.assetEvidence, expected.creatureIds, assetsById, actual.unitId);
    assertSheetEvidence(actual.sheetEvidence, expected, sheetsByName, actual.unitId);
  }
  for (const actual of report.edges) {
    const expected = edgesById.get(edgeId(actual));
    assertVerdict(actual, edgeId(actual));
    invariant(actual.differences.length > 0, `${edgeId(actual)}: inherited-trait evidence is required`);
    invariant(actual.edgeId === edgeId(actual) && actual.unitId === expected.unitId, `${edgeId(actual)}: edge identity drift`);
    assertAssetEvidence(actual.assetEvidence, [expected.parentId, expected.childId], assetsById, edgeId(actual));
    assertSheetEvidence(actual.sheetEvidence, unitsById.get(expected.unitId), sheetsByName, edgeId(actual));
  }
}

function validVerdict() {
  return { verdict: 'PASS', score: 95, categoryMatch: true, differences: ['trait'], suggestions: [], reasoning: 'complete', initialVerdict: 'PASS', adjudicated: false };
}

function selfTestFixture() {
  const assets = ['PG-001', 'PG-002', 'PG-003'].map((id, index) => ({ id, path: `${id}.png`, sha256: String(index + 1).repeat(64), bytes: 24, width: 1, height: 1 }));
  const unit = { unitId: 'mixed-PG-003', category: 'mixed', sheet: 'mixed.png', row: 1, creatureIds: ['PG-001', 'PG-002', 'PG-003'], edges: [{ parentId: 'PG-001', childId: 'PG-003' }, { parentId: 'PG-002', childId: 'PG-003' }] };
  const manifest = { resourcesFingerprint: 'fingerprint', catalogSha256: 'catalog', coveredCreatureIds: assets.map(({ id }) => id), assets, visualArtifacts: [{ path: 'mixed.png', pixelSha256: 'a'.repeat(64), width: 4, height: 3 }], units: [unit] };
  const evidenceFor = (ids) => ids.map((id) => ({ ...assets.find((asset) => asset.id === id) }));
  const sheetEvidence = { ...manifest.visualArtifacts[0], row: unit.row };
  const report = { status: 'PASS', acceptanceThreshold: 90, resourcesFingerprint: 'fingerprint', catalogSha256: 'catalog', summary: { creatures: 3, units: 1, edges: 2 }, units: [{ ...validVerdict(), unitId: unit.unitId, category: unit.category, creatureIds: [...unit.creatureIds], assetEvidence: evidenceFor(unit.creatureIds), sheetEvidence }], edges: unit.edges.map((edge) => ({ ...validVerdict(), ...edge, edgeId: edgeId(edge), unitId: unit.unitId, assetEvidence: evidenceFor([edge.parentId, edge.childId]), sheetEvidence })) };
  return { manifest, report };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function mustReject(name, action, results) {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  invariant(rejected, `self-test did not reject: ${name}`);
  results.push(name);
}

async function runSelfTests() {
  const results = [];
  const ledgerCases = [
    ['missing asset', ({ report }) => { report.units[0].assetEvidence.pop(); }],
    ['duplicate unit', ({ report }) => { report.units.push(clone(report.units[0])); }],
    ['missing edge', ({ report }) => { report.edges.pop(); }],
    ['asset hash drift', ({ report }) => { report.edges[0].assetEvidence[0].sha256 = 'f'.repeat(64); }],
    ['low score', ({ report }) => { report.units[0].score = 89; }],
    ['score above 100', ({ report }) => { report.units[0].score = 101; }],
    ['reasoning missing', ({ report }) => { report.units[0].reasoning = ''; }],
    ['mixed second-parent missing', ({ report }) => { report.units[0].creatureIds.splice(1, 1); }],
    ['sheet pixel drift', ({ report }) => { report.units[0].sheetEvidence.pixelSha256 = 'f'.repeat(64); }],
  ];
  for (const [name, mutate] of ledgerCases) {
    const fixture = selfTestFixture(); mutate(fixture);
    mustReject(name, () => validateLedger(fixture.manifest, fixture.report, { creatures: 3, units: 1, edges: 2 }), results);
  }
  const evidenceReport = { laneEvidence: LANE_RELATIVE_PATHS.map((entryPath) => ({ path: entryPath, sha256: 'a'.repeat(64) })), adjudicationEvidence: { path: ADJUDICATIONS_RELATIVE_PATH, sha256: 'b'.repeat(64) } };
  const hashes = new Map([...LANE_RELATIVE_PATHS.map((entryPath) => [entryPath, 'a'.repeat(64)]), [ADJUDICATIONS_RELATIVE_PATH, 'b'.repeat(64)]]);
  const laneHashDrift = clone(evidenceReport);
  laneHashDrift.laneEvidence[1].sha256 = 'c'.repeat(64);
  mustReject('lane hash drift', () => validateEvidenceHashes(laneHashDrift, hashes), results);
  const adjudicationHashDrift = clone(evidenceReport);
  adjudicationHashDrift.adjudicationEvidence.sha256 = 'c'.repeat(64);
  mustReject('adjudication hash drift', () => validateEvidenceHashes(adjudicationHashDrift, hashes), results);

  mustReject(
    'stale binding',
    () => assertBinding(
      { manifestSha256: 'stale', resourcesFingerprint: 'fingerprint' },
      'current',
      { resourcesFingerprint: 'fingerprint' },
      'fixture',
    ),
    results,
  );
  const expectedLedger = selfTestFixture().report;
  const driftedLedger = clone(expectedLedger); driftedLedger.units[0].verdict = 'WARN';
  mustReject('ledger verdict drift', () => assertDeepExact(driftedLedger, expectedLedger, 'replayed ledger'), results);
  const manifestFixture = selfTestFixture().manifest;
  const catalogFixture = [
    { id: 'PG-001', lineageId: 'PG-L001', category: 'start', stage: 1 },
    { id: 'PG-002', lineageId: 'PG-L002', category: 'start', stage: 1 },
    { id: 'PG-003', lineageId: 'PG-X003', category: 'mixed', stage: 2, evolutionFrom: ['PG-001', 'PG-002'] },
  ];
  const reconstructedFixtureUnits = reconstructRuntimeUnits(catalogFixture, { normal: 2, exceptional: 1 });
  const substituted = { ...clone(manifestFixture), units: clone(reconstructedFixtureUnits) };
  const mixedUnit = substituted.units.find((unit) => unit.unitId === 'mixed-PG-003');
  mixedUnit.edges[0].parentId = 'PG-002';
  mustReject('catalog/manifest edge substitution', () => validateManifestAgainstCatalog(substituted, catalogFixture, { normal: 2, exceptional: 1, units: 3, edges: 2 }), results);
  mustReject('fake .app traversal', () => validateRuntimePaths({ source: 'runtime-app-bundle', sourceDirectory: `${runtimeResourcesRelativePath}/../fake.app`, catalogPath: runtimeCatalogRelativePath }), results);
  const unresolvedCatalog = clone(catalogFixture); unresolvedCatalog[2].evolutionFrom[0] = 'PG-999';
  mustReject('unresolved parent', () => reconstructRuntimeUnits(unresolvedCatalog, { normal: 2, exceptional: 1 }), results);
  const unresolvedNormalChild = [
    { id: 'PG-001', lineageId: 'PG-L001', category: 'start', stage: 1 },
    { id: 'PG-061', lineageId: 'PG-L001', category: 'normal_evolution', stage: 2, evolutionFrom: 'PG-999' },
  ];
  mustReject(
    'normal child unresolved evolutionFrom',
    () => reconstructRuntimeUnits(unresolvedNormalChild, { normal: 1, exceptional: 0 }),
    results,
  );
  const wrongPreviousParent = [
    { id: 'PG-001', lineageId: 'PG-L001', category: 'start', stage: 1 },
    { id: 'PG-002', lineageId: 'PG-L002', category: 'start', stage: 1 },
    { id: 'PG-061', lineageId: 'PG-L001', category: 'normal_evolution', stage: 2, evolutionFrom: 'PG-002' },
  ];
  mustReject(
    'normal child wrong previous parent',
    () => reconstructRuntimeUnits(wrongPreviousParent, { normal: 2, exceptional: 0 }),
    results,
  );
  const normalRootWithParent = [
    { id: 'PG-001', lineageId: 'PG-L001', category: 'start', stage: 1, evolutionFrom: 'PG-999' },
  ];
  mustReject(
    'normal root evolutionFrom present',
    () => reconstructRuntimeUnits(normalRootWithParent, { normal: 1, exceptional: 0 }),
    results,
  );
  const laneSheetNames = [
    'normal-lineages-001-010.png', 'normal-lineages-011-020.png',
    'normal-lineages-021-030.png', 'normal-lineages-031-040.png',
    'normal-lineages-041-050.png', 'normal-lineages-051-060.png',
    'exceptional-evolutions-001-010.png', 'exceptional-evolutions-011-020.png',
    'exceptional-evolutions-021-030.png', 'exceptional-evolutions-031-040.png',
    'exceptional-evolutions-041-050.png', 'exceptional-evolutions-051-059.png',
  ];
  const laneManifest = {
    resourcesFingerprint: 'fingerprint',
    units: [{ unitId: 'normal-PG-L001', sheet: laneSheetNames[0] }],
    visualArtifacts: laneSheetNames.map((sheetPath) => ({ path: sheetPath, pixelSha256: 'a'.repeat(64), width: 1120, height: 2500 })),
  };
  const sheetMap = new Map(laneManifest.visualArtifacts.map((sheet) => [sheet.path, sheet]));
  const assignments = [
    [laneSheetNames[0], laneSheetNames[1], laneSheetNames[6], laneSheetNames[7]],
    [laneSheetNames[2], laneSheetNames[3], laneSheetNames[8], laneSheetNames[9]],
    [laneSheetNames[4], laneSheetNames[5], laneSheetNames[10], laneSheetNames[11]],
  ];
  const laneInputs = LANE_RELATIVE_PATHS.map((relativePath, index) => ({
    relativePath,
    document: {
      lane: ['A', 'B', 'C'][index], manifestSha256: 'manifest', resourcesFingerprint: 'fingerprint',
      sheets: assignments[index], sheetEvidence: assignments[index].map((sheetPath) => ({ path: sheetPath, pixelSha256: 'a'.repeat(64), width: 1120, height: 2500 })), units: [],
    },
  }));
  laneInputs[0].document.units.push({ unitId: 'normal-PG-L001' });
  const wrongLaneIdentity = clone(laneInputs);
  wrongLaneIdentity[0].document.lane = 'B';
  mustReject('wrong lane identity', () => validateLaneBindings(wrongLaneIdentity, 'manifest', laneManifest, sheetMap), results);
  const wrongSheetAssignment = clone(laneInputs);
  wrongSheetAssignment[0].document.sheets[0] = laneSheetNames[2];
  mustReject('wrong lane sheet assignment', () => validateLaneBindings(wrongSheetAssignment, 'manifest', laneManifest, sheetMap), results);
  const crossLaneUnit = clone(laneInputs);
  crossLaneUnit[0].document.units = [];
  crossLaneUnit[1].document.units.push({ unitId: 'normal-PG-L001' });
  mustReject('cross-lane unit assignment', () => validateLaneBindings(crossLaneUnit, 'manifest', laneManifest, sheetMap), results);
  console.log(JSON.stringify({ selfTest: 'PASS', negativeCases: results.length, cases: results }));
}

async function verifyFiles() {
  const manifestContents = await readFile(path.join(root, MANIFEST_RELATIVE_PATH));
  const manifest = JSON.parse(manifestContents);
  validateRuntimePaths(manifest);
  const report = JSON.parse(await readFile(path.join(root, OUTPUT_RELATIVE_PATH), 'utf8'));
  const expectedReport = await buildRuntimeEvolutionAudit({ rootDirectory: root });
  assertDeepExact(report, expectedReport, 'stored ledger/replayed inputs');
  invariant(report.manifestPath === MANIFEST_RELATIVE_PATH && report.manifestSha256 === sha256(manifestContents), 'ledger manifest binding drift');
  invariant(manifest.assetCount === 240 && manifest.creatureCount === 240 && manifest.unitCount === 119 && manifest.edgeCount === 190, 'manifest count drift');
  invariant(manifest.visualArtifacts?.length === 12, 'manifest must bind 12 contact sheets');

  const evidencePaths = [...LANE_RELATIVE_PATHS, ADJUDICATIONS_RELATIVE_PATH];
  const evidenceContents = await Promise.all(evidencePaths.map((relativePath) => readFile(path.join(root, relativePath))));
  validateEvidenceHashes(report, new Map(evidencePaths.map((relativePath, index) => [relativePath, sha256(evidenceContents[index])])));
  const adjudications = JSON.parse(evidenceContents.at(-1).toString('utf8'));
  exactIds(report.replacedIds, (id) => id, adjudications.replacedIds ?? [], 'ledger replaced ids');

  const runtimeDirectory = path.join(root, runtimeResourcesRelativePath);
  const runtimeCatalogContents = await readFile(path.join(root, runtimeCatalogRelativePath));
  const runtimeCatalog = JSON.parse(runtimeCatalogContents);
  validateManifestAgainstCatalog(manifest, runtimeCatalog);
  validateLedger(manifest, report);
  const sourceCatalogContents = await readFile(path.join(root, sourceResourcesRelativePath, 'creatures.json'));
  invariant(sha256(runtimeCatalogContents) === manifest.catalogSha256, 'runtime catalog SHA-256 drift');
  invariant(sha256(sourceCatalogContents) === manifest.catalogSha256, 'source/runtime catalog parity failed');
  assertDeepExact(JSON.parse(sourceCatalogContents), runtimeCatalog, 'source/runtime catalog content');

  const expectedPngNames = manifest.assets.map((asset) => `${asset.id}.png`).sort();
  const sourceCreatureDirectory = path.join(root, sourceResourcesRelativePath, 'Creatures');
  const runtimePngNames = (await readdir(runtimeDirectory)).filter((name) => /^PG-\d{3}\.png$/.test(name)).sort();
  const sourcePngNames = (await readdir(sourceCreatureDirectory)).filter((name) => /^PG-\d{3}\.png$/.test(name)).sort();
  exactIds(runtimePngNames, (name) => name, expectedPngNames, 'runtime PNG files');
  exactIds(sourcePngNames, (name) => name, expectedPngNames, 'source PNG files');
  for (const asset of manifest.assets) {
    invariant(asset.path === `${runtimeResourcesRelativePath}/${asset.id}.png`, `${asset.id}: runtime asset path must be exact`);
    const runtimePath = path.join(runtimeDirectory, `${asset.id}.png`);
    const [runtimeContents, sourceContents, runtimeInfo] = await Promise.all([readFile(runtimePath), readFile(path.join(sourceCreatureDirectory, `${asset.id}.png`)), stat(runtimePath)]);
    const dimensions = pngDimensions(runtimeContents, asset.id);
    invariant(runtimeInfo.size === asset.bytes && dimensions.width === asset.width && dimensions.height === asset.height, `${asset.id}: runtime asset metadata drift`);
    invariant(sha256(runtimeContents) === asset.sha256 && sha256(sourceContents) === asset.sha256, `${asset.id}: source/runtime asset SHA-256 drift`);
  }
  const fingerprint = createHash('sha256').update(manifest.catalogSha256).update(manifest.assets.map((asset) => `${asset.id}:${asset.sha256}`).join('\n')).digest('hex');
  invariant(fingerprint === manifest.resourcesFingerprint, 'manifest resources fingerprint drift');
  for (const sheet of manifest.visualArtifacts) {
    const contents = await readFile(path.join(root, 'docs/qa/evolution-continuity', sheet.path));
    const actual = decodedPngEvidence(contents, sheet.path);
    invariant(actual.pixelSha256 === sheet.pixelSha256, `${sheet.path}: contact-sheet pixel SHA-256 drift`);
    invariant(actual.width === sheet.width, `${sheet.path}: contact-sheet width drift`);
    invariant(actual.height === sheet.height, `${sheet.path}: contact-sheet height drift`);
  }
  console.log(JSON.stringify({ status: 'PASS', creatures: 240, units: 119, edges: 190, sheets: 12 }));
}

async function main() {
  if (process.argv.includes('--self-test')) await runSelfTests();
  else await verifyFiles();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
