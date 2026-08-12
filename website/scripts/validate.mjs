import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(websiteRoot, 'dist');
const failures = [];

const exists = async (path) => access(path).then(() => true).catch(() => false);
if (!(await exists(root))) failures.push('dist/ is missing; run npm run build first');

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
};

if (failures.length === 0) {
  const required = ['index.html', 'en/index.html', 'styles.css', 'script.js', 'CNAME', '.nojekyll'];
  for (const path of required) {
    if (!(await exists(join(root, path)))) failures.push(`missing required output: ${path}`);
  }

  const cname = await readFile(join(root, 'CNAME'), 'utf8').catch(() => '');
  if (cname.trim() !== 'punchgrow.thundo.kr') failures.push('CNAME does not contain punchgrow.thundo.kr');

  const htmlFiles = (await walk(root)).filter((path) => extname(path) === '.html');
  const idsByFile = new Map();
  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    const relative = file.slice(root.length + 1);
    if (!/^<!doctype html>/i.test(html)) failures.push(`${relative}: missing HTML doctype`);
    if (!/<html\s+lang="(?:ko|en)"/.test(html)) failures.push(`${relative}: missing supported lang attribute`);
    if (!/<meta\s+name="viewport"/.test(html)) failures.push(`${relative}: missing viewport meta`);
    if (!/<title>[^<]+<\/title>/.test(html)) failures.push(`${relative}: missing title`);
    if (!/<main\s+id="main"/.test(html)) failures.push(`${relative}: missing main landmark`);
    if (!/<h1[\s>]/.test(html)) failures.push(`${relative}: missing h1`);
    idsByFile.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));

    for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const ref = match[1];
      if (/^(?:https?:|mailto:|data:)/.test(ref)) continue;
      const [pathname, fragment] = ref.split('#');
      let target = pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : file;
      if (pathname?.endsWith('/')) target = join(target, 'index.html');
      if (pathname && !(await exists(target))) failures.push(`${relative}: broken reference ${ref}`);
      if (fragment) {
        const targetHtml = extname(target) === '.html' ? target : join(target, 'index.html');
        if (await exists(targetHtml)) {
          let ids = idsByFile.get(targetHtml);
          if (!ids) {
            const targetContents = await readFile(targetHtml, 'utf8');
            ids = new Set([...targetContents.matchAll(/\sid="([^"]+)"/g)].map((item) => item[1]));
            idsByFile.set(targetHtml, ids);
          }
          if (!ids.has(decodeURIComponent(fragment))) failures.push(`${relative}: missing fragment target ${ref}`);
        }
      }
    }
  }

  const sourceText = await Promise.all(htmlFiles.map((path) => readFile(path, 'utf8')));
  for (const id of ['experience', 'origins', 'privacy', 'install']) {
    if (!sourceText.every((html) => html.includes(`id="${id}"`))) failures.push(`locale parity: #${id} missing from a page`);
  }
  if (sourceText.some((html) => /brew install|Homebrew로 설치|notarized (?:download|release) available/i.test(html))) {
    failures.push('unsupported binary/Homebrew availability claim found');
  }
}

if (failures.length > 0) {
  console.error(`Website validation failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Website validation passed: locales, assets, fragments, metadata, and CNAME are valid.');
}
