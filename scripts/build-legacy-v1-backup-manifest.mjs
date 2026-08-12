import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const images = [];

for (let number = 1; number <= 240; number += 1) {
  const id = `PG-${String(number).padStart(3, '0')}`;
  const assetPath = `assets/creatures/legacy-v1/generated/${id}.png`;
  const absolutePath = path.join(root, assetPath);
  const mobilePath = `assets/creatures/legacy-v1/mobile/${id}.png`;
  const mobileContents = await readFile(path.join(root, mobilePath));
  const contents = await readFile(absolutePath);
  const info = await stat(absolutePath);
  images.push({
    id,
    path: assetPath,
    bytes: info.size,
    sha256: createHash('sha256').update(contents).digest('hex'),
    mobilePath,
    mobileSha256: createHash('sha256').update(mobileContents).digest('hex'),
  });
}

const manifest = {
  generatedAt: new Date().toISOString(),
  count: images.length,
  missing: [],
  images,
};

const output = path.join(root, 'production', 'manifests', 'legacy-v1-image-manifest.json');
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ packId: 'legacy-v1', images: images.length }));
