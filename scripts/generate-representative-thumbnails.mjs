import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = process.cwd();
const report = JSON.parse(await readFile(path.join(root, 'production/reports/representative-six-technical.json'), 'utf8'));

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

for (const evidence of report.images) {
  const source = PNG.sync.read(await readFile(path.join(root, evidence.path)));
  const thumbnail = resizeNearest(source, 96, 96);
  const outputPath = path.join(root, evidence.thumbnailPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, PNG.sync.write(thumbnail));
}

console.log(JSON.stringify({ generated: report.images.length, size: '96x96', method: 'nearest-neighbor' }, null, 2));
