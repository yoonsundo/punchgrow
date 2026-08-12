import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, listContainedRegularFiles } from './continuity-assignment/evidence.mjs';
import { assertG003V5AssignmentV3Core } from './continuity-assignment/g003-v5-assignment.mjs';
import {
  CONTINUITY_RUNTIME_DERIVATION_V1, assertRuntimeDerivedFromMaster, inspectContinuityPng, readStableContainedFile,
} from './continuity-candidate-png.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from './g003-transition-integrity.mjs';

export const G003_V5_PACKAGE_ROOT = '.omx/evidence/g003-v5/packages';
export const G003_V5_PACKAGE_SCHEMA_PATHS = Object.freeze([
  'production/contracts/continuity-g003-source-receipts-v5.schema.json',
  'production/contracts/continuity-g003-material-binding-v5.schema.json',
  'production/contracts/continuity-g003-input-allowlist-v5.schema.json',
  'production/contracts/continuity-g003-locked-review-contract-v5.schema.json',
  'production/contracts/continuity-g003-package-manifest-v5.schema.json',
  'production/contracts/continuity-g003-approved-material-v5.schema.json',
]);

const SHA = /^[a-f0-9]{64}$/; const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTHORITIES = new WeakSet(); const APPROVED_RECEIPTS = new WeakSet(); const APPROVED_RESOLVERS = new WeakSet();
const EFFECTIVE_STATE_RESOLVERS = new WeakSet(); const VERIFIED_PACKAGES = new WeakSet(); const PACKAGE_STATE = new WeakMap();
const fail = (message) => { throw new Error(`G003-v5 package preparation: ${message}`); };
const clone = (value) => structuredClone(value);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (canonicalStringify(actual) !== canonicalStringify(expected)) fail(`${label} fields mismatch`);
}
function assertSha(value, label) { if (!SHA.test(value ?? '')) fail(`${label} is not a SHA-256`); }
function canonicalBytes(value) { return Buffer.from(canonicalStringify(value)); }
function parseCanonical(bytes, label) {
  let value; try { value = JSON.parse(bytes); } catch { fail(`${label} is not JSON`); }
  if (!Buffer.from(bytes).equals(canonicalBytes(value))) fail(`${label} is not canonical JSON`);
  return value;
}
function surfaceDescriptor(pathValue, bytes, options) { return { path: pathValue, ...inspectContinuityPng(bytes, options) }; }

async function ensureSafePackageRoot(repoRoot, relativeRoot) {
  assertCanonicalRelativePath(relativeRoot, 'package root');
  const root = path.resolve(repoRoot); const target = path.resolve(root, relativeRoot); const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('package root escapes repository');
  let cursor = root;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component);
    try { await mkdir(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('package output ancestor is symlinked or non-directory');
  }
}

function assertTerminalBinding(value) {
  exactKeys(value, ['protocolAuthoritySha256', 'terminalOutputSha256', 'signedObligationScopeSha256'], 'terminal/scope binding');
  for (const key of Object.keys(value)) assertSha(value[key], `terminal/scope binding ${key}`);
}

export function createTestOnlyG003V5PackagePreparationAuthority({ assignmentV3, terminalBinding, retainedMaterials = [] }) {
  if (process.env.NODE_ENV === 'production') fail('test-only package preparation authority is forbidden in production');
  assertG003V5AssignmentV3Core(assignmentV3); assertTerminalBinding(terminalBinding);
  if (!Array.isArray(retainedMaterials)) fail('retained material index must be an array');
  const retained = new Map();
  for (const entry of retainedMaterials) {
    exactKeys(entry, ['slotId', 'masterPath', 'runtimePath'], 'retained material fixture');
    if (!/^PG-[0-9]{3}$/.test(entry.slotId ?? '') || retained.has(entry.slotId)) fail('retained material fixture identity is invalid');
    assertCanonicalRelativePath(entry.masterPath, 'retained master path'); assertCanonicalRelativePath(entry.runtimePath, 'retained runtime path');
    retained.set(entry.slotId, Object.freeze(clone(entry)));
  }
  const authority = Object.freeze({
    assignmentV3: Object.freeze(clone(assignmentV3)), assignmentV3Sha256: sha256Canonical(assignmentV3),
    terminalBinding: Object.freeze(clone(terminalBinding)), retained,
  });
  AUTHORITIES.add(authority); return authority;
}

