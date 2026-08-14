import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const entries = ['index.html', '404.html', 'en', 'dex', 'assets', 'styles.css', 'script.js', 'dex.js', '.nojekyll', 'CNAME'];
const catalogPath = join(root, '..', 'production', 'catalog', 'creatures.json');
const mobileCreaturesPath = join(root, '..', 'assets', 'creatures', 'mobile');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of entries) {
  await cp(join(root, entry), join(output, entry), { recursive: true });
}

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (catalog.length !== 256) throw new Error(`Expected 256 creatures, received ${catalog.length}`);

await mkdir(join(output, 'data'), { recursive: true });
await writeFile(
  join(output, 'data', 'creatures.json'),
  `${JSON.stringify(catalog.map(({ id, koName, enName, lineageId, stage, rarity, category, evolutionFrom, bodyForm, tone, identity, lore, shapeDNA, sharedMotifs, palette }) => ({
    id, koName, enName, lineageId, stage, rarity, category, evolutionFrom, bodyForm, tone, identity, lore, shapeDNA, sharedMotifs, palette,
    image: `assets/creatures/${id}.png`,
  })))}\n`,
);
await cp(mobileCreaturesPath, join(output, 'assets', 'creatures'), { recursive: true });

console.log(`Built PunchGrow website → ${output}`);
