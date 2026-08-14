import { sha256Bytes, sha256Canonical } from './continuity-assignment/canonical-json.mjs';
import { readContainedFile } from './continuity-assignment/evidence.mjs';
import { projectG002CatalogEpoch } from './continuity-assignment/g002-catalog-epoch.mjs';
import { validateSignedG002V2Successor, G002_V2_EFFECTIVE_ROOT_IDS, G002_V2_TARGET_SOURCE } from './continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { verifyG002V2PublicEvidence } from '../verify-g002-v2-public-evidence-manifest.mjs';
import {
  G003_AUTHORITY_ALGORITHM, G003_AUTHORITY_EPOCH, PINNED_G003_AUTHORITY_FINGERPRINT,
  PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64, PINNED_G003_ROOT_KEY_COMMITMENT_SHA256,
} from './g003-public-authority.mjs';

export const G003_V4_EVIDENCE = 'production/reports/biological-continuity-v3/g003-evidence-v3';
export const G003_V4_BASELINE_PATH = `${G003_V4_EVIDENCE}/active-baseline.json`;
export const G003_BASELINE_SCHEMA_VERSION = 'continuity-g003-active-baseline-v3';
export const G002_V2_PUBLIC = 'production/reports/biological-continuity-v3/g002-evidence-v2/public-evidence-manifest.json';
export const G002_V2_SUCCESSOR = 'production/reports/biological-continuity-v3/g002-evidence-v2/canonical-root-redesign-targets-v2.json';
export const G002_V2_ASSIGNMENT = 'production/reports/biological-continuity-v3/g002-evidence-v2/assignment-manifest.json';
export const G003_PROTOCOL = 'continuity-g003-review-protocol-v4';
export const G003_PRIOR_PROTOCOL_AUTHORITY_SHA256 = 'f585f5002c5f173a6a083e4a1d547d6b827d2277f140e94d1b8519d02b0124c7';
export const G003_COUNTS = Object.freeze({ regenerate: 177, retain: 63, edges: 190, obligations: 367, dependentQueue: 123, generatedParentEdges: 133, primaryVotes: 734, effectiveRoots: 15 });
export const G003_EDGE_CHILD_COUNTS = Object.freeze({ generated: 148, retained: 42 });
export const G003_AUTHORITY = Object.freeze({ publicManifestOutputSha256: '3fee012ba96fbd22ba5921185495bb5d6cbc622bba7b7a2769c56050af2cf430', publicManifestFileSha256: '1b30604091b8da34a3191d903836f8e61126405839abac8b2f1576d380cecd37', successorOutputSha256: '6cee5fa6c9c28d5801eac5df8696c3857787ddf4597035194c749be37aac6168', successorFileSha256: '01b1f63f570f82a304b5e661e14c4454e5b82895dca4e414cfb2b2a511a073f2', assignmentSha256: '9b5d863fa77e6e124b16f64c3268e6badafab801a837d812b07650dd07a2fb0e', effectiveAuthoritySha256: '22cf282dd777c8bf5239b8a6e4d56572143f314b983a189a5b0eb589308d1f92' });
export const G003_SIGNING_AUTHORITY = Object.freeze({
  algorithm: G003_AUTHORITY_ALGORITHM,
  authorityEpoch: G003_AUTHORITY_EPOCH,
  authorityFingerprint: PINNED_G003_AUTHORITY_FINGERPRINT,
  publicKeySpkiDerBase64: PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64,
  rootKeyCommitmentSha256: PINNED_G003_ROOT_KEY_COMMITMENT_SHA256,
  authorityRecordPath: 'production/contracts/g003-public-authority-v1.json',
  authorityRecordSha256: 'b8bfa387920542ef4accc420ca7ee0a8217df9edfd6f7ef022c627c5f3232d4b',
});
export const G003_SCHEMA_BINDINGS = Object.freeze([
  Object.freeze({ path: 'production/contracts/continuity-candidate-review-v4.schema.json', normalizedSha256: '38a56e1137b30785b023560c3c682e7a32e03fa1e90285d7d6b97015bb749433' }),
  Object.freeze({ path: 'production/contracts/g003-public-review-artifact-v4.schema.json', normalizedSha256: '1f5f259a4e83351a30c73960e45769276e411b349853daba1ebfc7bd86519cc7' }),
  Object.freeze({ path: 'production/contracts/continuity-pack-lock-v3.schema.json', normalizedSha256: '14438ff760324d5909fa9f2aa2680c53edccb06d148e4f18421f60db237fb01e' }),
  Object.freeze({ path: 'production/contracts/g003-active-baseline-v3.schema.json', normalizedSha256: 'e3708357232aa4e6ce229323b293ef38f9b17897c745007aa396375a2f7dd52b' }),
]);
export const G003_PROTOCOL_AUTHORITY_SHA256 = sha256Canonical({
  protocol: G003_PROTOCOL,
  priorProtocolAuthoritySha256: G003_PRIOR_PROTOCOL_AUTHORITY_SHA256,
  signingAuthority: G003_SIGNING_AUTHORITY,
  schemaBindings: G003_SCHEMA_BINDINGS,
  ...G003_AUTHORITY,
  counts: G003_COUNTS,
  targetSource: G002_V2_TARGET_SOURCE,
  effectiveRootIds: G002_V2_EFFECTIVE_ROOT_IDS,
});

