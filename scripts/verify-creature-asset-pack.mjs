import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const registry = JSON.parse(await readFile(path.join(root, 'config/creature-assets.json'), 'utf8'));
const packId = process.argv[2] ?? registry.activePack;
const sourceOnly = process.argv.includes('--source-only');
const manifestPath = path.join(root, 'production/manifests/creature-asset-packs', `${packId}.json`);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = [];

if (manifest.activationAllowed && manifest.visualQaReport) {
  try {
    const visualQa = JSON.parse(await readFile(path.join(root, manifest.visualQaReport), 'utf8'));
    const approvals = new Map((visualQa.entries ?? []).map((entry) => [entry.id, entry]));
    const batchEvidence = JSON.parse(await readFile(path.join(root, visualQa.batchEvidence), 'utf8'));
    const covered = new Set();
    for (const artifact of batchEvidence.visualArtifacts ?? []) {
      const contents = await readFile(path.join(root, artifact.path));
      const digest = createHash('sha256').update(contents).digest('hex');
      if (digest !== artifact.sha256) {
        errors.push(`${artifact.path}: visual evidence SHA-256 mismatch`);
      }
    }
    for (const batch of batchEvidence.batches ?? []) {
      if (batch.verdict !== 'pass' || batch.minimumScore < visualQa.acceptanceThreshold) {
        errors.push(`${batch.id}: visual QA batch did not pass`);
      }
      for (let number = batch.first; number <= batch.last; number += 1) {
        covered.add(`PG-${String(number).padStart(3, '0')}`);
      }
    }
    if (visualQa.packId !== packId || visualQa.reviewedCount !== 240 || visualQa.failures?.length > 0) {
      errors.push('visual QA report is incomplete');
    }
    for (const entry of manifest.entries ?? []) {
      const approval = approvals.get(entry.id);
      if (!covered.has(entry.id) || approval?.verdict !== 'pass' || approval.certifiedScoreFloor < 90) {
        errors.push(`${entry.id}: visual QA approval missing`);
      }
    }
  } catch (error) {
    errors.push(`missing visual QA report (${error.message})`);
  }
}

if (manifest.packId !== packId) {
  errors.push(`packId mismatch: ${manifest.packId}`);
}

if (manifest.licenseRef !== 'ASSET-LICENSE.md') {
  errors.push('licenseRef must be ASSET-LICENSE.md');
}

if (manifest.activationAllowed && !['qa-passed', 'active'].includes(manifest.status)) {
  errors.push('activationAllowed requires qa-passed or active status');
}

let activeEntryCount = manifest.entries?.length;
let activeEntries = manifest.entries;
if (activeEntryCount === undefined && manifest.technicalManifest) {
  const technicalManifest = JSON.parse(await readFile(path.join(root, manifest.technicalManifest), 'utf8'));
  activeEntries = technicalManifest.entries ?? technicalManifest.images;
  activeEntryCount = activeEntries?.length;
}

if (manifest.activationAllowed && activeEntryCount !== 240) {
  errors.push(`active pack requires 240 entries, found ${activeEntryCount ?? 0}`);
}

if (manifest.activationAllowed) {
  for (const entry of activeEntries ?? []) {
    try {
      const file = path.join(root, entry.path);
      const contents = await readFile(file);
      const digest = createHash('sha256').update(contents).digest('hex');
      if (digest !== entry.sha256) {
        errors.push(`${entry.id}: active asset SHA-256 mismatch`);
      }
      const image = PNG.sync.read(contents);
      if (image.width !== image.height || image.width < 1024) {
        errors.push(`${entry.id}: master must be square and at least 1024px`);
      }
    } catch (error) {
      errors.push(`${entry.id}: missing active asset (${error.message})`);
    }

    if (entry.mobilePath || entry.mobileSha256) {
      try {
        const mobileFile = path.join(root, entry.mobilePath);
        const mobileContents = await readFile(mobileFile);
        const mobileDigest = createHash('sha256').update(mobileContents).digest('hex');
        if (mobileDigest !== entry.mobileSha256) {
          errors.push(`${entry.id}: mobile asset SHA-256 mismatch`);
        }
        const mobileImage = PNG.sync.read(mobileContents);
        if (mobileImage.width !== 360 || mobileImage.height !== 360) {
          errors.push(`${entry.id}: mobile asset must be 360x360`);
        }
      } catch (error) {
        errors.push(`${entry.id}: missing mobile asset (${error.message})`);
      }
    }

    for (const [target, deploymentPath] of sourceOnly ? [] : Object.entries(entry.deploymentPaths ?? {})) {
      try {
        const deployed = await readFile(path.join(root, deploymentPath));
        const expected = target === 'catalog' ? entry.sha256 : entry.mobileSha256;
        const deployedDigest = createHash('sha256').update(deployed).digest('hex');
        if (deployedDigest !== expected) {
          errors.push(`${entry.id}: ${target} deployment SHA-256 mismatch`);
        }
      } catch (error) {
        errors.push(`${entry.id}: missing ${target} deployment (${error.message})`);
      }
    }
  }
}

for (const candidate of manifest.representativeCandidates ?? []) {
  const file = path.join(root, candidate.path);
  try {
    if (!(await stat(file)).isFile()) {
      throw new Error('not a file');
    }

    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (digest !== candidate.sha256) {
      errors.push(`${candidate.id}: SHA-256 mismatch`);
    }
  } catch (error) {
    errors.push(`${candidate.id}: missing candidate (${error.message})`);
  }
}

const result = {
  packId,
  status: manifest.status,
  activationAllowed: manifest.activationAllowed,
  activeEntryCount: activeEntryCount ?? null,
  representativeCandidates: manifest.representativeCandidates?.length ?? 0,
  errors,
};

console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) {
  process.exitCode = 1;
}
