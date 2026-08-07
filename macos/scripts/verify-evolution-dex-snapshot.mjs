import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const imagePath = process.argv[2];
if (!imagePath) throw new Error('snapshot PNG path is required');

const image = PNG.sync.read(await readFile(imagePath));
if (image.width !== 372 || image.height !== 620) {
  throw new Error(`expected 372x620, got ${image.width}x${image.height}`);
}

function countPixels(rect, predicate) {
  let count = 0;
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (predicate(
        image.data[offset],
        image.data[offset + 1],
        image.data[offset + 2],
        image.data[offset + 3],
      )) count += 1;
    }
  }
  return count;
}

const stageThree = { left: 0, top: 365, right: 190, bottom: 535 };
const footer = { left: 0, top: 535, right: 372, bottom: 620 };
const isBright = (red, green, blue, alpha) => alpha > 200 && Math.max(red, green, blue) > 125;
const isCyan = (red, green, blue, alpha) =>
  alpha > 200 && green > 110 && blue > 130 && blue > red * 1.25;
const isLime = (red, green, blue, alpha) =>
  alpha > 200 && green > 170 && red > 100 && blue < 140;

const metrics = {
  stageThreeBright: countPixels(stageThree, isBright),
  stageThreeCyan: countPixels(stageThree, isCyan),
  stageThreeCurrentBadge: countPixels(stageThree, isLime),
  footerCyan: countPixels(footer, isCyan),
};

const failures = [];
if (metrics.stageThreeBright < 1_000) failures.push('stage 3 card content is missing or clipped');
if (metrics.stageThreeCyan < 30) failures.push('stage 3 creature/path accent is missing');
if (metrics.stageThreeCurrentBadge < 30) failures.push('current-creature badge is missing');
if (metrics.footerCyan < 100) failures.push('current evolution footer is missing or clipped');

if (failures.length > 0) {
  throw new Error(`${failures.join('; ')} (${JSON.stringify(metrics)})`);
}

console.log(JSON.stringify({ ok: true, metrics }));
