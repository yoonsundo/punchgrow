#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { CONTINUITY_ROOT_DIRECTIVES, deriveCrossAuthorityObligationScope } from './lib/continuity-assignment/g002-v2-cross-authority-supersession.mjs';
import {
  G003_V5_ASSIGNMENT_V3_PATH, assertG003V5AssignmentV3Core, buildG003V5AssignmentV3,
  deriveG003V5AssignmentV3Binding, validateG003V5AssignmentV3,
} from './lib/continuity-assignment/g003-v5-assignment.mjs';

const read = async (relative) => JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url)));
const assignment = await read('production/reports/biological-continuity-v3/g002-evidence-v2/assignment-manifest.json');
const topology = await read('production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json');
const supersession = { rootDirectives: CONTINUITY_ROOT_DIRECTIVES, obligationScope: deriveCrossAuthorityObligationScope(assignment, topology) };
const inputs = { assignment, topology, supersession };

const first = buildG003V5AssignmentV3(inputs);
const second = buildG003V5AssignmentV3(structuredClone(inputs));
assert.equal(sha256Canonical(first), sha256Canonical(second));
assert.equal(first.obligations.length, 337);
assert.equal(first.obligations.filter((entry) => entry.kind === 'QUEUE').length, 167);
assert.equal(first.obligations.filter((entry) => entry.kind === 'EDGE').length, 170);
assert.equal(first.obligations.filter((entry) => entry.kind === 'QUEUE' && entry.assessmentMode === 'canonical-root-replacement').length, 17);
assert.equal(first.obligations.some((entry) => /PG-(?:19[6-9]|20[0-5])/.test(entry.obligationId)), false);
assert.equal(first.obligations.some((entry) => entry.obligationId.includes('PG-197')), false);

const pg005 = first.obligations.find((entry) => entry.obligationId === 'g003-candidate:PG-005');
assert.equal(pg005.assessmentMode, 'canonical-root-replacement');
assert.deepEqual(pg005.requiredChildTaxonomy, { biologicalClass: 'construct', speciesFamily: 'construct', coreAnatomy: 'hexapod', locomotionPlan: 'crawling' });
assert.ok(pg005.requiredAnchors.some((entry) => entry.anchorId === 'visibility:exactly-six-visible-walking-legs'));
assert.ok(pg005.requiredAnchors.some((entry) => entry.anchorId === 'visibility:all-six-legs-separately-readable'));
for (const slotId of ['PG-018', 'PG-078', 'PG-232']) {
  const obligations = first.obligations.filter((entry) => entry.childSlotId === slotId);
  assert.ok(obligations.length > 0);
  assert.ok(obligations.every((entry) => entry.requiredChildTaxonomy.speciesFamily === 'ovine'));
}

const generatedEdge = first.obligations.find((entry) => entry.obligationId === 'g003-edge:PG-018:PG-078');
assert.equal(generatedEdge.childSourcePolicy, 'APPROVED_MATERIAL_V5');
assert.deepEqual(generatedEdge.requiredParentObligationIds, ['g003-candidate:PG-018', 'g003-candidate:PG-078']);
const retainedEdge = first.obligations.find((entry) => entry.kind === 'EDGE' && entry.childSourcePolicy === 'SIGNED_RETAINED_G002');
assert.ok(retainedEdge.retainedSurfaceBindings.some((binding) => binding.role === 'child'));
assert.ok(retainedEdge.retainedSurfaceBindings.every((binding) => /^[a-f0-9]{64}$/.test(binding.masterSha256) && /^[a-f0-9]{64}$/.test(binding.runtimeSha256)));
validateG003V5AssignmentV3(first, inputs);

const unknown = structuredClone(first); unknown.injected = true;
assert.throws(() => assertG003V5AssignmentV3Core(unknown), /fields mismatch/);
const tampered = structuredClone(first); tampered.obligations[0].requiredChildTaxonomy.speciesFamily = 'fabricated';
assert.throws(() => validateG003V5AssignmentV3(tampered, inputs), /deterministic immutable-input derivation/);
const mixed = structuredClone(supersession); mixed.obligationScope.queueSlotIds[0] = 'PG-197';
assert.throws(() => buildG003V5AssignmentV3({ assignment, topology, supersession: mixed }), /mixed|queue scope/);
const cycle = structuredClone(supersession);
cycle.obligationScope.ordinaryEdges = cycle.obligationScope.ordinaryEdges.map((edge) => edge.parentId === 'PG-001' && edge.childId === 'PG-061' ? { parentId: 'PG-061', childId: 'PG-001' } : edge);
assert.throws(() => buildG003V5AssignmentV3({ assignment, topology, supersession: cycle }), /scope|cycle/);
const wrongDirective = structuredClone(supersession); wrongDirective.rootDirectives[1].canonicalTarget.speciesFamily = 'bovine';
assert.throws(() => buildG003V5AssignmentV3({ assignment, topology, supersession: wrongDirective }), /root directives/);
const badSurface = structuredClone(assignment);
const retained = badSurface.assignments.find((entry) => entry.sourceKind === 'existing'); retained.targetEvidence.masterSha256 = '0'.repeat(64);
assert.throws(() => buildG003V5AssignmentV3({ assignment: badSurface, topology, supersession }), /retained surfaces/);

const schema = await read('production/contracts/continuity-assignment-v3.schema.json');
const schemaBytes = await readFile(new URL('../production/contracts/continuity-assignment-v3.schema.json', import.meta.url));
assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(schema.additionalProperties, false);
assert.equal(schema.properties.obligations.minItems, 337);
assert.equal(schema.properties.obligations.maxItems, 337);
assert.equal(schema.$defs.obligation.additionalProperties, false);
assert.equal(canonicalStringify(schema.properties.counts.const), canonicalStringify(first.counts));
for (const field of ['delegationOutputSha256', 'successorOutputSha256', 'outputSha256', 'publicSignature']) assert.ok(schema.required.includes(field));
assert.equal(schema.$defs.signature.properties.purpose.const, 'continuity:assignment-v3');
const binding = deriveG003V5AssignmentV3Binding({ assignment, topology, obligationScope: supersession.obligationScope, schemaSha256: sha256Bytes(schemaBytes) });
assert.deepEqual(binding, { fixedPath: G003_V5_ASSIGNMENT_V3_PATH, schemaSha256: sha256Bytes(schemaBytes), coreSha256: sha256Canonical(first) });
assert.equal(Object.hasOwn(binding, 'successorOutputSha256'), false);

console.log(JSON.stringify({ status: 'PASS', obligations: 337, queue: 167, ordinaryEdges: 170, sha256: sha256Canonical(first), hostileCases: 5 }));
