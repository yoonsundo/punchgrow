import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const masterRoot = path.join(root, 'assets/creatures/redesign-v2/generated');
const mobileRoot = path.join(root, 'assets/creatures/redesign-v2/mobile');
const output = path.join(root, 'production/manifests/creature-asset-packs/cute-redesign-v2-progress.json');

const ids = (await readdir(masterRoot))
  .filter((file) => /^PG-\d{3}\.png$/.test(file))
  .map((file) => file.slice(0, 6))
  .sort();

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');
const entries = [];
for (const id of ids) {
  const master = await readFile(path.join(masterRoot, `${id}.png`));
  const mobile = await readFile(path.join(mobileRoot, `${id}.png`));
  entries.push({
    id,
    masterPath: `assets/creatures/redesign-v2/generated/${id}.png`,
    masterSha256: sha256(master),
    mobilePath: `assets/creatures/redesign-v2/mobile/${id}.png`,
    mobileSha256: sha256(mobile),
  });
}

const progress = {
  schemaVersion: 1,
  packId: 'cute-redesign-v2',
  generatedCount: entries.length,
  remainingCount: 240 - entries.length,
  firstMissingId: Array.from({ length: 240 }, (_, index) => `PG-${String(index + 1).padStart(3, '0')}`)
    .find((id) => !ids.includes(id)) ?? null,
  entries,
};

await writeFile(output, `${JSON.stringify(progress, null, 2)}\n`);
console.log(JSON.stringify({ generated: entries.length, remaining: progress.remainingCount, firstMissingId: progress.firstMissingId }));