export async function loadG003V5PackagePreparationAuthority() {
  fail('production package authority is unavailable until terminal-bound assignment-v3 integration is installed');
}

function assertApprovedReceipt(value, authority) {
  if (!APPROVED_RECEIPTS.has(value)) fail('generated material requires a verified current approved-material-v5 receipt');
  exactKeys(value, ['schemaVersion', 'obligationId', 'slotId', 'assignmentV3Sha256', 'protocolAuthoritySha256', 'terminalOutputSha256', 'packageManifestSha256', 'materialBindingSha256', 'surfaces', 'approvedAt'], 'approved material receipt');
  if (value.schemaVersion !== 'continuity-g003-approved-material-v5' || value.obligationId !== `g003-candidate:${value.slotId}`
      || value.assignmentV3Sha256 !== authority.assignmentV3Sha256
      || value.protocolAuthoritySha256 !== authority.terminalBinding.protocolAuthoritySha256
      || value.terminalOutputSha256 !== authority.terminalBinding.terminalOutputSha256) fail('approved material receipt authority is stale or foreign');
  for (const field of ['packageManifestSha256', 'materialBindingSha256']) assertSha(value[field], `approved material ${field}`);
  exactKeys(value.surfaces, ['master', 'runtime'], 'approved material surfaces');
  for (const name of ['master', 'runtime']) {
    exactKeys(value.surfaces[name], ['path', 'sha256'], `approved ${name}`);
    assertCanonicalRelativePath(value.surfaces[name].path, `approved ${name} path`); assertSha(value.surfaces[name].sha256, `approved ${name}`);
  }
  if (!Number.isFinite(Date.parse(value.approvedAt)) || new Date(value.approvedAt).toISOString() !== value.approvedAt) fail('approved material timestamp is invalid');
}

export function createTestOnlyApprovedMaterialV5Receipt({ verifiedPackage, approvedAt }, authority) {
  if (process.env.NODE_ENV === 'production' || !AUTHORITIES.has(authority) || !VERIFIED_PACKAGES.has(verifiedPackage)) fail('test-only approved material receipt requires a verified v5 package');
  const state = PACKAGE_STATE.get(verifiedPackage); const child = state.derived.sourceReceipts.sources.find((entry) => entry.role === 'child');
  if (state.authority !== authority || state.derived.obligation.kind !== 'QUEUE' || !child) fail('approved material must derive from a queue package under the same authority');
  const receipt = Object.freeze({ schemaVersion: 'continuity-g003-approved-material-v5', obligationId: state.derived.obligation.obligationId,
    slotId: state.derived.obligation.childSlotId, assignmentV3Sha256: authority.assignmentV3Sha256,
    protocolAuthoritySha256: authority.terminalBinding.protocolAuthoritySha256, terminalOutputSha256: authority.terminalBinding.terminalOutputSha256,
    packageManifestSha256: verifiedPackage.packageManifestSha256, materialBindingSha256: verifiedPackage.materialBindingSha256,
    surfaces: Object.freeze({ master: Object.freeze({ path: child.surfaces.master.path, sha256: child.surfaces.master.sha256 }),
      runtime: Object.freeze({ path: child.surfaces.runtime.path, sha256: child.surfaces.runtime.sha256 }) }), approvedAt });
  APPROVED_RECEIPTS.add(receipt); assertApprovedReceipt(receipt, authority); return receipt;
}

export function createTestOnlyApprovedMaterialV5Resolver({ authority, receipts }) {
  if (!AUTHORITIES.has(authority) || !Array.isArray(receipts)) fail('approved material resolver fixture is invalid');
  const byObligation = new Map();
  for (const receipt of receipts) { assertApprovedReceipt(receipt, authority); if (byObligation.has(receipt.obligationId)) fail('approved material current tip is forked'); byObligation.set(receipt.obligationId, receipt); }
  const resolver = Object.freeze({ resolve(obligationId) { return byObligation.get(obligationId) ?? null; } }); APPROVED_RESOLVERS.add(resolver); return resolver;
}

export function createTestOnlyG003V5EffectiveStateResolver(resolve) {
  if (process.env.NODE_ENV === 'production' || typeof resolve !== 'function') fail('test-only effective-state resolver is invalid');
  const resolver = Object.freeze({ resolve }); EFFECTIVE_STATE_RESOLVERS.add(resolver); return resolver;
}

