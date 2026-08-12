import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const MANIFEST_RELATIVE_PATH = 'docs/qa/evolution-continuity/evolution-audit-manifest.json';
export const ADJUDICATIONS_RELATIVE_PATH = 'production/reports/evolution-runtime-adjudications.json';
export const OUTPUT_RELATIVE_PATH = 'production/reports/evolution-runtime-visual-audit.json';
export const LANE_RELATIVE_PATHS = ['a', 'b', 'c'].map(
  (lane) => `production/reports/evolution-runtime-audit-lanes/lane-${lane}.json`,
);
export const ACCEPTANCE_THRESHOLD = 90;

const EXPECTED_LANE_SHEETS = {
  A: [
    'normal-lineages-001-010.png', 'normal-lineages-011-020.png',
    'exceptional-evolutions-001-010.png', 'exceptional-evolutions-011-020.png',
  ],
  B: [
    'normal-lineages-021-030.png', 'normal-lineages-031-040.png',
    'exceptional-evolutions-021-030.png', 'exceptional-evolutions-031-040.png',
  ],
  C: [
    'normal-lineages-041-050.png', 'normal-lineages-051-060.png',
    'exceptional-evolutions-041-050.png', 'exceptional-evolutions-051-059.png',
  ],
};
const SUPPLEMENTAL_REREVIEW_UNITS = new Set(['normal-PG-L060', 'mixed-PG-199', 'mutant-PG-227']);

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function edgeId(edge) {
  return `${edge.parentId}->${edge.childId}`;
}

