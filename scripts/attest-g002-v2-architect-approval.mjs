#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from './lib/continuity-assignment/canonical-json.mjs';
import { readJson, writeCanonicalFile } from './lib/continuity-assignment/evidence.mjs';
import { signPublicEvidence, verifyPublicEvidence } from './lib/g002-public-authority.mjs';
import { G002_V2_ADDITION_IDS, G002_V2_DRAFT_CANONICAL_SHA256 } from './lib/continuity-assignment/canonical-root-redesign-authority-v2.mjs';
import { ARCHITECT_APPROVAL_PATH, DRAFT_PATH, summarizeCanonicalReviewProof } from './build-g002-v2-canonical-successor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exactKeys = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error('architect approval draft fields mismatch'); };
async function readKey() { if (process.stdin.isTTY) throw new Error('--conductor-key-stdin requires non-TTY stdin'); const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); const key=Buffer.concat(chunks); if(key.length<32)throw new Error('conductor key must contain at least 32 bytes'); return key; }

export function validateG002V2ArchitectApprovalInput({ approvalDraft, draft, reviewProofs }) {
  if(sha256Canonical(draft)!==G002_V2_DRAFT_CANONICAL_SHA256)throw new Error('architect approval draft target authority differs from the code-pinned reviewed draft');
  for(const proof of reviewProofs){const target=draft.targets.find((entry)=>entry.rootId===proof.rootId);if(!target||proof.targetSha256!==sha256Canonical(target))throw new Error(`${proof.rootId}: architect proof target differs from reviewed draft`);}
  exactKeys(approvalDraft,['schemaVersion','source','reviewerId','decision','approvedTargetIds','approvedAt']);
  const canonicalTime=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;const parsed=Date.parse(approvalDraft.approvedAt);
  if(approvalDraft.schemaVersion!=='g002-v2-canonical-architect-approval-v1'||approvalDraft.source!=='independent-architect-review'
      ||typeof approvalDraft.reviewerId!=='string'||approvalDraft.reviewerId.length<4||approvalDraft.decision!=='APPROVE'
      ||JSON.stringify(approvalDraft.approvedTargetIds)!==JSON.stringify(G002_V2_ADDITION_IDS)||!canonicalTime.test(approvalDraft.approvedAt)
      ||!Number.isFinite(parsed)||new Date(parsed).toISOString()!==approvalDraft.approvedAt||parsed>Date.now()+300000)throw new Error('architect approval draft identity/decision/time invalid');
  const reviewerIds=new Set(reviewProofs.flatMap((proof)=>proof.primaryReviews.map((review)=>review.reviewerInstanceId)));if(reviewerIds.has(approvalDraft.reviewerId))throw new Error('architect identity must be distinct from all primary reviewers');
  const evidenceSha256=sha256Canonical({newTargetIds:draft.newTargetIds,targets:draft.targets,reviewProofs,visibilityPolicy:draft.visibilityPolicy});const core={...approvalDraft,evidenceSha256};return{...core,outputSha256:sha256Canonical(core)};
}

export async function attestG002V2ArchitectApproval({ approvalDraftPath, reviewProofPaths, repoRoot = ROOT, conductorKey, signer = signPublicEvidence }) {
  if (!Array.isArray(reviewProofPaths) || reviewProofPaths.length !== 6) throw new Error('exactly six public review proofs are required');
  const [draft, approvalDraft, reviewProofs] = await Promise.all([readJson(repoRoot,DRAFT_PATH),readJson(repoRoot,approvalDraftPath),Promise.all(reviewProofPaths.map((entry)=>summarizeCanonicalReviewProof(entry,{repoRoot})))]);
  reviewProofs.sort((a,b)=>a.rootId.localeCompare(b.rootId,'en')); const unsigned=validateG002V2ArchitectApprovalInput({approvalDraft,draft,reviewProofs});const approval={...unsigned,publicSignature:signer(unsigned,conductorKey)};verifyPublicEvidence(unsigned,approval.publicSignature);
  await writeCanonicalFile(path.join(repoRoot,ARCHITECT_APPROVAL_PATH),approval,{containmentRoot:repoRoot,mode:0o644,allowedBasenames:new Set(['architect-approval.json'])});return{status:'SIGNED',output:ARCHITECT_APPROVAL_PATH,outputSha256:approval.outputSha256};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){const args=process.argv.slice(2),reviewProofPaths=[];let approvalDraftPath;for(let i=0;i<args.length;i+=1){if(args[i]==='--approval-draft')approvalDraftPath=args[++i];else if(args[i]==='--review-proof')reviewProofPaths.push(args[++i]);else if(args[i]!=='--conductor-key-stdin')throw new Error(`unknown argument: ${args[i]}`);}if(!args.includes('--conductor-key-stdin')||!approvalDraftPath)throw new Error('--approval-draft, six --review-proof, and --conductor-key-stdin are required');console.log(JSON.stringify(await attestG002V2ArchitectApproval({approvalDraftPath,reviewProofPaths,conductorKey:await readKey()})));}