async function materialFromPaths(repoRoot, { slotId, role, origin, sourceObligationId, masterPath, runtimePath }, expected = null, { requireDerived = true } = {}) {
  const [masterBytes, runtimeBytes] = await Promise.all([
    readStableContainedFile(repoRoot, masterPath, `${role} master`), readStableContainedFile(repoRoot, runtimePath, `${role} runtime`),
  ]);
  if (requireDerived) assertRuntimeDerivedFromMaster(masterBytes, runtimeBytes);
  else {
    inspectContinuityPng(masterBytes, { label: `${role} retained master` });
    inspectContinuityPng(runtimeBytes, { label: `${role} retained runtime` });
  }
  const master = surfaceDescriptor(masterPath, masterBytes, { label: `${role} master`, master: requireDerived });
  const runtime = surfaceDescriptor(runtimePath, runtimeBytes, { label: `${role} runtime`, runtime: requireDerived });
  if (expected && (master.sha256 !== expected.masterSha256 || runtime.sha256 !== expected.runtimeSha256)) fail(`${role} retained bytes differ from assignment-v3 binding`);
  return { receipt: { role, slotId, origin, sourceObligationId, surfaces: { master, runtime } }, bytes: { master: masterBytes, runtime: runtimeBytes } };
}

async function stagedChild(repoRoot, obligation, generationRunId) {
  const slotId = obligation.childSlotId; const candidateRoot = `assets/creatures/biological-continuity-v3/candidates/${generationRunId}/${slotId}`;
  const provenanceBytes = await readStableContainedFile(repoRoot, `${candidateRoot}/provenance.json`, 'staged provenance');
  const provenance = parseCanonical(provenanceBytes, 'staged provenance');
  exactKeys(provenance, ['schemaVersion', 'slotId', 'generationRunId', 'sourceKind', 'promptSha256', 'workspaceMaster', 'candidateMaster', 'runtime', 'derivation'], 'staged provenance');
  if (provenance.schemaVersion !== 'continuity-candidate-provenance-v1' || provenance.slotId !== slotId || provenance.generationRunId !== generationRunId
      || provenance.sourceKind !== 'local-built-in-imagegen-png' || canonicalStringify(provenance.derivation) !== canonicalStringify(CONTINUITY_RUNTIME_DERIVATION_V1)) fail('staged provenance identity or derivation changed');
  const masterPath = `${candidateRoot}/master.png`; const runtimePath = `${candidateRoot}/runtime.png`;
  const expectedWorkspace = `assets/creatures/biological-continuity-v3/workspace-masters/${generationRunId}/${slotId}/${provenance.candidateMaster?.sha256}.png`;
  for (const [name, descriptor, expectedPath] of [['workspaceMaster', provenance.workspaceMaster, expectedWorkspace], ['candidateMaster', provenance.candidateMaster, masterPath], ['runtime', provenance.runtime, runtimePath]]) {
    exactKeys(descriptor, ['path', 'sha256', 'bytes', 'width', 'height'], `staged ${name}`);
    if (descriptor.path !== expectedPath || !SHA.test(descriptor.sha256 ?? '')) fail(`staged ${name} path or hash is not fixed`);
  }
  const [workspaceBytes, promptBytes] = await Promise.all([
    readStableContainedFile(repoRoot, expectedWorkspace, 'staged workspace master'), readStableContainedFile(repoRoot, `${candidateRoot}/prompt.txt`, 'staged generation prompt'),
  ]);
  const material = await materialFromPaths(repoRoot, { slotId, role: 'child', origin: 'STAGED_GENERATION', sourceObligationId: obligation.obligationId, masterPath, runtimePath });
  if (!workspaceBytes.equals(material.bytes.master) || sha256Bytes(workspaceBytes) !== provenance.workspaceMaster.sha256
      || material.receipt.surfaces.master.sha256 !== provenance.candidateMaster.sha256 || material.receipt.surfaces.master.bytes !== provenance.candidateMaster.bytes
      || material.receipt.surfaces.runtime.sha256 !== provenance.runtime.sha256 || material.receipt.surfaces.runtime.bytes !== provenance.runtime.bytes
      || sha256Bytes(promptBytes) !== provenance.promptSha256 || !promptBytes.toString('utf8').trim()) fail('staged bytes differ from fixed provenance');
  return { ...material, generationPromptSha256: provenance.promptSha256 };
}