const protectedFiles = Object.freeze([
  Object.freeze({ path: 'config/creature-assets.json', sha256: '27fbc75e2347a9048ea0d215df56ba8e3fbc62e6d66e9e875b3ed886d8a894bb' }),
  Object.freeze({ path: 'production/catalog/creatures.json', sha256: 'd9a3265d8e8f07d9ce7f3de52affe3420df4d2aa3406a7f4f364ae1380e9e8a0' }),
  Object.freeze({ path: 'macos/Sources/PunchGrowMenuBar/Resources/creatures.json', sha256: 'd9a3265d8e8f07d9ce7f3de52affe3420df4d2aa3406a7f4f364ae1380e9e8a0' }),
  Object.freeze({ path: 'production/manifests/creature-asset-packs/cute-redesign-v2.json', sha256: '7bb53a3cbdc04ba22ff1c68ca174d92e014d7725c16edcd32fcc175e0ecdf3fa' }),
]);
const fail = (message) => { throw new Error(`G003-v4 authority: ${message}`); };
export const g003V4OpaqueId = (kind, material) => `${kind}-${sha256Canonical({ protocol: G003_PROTOCOL, authority: G003_PROTOCOL_AUTHORITY_SHA256, material }).slice(0, 24)}`;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(`${label} fields mismatch`);
}

function pointerTarget(value, pointer, label) {
  let target = value;
  for (const component of pointer) {
    if (!target || typeof target !== 'object' || !(component in target)) fail(`${label} pointer is missing: ${pointer.join('/')}`);
    target = target[component];
  }
  return target;
}

