#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readContainedFile, listContainedRegularFiles } from './lib/continuity-assignment/evidence.mjs';
import {
  PINNED_G003_AUTHORITY_FINGERPRINT, PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64,
  PINNED_G003_ROOT_KEY_COMMITMENT_SHA256, assertG003ConductorKeyPinned, verifyG003PublicEvidence,
} from './lib/g003-public-authority.mjs';
import {
  G003_COUNTS, G003_PRIOR_PROTOCOL_AUTHORITY_SHA256, G003_PROTOCOL, G003_PROTOCOL_AUTHORITY_SHA256, G003_SCHEMA_BINDINGS,
  G003_SIGNING_AUTHORITY, G003_V4_EVIDENCE, assertG003V4BaselineShape, assertG003V4SchemaBinding, verifyG003V4Authority,
} from './lib/g003-v4-authority.mjs';
import { assertG003MutationOpen, rebuildCoverage, withExclusiveG003Operation } from './conduct-g003-reviews.mjs';
import { G003_V4_FREEZE_PATH } from './lib/g003-v4-freeze-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verified = await verifyG003V4Authority(ROOT);
assert.equal(G003_PROTOCOL, 'continuity-g003-review-protocol-v4');
assert.equal(G003_PROTOCOL_AUTHORITY_SHA256, 'e1a569f6cd3351c04db5795acc98762d6f2bfd0596826fc4a0c35fe3f870df5e');
assert.equal(G003_PRIOR_PROTOCOL_AUTHORITY_SHA256, 'f585f5002c5f173a6a083e4a1d547d6b827d2277f140e94d1b8519d02b0124c7');
assert.equal(G003_SIGNING_AUTHORITY.authorityFingerprint, PINNED_G003_AUTHORITY_FINGERPRINT);
assert.equal(G003_SIGNING_AUTHORITY.publicKeySpkiDerBase64, PINNED_G003_PUBLIC_KEY_SPKI_DER_BASE64);
assert.equal(G003_SIGNING_AUTHORITY.rootKeyCommitmentSha256, PINNED_G003_ROOT_KEY_COMMITMENT_SHA256);

for (const mutation of [
  { reviewProtocol: 'continuity-g003-review-protocol-v3' },
  { protocolAuthoritySha256: G003_PRIOR_PROTOCOL_AUTHORITY_SHA256 },
  { priorProtocolAuthoritySha256: '0'.repeat(64) },
  { signingAuthority: { ...G003_SIGNING_AUTHORITY, publicKeySpkiDerBase64: 'MCowBQYDK2VwAyEA' } },
  { signingAuthority: { ...G003_SIGNING_AUTHORITY, rootKeyCommitmentSha256: '0'.repeat(64) } },
]) assert.throws(() => assertG003V4BaselineShape({ ...verified.baseline, ...mutation }), /baseline shape\/binding mismatch/);

const g002Manifest = JSON.parse(await readContainedFile(ROOT, 'production/reports/biological-continuity-v3/g002-evidence-v2/public-evidence-manifest.json'));
const g002Unsigned = structuredClone(g002Manifest); delete g002Unsigned.publicSignature;
assert.throws(() => verifyG003PublicEvidence(g002Unsigned, g002Manifest.publicSignature), /G003 public evidence signature authority is invalid/);
assert.throws(() => verifyG003PublicEvidence({}, { algorithm: 'Ed25519', authorityEpoch: 'g003-authority-epoch-v1', authorityFingerprint: '0'.repeat(64), signatureBase64: 'A'.repeat(88) }), /authority is invalid/);
const signatureOptions = { purpose: 'g003:public-review-artifact', schemaSha256: G003_SIGNING_AUTHORITY.authorityRecordSha256 };
const envelope = { algorithm: 'Ed25519', authorityEpoch: 'g003-authority-epoch-v1', authorityFingerprint: PINNED_G003_AUTHORITY_FINGERPRINT,
  purpose: signatureOptions.purpose, schemaSha256: signatureOptions.schemaSha256, signatureBase64: Buffer.alloc(64).toString('base64') };