async function retainedMaterial(repoRoot, authority, obligation, role, slotId) {
  const binding = obligation.retainedSurfaceBindings.find((entry) => entry.role === role && entry.slotId === slotId);
  const paths = authority.retained.get(slotId);
  if (!binding || !paths) fail(`${role} retained source is absent from assignment-v3 authority`);
  return materialFromPaths(repoRoot, { slotId, role, origin: 'SIGNED_RETAINED_G002', sourceObligationId: null,
    masterPath: paths.masterPath, runtimePath: paths.runtimePath }, binding, { requireDerived: false });
}

async function approvedMaterial(repoRoot, authority, approvedResolver, role, slotId, sourceObligationId) {
  if (!APPROVED_RESOLVERS.has(approvedResolver)) fail('generated material resolver is not verified');
  const receipt = approvedResolver.resolve(sourceObligationId); if (!receipt) fail(`missing current approved-material-v5 tip for ${sourceObligationId}`);
  assertApprovedReceipt(receipt, authority);
  if (receipt.slotId !== slotId || receipt.obligationId !== sourceObligationId) fail('approved material tip does not match required source obligation');
  return materialFromPaths(repoRoot, { slotId, role, origin: 'APPROVED_MATERIAL_V5', sourceObligationId,
    masterPath: receipt.surfaces.master.path, runtimePath: receipt.surfaces.runtime.path }, {
    masterSha256: receipt.surfaces.master.sha256, runtimeSha256: receipt.surfaces.runtime.sha256,
  });
}

async function sourceFor(repoRoot, authority, approvedResolver, obligation, { role, slotId, policy, sourceObligationId }) {
  if (policy === 'SIGNED_RETAINED_G002') return retainedMaterial(repoRoot, authority, obligation, role, slotId);
  if (policy === 'APPROVED_MATERIAL_V5') return approvedMaterial(repoRoot, authority, approvedResolver, role, slotId, sourceObligationId);
  fail(`${role} has unsupported source policy`);
}

function reviewContract(obligation) {
  return { schemaVersion: 'continuity-g003-locked-review-contract-v5', obligationId: obligation.obligationId,
    childSlotId: obligation.childSlotId, assessmentMode: obligation.assessmentMode,
    parentRoles: obligation.parents.map((entry) => entry.parentRole), requiredChildTaxonomy: clone(obligation.requiredChildTaxonomy),
    requiredAnchors: clone(obligation.requiredAnchors), benchmarkBinding: clone(obligation.benchmarkBinding) };
}
function reviewPrompt(contract) {
  return Buffer.from([
    'PunchGrow G003-v5 blinded biological-continuity review.',
    'Judge only the allowlisted master/runtime pixels. Names, lore, palette-only similarity, and prior verdicts are forbidden evidence.',
    'Each parent must visibly remain the same creature grown up; every locked anchor and taxonomy field must be assessed on master and runtime.',
    'Any anatomy, locomotion, provenance, anchor, or ambiguity dissent rejects the material.',
    `Locked contract: ${canonicalStringify(contract).trim()}`,
  ].join('\n') + '\n');
}

async function assertEffectiveClear(resolver, materialSha256, constituents) {
  if (!EFFECTIVE_STATE_RESOLVERS.has(resolver)) fail('effective rejection state resolver is not verified');
  const result = await resolver.resolve({ materialSha256, constituentMaterialSha256s: [...constituents] });
  exactKeys(result, ['status', 'matchedMaterialSha256'], 'effective rejection state');
  if (!['CLEAR', 'REJECTED'].includes(result.status) || (result.status === 'CLEAR' && result.matchedMaterialSha256 !== null)
      || (result.status === 'REJECTED' && ![materialSha256, ...constituents].includes(result.matchedMaterialSha256))) fail('effective rejection state result is malformed');
  if (result.status !== 'CLEAR') fail(`material is tombstoned: ${result.matchedMaterialSha256}`);
}