function assertUniqueExact(actualIds, expectedIds, label) {
  const seen = new Set();
  for (const id of actualIds) {
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

function assertSheetDescriptor(actual, expected, label) {
  assertUniqueExact(Object.keys(actual ?? {}), ['path', 'pixelSha256', 'width', 'height'], `${label} fields`);
  invariant(actual.path === expected?.path, `${label}: path drift`);
  invariant(typeof actual.pixelSha256 === 'string' && actual.pixelSha256.length === 64, `${label}: invalid pixel SHA-256`);
  invariant(actual.pixelSha256 === expected?.pixelSha256, `${label}: pixel SHA-256 drift`);
  invariant(Number.isInteger(actual.width) && actual.width > 0 && actual.width === expected?.width, `${label}: width drift`);
  invariant(Number.isInteger(actual.height) && actual.height > 0 && actual.height === expected?.height, `${label}: height drift`);
}

function normalizedVerdict(record) {
  return {
    verdict: String(record?.verdict ?? '').toUpperCase(),
    score: Number(record?.score),
    categoryMatch: record?.categoryMatch,
    differences: record?.differences,
    suggestions: record?.suggestions,
    reasoning: record?.reasoning,
  };
}

function normalizedEdgeVerdict(record, unitRecord) {
  const unitVerdict = normalizedVerdict(unitRecord);
  return {
    verdict: String(record?.verdict ?? '').toUpperCase(),
    score: Number(record?.score),
    categoryMatch: unitVerdict.categoryMatch,
    differences: record?.inheritedTraits,
    suggestions: record?.issues,
    reasoning: unitVerdict.reasoning,
  };
}

function assertCompleteVerdict(record, label) {
  invariant(record.verdict === 'PASS', `${label}: verdict must be PASS`);
  invariant(
    Number.isFinite(record.score) && record.score >= ACCEPTANCE_THRESHOLD && record.score <= 100,
    `${label}: score must be between ${ACCEPTANCE_THRESHOLD} and 100`,
  );
  invariant(record.categoryMatch === true, `${label}: categoryMatch must be true`);
  invariant(Array.isArray(record.differences), `${label}: differences must be an array`);
  invariant(Array.isArray(record.suggestions), `${label}: suggestions must be an array`);
  invariant(typeof record.reasoning === 'string' && record.reasoning.trim(), `${label}: reasoning is required`);
}

function laneUnits(lane) {
  invariant(Array.isArray(lane.units), 'lane units must be an array');
  return lane.units;
}

function laneEdges(lane) {
  return laneUnits(lane).flatMap((unit) =>
    unit.edgeVerdicts.map((edge) => ({ ...edge, unitId: unit.unitId })),
  );
}

export function assertBinding(document, manifestHash, manifest, label) {
  invariant(document.manifestSha256 === manifestHash, `${label}: stale manifestSha256 binding`);
  invariant(document.resourcesFingerprint === manifest.resourcesFingerprint, `${label}: stale resourcesFingerprint binding`);
}

export function validateLaneBindings(laneInputs, manifestHash, manifest, sheetsByName) {
  const union = [];
  for (const [index, input] of laneInputs.entries()) {
    const lane = input.document;
    const expectedIdentity = ['A', 'B', 'C'][index];
    invariant(input.relativePath.endsWith(`lane-${expectedIdentity.toLowerCase()}.json`), `${input.relativePath}: filename/lane identity mismatch`);
    invariant(lane.lane === expectedIdentity, `${input.relativePath}: lane must be ${expectedIdentity}`);
    assertBinding(lane, manifestHash, manifest, input.relativePath);
    assertUniqueExact(lane.sheets, EXPECTED_LANE_SHEETS[expectedIdentity], `${input.relativePath} sheets`);
    invariant(Array.isArray(lane.sheetEvidence), `${input.relativePath}: sheetEvidence must be an array`);
    assertUniqueExact(lane.sheetEvidence.map((entry) => entry.path), EXPECTED_LANE_SHEETS[expectedIdentity], `${input.relativePath} sheetEvidence`);
    for (const evidence of lane.sheetEvidence) {
      assertSheetDescriptor(evidence, sheetsByName.get(evidence.path), `${input.relativePath}: ${evidence.path}`);
    }
    const allowedSheets = new Set(EXPECTED_LANE_SHEETS[expectedIdentity]);
    for (const unit of laneUnits(lane)) {
      const manifestUnit = manifest.units.find((candidate) => candidate.unitId === unit.unitId);
      invariant(manifestUnit, `${input.relativePath}: unexpected unit ${unit.unitId}`);
      invariant(allowedSheets.has(manifestUnit.sheet), `${input.relativePath}: ${unit.unitId} belongs to ${manifestUnit.sheet}`);
    }
    union.push(...lane.sheetEvidence.map((entry) => entry.path));
  }
  assertUniqueExact(union, sheetsByName.keys(), 'lane sheet union');
}

async function readInputs(rootDirectory) {
  const manifestContents = await readFile(path.join(rootDirectory, MANIFEST_RELATIVE_PATH));
  const laneInputs = await Promise.all(LANE_RELATIVE_PATHS.map(async (relativePath) => {
    const contents = await readFile(path.join(rootDirectory, relativePath));
    return { relativePath, contents, document: JSON.parse(contents.toString('utf8')) };
  }));
  const adjudicationsContents = await readFile(path.join(rootDirectory, ADJUDICATIONS_RELATIVE_PATH));
  return {
    manifestContents,
    manifest: JSON.parse(manifestContents.toString('utf8')),
    laneInputs,
    adjudicationsContents,
    adjudications: JSON.parse(adjudicationsContents.toString('utf8')),
  };
}

export async function buildRuntimeEvolutionAudit({ rootDirectory = process.cwd(), inputs = null } = {}) {
  const loaded = inputs ?? await readInputs(rootDirectory);
  const { manifestContents, manifest, laneInputs, adjudicationsContents, adjudications } = loaded;
  const manifestHash = sha256(manifestContents);

  invariant(manifest.assetCount === 240 && manifest.assets?.length === 240, 'manifest must contain 240 assets');
  invariant(manifest.creatureCount === 240 && manifest.coveredCreatureIds?.length === 240, 'manifest must cover 240 creatures');
  invariant(manifest.unitCount === 119 && manifest.units?.length === 119, 'manifest must contain 119 units');
  invariant(manifest.edgeCount === 190, 'manifest must contain 190 edges');
  invariant(manifest.visualArtifacts?.length === 12, 'manifest must contain 12 contact sheets');

  const assetsById = new Map();
  for (const asset of manifest.assets) {
    invariant(!assetsById.has(asset.id), `manifest assets: duplicate ${asset.id}`);
    invariant(typeof asset.sha256 === 'string' && asset.sha256.length === 64, `${asset.id}: invalid asset SHA-256`);
    assetsById.set(asset.id, asset);
  }
  assertUniqueExact(manifest.coveredCreatureIds, assetsById.keys(), 'manifest creature ids');

  const sheetsByName = new Map();
  for (const artifact of manifest.visualArtifacts) {
    invariant(!sheetsByName.has(artifact.path), `manifest sheets: duplicate ${artifact.path}`);
    assertSheetDescriptor(artifact, artifact, `manifest sheet ${artifact.path}`);
    sheetsByName.set(artifact.path, artifact);
  }
  validateLaneBindings(laneInputs, manifestHash, manifest, sheetsByName);
  assertBinding(adjudications, manifestHash, manifest, ADJUDICATIONS_RELATIVE_PATH);

  const unitsById = new Map();
  const edgesById = new Map();
  for (const unit of manifest.units) {
    invariant(!unitsById.has(unit.unitId), `manifest units: duplicate ${unit.unitId}`);
    invariant(sheetsByName.has(unit.sheet), `${unit.unitId}: unknown sheet ${unit.sheet}`);
    invariant(Number.isInteger(unit.row) && unit.row > 0, `${unit.unitId}: invalid sheet row`);
    assertUniqueExact(unit.creatureIds, unit.creatureIds, `${unit.unitId} creature ids`);
    for (const id of unit.creatureIds) invariant(assetsById.has(id), `${unit.unitId}: missing asset ${id}`);
    if (unit.category === 'mixed') {
      invariant(unit.edges.length === 2, `${unit.unitId}: mixed unit must have two parent edges`);
      invariant(unit.edges[0].childId === unit.edges[1].childId, `${unit.unitId}: mixed parent edges must share a child`);
    }
    unitsById.set(unit.unitId, unit);
    for (const edge of unit.edges) {
      const id = edgeId(edge);
      invariant(!edgesById.has(id), `manifest edges: duplicate ${id}`);
      edgesById.set(id, { ...edge, unitId: unit.unitId });
    }
  }
  invariant(edgesById.size === 190, `manifest edge total must be 190, got ${edgesById.size}`);

  const laneUnitRecords = laneInputs.flatMap((input) => laneUnits(input.document));
  const laneEdgeRecords = laneInputs.flatMap((input) => laneEdges(input.document));
  assertUniqueExact(laneUnitRecords.map((record) => record.unitId), unitsById.keys(), 'lane units');
  assertUniqueExact(laneEdgeRecords.map(edgeId), edgesById.keys(), 'lane edges');
  for (const record of laneEdgeRecords) {
    invariant(record.unitId === edgesById.get(edgeId(record)).unitId, `${edgeId(record)}: lane edge is attached to the wrong unit`);
  }

  const unitRecordsById = new Map(laneUnitRecords.map((record) => [record.unitId, record]));
  const edgeRecordsById = new Map(laneEdgeRecords.map((record) => [edgeId(record), record]));
  invariant(Array.isArray(adjudications.units), 'adjudications: units must be an array');
  const adjudicationList = adjudications.units;
  const unitOverrides = new Map();
  const edgeOverrides = new Map();
  for (const entry of adjudicationList) {
    invariant(unitsById.has(entry.unitId), `adjudications: unexpected unit ${entry.unitId}`);
    invariant(!unitOverrides.has(entry.unitId), `adjudications: duplicate unit ${entry.unitId}`);
    unitOverrides.set(entry.unitId, entry);
    const expectedEdges = new Set(unitsById.get(entry.unitId).edges.map(edgeId));
    invariant(Array.isArray(entry.edgeVerdicts), `${entry.unitId}: edgeVerdicts must be an array`);
    const suppliedEdgeIds = entry.edgeVerdicts.map(edgeId);
    invariant(new Set(suppliedEdgeIds).size === suppliedEdgeIds.length, `${entry.unitId}: duplicate adjudicated edge`);
    for (const id of suppliedEdgeIds) invariant(expectedEdges.has(id), `${entry.unitId}: unexpected adjudicated edge ${id}`);
    for (const edge of entry.edgeVerdicts) {
      const id = edgeId(edge);
      invariant(!edgeOverrides.has(id), `adjudications: duplicate edge ${id}`);
      edgeOverrides.set(id, { ...edge, unitId: entry.unitId, unitVerdict: entry });
    }
  }

  const requiredOverrides = new Set();
  for (const [unitId, unitRecord] of unitRecordsById) {
    const unitInitial = normalizedVerdict(unitRecord);
    const edgeInitials = unitsById.get(unitId).edges.map((edge) =>
      normalizedEdgeVerdict(edgeRecordsById.get(edgeId(edge)), unitRecord),
    );
    const initialNonPass = unitInitial.verdict !== 'PASS' || edgeInitials.some((edge) => edge.verdict !== 'PASS');
    if (initialNonPass) requiredOverrides.add(unitId);
    const hasThresholdScore = unitInitial.score === ACCEPTANCE_THRESHOLD
      || edgeInitials.some((edge) => edge.score === ACCEPTANCE_THRESHOLD);
    if (unitOverrides.has(unitId) && !initialNonPass) {
      invariant(SUPPLEMENTAL_REREVIEW_UNITS.has(unitId) && hasThresholdScore, `${unitId}: unnecessary PASS override`);
    }
  }
  for (const unitId of requiredOverrides) {
    invariant(unitOverrides.has(unitId), `${unitId}: initial non-PASS unit requires adjudication`);
  }
  for (const unitId of unitOverrides.keys()) {
    invariant(requiredOverrides.has(unitId) || SUPPLEMENTAL_REREVIEW_UNITS.has(unitId), `${unitId}: unnecessary extra adjudication`);
  }
  for (const [id, override] of edgeOverrides) {
    const unitId = override.unitId;
    invariant(unitOverrides.has(unitId), `${id}: edge adjudication requires an allowed unit adjudication`);
  }

  const finalUnits = manifest.units.map((unit) => {
    const initial = normalizedVerdict(unitRecordsById.get(unit.unitId));
    const override = unitOverrides.get(unit.unitId);
    const verdict = override ? normalizedVerdict(override) : initial;
    assertCompleteVerdict(verdict, unit.unitId);
    return {
      unitId: unit.unitId, category: unit.category, creatureIds: [...unit.creatureIds],
      verdict: verdict.verdict, score: verdict.score, categoryMatch: verdict.categoryMatch,
      differences: verdict.differences, suggestions: verdict.suggestions, reasoning: verdict.reasoning,
      adjudicated: Boolean(override), initialVerdict: initial.verdict,
      sheetEvidence: { ...sheetsByName.get(unit.sheet), row: unit.row },
      assetEvidence: unit.creatureIds.map((id) => ({ ...assetsById.get(id) })),
    };
  });

  const finalEdges = [...edgesById.values()].map((edge) => {
    const id = edgeId(edge);
    const initial = normalizedEdgeVerdict(edgeRecordsById.get(id), unitRecordsById.get(edge.unitId));
    const override = edgeOverrides.get(id);
    const verdict = override
      ? normalizedEdgeVerdict(override, override.unitVerdict)
      : initial;
    assertCompleteVerdict(verdict, id);
    invariant(verdict.differences.length > 0, `${id}: edge differences must contain inherited-trait evidence`);
    const unit = unitsById.get(edge.unitId);
    return {
      edgeId: id, unitId: edge.unitId, parentId: edge.parentId, childId: edge.childId,
      verdict: verdict.verdict, score: verdict.score, categoryMatch: verdict.categoryMatch,
      differences: verdict.differences, suggestions: verdict.suggestions, reasoning: verdict.reasoning,
      adjudicated: Boolean(override), initialVerdict: initial.verdict,
      sheetEvidence: { ...sheetsByName.get(unit.sheet), row: unit.row },
      assetEvidence: [edge.parentId, edge.childId].map((assetId) => ({ ...assetsById.get(assetId) })),
    };
  });

  invariant(Array.isArray(adjudications.replacedIds), 'adjudications: replacedIds must be an array');
  assertUniqueExact(adjudications.replacedIds, adjudications.replacedIds, 'adjudications replaced ids');
  const replacedIds = [...adjudications.replacedIds].sort();
  for (const id of replacedIds) invariant(assetsById.has(id), `adjudications: unexpected replaced asset ${id}`);
  return {
    schemaVersion: 1, status: 'PASS', acceptanceThreshold: ACCEPTANCE_THRESHOLD,
    manifestPath: MANIFEST_RELATIVE_PATH, manifestSha256: manifestHash,
    resourcesFingerprint: manifest.resourcesFingerprint, catalogSha256: manifest.catalogSha256,
    laneEvidence: laneInputs.map((input) => ({ path: input.relativePath, sha256: sha256(input.contents) })),
    adjudicationEvidence: { path: ADJUDICATIONS_RELATIVE_PATH, sha256: sha256(adjudicationsContents) },
    replacedIds, summary: { creatures: 240, units: 119, edges: 190 },
    units: finalUnits, edges: finalEdges,
  };
}

async function main() {
  const report = await buildRuntimeEvolutionAudit();
  await writeFile(path.join(process.cwd(), OUTPUT_RELATIVE_PATH), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: OUTPUT_RELATIVE_PATH, ...report.summary, replacedIds: report.replacedIds }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
