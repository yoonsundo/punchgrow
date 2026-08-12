#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readContainedFile, readJson } from './lib/continuity-assignment/evidence.mjs';
import { verifyG003PublicEvidence } from './lib/g003-public-authority.mjs';
import { G002_V2_IMMUTABLE_PREDECESSOR, CONTINUITY_DELEGATION_PURPOSE, assertSingleContinuityDelegationTip, validateContinuityDelegation } from './lib/continuity-public-authority.mjs';
import { verifyG002V2PublicEvidence } from './verify-g002-v2-public-evidence-manifest.mjs';
import { CONTINUITY_DELEGATION_PATH, CONTINUITY_DELEGATION_SCHEMA_PATH, CONTINUITY_SUPERSESSION_SCHEMA_PATH } from './attest-continuity-authority-delegation.mjs';
import { deriveCrossAuthorityAssignmentV3Binding, deriveCrossAuthorityObligationScope, supersessionIntentV1 } from './lib/continuity-assignment/g002-v2-cross-authority-supersession.mjs';
import { assertG003TransitionSnapshot, loadVerifiedG003TransitionSnapshot } from './lib/g003-transition-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { throw new Error(`continuity delegation verification: ${message}`); };

export async function verifyImmutableG002V2Predecessor({ repoRoot = ROOT, verifyPredecessor = verifyG002V2PublicEvidence } = {}) {
  await verifyPredecessor({ repoRoot });
  for (const [pathKey, hashKey] of [['publicManifestPath', 'publicManifestFileSha256'], ['successorPath', 'successorFileSha256'], ['assignmentPath', 'assignmentFileSha256']]) {
    const bytes = await readContainedFile(repoRoot, G002_V2_IMMUTABLE_PREDECESSOR[pathKey]);
    if (sha256Bytes(bytes) !== G002_V2_IMMUTABLE_PREDECESSOR[hashKey]) fail(`immutable predecessor byte drift: ${G002_V2_IMMUTABLE_PREDECESSOR[pathKey]}`);
  }
  return true;
}

export async function verifyContinuityAuthorityDelegation({ repoRoot = ROOT, delegation: supplied, transitionSnapshot, knownDelegations = [] } = {}) {
  const snapshot = transitionSnapshot ?? await loadVerifiedG003TransitionSnapshot(repoRoot);
  assertG003TransitionSnapshot(snapshot);
  const delegation = supplied ?? await readJson(repoRoot, CONTINUITY_DELEGATION_PATH);
  const [delegationSchema, supersessionSchema] = await Promise.all([
    readJson(repoRoot, CONTINUITY_DELEGATION_SCHEMA_PATH), readJson(repoRoot, CONTINUITY_SUPERSESSION_SCHEMA_PATH),
  ]);
  const delegationSchemaSha256 = sha256Canonical(delegationSchema);
  const delegatedSchemaSha256 = sha256Canonical(supersessionSchema);
  const unsigned = validateContinuityDelegation(delegation, { delegatedSchemaSha256 });
  assertSingleContinuityDelegationTip([delegation, ...knownDelegations]);
  if (sha256Canonical(delegation.predecessor) !== sha256Canonical(G002_V2_IMMUTABLE_PREDECESSOR)) fail('delegation predecessor binding differs from immutable G002-v2');
  const obligationScope = deriveCrossAuthorityObligationScope(snapshot.assignment, snapshot.topology);
  const assignmentV3 = await deriveCrossAuthorityAssignmentV3Binding(repoRoot, snapshot, obligationScope);
  const expectedIntent = supersessionIntentV1(obligationScope, assignmentV3);
  if (sha256Canonical(delegation.grant.assignmentV3) !== sha256Canonical(assignmentV3)) fail('delegation assignment-v3 binding differs from canonical immutable-input derivation');
  if (delegation.successorIntentSha256 !== sha256Canonical(expectedIntent)) fail('delegation successor intent differs from canonical fixed tip');
  verifyG003PublicEvidence(unsigned, delegation.publicSignature, { purpose: CONTINUITY_DELEGATION_PURPOSE, schemaSha256: delegationSchemaSha256 });
  return { status: 'PASS', delegation, delegationSchemaSha256, delegatedSchemaSha256, intent: expectedIntent };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyContinuityAuthorityDelegation();
  console.log(JSON.stringify({ status: result.status, outputSha256: result.delegation.outputSha256 }));
}
