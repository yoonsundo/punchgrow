import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const catalogPath = path.join(root, 'production', 'catalog', 'creatures.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const generatedDir = path.join(root, 'assets', 'creatures', 'generated');
const availableFilenames = new Set(await readdir(generatedDir));
const images = [];
const missing = [];

for (const creature of catalog) {
  const filename = path.basename(creature.imagePath);
  if (!availableFilenames.has(filename)) {
    missing.push(creature.id);
    continue;
  }
  const absolutePath = path.join(generatedDir, filename);
  const data = await readFile(absolutePath);
  const info = await stat(absolutePath);
  images.push({
    id: creature.id,
    path: creature.imagePath,
    bytes: info.size,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
}

const manifest = {
  generatedAt: new Date().toISOString(),
  count: images.length,
  missing,
  images,
};
await writeFile(
  path.join(root, 'production', 'manifests', 'image-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify({ catalog: catalog.length, images: images.length, missing: missing.length }, null, 2));
if (missing.length > 0) {
  process.exit(1);
}
