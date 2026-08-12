#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalStringify, sha256Bytes } from './lib/continuity-assignment/canonical-json.mjs';
import { buildG003V5AssignmentV3 } from './lib/continuity-assignment/g003-v5-assignment.mjs';
import { CONTINUITY_ROOT_DIRECTIVES, deriveCrossAuthorityObligationScope } from './lib/continuity-assignment/g002-v2-cross-authority-supersession.mjs';
import { CONTINUITY_RUNTIME_DERIVATION_V1, deriveContinuityRuntimePng } from './lib/continuity-candidate-png.mjs';
import {
  createTestOnlyApprovedMaterialV5Receipt, createTestOnlyApprovedMaterialV5Resolver,
  createTestOnlyG003V5EffectiveStateResolver, createTestOnlyG003V5PackagePreparationAuthority,
  prepareG003V5Package, verifyG003V5Package,
} from './lib/g003-v5-package-preparation.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative)));
const assignment = await readJson('production/reports/biological-continuity-v3/g002-evidence-v2/assignment-manifest.json');
const topology = await readJson('production/reports/biological-continuity-v3/g002-evidence-v2/topology-after.json');
const scope = deriveCrossAuthorityObligationScope(assignment, topology);
const assignmentV3 = buildG003V5AssignmentV3({ assignment, topology, supersession: { rootDirectives: CONTINUITY_ROOT_DIRECTIVES, obligationScope: scope } });
const pixels = await readJson('production/reports/biological-continuity-v3/g002-evidence-v1/pixel-clusters.json');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'g003-v5-package-'));
const hex = (text) => sha256Bytes(Buffer.from(text));
const terminalBinding = { protocolAuthoritySha256: hex('protocol'), terminalOutputSha256: hex('terminal'), signedObligationScopeSha256: hex('scope') };

async function copyRelative(source, relative) { await mkdir(path.dirname(path.join(temporary, relative)), { recursive: true }); await copyFile(path.join(ROOT, source), path.join(temporary, relative)); }
const retainedMaterials = [];
for (const slotId of ['PG-001', 'PG-061']) {
  const entry = pixels.entries.find((item) => item.pgId === slotId); const masterPath = `retained/${slotId}/master.png`; const runtimePath = `retained/${slotId}/runtime.png`;
  await copyRelative(entry.surfaces.master.path, masterPath); await copyRelative(entry.surfaces.runtime.path, runtimePath);
  retainedMaterials.push({ slotId, masterPath, runtimePath });
}
const authority = createTestOnlyG003V5PackagePreparationAuthority({ assignmentV3, terminalBinding, retainedMaterials });
const tombstones = new Set();
const effectiveStateResolver = createTestOnlyG003V5EffectiveStateResolver(({ materialSha256, constituentMaterialSha256s }) => {
  const matched = [materialSha256, ...constituentMaterialSha256s].find((digest) => tombstones.has(digest)) ?? null;
  return { status: matched ? 'REJECTED' : 'CLEAR', matchedMaterialSha256: matched };
});
let approvedResolver = createTestOnlyApprovedMaterialV5Resolver({ authority, receipts: [] });

const sourceMaster = await readFile(path.join(ROOT, pixels.entries.find((entry) => entry.pgId === 'PG-001').surfaces.master.path));
const alternateEntry = pixels.entries.find((entry) => entry.pgId === 'PG-002');
const alternateMaster = await readFile(path.join(ROOT, alternateEntry.surfaces.master.path));
async function stage(slotId, runId, { masterBytes = sourceMaster, runtimeBytes = deriveContinuityRuntimePng(masterBytes), provenancePatch = null } = {}) {
  const root = `assets/creatures/biological-continuity-v3/candidates/${runId}/${slotId}`;
  const workspace = `assets/creatures/biological-continuity-v3/workspace-masters/${runId}/${slotId}/${sha256Bytes(masterBytes)}.png`;
  const prompt = Buffer.from(`Generate ${slotId} under the signed biological contract.\n`);
  const descriptor = (filePath, bytes, width, height) => ({ path: filePath, sha256: sha256Bytes(bytes), bytes: bytes.length, width, height });
  const masterDecoded = (masterBytes === alternateMaster ? alternateEntry : pixels.entries.find((entry) => entry.pgId === 'PG-001')).surfaces.master.features;
  let provenance = { schemaVersion: 'continuity-candidate-provenance-v1', slotId, generationRunId: runId, sourceKind: 'local-built-in-imagegen-png',
    promptSha256: sha256Bytes(prompt), workspaceMaster: descriptor(workspace, masterBytes, masterDecoded.width, masterDecoded.height),
    candidateMaster: descriptor(`${root}/master.png`, masterBytes, masterDecoded.width, masterDecoded.height),
    runtime: descriptor(`${root}/runtime.png`, runtimeBytes, 360, 360), derivation: structuredClone(CONTINUITY_RUNTIME_DERIVATION_V1) };
  if (provenancePatch) provenance = provenancePatch(provenance);
  for (const [relative, bytes] of [[workspace, masterBytes], [`${root}/master.png`, masterBytes], [`${root}/runtime.png`, runtimeBytes], [`${root}/prompt.txt`, prompt], [`${root}/provenance.json`, Buffer.from(canonicalStringify(provenance))]]) {
    await mkdir(path.dirname(path.join(temporary, relative)), { recursive: true }); await writeFile(path.join(temporary, relative), bytes);
  }
  return { root, workspace };
}