assert.throws(() => verifyG003PublicEvidence({}, { ...envelope, authorityEpoch: 'g003-authority-epoch-v0' }, signatureOptions), /authority is invalid/);
assert.throws(() => verifyG003PublicEvidence({}, { ...envelope, purpose: 'g003:pack-lock' }, signatureOptions), /authority is invalid/);
assert.throws(() => verifyG003PublicEvidence({}, { ...envelope, schemaSha256: '0'.repeat(64) }, signatureOptions), /authority is invalid/);
assert.throws(() => verifyG003PublicEvidence({}, { ...envelope, signatureBase64: 'A'.repeat(88) }, signatureOptions), /encoding is invalid/);
assert.throws(() => assertG003V4BaselineShape({ ...verified.baseline, schemaBindings: verified.baseline.schemaBindings.map((entry, index) => index ? entry : { ...entry, normalizedSha256: '0'.repeat(64) }) }), /baseline shape\/binding mismatch/);
const publicArtifactBinding = G003_SCHEMA_BINDINGS.find((entry) => entry.path.endsWith('g003-public-review-artifact-v4.schema.json'));
const publicArtifactSchema = JSON.parse(await readContainedFile(ROOT, publicArtifactBinding.path));
const badPublicProtocolSchema = structuredClone(publicArtifactSchema);
badPublicProtocolSchema.properties.protocolAuthoritySha256.const = '0'.repeat(64);
assert.throws(() => assertG003V4SchemaBinding(publicArtifactBinding, badPublicProtocolSchema), /excluded field changed/);
const badPublicSignatureSchema = structuredClone(publicArtifactSchema);
badPublicSignatureSchema.$defs.publicSignature.properties.schemaSha256.const = '0'.repeat(64);
assert.throws(() => assertG003V4SchemaBinding(publicArtifactBinding, badPublicSignatureSchema), /excluded field changed/);
assert.throws(() => assertG003ConductorKeyPinned(Buffer.alloc(32, 1)), /hard-pinned G003 public authority and commitment/);
assert.throws(() => assertG003ConductorKeyPinned(null), /at least 32 bytes/);

const before = await listContainedRegularFiles(ROOT, G003_V4_EVIDENCE);
await assert.rejects(rebuildCoverage(Buffer.alloc(32, 1)), /hard-pinned G003 public authority and commitment/);
await assert.rejects(rebuildCoverage(null), /at least 32 bytes/);
const after = await listContainedRegularFiles(ROOT, G003_V4_EVIDENCE);
assert.deepEqual(after, before, 'wrong or missing conductor key mutated G003 evidence');

assert.equal(g002Manifest.runtimeAssets.length, 240);
assert.equal(new Set(g002Manifest.runtimeAssets.map((entry) => entry.pgId)).size, 240);
assert.ok(g002Manifest.runtimeAssets.every((entry) => entry.mobile?.path && entry.macos?.path));
assert.equal(verified.baseline.protectedFiles.length, 4);
assert.equal(verified.gate.queueCandidates.length, G003_COUNTS.regenerate);
assert.equal(verified.gate.edgeCandidates.length, G003_COUNTS.edges);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v4-state-'));
const finalizingPath = 'state/finalizing.json'; const terminalPath = 'state/terminal.json';
await mkdir(path.join(temporary, 'state'), { recursive: true });
await writeFile(path.join(temporary, finalizingPath), '{}');
await assert.rejects(assertG003MutationOpen({ repoRoot: temporary, finalizingPath, terminalPath }), /FINALIZING/);
await writeFile(path.join(temporary, terminalPath), '{}');
await assert.rejects(assertG003MutationOpen({ repoRoot: temporary, finalizingPath: 'state/missing.json', terminalPath }), /TERMINAL/);

const frozen = await mkdtemp(path.join(os.tmpdir(), 'punchgrow-g003-v4-frozen-mutation-'));
await mkdir(path.join(frozen, path.dirname(G003_V4_FREEZE_PATH)), { recursive: true });
await writeFile(path.join(frozen, G003_V4_FREEZE_PATH), '{}\n');
let callbacks = 0;
for (const allowFinalizing of [false, true]) {
  const sentinel = path.join(frozen, `callback-${allowFinalizing}.txt`);
  await assert.rejects(withExclusiveG003Operation(`freeze-regression-${allowFinalizing}`, async () => {
    callbacks += 1; await writeFile(sentinel, 'unexpected');
  }, { repoRoot: frozen, allowFinalizing, finalizingPath: 'state/finalizing.json', terminalPath: 'state/terminal.json' }), /freeze marker exists/);
  await assert.rejects(access(sentinel), { code: 'ENOENT' }, `freeze preflight allowed ${allowFinalizing ? 'finalizing' : 'normal'} callback write`);
}
assert.equal(callbacks, 0, 'freeze preflight must run before every exclusive mutation callback');

console.log(JSON.stringify({ status: 'PASS', protocol: G003_PROTOCOL, protocolAuthoritySha256: G003_PROTOCOL_AUTHORITY_SHA256,
  runtimeAssets: g002Manifest.runtimeAssets.length, protectedFiles: verified.baseline.protectedFiles.length, wrongKeyMutations: 0, frozenMutationCallbacks: callbacks }));
