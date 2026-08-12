#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readContainedFile, readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { G002_V2_ADDITION_IDS, G002_V2_DRAFT_CANONICAL_SHA256, G002_V2_ROOT, validateG002V2SuccessorCore, validateUnsignedG002V2Successor, verifyG002V1BaseAuthority } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { verifyCanonicalPublicReviewProofMaterial } from './conduct-g002-v2-canonical-reviews.mjs';
import { verifyPublicEvidence } from './lib/g002-public-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DRAFT_PATH = `${G002_V2_ROOT}/canonical-root-redesign-targets-v2.draft.json`;
export const UNSIGNED_PATH = `${G002_V2_ROOT}/canonical-root-redesign-targets-v2.unsigned.json`;
export const ARCHITECT_APPROVAL_PATH = `${G002_V2_ROOT}/canonical-root-reviews/architect-approval.json`;

export async function summarizeCanonicalReviewProof(entry, { repoRoot = ROOT } = {}) {
  const bytes = await readContainedFile(repoRoot, entry); const { proof } = await verifyCanonicalPublicReviewProofMaterial(JSON.parse(bytes), { repoRoot });
  const expectedPath = `${G002_V2_ROOT}/canonical-root-reviews/proofs/${proof.rootId}.json`;
  if (entry !== expectedPath) throw new Error(`${proof.rootId}: signed review proof must use fixed public path`);
  const primaryReviews = proof.passes.map(({ assignment, raw, vote }, index) => ({
    reviewerInstanceId: assignment.reviewerInstanceId, agentTaskId: assignment.agentTaskId, reviewRunId: assignment.reviewRunId,
    passNumber: index + 1, assignmentSha256: sha256Canonical(assignment), packageManifestSha256: proof.packageManifestSha256,
    materialBindingSha256: proof.materialBindingSha256, promptSha256: proof.promptSha256, inputAllowlistSha256: proof.inputAllowlistSha256,
    rawVoteSha256: sha256Canonical(raw), reviewOutputSha256: sha256Canonical(vote),
    observedSurfaces: { masterSha256: proof.candidate.master.sha256, runtimeSha256: proof.candidate.runtime.sha256 },
    verdicts: { target: 'PASS', anchors: 'PASS', visibility: 'PASS', clarifications: 'PASS' }, blinded: true,
  }));
  return { rootId: proof.rootId, targetSha256: proof.targetSha256, publicProofPath: entry, publicProofFileSha256: sha256Bytes(bytes), publicProofOutputSha256: proof.outputSha256,
    publicProofSignatureSha256: sha256Canonical(proof.publicSignature), primaryReviews,
    consensusSha256: sha256Canonical({ rootId: proof.rootId, primaryReviews }) };
}

export async function verifyG002V2UnsignedSuccessorMaterial(unsigned, { repoRoot = ROOT } = {}) {
  validateUnsignedG002V2Successor(unsigned);
  await verifyG002V1BaseAuthority(repoRoot, unsigned.baseAuthority);
  const reviewerIds = new Set();
  for (const binding of unsigned.reviewProofs) {
    const bytes = await readContainedFile(repoRoot, binding.publicProofPath);
    const { proof } = await verifyCanonicalPublicReviewProofMaterial(JSON.parse(bytes), { repoRoot });
    if (sha256Bytes(bytes) !== binding.publicProofFileSha256 || proof.outputSha256 !== binding.publicProofOutputSha256
        || sha256Canonical(proof.publicSignature) !== binding.publicProofSignatureSha256) throw new Error(`${binding.rootId}: public proof binding differs from unsigned successor`);
    const summarized=await summarizeCanonicalReviewProof(binding.publicProofPath,{repoRoot});if(sha256Canonical(summarized)!==sha256Canonical(binding))throw new Error(`${binding.rootId}: persisted public proof summary differs from unsigned successor binding`);
    for (const pass of proof.passes) reviewerIds.add(pass.assignment.reviewerInstanceId);
  }
  const architect = unsigned.architectApproval;
  const architectUnsigned = structuredClone(architect); delete architectUnsigned.publicSignature;
  verifyPublicEvidence(architectUnsigned, architect.publicSignature);
  if (reviewerIds.has(architect.reviewerId)) throw new Error('architect identity must be distinct from all primary reviewers');
  return true;
}

export async function buildG002V2CanonicalSuccessor({ repoRoot = ROOT, reviewProofPaths, architectApprovalPath, write = true }) {
  if (!Array.isArray(reviewProofPaths) || reviewProofPaths.length !== 6 || !architectApprovalPath) throw new Error('exactly six --review-proof files and one --architect-approval are required');
  const draft = await readJson(repoRoot, DRAFT_PATH);
  if (sha256Canonical(draft) !== G002_V2_DRAFT_CANONICAL_SHA256) throw new Error('G002-v2 draft differs from the code-pinned reviewed target authority');
  const reviewProofs = await Promise.all(reviewProofPaths.map((entry) => summarizeCanonicalReviewProof(entry, { repoRoot })));
  reviewProofs.sort((a, b) => a.rootId.localeCompare(b.rootId, 'en'));
  const architectApproval = await readJson(repoRoot, architectApprovalPath);
  const architectUnsigned = structuredClone(architectApproval); delete architectUnsigned.publicSignature;
  verifyPublicEvidence(architectUnsigned, architectApproval.publicSignature);
  const primaryReviewerIds = new Set(reviewProofs.flatMap((proof) => proof.primaryReviews.map((review) => review.reviewerInstanceId)));
  if (primaryReviewerIds.has(architectApproval.reviewerId)) throw new Error('architect identity must be distinct from all primary reviewers');
  const core = { ...draft, state: 'APPROVED_FOR_REGENERATION_TARGETING', reviewProofs, architectApproval };
  validateG002V2SuccessorCore(core);
  await verifyG002V1BaseAuthority(repoRoot, core.baseAuthority);
  const unsigned = { ...core, outputSha256: sha256Canonical(core) };
  await verifyG002V2UnsignedSuccessorMaterial(unsigned, { repoRoot });
  if (write) {
    await writeCanonicalFile(path.join(repoRoot, ARCHITECT_APPROVAL_PATH), architectApproval, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set(['architect-approval.json']) });
    await writeCanonicalFile(path.join(repoRoot, UNSIGNED_PATH), unsigned, { containmentRoot: repoRoot, mode: 0o644, allowedBasenames: new Set([path.basename(UNSIGNED_PATH)]) });
  }
  return { status: 'PASS', output: UNSIGNED_PATH, newTargetIds: G002_V2_ADDITION_IDS, outputSha256: unsigned.outputSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const reviewProofPaths = []; let architectApprovalPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--review-proof') reviewProofPaths.push(args[++index]);
    else if (args[index] === '--architect-approval') architectApprovalPath = args[++index];
    else throw new Error(`unknown G002-v2 successor build argument: ${args[index]}`);
  }
  console.log(JSON.stringify(await buildG002V2CanonicalSuccessor({ reviewProofPaths, architectApprovalPath })));
}
