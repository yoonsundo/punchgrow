import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const report = JSON.parse(
  await readFile(path.join(root, 'production/reports/cute-redesign-v2-visual-qa.json'), 'utf8'),
);
const batches = JSON.parse(await readFile(path.join(root, report.batchEvidence), 'utf8'));
const covered = new Set();

for (const artifact of batches.visualArtifacts) {
  const contents = await readFile(path.join(root, artifact.path));
  const digest = createHash('sha256').update(contents).digest('hex');
  if (digest !== artifact.sha256) {
    throw new Error(`${artifact.path}: visual evidence SHA-256 mismatch`);
  }
}

for (const batch of batches.batches) {
  if (batch.verdict !== 'pass' || batch.minimumScore < report.acceptanceThreshold) {
    throw new Error(`${batch.id}: visual QA batch did not pass`);
  }
  for (let number = batch.first; number <= batch.last; number += 1) {
    covered.add(`PG-${String(number).padStart(3, '0')}`);
  }
}

for (const entry of report.entries) {
  if (!covered.has(entry.id) || entry.verdict !== 'pass' || entry.certifiedScoreFloor < 90) {
    throw new Error(`${entry.id}: visual QA evidence is incomplete`);
  }
}

if (report.reviewedCount !== 240 || covered.size !== 240 || report.failures.length > 0) {
  throw new Error('cute-redesign-v2 visual QA ledger is incomplete');
}

console.log(JSON.stringify({ packId: report.packId, batches: batches.batches.length, reviewed: covered.size }));
