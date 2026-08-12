#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readJson } from './lib/continuity-assignment/evidence.mjs';
import { signG003PublicEvidence, verifyG003PublicEvidence, PINNED_G003_AUTHORITY_FINGERPRINT } from './lib/g003-public-authority.mjs';
import {
  CONTINUITY_AUTHORITY_ALGORITHM, CONTINUITY_AUTHORITY_EPOCH, CONTINUITY_DELEGATION_PURPOSE,
  CONTINUITY_SUPERSESSION_PURPOSE, G002_V2_IMMUTABLE_PREDECESSOR, deriveContinuityAuthority,
  assertSingleContinuityDelegationTip, validateContinuityDelegation,
} from './lib/continuity-public-authority.mjs';
import { assertG003TransitionSnapshot, loadVerifiedG003TransitionSnapshot } from './lib/g003-transition-snapshot.mjs';
import { publishBytesNoReplace, withG003TransitionLock } from './lib/g003-transition-integrity.mjs';
import {
  CROSS_AUTHORITY_SUPERSESSION_PATH,
  deriveCrossAuthorityAssignmentV3Binding, deriveCrossAuthorityObligationScope, supersessionIntentV1,
} from './lib/continuity-assignment/g002-v2-cross-authority-supersession.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTINUITY_DELEGATION_PATH = 'production/reports/biological-continuity-v3/continuity-authority/delegation-v1.json';
export const CONTINUITY_DELEGATION_SCHEMA_PATH = 'production/contracts/continuity-authority-delegation-v1.schema.json';
export const CONTINUITY_SUPERSESSION_SCHEMA_PATH = 'production/contracts/continuity-g002-v2-supersession-v1.schema.json';

export async function assertContinuityDelegationTipAvailable(repoRoot = ROOT) {
  for (const relative of [CONTINUITY_DELEGATION_PATH, CROSS_AUTHORITY_SUPERSESSION_PATH]) {
    try {
      await lstat(path.join(repoRoot, relative));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`continuity fixed tip already exists; second delegation is forbidden: ${relative}`);
  }
  return true;
}

async function readRootKey() {
  if (process.stdin.isTTY) throw new Error('--g003-root-key-stdin requires non-TTY stdin');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const key = Buffer.concat(chunks); if (key.length < 32) throw new Error('G003 root key must contain at least 32 bytes'); return key;
}

export async function attestContinuityAuthorityDelegation({
  repoRoot = ROOT, g003RootKey, write = true, testOnlyTransitionSnapshot,
  deriveAuthority = deriveContinuityAuthority, issuerSigner = signG003PublicEvidence, issuerVerifier = verifyG003PublicEvidence,
  nonce,
} = {}) {
  if (testOnlyTransitionSnapshot && write) throw new Error('test-only transition snapshot cannot publish');
  return withG003TransitionLock(repoRoot, async () => {
  const snapshot = testOnlyTransitionSnapshot ?? await loadVerifiedG003TransitionSnapshot(repoRoot);
  assertG003TransitionSnapshot(snapshot, { production: write });
  const actualNonce = nonce ?? randomBytes(32).toString('hex');
  const [delegationSchema, supersessionSchema] = await Promise.all([
    readJson(repoRoot, CONTINUITY_DELEGATION_SCHEMA_PATH), readJson(repoRoot, CONTINUITY_SUPERSESSION_SCHEMA_PATH),
  ]);
  const delegationSchemaSha256 = sha256Canonical(delegationSchema);
  const delegatedSchemaSha256 = sha256Canonical(supersessionSchema);
  const obligationScope = deriveCrossAuthorityObligationScope(snapshot.assignment, snapshot.topology);
  const assignmentV3 = await deriveCrossAuthorityAssignmentV3Binding(repoRoot, snapshot, obligationScope);
  const successorIntentSha256 = sha256Canonical(supersessionIntentV1(obligationScope, assignmentV3));
  const authority = deriveAuthority(g003RootKey);
  const delegate = {
    algorithm: CONTINUITY_AUTHORITY_ALGORITHM, authorityEpoch: CONTINUITY_AUTHORITY_EPOCH,
    authorityFingerprint: authority.fingerprintSha256, publicKeySpkiDerBase64: authority.publicKeySpkiDerBase64,
    rootKeyCommitmentSha256: authority.rootKeyCommitmentSha256,
  };
  const grant = { purpose: CONTINUITY_SUPERSESSION_PURPOSE, schemaVersion: 'continuity-g002-v2-supersession-v1', schemaSha256: delegatedSchemaSha256, successorPath: CROSS_AUTHORITY_SUPERSESSION_PATH, assignmentV3, oneTime: true, nativeG002SignatureClaimAllowed: false };
  const core = {
    schemaVersion: 'continuity-authority-delegation-v1',
    delegationId: `continuity-delegation-${sha256Canonical({ predecessor: G002_V2_IMMUTABLE_PREDECESSOR, successorPath: grant.successorPath }).slice(0, 24)}`,
    nonce: actualNonce,
    issuer: { authorityEpoch: 'g003-authority-epoch-v1', authorityFingerprint: PINNED_G003_AUTHORITY_FINGERPRINT },
    delegate, grant, predecessor: G002_V2_IMMUTABLE_PREDECESSOR, successorIntentSha256,
  };
  const unsigned = { ...core, outputSha256: sha256Canonical(core) };
  const delegation = { ...unsigned, publicSignature: issuerSigner(unsigned, g003RootKey, { purpose: CONTINUITY_DELEGATION_PURPOSE, schemaSha256: delegationSchemaSha256 }) };
  validateContinuityDelegation(delegation, { delegatedSchemaSha256 });
  assertSingleContinuityDelegationTip([delegation]);
  issuerVerifier(unsigned, delegation.publicSignature, { purpose: CONTINUITY_DELEGATION_PURPOSE, schemaSha256: delegationSchemaSha256 });
  const publication = write ? await publishBytesNoReplace(repoRoot, path.join(repoRoot, CONTINUITY_DELEGATION_PATH), Buffer.from(canonicalStringify(delegation))) : null;
  return { status: write ? publication : 'VALID', output: CONTINUITY_DELEGATION_PATH, outputSha256: delegation.outputSha256, delegation };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--g003-root-key-stdin') throw new Error('--g003-root-key-stdin is required');
  const result = await attestContinuityAuthorityDelegation({ g003RootKey: await readRootKey() });
  console.log(JSON.stringify({ status: result.status, output: result.output, outputSha256: result.outputSha256 }));
}
