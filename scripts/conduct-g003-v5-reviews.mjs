#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from './lib/continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath, readContainedFile } from './lib/continuity-assignment/evidence.mjs';
import {
  assembleG003V5PublicReview,
  createG003V5ArtifactAuthority,
  createG003V5ConductorContext,
  createG003V5RejectionArtifacts,
  createG003V5ReviewerEvidence,
  loadG003V5VerifiedInputs,
  publishG003V5Coverage,
  publishG003V5Records,
  publishG003V5VoteRecord,
} from './lib/g003-v5-conductor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { throw new Error(`G003-v5 conductor CLI: ${message}`); };

async function readStdinKey() {
  if (!process.argv.includes('--conductor-key-stdin')) fail('--conductor-key-stdin is required');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const key = Buffer.concat(chunks); if (key.length < 32) fail('conductor key stdin is missing or too short');
  return key;
}

export async function readCanonicalJson(relativePath, label, repoRoot = ROOT) {
  assertCanonicalRelativePath(relativePath, label);
  const bytes = await readContainedFile(repoRoot, relativePath, label);
  let value; try { value = JSON.parse(bytes); } catch { fail(`${label} is not JSON`); }
  if (!bytes.equals(Buffer.from(canonicalStringify(value)))) fail(`${label} must be exact canonical JSON bytes`);
  return { value, bytes };
}

export async function loadPersistedVotes(voteRoot, repoRoot = ROOT) {
  assertCanonicalRelativePath(voteRoot, 'v5 raw vote root');
  const entries = (await readdir(path.join(repoRoot, voteRoot), { withFileTypes: true }))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  if (entries.length !== 674 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !/^vote-[a-f0-9]{64}\.json$/.test(entry.name))) {
    fail('persisted raw vote root must contain exactly 674 canonical vote-<sha256>.json files');
  }
  return Promise.all(entries.map(async (entry) => {
    const { value } = await readCanonicalJson(`${voteRoot}/${entry.name}`, `raw vote ${entry.name}`, repoRoot);
    if (entry.name !== `vote-${value.outputSha256}.json`) fail(`raw vote filename does not bind output hash: ${entry.name}`);
    return value;
  }));
}

async function productionRuntime(key) {
  const verifiedInputs = await loadG003V5VerifiedInputs({ repoRoot: ROOT });
  const context = createG003V5ConductorContext({ verifiedInputs });
  const artifactAuthority = await createG003V5ArtifactAuthority({ repoRoot: ROOT, conductorKey: key, context });
  return { context, artifactAuthority };
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== '--conductor-key-stdin');
  const [command, ...operands] = args;
  if (command === 'issue-assignment') fail('UNAVAILABLE_NO_VERIFIED_PACKAGE: v5 package preparation/material verification is not implemented; no assignment was signed or written');
  const key = await readStdinKey();
  try {
    const { context, artifactAuthority } = await productionRuntime(key);
    if (command === 'attest-vote') {
      const [assignmentPath, verdictPath, outputRoot] = operands; if (!assignmentPath || !verdictPath || !outputRoot) fail('attest-vote <assignment.json> <reviewer-verdict-v2.json> <vote-root>');
      const [{ value: assignment, bytes: assignmentBytes }, { value: verdict }] = await Promise.all([
        readCanonicalJson(assignmentPath, 'v5 assignment'), readCanonicalJson(verdictPath, 'reviewer verdict v2'),
      ]);
      const vote = createG003V5ReviewerEvidence({ context, assignment, assignmentBytes, verdict, artifactAuthority });
      const records = await publishG003V5VoteRecord({ repoRoot: ROOT, context, artifactAuthority,
        relativePath: `${outputRoot}/vote-${vote.outputSha256}.json`, vote });
      process.stdout.write(`${JSON.stringify(records[0])}\n`); return;
    }
    if (command === 'assemble-review') {
      const [obligationId, voteOnePath, voteTwoPath, outputRoot] = operands;
      if (!obligationId || !voteOnePath || !voteTwoPath || !outputRoot) fail('assemble-review <obligation-id> <vote-1.json> <vote-2.json> <output-root>');
      const votes = await Promise.all([voteOnePath, voteTwoPath].map((item, index) => readCanonicalJson(item, `vote ${index + 1}`).then((entry) => entry.value)));
      const assembled = assembleG003V5PublicReview({ context, obligationId, votes, artifactAuthority });
      const records = await publishG003V5Records({ repoRoot: ROOT, context, artifactAuthority, records: [
        { relativePath: `${outputRoot}/review-${assembled.review.outputSha256}.json`, value: assembled.review },
        { relativePath: `${outputRoot}/public-artifact-${assembled.publicArtifact.outputSha256}.json`, value: assembled.publicArtifact },
      ] });
      process.stdout.write(`${JSON.stringify(records)}\n`); return;
    }
    if (command === 'attest-rejection') {
      const [assignmentPath, verdictPath, materialPath, outputRoot] = operands;
      if (!assignmentPath || !verdictPath || !materialPath || !outputRoot) fail('attest-rejection <assignment.json> <rejection-observation-v2.json> <material.json> <output-root>');
      const [{ value: assignment, bytes: assignmentBytes }, { value: observation }, { value: material }] = await Promise.all([
        readCanonicalJson(assignmentPath, 'v5 assignment'), readCanonicalJson(verdictPath, 'typed rejection observation'), readCanonicalJson(materialPath, 'rejected material binding'),
      ]);
      const rejectedAt = observation.observedAt;
      const artifacts = createG003V5RejectionArtifacts({ context, assignment, assignmentBytes, observation, material,
        artifactAuthority, rejectionAuthority: artifactAuthority, rejectedAt });
      const records = await publishG003V5Records({ repoRoot: ROOT, context, artifactAuthority, records: [
        { relativePath: `${outputRoot}/archive-${artifacts.archive.outputSha256}.json`, value: artifacts.archive },
        { relativePath: `${outputRoot}/tombstone-${artifacts.tombstone.outputSha256}.json`, value: artifacts.tombstone },
      ] });
      process.stdout.write(`${JSON.stringify(records)}\n`); return;
    }
    if (command === 'rebuild-coverage') {
      const [voteRoot, stateRoot] = operands; if (!voteRoot) fail('rebuild-coverage <raw-vote-root> [state-root]');
      const votes = await loadPersistedVotes(voteRoot);
      const result = await publishG003V5Coverage({ repoRoot: ROOT,
        stateRoot: stateRoot ?? 'production/reports/biological-continuity-v3/g003-terminal-v5/reviews', context, votes, artifactAuthority });
      process.stdout.write(`${JSON.stringify({ status: result.publication, output: result.relativePath, fileSha256: result.fileSha256 })}\n`); return;
    }
    fail('commands: issue-assignment | attest-vote | assemble-review | attest-rejection | rebuild-coverage');
  } finally { key.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
