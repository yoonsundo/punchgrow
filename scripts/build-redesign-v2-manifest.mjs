import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(
  root,
  'production',
  'manifests',
  'creature-asset-packs',
  'cute-redesign-v2.json',
);
const current = JSON.parse(await readFile(manifestPath, 'utf8'));
const visualQaPath = 'production/reports/cute-redesign-v2-visual-qa.json';
const visualQa = JSON.parse(await readFile(path.join(root, visualQaPath), 'utf8'));
const batchEvidence = JSON.parse(await readFile(path.join(root, visualQa.batchEvidence), 'utf8'));
const entries = [];
const coveredByBatch = new Set();

for (const artifact of batchEvidence.visualArtifacts ?? []) {
  const contents = await readFile(path.join(root, artifact.path));
  const digest = createHash('sha256').update(contents).digest('hex');
  if (digest !== artifact.sha256) {
    throw new Error(`${artifact.path}: visual evidence SHA-256 mismatch`);
  }
}

for (const batch of batchEvidence.batches ?? []) {
  if (batch.verdict !== 'pass' || batch.minimumScore < visualQa.acceptanceThreshold) {
    throw new Error(`${batch.id}: visual QA batch did not pass`);
  }
  for (let number = batch.first; number <= batch.last; number += 1) {
    coveredByBatch.add(`PG-${String(number).padStart(3, '0')}`);
  }
}

if (
  visualQa.packId !== 'cute-redesign-v2'
  || visualQa.acceptanceThreshold < 90
  || visualQa.reviewedCount !== 240
  || visualQa.failures.length > 0
  || coveredByBatch.size !== 240
) {
  throw new Error('cute-redesign-v2 visual QA gate is incomplete');
}

const approvals = new Map(visualQa.entries.map((entry) => [entry.id, entry]));
const representativeCandidates = [];

for (const candidate of current.representativeCandidates ?? []) {
  const contents = await readFile(path.join(root, candidate.path));
  representativeCandidates.push({
    ...candidate,
    sha256: createHash('sha256').update(contents).digest('hex'),
  });
}

for (let number = 1; number <= 240; number += 1) {
  const id = `PG-${String(number).padStart(3, '0')}`;
  const pathFor = (variant) => `assets/creatures/redesign-v2/${variant}/${id}.png`;
  const masterPath = pathFor('generated');
  const mobilePath = pathFor('mobile');
  const master = await readFile(path.join(root, masterPath));
  const mobile = await readFile(path.join(root, mobilePath));
  const masterInfo = await stat(path.join(root, masterPath));
  const mobileInfo = await stat(path.join(root, mobilePath));
  const approval = approvals.get(id);
  if (!coveredByBatch.has(id) || approval?.verdict !== 'pass' || approval.certifiedScoreFloor < 90) {
    throw new Error(`${id}: missing passing visual QA evidence`);
  }

  entries.push({
    id,
    path: masterPath,
    bytes: masterInfo.size,
    sha256: createHash('sha256').update(master).digest('hex'),
    mobilePath,
    mobileBytes: mobileInfo.size,
    mobileSha256: createHash('sha256').update(mobile).digest('hex'),
    deploymentPaths: {
      catalog: `assets/creatures/generated/${id}.png`,
      mobile: `assets/creatures/mobile/${id}.png`,
      macos: `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${id}.png`,
    },
    visualStatus: 'approved',
  });
}

const manifest = {
  ...current,
  status: 'active',
  activationAllowed: true,
  activationBlockers: [],
  visualQaReport: visualQaPath,
  representativeCandidates,
  entries,
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const globalQaReport = {
  schemaVersion: 2,
  activePack: manifest.packId,
  artDirectionRevision: manifest.artDirectionRevision,
  masterRoot: manifest.masterRoot,
  mobileRoot: manifest.mobileRoot,
  visualQaReport: visualQaPath,
  summary: {
    masters: entries.length,
    mobileDerivatives: entries.length,
    visualQaPassed: visualQa.reviewedCount,
    failures: visualQa.failures.length,
    minimumVisualScore: visualQa.acceptanceThreshold,
  },
  status: 'passed',
};
await writeFile(
  path.join(root, 'production', 'reports', 'global-image-qa.json'),
  `${JSON.stringify(globalQaReport, null, 2)}\n`,
);
console.log(JSON.stringify({ packId: manifest.packId, status: manifest.status, entries: entries.length }));