function normalizeBoundSchema(binding, value) {
  const normalized = structuredClone(value);
  const protocol = G003_PROTOCOL_AUTHORITY_SHA256;
  const definitions = binding.path.endsWith('continuity-candidate-review-v4.schema.json') ? [
    { pointer: ['properties', 'protocolAuthoritySha256', 'const'], expected: protocol, sentinel: '__G003_PROTOCOL_AUTHORITY_SHA256__' },
    { pointer: ['$defs', 'vote', 'properties', 'protocolAuthoritySha256', 'const'], expected: protocol, sentinel: '__G003_PROTOCOL_AUTHORITY_SHA256__' },
  ] : binding.path.endsWith('g003-public-review-artifact-v4.schema.json') ? [
    { pointer: ['properties', 'protocolAuthoritySha256', 'const'], expected: protocol, sentinel: '__G003_PROTOCOL_AUTHORITY_SHA256__' },
    { pointer: ['$defs', 'publicSignature', 'properties', 'purpose', 'const'], expected: 'g003:public-review-artifact' },
    { pointer: ['$defs', 'publicSignature', 'properties', 'schemaSha256', 'const'], expected: binding.normalizedSha256, sentinel: '__G003_SCHEMA_SHA256__' },
  ] : binding.path.endsWith('continuity-pack-lock-v3.schema.json') ? [
    { pointer: ['properties', 'protocolAuthoritySha256', 'const'], expected: protocol, sentinel: '__G003_PROTOCOL_AUTHORITY_SHA256__' },
    { pointer: ['properties', 'publicSignature', 'properties', 'purpose', 'const'], expected: 'g003:pack-lock' },
    { pointer: ['properties', 'publicSignature', 'properties', 'schemaSha256', 'const'], expected: binding.normalizedSha256, sentinel: '__G003_SCHEMA_SHA256__' },
  ] : binding.path.endsWith('g003-active-baseline-v3.schema.json') ? [
    { pointer: ['properties', 'protocolAuthoritySha256', 'const'], expected: protocol, sentinel: '__G003_PROTOCOL_AUTHORITY_SHA256__' },
  ] : null;
  if (!definitions) fail(`unrecognized protocol schema binding: ${binding.path}`);
  for (const definition of definitions) {
    if (pointerTarget(value, definition.pointer, binding.path) !== definition.expected) fail(`protocol schema excluded field changed: ${binding.path}#/${definition.pointer.join('/')}`);
    if (definition.sentinel) {
      const parent = pointerTarget(normalized, definition.pointer.slice(0, -1), binding.path);
      parent[definition.pointer.at(-1)] = definition.sentinel;
    }
  }
  return normalized;
}

export function assertG003V4SchemaBinding(binding, schema) {
  if (!G003_SCHEMA_BINDINGS.includes(binding)) fail('schema binding is not the pinned protocol binding');
  if (sha256Canonical(normalizeBoundSchema(binding, schema)) !== binding.normalizedSha256) fail(`protocol schema changed: ${binding.path}`);
  return true;
}

export function assertG003V4BaselineShape(value) {
  exactKeys(value, ['schemaVersion', 'reviewProtocol', 'protocolAuthoritySha256', 'priorProtocolAuthoritySha256', 'activePack', 'authority', 'signingAuthority', 'schemaBindings', 'counts', 'targetSource', 'effectiveRootIds', 'protectedFiles', 'supersedes'], 'baseline');
  if (value.schemaVersion !== G003_BASELINE_SCHEMA_VERSION || value.reviewProtocol !== G003_PROTOCOL
      || value.protocolAuthoritySha256 !== G003_PROTOCOL_AUTHORITY_SHA256 || value.priorProtocolAuthoritySha256 !== G003_PRIOR_PROTOCOL_AUTHORITY_SHA256
      || value.activePack !== 'cute-redesign-v2' || sha256Canonical(value.protectedFiles) !== sha256Canonical(protectedFiles)
      || sha256Canonical(value.authority) !== sha256Canonical(G003_AUTHORITY) || sha256Canonical(value.signingAuthority) !== sha256Canonical(G003_SIGNING_AUTHORITY)
      || sha256Canonical(value.schemaBindings) !== sha256Canonical(G003_SCHEMA_BINDINGS)
      || sha256Canonical(value.counts) !== sha256Canonical(G003_COUNTS) || value.targetSource !== G002_V2_TARGET_SOURCE
      || sha256Canonical(value.effectiveRootIds) !== sha256Canonical(G002_V2_EFFECTIVE_ROOT_IDS)
      || value.supersedes !== 'production/reports/biological-continuity-v3/g003-evidence-v2/active-baseline.json') fail('baseline shape/binding mismatch');
  return value;
}