async function derivePackage({ request, repoRoot, authority, approvedMaterialResolver, effectiveStateResolver }) {
  if (!AUTHORITIES.has(authority)) fail('package preparation authority is not branded');
  const obligation = authority.assignmentV3.obligations.find((entry) => entry.obligationId === request?.obligationId);
  if (!obligation) fail('obligationId is outside exact assignment-v3');
  const requestKeys = obligation.kind === 'QUEUE' ? ['obligationId', 'stagedGenerationRunId'] : ['obligationId'];
  exactKeys(request, requestKeys, 'package request');
  if (obligation.kind === 'QUEUE' && !RUN.test(request.stagedGenerationRunId ?? '')) fail('queue request requires a valid stagedGenerationRunId');
  const sources = [];
  for (const parent of obligation.parents) sources.push(await sourceFor(repoRoot, authority, approvedMaterialResolver, obligation, {
    role: parent.parentRole, slotId: parent.parentSlotId, policy: parent.sourcePolicy, sourceObligationId: parent.sourceObligationId,
  }));
  let child;
  if (obligation.kind === 'QUEUE') child = await stagedChild(repoRoot, obligation, request.stagedGenerationRunId);
  else child = await sourceFor(repoRoot, authority, approvedMaterialResolver, obligation, { role: 'child', slotId: obligation.childSlotId,
    policy: obligation.childSourcePolicy, sourceObligationId: obligation.childSourcePolicy === 'APPROVED_MATERIAL_V5' ? `g003-candidate:${obligation.childSlotId}` : null });
  sources.push(child);
  const sourceReceipts = { schemaVersion: 'continuity-g003-source-receipts-v5', assignmentV3Sha256: authority.assignmentV3Sha256,
    obligationId: obligation.obligationId, sources: sources.map((entry) => entry.receipt) };
  const sourceReceiptsSha256 = sha256Canonical(sourceReceipts);
  const constituents = sources.flatMap((entry) => [entry.receipt.surfaces.master.sha256, entry.receipt.surfaces.runtime.sha256]);
  if (new Set(constituents).size !== constituents.length) fail('package material constituents must be distinct');
  const materialSha256 = sha256Canonical({ obligationId: obligation.obligationId, sources: sourceReceipts.sources });
  const materialBinding = { schemaVersion: 'continuity-g003-material-binding-v5', assignmentV3Sha256: authority.assignmentV3Sha256,
    obligationId: obligation.obligationId, sourceReceiptsSha256, childMaterialSha256s: [child.receipt.surfaces.master.sha256, child.receipt.surfaces.runtime.sha256],
    constituentMaterialSha256s: [...constituents], materialSha256 };
  await assertEffectiveClear(effectiveStateResolver, materialSha256, constituents);
  const contract = reviewContract(obligation); const prompt = reviewPrompt(contract);
  const packageSeed = { assignmentV3Sha256: authority.assignmentV3Sha256, obligationId: obligation.obligationId,
    stagedGenerationRunId: request.stagedGenerationRunId ?? null, materialSha256 };
  const packageId = `package-${sha256Canonical(packageSeed).slice(0, 24)}`;
  const inputFiles = [];
  for (const source of sources) for (const surfaceName of ['master', 'runtime']) {
    const relative = `inputs/${source.receipt.role}-${surfaceName}.png`; const bytes = source.bytes[surfaceName];
    inputFiles.push({ path: relative, sha256: sha256Bytes(bytes), bytes: bytes.length, role: `${source.receipt.role}-${surfaceName}`, content: bytes });
  }
  const allowlist = { schemaVersion: 'continuity-g003-input-allowlist-v5', obligationId: obligation.obligationId,
    files: inputFiles.map(({ path: filePath, sha256, role }) => ({ path: filePath, sha256, role })) };
  const fixed = [
    ['source-receipts.json', canonicalBytes(sourceReceipts)], ['material-binding.json', canonicalBytes(materialBinding)],
    ['allowlist.json', canonicalBytes(allowlist)], ['review-contract.json', canonicalBytes(contract)], ['prompt.txt', prompt],
    ...inputFiles.map((entry) => [entry.path, entry.content]),
  ];
  const manifest = { schemaVersion: 'continuity-g003-package-manifest-v5', packageId, obligationId: obligation.obligationId,
    assignmentV3Sha256: authority.assignmentV3Sha256, protocolAuthoritySha256: authority.terminalBinding.protocolAuthoritySha256,
    terminalOutputSha256: authority.terminalBinding.terminalOutputSha256, materialBindingSha256: sha256Canonical(materialBinding),
    files: fixed.map(([filePath, bytes]) => ({ path: filePath, sha256: sha256Bytes(bytes), bytes: bytes.length })).sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  return { obligation, packageId, sourceReceipts, materialBinding, allowlist, contract, prompt, fixed, manifest, materialSha256, constituents,
    request: clone(request), approvedMaterialResolver, effectiveStateResolver };
}

async function verifyDerivedPackage(repoRoot, packageRoot, derived) {
  const expectedNames = [...derived.fixed.map(([name]) => name), 'package-manifest.json'].sort();
  const actualNames = await listContainedRegularFiles(repoRoot, packageRoot);
  if (canonicalStringify(actualNames) !== canonicalStringify(expectedNames)) fail('package file coverage differs from deterministic manifest');
  for (const [relative, expectedBytes] of [...derived.fixed, ['package-manifest.json', canonicalBytes(derived.manifest)]]) {
    const actual = await readStableContainedFile(repoRoot, `${packageRoot}/${relative}`, `package ${relative}`);
    if (!actual.equals(expectedBytes)) fail(`package ${relative} differs from deterministic bytes`);
  }
  await assertEffectiveClear(derived.effectiveStateResolver, derived.materialSha256, derived.constituents);
}

export async function prepareG003V5Package({ request, repoRoot, authority, approvedMaterialResolver, effectiveStateResolver, outputRoot = G003_V5_PACKAGE_ROOT }) {
  const derived = await derivePackage({ request, repoRoot, authority, approvedMaterialResolver, effectiveStateResolver });
  const packageRoot = `${outputRoot}/${derived.packageId}`; assertCanonicalRelativePath(packageRoot, 'package publication root');
  await withG003TransitionLock(repoRoot, async () => {
    await ensureSafePackageRoot(repoRoot, packageRoot);
    for (const [relative, bytes] of derived.fixed) await publishBytesNoReplace(repoRoot, path.join(repoRoot, packageRoot, relative), bytes);
    await publishBytesNoReplace(repoRoot, path.join(repoRoot, packageRoot, 'package-manifest.json'), canonicalBytes(derived.manifest));
    await verifyDerivedPackage(repoRoot, packageRoot, derived);
  });
  const verified = Object.freeze({ packageId: derived.packageId, packageRoot, obligationId: derived.obligation.obligationId,
    packageManifestSha256: sha256Canonical(derived.manifest), materialBindingSha256: sha256Canonical(derived.materialBinding),
    inputAllowlistSha256: sha256Canonical(derived.allowlist), promptSha256: sha256Bytes(derived.prompt),
    inputAssetSha256s: Object.freeze(derived.allowlist.files.map((entry) => entry.sha256)),
    childMaterialSha256s: Object.freeze([...derived.materialBinding.childMaterialSha256s]), requiredChildTaxonomy: Object.freeze(clone(derived.obligation.requiredChildTaxonomy)),
    reviewContext: Object.freeze({ parentRoles: derived.obligation.parents.map((entry) => entry.parentRole), requiredAnchors: clone(derived.obligation.requiredAnchors),
      eiluBenchmarkId: derived.obligation.benchmarkBinding.benchmarkId, canonicalMode: derived.obligation.assessmentMode === 'canonical-root-replacement' }) });
  VERIFIED_PACKAGES.add(verified); PACKAGE_STATE.set(verified, { repoRoot, packageRoot, derived, authority }); return verified;
}

export function assertVerifiedG003V5Package(value) { if (!VERIFIED_PACKAGES.has(value)) fail('package was not produced by authenticated v5 preparation'); return value; }

export async function verifyG003V5Package(value) {
  assertVerifiedG003V5Package(value); const state = PACKAGE_STATE.get(value);
  const current = await derivePackage({ request: state.derived.request, repoRoot: state.repoRoot, authority: state.authority,
    approvedMaterialResolver: state.derived.approvedMaterialResolver, effectiveStateResolver: state.derived.effectiveStateResolver });
  if (sha256Canonical(current.manifest) !== value.packageManifestSha256 || current.packageId !== value.packageId) fail('package dependencies or deterministic identity changed');
  await verifyDerivedPackage(state.repoRoot, state.packageRoot, current); return value;
}
