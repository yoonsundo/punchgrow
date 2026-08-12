import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = process.cwd();
const catalog = JSON.parse(await readFile(path.join(root, 'production/catalog/creatures.json'), 'utf8'));
const report = JSON.parse(await readFile(path.join(root, 'production/reports/representative-six-technical.json'), 'utf8'));
const packageText = await readFile(path.join(root, '문서/CREATURE_REPRESENTATIVE_SIX_PACKAGES.md'), 'utf8');
const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
const errors = [];
const expectedGrades = ['PROCESS', 'AGENT', 'DAEMON', 'ORACLE', 'ARCHITECT', 'ORIGIN'];
const seenIds = new Set();

function hasChunk(source, expectedType) {
  for (let offset = 8; offset + 12 <= source.length;) {
    const length = source.readUInt32BE(offset);
    const type = source.toString('ascii', offset + 4, offset + 8);
    if (type === expectedType) return true;
    offset += 12 + length;
  }
  return false;
}

function resizeNearest(source, width, height) {
  const output = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / width));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      source.data.copy(output.data, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return output;
}

for (const [index, evidence] of report.images.entries()) {
  if (seenIds.has(evidence.id)) errors.push(`${evidence.id}: duplicate representative ID`);
  seenIds.add(evidence.id);
  const creature = catalogById.get(evidence.id);
  if (!creature) {
    errors.push(`${evidence.id}: missing catalog entry`);
    continue;
  }
  if (creature.rarity !== expectedGrades[index]) {
    errors.push(`${evidence.id}: expected representative grade ${expectedGrades[index]}, got ${creature.rarity}`);
  }
  const source = await readFile(path.join(root, creature.imagePath));
  const image = PNG.sync.read(source);
  const thumbnail = PNG.sync.read(await readFile(path.join(root, evidence.thumbnailPath)));
  const hash = createHash('sha256').update(source).digest('hex');
  if (image.width !== 2048 || image.height !== 2048 || image.colorType !== 6 || !image.alpha) {
    errors.push(`${evidence.id}: representative image must be 2048x2048 RGBA`);
  }
  if (!hasChunk(source, 'sRGB')) errors.push(`${evidence.id}: missing PNG sRGB chunk`);
  if (thumbnail.width !== 96 || thumbnail.height !== 96 || thumbnail.colorType !== 6 || !thumbnail.alpha) {
    errors.push(`${evidence.id}: thumbnail must be 96x96 RGBA`);
  }
  const expectedThumbnail = resizeNearest(image, 96, 96);
  if (!thumbnail.data.equals(expectedThumbnail.data)) errors.push(`${evidence.id}: thumbnail is not a direct nearest-neighbor resize`);
  if (hash !== evidence.sha256) errors.push(`${evidence.id}: stale SHA-256 evidence`);
  if (evidence.colorSpaceTag !== 'sRGB') errors.push(`${evidence.id}: stale color-space evidence`);
  const sectionStart = packageText.indexOf(`## ${index + 1}.`);
  const sectionEnd = packageText.indexOf('\n---', sectionStart);
  const section = packageText.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  for (const color of Object.values(creature.palette)) {
    if (!section.includes(color)) errors.push(`${evidence.id}: representative section omits catalog palette color ${color}`);
  }
}

if (report.verdict !== 'PASS') errors.push(`technical report verdict must be PASS`);
if (report.images.length !== 6) errors.push(`expected 6 representative entries, got ${report.images.length}`);
if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, representatives: report.images.length }, null, 2));