export async function verifyG003V4Authority(repoRoot) {
  const baseline = assertG003V4BaselineShape(JSON.parse(await readContainedFile(repoRoot, G003_V4_BASELINE_PATH)));
  await verifyG002V2PublicEvidence({ repoRoot });
  const authorityRecordBytes = await readContainedFile(repoRoot, G003_SIGNING_AUTHORITY.authorityRecordPath);
  if (sha256Bytes(authorityRecordBytes) !== G003_SIGNING_AUTHORITY.authorityRecordSha256) fail('public signing authority record changed');
  for (const binding of G003_SCHEMA_BINDINGS) {
    const schema = JSON.parse(await readContainedFile(repoRoot, binding.path));
    assertG003V4SchemaBinding(binding, schema);
  }
  const [publicBytes, successorBytes, assignmentBytes] = await Promise.all([
    readContainedFile(repoRoot, G002_V2_PUBLIC), readContainedFile(repoRoot, G002_V2_SUCCESSOR), readContainedFile(repoRoot, G002_V2_ASSIGNMENT),
  ]);
  if (sha256Bytes(publicBytes) !== G003_AUTHORITY.publicManifestFileSha256 || sha256Bytes(successorBytes) !== G003_AUTHORITY.successorFileSha256
      || sha256Bytes(assignmentBytes) !== G003_AUTHORITY.assignmentSha256) fail('pinned G002-v2 authority file hash mismatch');
  const publicManifest = JSON.parse(publicBytes); const successor = JSON.parse(successorBytes); const assignment = JSON.parse(assignmentBytes);
  if (publicManifest.outputSha256 !== G003_AUTHORITY.publicManifestOutputSha256 || successor.outputSha256 !== G003_AUTHORITY.successorOutputSha256) fail('pinned G002-v2 authority output mismatch');
  validateSignedG002V2Successor(successor);
  const gate = assignment.reviewCoverageManifest;
  const generatedSlots = new Set(gate?.queueCandidates?.map((item) => item.slotId) ?? []);
  const generatedEdgeChildren = gate?.edgeCandidates?.filter((item) => generatedSlots.has(item.childId)).length;
  const retainedEdgeChildren = (gate?.edgeCandidates?.length ?? 0) - generatedEdgeChildren;
  if (assignment.schemaVersion !== 'continuity-assignment-v2' || assignment.effectiveAuthoritySha256 !== G003_AUTHORITY.effectiveAuthoritySha256
      || gate?.schemaVersion !== 'continuity-g003-review-gate-v2' || gate.queueCandidates?.length !== G003_COUNTS.regenerate
      || gate.edgeCandidates?.length !== G003_COUNTS.edges || gate.coverage?.missingCoverage !== G003_COUNTS.obligations
      || gate.queueCandidates.filter((item) => item.requiredParentCandidateIds.length > 0).length !== G003_COUNTS.dependentQueue
      || gate.edgeCandidates.filter((item) => item.allowedParentAnchors.some((parent) => parent.sourceKind === 'generated-parent-candidate')).length !== G003_COUNTS.generatedParentEdges
      || generatedEdgeChildren !== G003_EDGE_CHILD_COUNTS.generated || retainedEdgeChildren !== G003_EDGE_CHILD_COUNTS.retained) fail('assignment/gate authority or counts mismatch');
  for (const binding of protectedFiles) {
    let bytes = await readContainedFile(repoRoot, binding.path);
    if (binding.path.endsWith('/creatures.json')) {
      bytes = Buffer.from(projectG002CatalogEpoch(JSON.parse(bytes)).bytes);
    }
    if (sha256Bytes(bytes) !== binding.sha256) fail(`protected active file changed: ${binding.path}`);
  }
  return { baseline, publicManifest, successor, assignment, gate, effectiveRootIds: G002_V2_EFFECTIVE_ROOT_IDS, targetSource: G002_V2_TARGET_SOURCE };
}
