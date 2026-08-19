import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(websiteRoot, '..');
const root = join(websiteRoot, 'dist');
const failures = [];
const release = {
  version: '0.4.0',
  creatures: 256,
  sha256: '2cdc59e41713d236e3ebdc049c057463c272e67562869d0694aa27682fb3cd12',
  caskUrl: 'https://github.com/yoonsundo/punchgrow/releases/download/v#{version}/PunchGrow-#{version}-arm64.zip',
  homepage: 'https://punchgrow.thundo.kr/',
};
const homebrewCommands = [
  'brew tap yoonsundo/punchgrow https://github.com/yoonsundo/punchgrow',
  'brew trust yoonsundo/punchgrow',
  'brew install --cask punchgrow',
  'xattr -d com.apple.quarantine /Applications/PunchGrow.app',
].join('\n');

const exists = async (path) => access(path).then(() => true).catch(() => false);
if (!(await exists(root))) failures.push('dist/ is missing; run npm run build first');

const caskPath = join(repositoryRoot, 'Casks', 'punchgrow.rb');
if (!(await exists(caskPath))) {
  failures.push('root Casks/punchgrow.rb is missing');
} else {
  const cask = await readFile(caskPath, 'utf8');
  const caskName = cask.match(/^cask "([^"]+)" do$/m)?.[1];
  const version = cask.match(/^  version "([^"]+)"$/m)?.[1];
  const sha256 = cask.match(/^  sha256 "([a-f0-9]{64})"$/m)?.[1];
  const url = cask.match(/^  url "([^"]+)"$/m)?.[1];
  const homepage = cask.match(/^  homepage "([^"]+)"$/m)?.[1];
  if (caskName !== 'punchgrow') failures.push(`cask name must be punchgrow, received ${caskName ?? 'missing'}`);
  if (version !== release.version) failures.push(`cask version must be ${release.version}, received ${version ?? 'missing'}`);
  if (sha256 !== release.sha256) failures.push(`cask sha256 must match the v${release.version} release asset`);
  if (url !== release.caskUrl) failures.push(`cask URL must derive the v${release.version} arm64 release asset from version`);
  if (homepage !== release.homepage) failures.push('cask homepage must use the official HTTPS website');
  if (!cask.includes(`${release.creatures}-creature catalog`)) {
    failures.push('cask caveat must state the 256-creature v0.4.0 release catalog');
  }
}

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
  const required = ['index.html', '404.html', 'en/index.html', 'dex/index.html', 'en/dex/index.html', 'styles.css', 'script.js', 'dex.js', 'data/creatures.json', '.nojekyll', 'CNAME'];
  for (const path of required) {
    if (!(await exists(join(root, path)))) failures.push(`missing required output: ${path}`);
  }

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
      let target = pathname
        ? resolve(pathname.startsWith('/') ? root : dirname(file), decodeURIComponent(pathname).replace(/^\/+/, ''))
        : file;
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

  const sourceText = await Promise.all(['index.html', 'en/index.html'].map((path) => readFile(join(root, path), 'utf8')));
  for (const id of ['experience', 'origins', 'privacy', 'open-source', 'install']) {
    if (!sourceText.every((html) => html.includes(`id="${id}"`))) failures.push(`locale parity: #${id} missing from a page`);
  }
  for (const [index, html] of sourceText.entries()) {
    const locale = index === 0 ? 'ko' : 'en';
    const commandBlock = html.match(new RegExp(`<pre id="brew-${locale}"><code>([\\s\\S]*?)<\\/code><\\/pre>`))?.[1].replace(/\r\n/g, '\n').trim();
    if (commandBlock !== homebrewCommands) {
      failures.push(`${locale} homepage Homebrew commands must exactly match the published tap, trust, install, and quarantine contract`);
    }
  }
  const readmes = await Promise.all(['README.md', 'README.en.md'].map((path) => readFile(join(repositoryRoot, path), 'utf8')));
  const dexScript = await readFile(join(root, 'dex.js'), 'utf8');
  if (/style\s*=/.test(dexScript)) {
    failures.push('dex.js must not generate inline styles that the static-site CSP blocks');
  }
  const releaseTruthClaims = [
    [sourceText[0], 'Homebrew v0.4.0 릴리스와 현재 <code>main</code> 소스·공개 도감에는 모두 64개 시작 계보·256종', 'ORIGIN 도달 계보 7/64(약 10.9%)', 'Korean homepage'],
    [sourceText[1], 'Homebrew v0.4.0, current <code>main</code>, and the public dex all contain 64 starting lineages and 256 creatures', '7 of 64 lineages (about 10.9%) able to reach ORIGIN', 'English homepage'],
  ];
  for (const [contents, releasedClaim, currentClaim, label] of releaseTruthClaims) {
    if (!contents.includes(releasedClaim) || !contents.includes(currentClaim)) {
      failures.push(`${label} must state the shared v0.4.0 release and current-main 64-lineage/256-creature contract`);
    }
  }
  const readmeReleaseTruthClaims = [
    [readmes[0], /\*\*2026-08-18 Homebrew 릴리스\*\*[\s\S]{0,120}64개 시작 계보 · 256종/, /\*\*현재 소스·공개 도감\*\*[\s\S]{0,120}64개 시작 계보 · 256종/, 'Korean README'],
    [readmes[1], /\*\*2026-08-18 Homebrew release\*\*[\s\S]{0,140}64 starting lineages · 256 creatures/, /\*\*Current source and public dex\*\*[\s\S]{0,140}64 starting lineages · 256 creatures/, 'English README'],
  ];
  for (const [contents, releasedClaim, currentClaim, label] of readmeReleaseTruthClaims) {
    if (!releasedClaim.test(contents) || !currentClaim.test(contents)) {
      failures.push(`${label} must state the shared v0.4.0 release and current-main 64-lineage/256-creature contract`);
    }
  }
  if (!sourceText.every((html) => html.includes('hreflang="x-default"') && html.includes('property="og:image"'))) {
    failures.push('homepage metadata contract must include x-default and Open Graph images in both locales');
  }
  if ((await readFile(join(root, 'CNAME'), 'utf8')).trim() !== 'punchgrow.thundo.kr') {
    failures.push('CNAME must contain punchgrow.thundo.kr');
  }
  const dex = JSON.parse(await readFile(join(root, 'data', 'creatures.json'), 'utf8'));
  if (dex.length !== 256 || new Set(dex.map((creature) => creature.id)).size !== 256) {
    failures.push('creature dex data must contain exactly 256 unique creatures');
  }
  const startingLineages = dex.filter((creature) => creature.category === 'start');
  const fusionCollectibles = dex.filter((creature) => creature.category === 'mixed');
  if (startingLineages.length !== 64 || new Set(startingLineages.map((creature) => creature.lineageId)).size !== 64) {
    failures.push('creature dex must contain exactly 64 unique starting lineages');
  }
  if (fusionCollectibles.length !== 10) {
    failures.push('creature dex must contain exactly 10 fusion collectibles');
  }
  const dexPages = await Promise.all(['dex/index.html', 'en/dex/index.html'].map((path) => readFile(join(root, path), 'utf8')));
  const dexClaims = [
    ['64개 시작 계보', '10종의 퓨전 수집종', '전체 256종'],
    ['64 starting lineages', '10 fusion collectibles', '256 creatures in total'],
  ];
  dexPages.forEach((html, index) => {
    const locale = index === 0 ? 'ko' : 'en';
    if (!dexClaims[index].every((claim) => html.includes(claim))) failures.push(`${locale} dex must state the 64 lineage, 10 fusion collectible, and 256 creature contract`);
    if (!/<noscript>[\s\S]*class="dex-fallback"[\s\S]*production\/catalog\/creatures\.json[\s\S]*<\/noscript>/.test(html)) {
      failures.push(`${locale} dex must include a meaningful localized no-script fallback and source catalog route`);
    }
  });
  if (!dexScript.includes("visible.filter((lineage) => lineage.maxGrade !== 'FUSION')") || !dexScript.includes('copy.fusionCollectibles')) {
    failures.push('dex result semantics must count fusion collectibles separately from lineages');
  }
  if (!dexScript.includes("loadError: 'The creature data could not be loaded.") || !dexScript.includes("loadError: '크리처 데이터를 불러오지 못했습니다.")) {
    failures.push('dex fetch failure must have localized Korean and English copy');
  }
  const stylesheet = await readFile(join(root, 'styles.css'), 'utf8');
  if (!stylesheet.includes('html:not(.js) .dex-controls, html:not(.js) .dex-result { display: none; }')) {
    failures.push('no-script dex must hide inactive controls and the indefinite loading status');
  }
  for (const creature of dex) {
    if (!(await exists(join(root, creature.image.replace(/^\.\.\//, ''))))) {
      failures.push(`missing creature image for ${creature.id}`);
    }
  }
  if (sourceText.some((html) => /Developer ID[- ]signed|Apple[- ]notarized (?:download|release) available/i.test(html))) {
    failures.push('unsupported notarized binary availability claim found');
  }
}

if (failures.length > 0) {
  console.error(`Website validation failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Website validation passed: release cask, install commands, dex semantics, locales, assets, fragments, and metadata are valid.');
}
