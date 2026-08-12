import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const catalogDir = path.resolve('production', 'catalog');
const sourceFiles = [
  'creatures-001-080.json',
  'creatures-081-160.json',
  'creatures-161-240.json',
  'creatures-241-256.json',
];

const chunks = [];
for (const filename of sourceFiles) {
  const filePath = path.join(catalogDir, filename);
  const entries = JSON.parse(await readFile(filePath, 'utf8'));

  for (const entry of entries) {
    entry.imagePath = `assets/creatures/generated/${entry.id}.png`;
  }

  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`);
  chunks.push(entries);
}

const catalog = chunks.flat().sort((a, b) => a.id.localeCompare(b.id));
await writeFile(
  path.join(catalogDir, 'creatures.json'),
  `${JSON.stringify(catalog, null, 2)}\n`,
);

console.log(JSON.stringify({ updated: catalog.length, first: catalog[0]?.id, last: catalog.at(-1)?.id }, null, 2));