await stage('PG-005', 'root-run');
const rootPackage = await prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver });
assert.equal(rootPackage.requiredChildTaxonomy.coreAnatomy, 'hexapod'); assert.equal(rootPackage.reviewContext.canonicalMode, true);
await verifyG003V5Package(rootPackage);
const rootReceipt = createTestOnlyApprovedMaterialV5Receipt({ verifiedPackage: rootPackage, approvedAt: '2026-08-11T00:00:00.000Z' }, authority);
approvedResolver = createTestOnlyApprovedMaterialV5Resolver({ authority, receipts: [rootReceipt] });

await stage('PG-065', 'dependent-run', { masterBytes: alternateMaster });
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-065', stagedGenerationRunId: 'dependent-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: createTestOnlyApprovedMaterialV5Resolver({ authority, receipts: [] }), effectiveStateResolver }), /missing current approved-material-v5 tip/);
const dependentPackage = await prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-065', stagedGenerationRunId: 'dependent-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver });
const dependentReceipt = createTestOnlyApprovedMaterialV5Receipt({ verifiedPackage: dependentPackage, approvedAt: '2026-08-11T00:01:00.000Z' }, authority);
approvedResolver = createTestOnlyApprovedMaterialV5Resolver({ authority, receipts: [rootReceipt, dependentReceipt] });

const retainedEdge = await prepareG003V5Package({ request: { obligationId: 'g003-edge:PG-001:PG-061' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver });
assert.equal(retainedEdge.childMaterialSha256s[0], assignmentV3.obligations.find((entry) => entry.obligationId === retainedEdge.obligationId).retainedSurfaceBindings.find((entry) => entry.role === 'child').masterSha256);
const generatedEdge = await prepareG003V5Package({ request: { obligationId: 'g003-edge:PG-005:PG-065' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver });
assert.deepEqual(generatedEdge.childMaterialSha256s, dependentPackage.childMaterialSha256s);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-edge:PG-005:PG-065' }, repoRoot: temporary,
  authority, approvedMaterialResolver: { resolve: () => rootReceipt }, effectiveStateResolver }), /resolver is not verified/);

await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run', masterPath: 'forged.png' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /fields mismatch/);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run', materialSha256: '0'.repeat(64) }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /fields mismatch/);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-edge:PG-001:PG-061', stagedGenerationRunId: 'forged' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /fields mismatch/);
await assert.rejects(prepareG003V5Package({ request: { obligationId: '../outside', stagedGenerationRunId: 'x' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /outside exact assignment-v3/);

const badRuntime = Buffer.from(deriveContinuityRuntimePng(sourceMaster)); badRuntime[badRuntime.length - 1] ^= 1; await stage('PG-005', 'bad-crc', { runtimeBytes: badRuntime });
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'bad-crc' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /PNG\/CRC|invalid/);
await stage('PG-005', 'bad-provenance', { provenancePatch: (value) => ({ ...value, promptSha256: '0'.repeat(64) }) });
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'bad-provenance' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /staged bytes differ/);
const wrongRuntime = deriveContinuityRuntimePng(sourceMaster); wrongRuntime[100] ^= 1; await stage('PG-005', 'bad-runtime', { runtimeBytes: wrongRuntime });
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'bad-runtime' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /PNG\/CRC|deterministic derivative/);

await stage('PG-005', 'symlink-run'); const symlinkMaster = path.join(temporary, 'assets/creatures/biological-continuity-v3/candidates/symlink-run/PG-005/master.png');
await unlink(symlinkMaster); await symlink(path.join(temporary, 'retained/PG-001/master.png'), symlinkMaster);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'symlink-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /symlink/);
await stage('PG-005', 'hardlink-run'); const hardMaster = path.join(temporary, 'assets/creatures/biological-continuity-v3/candidates/hardlink-run/PG-005/master.png');
await unlink(hardMaster); await link(path.join(temporary, 'retained/PG-001/master.png'), hardMaster);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'hardlink-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /independent regular file/);

const binding = JSON.parse(await readFile(path.join(temporary, rootPackage.packageRoot, 'material-binding.json')));
tombstones.add(binding.materialSha256);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver, outputRoot: '.omx/evidence/g003-v5/rejected-exact' }), /tombstoned/);
tombstones.delete(binding.materialSha256); tombstones.add(binding.constituentMaterialSha256s[0]);
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver, outputRoot: '.omx/evidence/g003-v5/rejected-constituent' }), /tombstoned/);
await assert.rejects(verifyG003V5Package(rootPackage), /tombstoned/); tombstones.clear(); await verifyG003V5Package(rootPackage);

const repeated = await prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver });
assert.equal(repeated.packageManifestSha256, rootPackage.packageManifestSha256);
await writeFile(path.join(temporary, rootPackage.packageRoot, 'prompt.txt'), 'tampered');
await assert.rejects(prepareG003V5Package({ request: { obligationId: 'g003-candidate:PG-005', stagedGenerationRunId: 'root-run' }, repoRoot: temporary,
  authority, approvedMaterialResolver: approvedResolver, effectiveStateResolver }), /different bytes|differs/);

console.log(JSON.stringify({ status: 'PASS', rootQueue: true, dependentQueue: true, retainedEdge: true, generatedEdge: true, hostileCases: 14,
  deterministicManifest: rootPackage.packageManifestSha256 }));
