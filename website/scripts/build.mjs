import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const entries = ['index.html', 'en', 'assets', 'styles.css', 'script.js', '.nojekyll'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of entries) {
  await cp(join(root, entry), join(output, entry), { recursive: true });
}

const cname = (await readFile(join(root, 'CNAME'), 'utf8').catch(() => '')).trim();
if (cname) await writeFile(join(output, 'CNAME'), `${cname}\n`);

console.log(`Built PunchGrow website → ${output}`);
