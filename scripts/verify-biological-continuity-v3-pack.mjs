#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { canonicalStringify, sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { listContainedRegularFiles, readContainedFile, readJson } from './lib/continuity-assignment/evidence.mjs';
import { verifyG003PublicEvidence } from './lib/g003-public-authority.mjs';
import { G003_FINALIZING_STATE, G003_TERMINAL_STATE, assertG003ActiveBaseline, loadLockedG003Gate, resolveVerifiedRecordChains, verifyArtifact } from './conduct-g003-reviews.mjs';
import { assertGenerationRunId } from './prepare-continuity-candidate-review.mjs';
import { G002_V2_EFFECTIVE_ROOT_IDS, G002_V2_TARGET_SOURCE, resolveG002V2Authority } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { G002_V2_SUCCESSOR, G003_AUTHORITY, G003_COUNTS, G003_PROTOCOL_AUTHORITY_SHA256, G003_SCHEMA_BINDINGS, G003_V4_EVIDENCE } from './lib/g003-v4-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'production/manifests/creature-asset-packs/biological-continuity-v3.json';
const LOCK = 'production/manifests/creature-asset-packs/biological-continuity-v3.lock.json';
const REGISTRY = 'config/creature-assets.json';
const EVIDENCE = G003_V4_EVIDENCE;
const COVERAGE = `${EVIDENCE}/review-coverage.json`;
const CANONICAL_TARGETS = G002_V2_SUCCESSOR;
const SHA = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message) { throw new Error(`v3 pack verification: ${message}`); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const missing = keys.filter((key) => !(key in value)); const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch`);
}
function chunks(bytes) {
  const result = []; let offset = 8;
  while (offset + 12 <= bytes.length) { const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8); result.push(type); offset += 12 + length; if (type === 'IEND') break; }
  return result;
}
function unsigned(value) { const copy = structuredClone(value); delete copy.publicSignature; return copy; }
function core(value) { const copy = unsigned(value); delete copy.outputSha256; return copy; }
function authorityCore(value) { const copy = core(value); delete copy.conductorHmacSha256; return copy; }
function signatureProfile(value) { return { purpose: `g003:${value.schemaVersion}`, schemaSha256: sha256Canonical({ schemaVersion: value.schemaVersion, fields: Object.keys(value).sort() }) }; }
function exactIds(required, actual, label) {
  if (new Set(required).size !== required.length || new Set(actual).size !== actual.length
      || JSON.stringify([...required].sort()) !== JSON.stringify([...actual].sort())) fail(`${label} does not match independently discovered current chain tips`);
}
export function assertCoverageCurrentTips(requirements, tips) {
  exactIds(requirements.map((item) => item.id), tips.map((record) => record.requirementId), 'coverage requirements');
  const currentByRequirement = new Map(tips.map((record) => [record.requirementId, record]));
  for (const requirement of requirements) {
    const current = currentByRequirement.get(requirement.id); const evidence = requirement.evidence;
    if (!current || current.artifactPath !== evidence?.reviewArtifactPath || current.artifactSha256 !== evidence?.reviewArtifactSha256) fail(`${requirement.id}: coverage points to a stale/non-tip accepted artifact`);
  }
  return currentByRequirement;
}
export function assertPackComposition(entries, { total = 240, replacements = G003_COUNTS.regenerate, retained = G003_COUNTS.retain } = {}) {
  if (entries.length !== total || entries.filter((entry) => entry.sourceKind === 'g003-approved-candidate').length !== replacements
      || entries.filter((entry) => entry.sourceKind === 'retained-cute-redesign-v2').length !== retained) fail(`pack composition must be ${replacements} replacements + ${retained} retained = ${total}`);
}
export function assertExactPackInventory(expected, masterFiles, mobileFiles) {
  const sorted = [...expected].sort();
  if (JSON.stringify([...masterFiles].sort()) !== JSON.stringify(sorted) || JSON.stringify([...mobileFiles].sort()) !== JSON.stringify(sorted)) fail('approved roots contain missing or unmanifested files');
}
export function assertCoverageChildBinding(requirementId, evidence, artifact, artifactRawSha256) {
  if (evidence.reviewArtifactSha256 !== artifactRawSha256 || evidence.candidateId !== artifact.candidateId
      || artifact.childPixels?.length !== 2
      || JSON.stringify([...evidence.approvedChildPixelSha256s].sort()) !== JSON.stringify(artifact.childPixels.map((pixel) => pixel.sha256).sort())) {
    fail(`${requirementId}: coverage/artifact child pixel binding mismatch`);
  }
  return artifact.childPixels;
}
export function assertCoverageIdentity(coverage, locked) {
  const queueIdentity = (items) => items.map(({ candidateId, slotId }) => ({ candidateId, slotId }));
  const edgeIdentity = (items) => items.map(({ edgeId, parentId, childId }) => ({ edgeId, parentId, childId }));
  if (canonicalStringify(queueIdentity(coverage.queueCandidates ?? [])) !== canonicalStringify(queueIdentity(locked.queueCandidates))
      || canonicalStringify(edgeIdentity(coverage.edgeCandidates ?? [])) !== canonicalStringify(edgeIdentity(locked.edgeCandidates))
      || canonicalStringify(coverage.eiluBenchmark?.pixelBindings) !== canonicalStringify(locked.eiluBenchmark.pixelBindings)) {
    fail('coverage identities or Eilu pixels differ from the signed G002 assignment');
  }
}

export function assertReviewPolicyCoverage(requirements, byRequirement, signedCanonical = null) {
  const canonicalIds = [];
  for (const requirement of requirements) {
    const artifact = byRequirement.get(requirement.id); const policy = artifact?.reviewPolicy;
    if (!policy || canonicalStringify(requirement.evidence?.reviewPolicy) !== canonicalStringify(policy)) fail(`${requirement.id}: coverage review policy differs from signed artifact`);
    const slotId = requirement.kind === 'queue' ? requirement.id.slice('g003-candidate:'.length) : null;
    if (policy.assessmentMode === 'canonical-root-replacement') {
      const signedTarget = signedCanonical?.byRootId?.get(slotId);
      if (requirement.kind !== 'queue' || !G002_V2_EFFECTIVE_ROOT_IDS.includes(slotId)
          || policy.continuitySubject !== 'signed-canonical-root-contract'
          || policy.taxonomyTargetSource !== G002_V2_TARGET_SOURCE
          || policy.historicalParentPixelsOnly !== true || !SHA.test(policy.canonicalContractOutputSha256 ?? '')
          || policy.canonicalEffectiveAuthoritySha256 !== G003_AUTHORITY.effectiveAuthoritySha256
          || !policy.visibilityPolicy || !Array.isArray(policy.clarificationRequirements) || policy.clarificationRequirements.length < 2
          || (signedCanonical && (policy.canonicalContractOutputSha256 !== signedCanonical.outputSha256
            || canonicalStringify(policy.requiredChildTaxonomy) !== canonicalStringify(signedTarget?.canonicalTarget)
            || canonicalStringify(policy.visibilityPolicy) !== canonicalStringify(signedCanonical.visibilityPolicy)
            || canonicalStringify(policy.clarificationRequirements) !== canonicalStringify(signedTarget?.clarificationRequirements)))
          || artifact.parentEvidence.some((entry) => entry.evidenceRole !== 'historical-reference-only')) fail(`${requirement.id}: invalid canonical-root replacement policy/evidence role`);
      canonicalIds.push(slotId);
    } else if (policy.assessmentMode !== 'same-creature-continuity'
        || policy.continuitySubject !== 'prior-parent-pixels' || policy.historicalParentPixelsOnly !== false
        || policy.canonicalContractOutputSha256 !== null || policy.canonicalEffectiveAuthoritySha256 !== null || policy.visibilityPolicy !== null
        || !Array.isArray(policy.clarificationRequirements) || policy.clarificationRequirements.length !== 0
        || artifact.parentEvidence.some((entry) => entry.evidenceRole !== 'continuity-parent')) {
      fail(`${requirement.id}: strict continuity policy/evidence role was weakened`);
    }
  }
  exactIds(G002_V2_EFFECTIVE_ROOT_IDS, canonicalIds, 'canonical-root replacement review policies');
  return true;
}

function verifySignedSupersession(value, descriptor, artifact) {
  if (value?.schemaVersion !== 'continuity-g003-accepted-review-supersession-v1' || value.outputSha256 !== sha256Canonical(authorityCore(value))
      || !SHA.test(value.conductorHmacSha256 ?? '') || !SHA.test(value.priorArtifactSha256 ?? '') || !SHA.test(value.priorReviewSha256 ?? '')) fail(`${artifact.requirementId}: invalid signed supersession`);
  verifyG003PublicEvidence(unsigned(value), value.publicSignature, signatureProfile(unsigned(value)));
  assertGenerationRunId(value.newGenerationRunId, `${artifact.requirementId} supersession generationRunId`);
  if (descriptor.priorArtifactSha256 !== value.priorArtifactSha256 || value.requirementId !== artifact.requirementId
      || value.newGenerationRunId !== artifact.generationRunId) fail(`${artifact.requirementId}: supersession routing differs from accepted artifact`);
  return value;
}

export async function discoverCurrentAcceptedArtifacts() {
  const artifactPaths = [];
  for (const publicRoot of [`${EVIDENCE}/candidates`, `${EVIDENCE}/edges`]) {
    try {
      artifactPaths.push(...(await listContainedRegularFiles(ROOT, publicRoot))
        .filter((relative) => relative.endsWith('/public-review-artifact.json')).map((relative) => `${publicRoot}/${relative}`));
    } catch (error) { if (!/ENOENT|does not exist/.test(error.message)) throw error; }
  }
  const records = [];
  for (const artifactPath of artifactPaths) {
    const artifactBytes = await readContainedFile(ROOT, artifactPath); const artifactSha256 = sha256Bytes(artifactBytes);
    const artifact = await verifyArtifact({ artifactPath, artifactSha256, requirementId: artifactPath });
    assertGenerationRunId(artifact.generationRunId, `${artifact.requirementId} artifact generationRunId`);
    let supersession = null;
    if (artifact.supersession !== null) {
      const descriptor = artifact.supersession;
      if (!descriptor?.path?.startsWith(`${EVIDENCE}/supersessions/`) || !SHA.test(descriptor.sha256 ?? '') || !SHA.test(descriptor.priorArtifactSha256 ?? '')) fail(`${artifact.requirementId}: invalid supersession descriptor`);
      const bytes = await readContainedFile(ROOT, descriptor.path);
      if (sha256Bytes(bytes) !== descriptor.sha256) fail(`${artifact.requirementId}: supersession bytes changed`);
      const value = verifySignedSupersession(JSON.parse(bytes), descriptor, artifact);
      supersession = { ...descriptor, value };
    }
    records.push({
      requirementKind: artifact.reviewKind, requirementId: artifact.requirementId, generationRunId: artifact.generationRunId,
      artifactPath, artifactSha256, reviewSha256: artifact.review.sha256, childPixels: artifact.childPixels, supersession, artifact,
    });
  }
  const tips = resolveVerifiedRecordChains(records);
  return { records, tips, byRequirement: new Map(tips.map((record) => [record.requirementId, record])) };
}

export function acceptedTipSet(discovered) {
  const tips = discovered.tips.map((record) => ({
    requirementKind: record.requirementKind, requirementId: record.requirementId, generationRunId: record.generationRunId,
    artifactPath: record.artifactPath, artifactSha256: record.artifactSha256, reviewSha256: record.reviewSha256,
  })).sort((left, right) => left.requirementId.localeCompare(right.requirementId));
  if (tips.length !== G003_COUNTS.obligations || new Set(tips.map((tip) => tip.requirementId)).size !== tips.length) fail(`terminal accepted tip set must contain exactly ${G003_COUNTS.obligations} requirements`);
  for (const tip of tips) {
    assertGenerationRunId(tip.generationRunId, `${tip.requirementId} terminal generationRunId`);
    if (!['queue', 'edge'].includes(tip.requirementKind) || !SHA.test(tip.artifactSha256) || !SHA.test(tip.reviewSha256)
        || typeof tip.artifactPath !== 'string' || !tip.artifactPath.startsWith(`${EVIDENCE}/`)) fail(`${tip.requirementId}: terminal tip binding is invalid`);
  }
  return tips;
}

function verifySignedState(value, schemaVersion, label) {
  if (value?.schemaVersion !== schemaVersion || value.outputSha256 !== sha256Canonical(core(value))) fail(`${label} output hash is invalid`);
  verifyG003PublicEvidence(unsigned(value), value.publicSignature, signatureProfile(unsigned(value)));
  return value;
}

export async function verifyG003FinalizingState({ discovered = null, coverage = null } = {}) {
  const bytes = await readContainedFile(ROOT, G003_FINALIZING_STATE); const value = JSON.parse(bytes);
  verifySignedState(value, 'continuity-g003-finalizing-state-v3', 'G003 finalizing state');
  exactKeys(value, ['schemaVersion', 'protocolAuthoritySha256', 'state', 'coverage', 'acceptedTipCount', 'acceptedTipSetSha256', 'acceptedTips', 'terminalStatePath', 'startedAt', 'terminalCompletedAt', 'nonce', 'outputSha256', 'publicSignature'], 'G003 finalizing state');
  exactKeys(value.coverage, ['path', 'sha256'], 'G003 finalizing coverage');
  if (value.state !== 'FINALIZING' || value.coverage?.path !== COVERAGE || !SHA.test(value.coverage.sha256 ?? '')
      || value.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || value.acceptedTipCount !== G003_COUNTS.obligations || !SHA.test(value.acceptedTipSetSha256 ?? '') || !Array.isArray(value.acceptedTips)
      || value.terminalStatePath !== G003_TERMINAL_STATE || Number.isNaN(Date.parse(value.startedAt))
      || Number.isNaN(Date.parse(value.terminalCompletedAt))
      || typeof value.nonce !== 'string' || value.nonce.length < 16) fail('G003 finalizing state shape is invalid');
  const currentCoverage = coverage ?? await readJson(ROOT, COVERAGE);
  if (sha256Bytes(await readContainedFile(ROOT, COVERAGE)) !== value.coverage.sha256 || currentCoverage.state !== 'PASS') fail('G003 finalizing coverage changed or is not PASS');
  const currentDiscovered = discovered ?? await discoverCurrentAcceptedArtifacts(); const tips = acceptedTipSet(currentDiscovered);
  if (sha256Canonical(tips) !== value.acceptedTipSetSha256 || canonicalStringify(tips) !== canonicalStringify(value.acceptedTips)) fail('G003 finalizing state differs from current accepted chain tips');
  return { value, bytes, sha256: sha256Bytes(bytes), discovered: currentDiscovered, coverage: currentCoverage };
}

export function assertTerminalTipBinding({ lock, terminal, finalizing, finalizingSha256, lockSha256, currentTipSetSha256 }) {
  if (terminal.state !== 'TERMINAL' || terminal.finalizingState?.path !== G003_FINALIZING_STATE
      || terminal.finalizingState.sha256 !== finalizingSha256 || terminal.packLock?.path !== LOCK
      || terminal.packLock.sha256 !== lockSha256 || terminal.acceptedTipSetSha256 !== finalizing.acceptedTipSetSha256
      || terminal.completedAt !== finalizing.terminalCompletedAt
      || terminal.acceptedTipSetSha256 !== currentTipSetSha256 || terminal.acceptedTipCount !== G003_COUNTS.obligations
      || lock.finalization?.statePath !== G003_FINALIZING_STATE || lock.finalization.stateSha256 !== finalizingSha256
      || lock.finalization.acceptedTipSetSha256 !== finalizing.acceptedTipSetSha256
      || lock.finalization.acceptedTipSetSha256 !== currentTipSetSha256 || lock.finalization.acceptedTipCount !== G003_COUNTS.obligations
      || lock.finalization.terminalStatePath !== G003_TERMINAL_STATE) fail('terminal state/pack lock does not bind the exact current accepted tip set');
  return true;
}

export async function verifyG003TerminalState(lock, lockBytes, { discovered = null, coverage = null } = {}) {
  const finalizing = await verifyG003FinalizingState({ discovered, coverage });
  const terminalBytes = await readContainedFile(ROOT, G003_TERMINAL_STATE); const terminal = JSON.parse(terminalBytes);
  verifySignedState(terminal, 'continuity-g003-terminal-state-v3', 'G003 terminal state');
  exactKeys(terminal, ['schemaVersion', 'protocolAuthoritySha256', 'state', 'finalizingState', 'packLock', 'acceptedTipSetSha256', 'acceptedTipCount', 'completedAt', 'outputSha256', 'publicSignature'], 'G003 terminal state');
  exactKeys(terminal.finalizingState, ['path', 'sha256'], 'G003 terminal finalizing reference');
  exactKeys(terminal.packLock, ['path', 'sha256'], 'G003 terminal pack lock reference');
  if (terminal.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || Number.isNaN(Date.parse(terminal.completedAt))) fail('G003 terminal authority/completion time is invalid');
  assertTerminalTipBinding({
    lock, terminal, finalizing: finalizing.value, finalizingSha256: finalizing.sha256,
    lockSha256: sha256Bytes(lockBytes), currentTipSetSha256: sha256Canonical(acceptedTipSet(finalizing.discovered)),
  });
  return { terminal, finalizing: finalizing.value };
}

export function assertCurrentParentArtifactBinding(requirementId, parentId, publishedParent, parentArtifact) {
  const expectedCandidateId = `g003-candidate:${parentId}`;
  const expectedPixels = parentArtifact?.childPixels?.map((pixel) => pixel.sha256).sort();
  if (!publishedParent || !parentArtifact || publishedParent.approvedParentCandidateId !== expectedCandidateId
      || publishedParent.approvedParentReviewSha256 !== parentArtifact.review?.sha256
      || JSON.stringify([...(publishedParent.pixelSha256s ?? [])].sort()) !== JSON.stringify(expectedPixels)) fail(`${requirementId}: generated parent differs from current signed parent chain tip`);
}

export async function verifyCoverageArtifacts(coverage, { discovered = null } = {}) {
  const locked = await loadLockedG003Gate();
  const signedCanonicalValue = await readJson(ROOT, CANONICAL_TARGETS);
  const signedCanonical = await resolveG002V2Authority(signedCanonicalValue, { repoRoot: ROOT });
  assertCoverageIdentity(coverage, locked);
  const lockedEilu = coverage.eiluBenchmark.pixelBindings.flatMap((binding) => [binding.masterSha256, binding.runtimeSha256]).sort();
  const requirements = [...coverage.queueCandidates.map((item) => ({ kind: 'queue', id: item.candidateId, evidence: item.reviewEvidence })),
    ...coverage.edgeCandidates.map((item) => ({ kind: 'edge', id: item.edgeId, evidence: item.reviewEvidence }))];
  if (requirements.length !== G003_COUNTS.obligations || new Set(requirements.map((item) => item.id)).size !== requirements.length) fail(`coverage must contain ${G003_COUNTS.obligations} unique locked requirements`);
  const currentAccepted = discovered ?? await discoverCurrentAcceptedArtifacts();
  assertCoverageCurrentTips(requirements, currentAccepted.tips);
  const paths = new Set();
  const byRequirement = new Map();
  let primaryVoteCount = 0;
  for (const requirement of requirements) {
    const evidence = requirement.evidence;
    if (!evidence || paths.has(evidence.reviewArtifactPath)) fail(`${requirement.id}: missing or duplicate public review artifact`);
    paths.add(evidence.reviewArtifactPath);
    const artifact = await verifyArtifact({ requirementId: requirement.id, artifactPath: evidence.reviewArtifactPath, artifactSha256: evidence.reviewArtifactSha256 });
    assertCoverageChildBinding(requirement.id, evidence, artifact, evidence.reviewArtifactSha256);
    if ((requirement.kind === 'queue' && (artifact.reviewKind !== 'queue' || artifact.candidateId !== requirement.id))
        || (requirement.kind === 'edge' && (artifact.reviewKind !== 'edge' || artifact.edgeId !== requirement.id))) fail(`${requirement.id}: public artifact identity mismatch`);
    if (JSON.stringify(artifact.eiluPixels.map((pixel) => pixel.sha256).sort()) !== JSON.stringify(lockedEilu)) fail(`${requirement.id}: public artifact does not bind the six locked Eilu pixels`);
    const votes = await Promise.all(artifact.votes.map(async (descriptor) => JSON.parse(await readContainedFile(ROOT, descriptor.path))));
    if (votes.length !== 2 || JSON.stringify(votes.map((vote) => vote.passNumber).sort()) !== JSON.stringify([1, 2])
        || new Set(votes.map((vote) => vote.reviewerInstanceId)).size !== 2
        || new Set(votes.map((vote) => vote.agentTaskId)).size !== 2
        || new Set(votes.map((vote) => vote.voterReviewRunId)).size !== 2
        || votes.some((vote) => vote.schemaVersion !== 'continuity-candidate-primary-vote-v4'
          || vote.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || vote.role !== 'primary')) {
      fail(`${requirement.id}: exact independent primary pass-1/pass-2 vote authority is missing`);
    }
    primaryVoteCount += votes.length;
    byRequirement.set(requirement.id, artifact);
  }
  if (primaryVoteCount !== G003_COUNTS.primaryVotes) fail(`coverage must bind exactly ${G003_COUNTS.primaryVotes} primary votes`);
  assertReviewPolicyCoverage(requirements, byRequirement, signedCanonical);
  const dependentQueues = locked.queueCandidates.filter((item) => item.requiredParentCandidateIds.length > 0);
  if (dependentQueues.length !== G003_COUNTS.dependentQueue) fail(`locked queue generated-parent topology is not ${G003_COUNTS.dependentQueue} candidates`);
  for (const item of dependentQueues) {
    const childArtifact = byRequirement.get(item.candidateId);
    for (const parentCandidateId of item.requiredParentCandidateIds) {
      const parentId = parentCandidateId.slice('g003-candidate:'.length); const parentArtifact = byRequirement.get(parentCandidateId);
      const publishedParent = childArtifact.parentEvidence.find((entry) => entry.parentId === parentId && entry.approvedParentCandidateId === parentCandidateId);
      assertCurrentParentArtifactBinding(item.candidateId, parentId, publishedParent, parentArtifact);
    }
  }
  for (const item of locked.edgeCandidates) {
    const childArtifact = byRequirement.get(item.edgeId);
    for (const parent of item.allowedParentAnchors.filter((entry) => entry.sourceKind === 'generated-parent-candidate')) {
      const parentArtifact = byRequirement.get(`g003-candidate:${parent.parentId}`);
      const publishedParent = childArtifact.parentEvidence.find((entry) => entry.parentRole === parent.parentRole && entry.parentId === parent.parentId);
      assertCurrentParentArtifactBinding(item.edgeId, parent.parentId, publishedParent, parentArtifact);
    }
  }
  return { artifacts: requirements.length, primaryVotes: primaryVoteCount, byRequirement, discovered: currentAccepted };
}

export async function verifyV3Pack() {
  await assertG003ActiveBaseline();
  const [manifest, lockBytes, registry] = await Promise.all([readJson(ROOT, MANIFEST), readContainedFile(ROOT, LOCK), readJson(ROOT, REGISTRY)]);
  const lock = JSON.parse(lockBytes);
  if (registry.activePack !== 'cute-redesign-v2' || registry.packs?.['biological-continuity-v3']) fail('v3 must remain unregistered and cute-redesign-v2 must remain active');
  if (manifest.packId !== 'biological-continuity-v3' || manifest.status !== 'qa-passed' || manifest.activationAllowed !== true || manifest.entries?.length !== 240) fail('manifest activation gate is incomplete');
  if (lock.schemaVersion !== 'continuity-pack-lock-v3' || lock.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256
      || lock.outputSha256 !== sha256Canonical(core(lock))) fail('lock protocol authority/output hash mismatch');
  verifyG003PublicEvidence(unsigned(lock), lock.publicSignature, { purpose: 'g003:pack-lock', schemaSha256: G003_SCHEMA_BINDINGS[2].normalizedSha256 });
  if (sha256Bytes(await readContainedFile(ROOT, lock.manifest.path)) !== lock.manifest.sha256 || lock.manifest.path !== MANIFEST) fail('locked manifest hash mismatch');
  const coverage = await readJson(ROOT, lock.reviewCoverage.path);
  if (sha256Bytes(await readContainedFile(ROOT, lock.reviewCoverage.path)) !== lock.reviewCoverage.sha256 || coverage.state !== 'PASS'
      || coverage.queueCandidates?.length !== G003_COUNTS.regenerate || coverage.edgeCandidates?.length !== G003_COUNTS.edges || coverage.coverage?.missingCoverage !== 0) fail('locked G003 coverage is incomplete or stale');
  const verifiedCoverage = await verifyCoverageArtifacts(coverage);
  await verifyG003TerminalState(lock, lockBytes, { discovered: verifiedCoverage.discovered, coverage });
  const ids = new Set(); const tree = [];
  for (const entry of manifest.entries) {
    if (!/^PG-[0-9]{3}$/.test(entry.id) || ids.has(entry.id)) fail(`duplicate/invalid entry ${entry.id}`); ids.add(entry.id);
    const master = await readContainedFile(ROOT, entry.path); const runtime = await readContainedFile(ROOT, entry.mobilePath);
    if (master.length !== entry.bytes || sha256Bytes(master) !== entry.sha256 || runtime.length !== entry.mobileBytes || sha256Bytes(runtime) !== entry.mobileSha256) fail(`${entry.id}: hash/size drift`);
    if (!master.subarray(0, 8).equals(PNG_SIGNATURE) || !runtime.subarray(0, 8).equals(PNG_SIGNATURE)) fail(`${entry.id}: non-PNG asset`);
    const masterImage = PNG.sync.read(master); const runtimeImage = PNG.sync.read(runtime);
    if (masterImage.width !== masterImage.height || masterImage.width < 1024) fail(`${entry.id}: master must be square >=1024`);
    if (runtimeImage.width !== 360 || runtimeImage.height !== 360) fail(`${entry.id}: runtime must be 360x360`);
    if (entry.sourceKind === 'g003-approved-candidate') {
      const ihdrColorType = runtime[25];
      if (ihdrColorType !== 6 || !chunks(runtime).includes('sRGB')) fail(`${entry.id}: generated runtime must be RGBA with sRGB chunk`);
    }
    tree.push({ id: entry.id, sha256: entry.sha256, mobileSha256: entry.mobileSha256 });
  }
  assertPackComposition(manifest.entries);
  const masterFiles = await listContainedRegularFiles(ROOT, manifest.masterRoot); const mobileFiles = await listContainedRegularFiles(ROOT, manifest.mobileRoot);
  const expected = [...ids].map((id) => `${id}.png`).sort();
  assertExactPackInventory(expected, masterFiles, mobileFiles);
  if (sha256Canonical(tree) !== lock.sourceTreeSha256 || lock.entryCount !== 240) fail('source tree lock mismatch');
  return { status: 'PASS_SOURCE_ONLY_NOT_REGISTERED', packId: manifest.packId, entries: 240, queueCandidates: G003_COUNTS.regenerate, edgeCandidates: G003_COUNTS.edges };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); if (args.length > 1 || (args[0] && args[0] !== '--source-only')) fail('usage: [--source-only]');
  verifyV3Pack().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
