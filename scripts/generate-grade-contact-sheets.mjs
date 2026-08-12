import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = process.cwd();
const catalog = JSON.parse(await readFile(path.join(root, 'production/catalog/creatures.json'), 'utf8'));
const output = path.join(root, 'production/reports/grade-contact-sheets');
await mkdir(output, { recursive: true });

const glyphs = {
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
};

function pixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 4;
  image.data.set(color, at);
}

function label(image, text, x, y, scale = 4) {
  for (const character of text) {
    const glyph = glyphs[character];
    if (!glyph) { x += scale * 6; continue; }
    glyph.forEach((row, rowIndex) => [...row].forEach((value, columnIndex) => {
      if (value !== '1') return;
      for (let yy = 0; yy < scale; yy += 1) for (let xx = 0; xx < scale; xx += 1) {
        pixel(image, x + columnIndex * scale + xx, y + rowIndex * scale + yy, [232, 238, 248, 255]);
      }
    }));
    x += scale * 6;
  }
}

function drawContain(destination, source, left, top, boxWidth, boxHeight) {
  const scale = Math.min(boxWidth / source.width, boxHeight / source.height);
  const width = Math.round(source.width * scale), height = Math.round(source.height * scale);
  const startX = left + Math.floor((boxWidth - width) / 2), startY = top + Math.floor((boxHeight - height) / 2);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
    const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
    const sourceAt = (sourceY * source.width + sourceX) * 4;
    const alpha = source.data[sourceAt + 3] / 255;
    if (alpha === 0) continue;
    const destinationAt = ((startY + y) * destination.width + startX + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      destination.data[destinationAt + channel] = Math.round(source.data[sourceAt + channel] * alpha + destination.data[destinationAt + channel] * (1 - alpha));
    }
    destination.data[destinationAt + 3] = 255;
  }
}

for (const rarity of ['ORACLE', 'ARCHITECT', 'ORIGIN']) {
  const creatures = catalog.filter((creature) => creature.rarity === rarity);
  const columns = rarity === 'ORIGIN' ? 3 : 4;
  const cellWidth = 260, cellHeight = 290, rows = Math.ceil(creatures.length / columns);
  const sheet = new PNG({ width: columns * cellWidth, height: rows * cellHeight, colorType: 6 });
  for (let offset = 0; offset < sheet.data.length; offset += 4) sheet.data.set([10, 17, 29, 255], offset);
  for (const [index, creature] of creatures.entries()) {
    const source = PNG.sync.read(await readFile(path.join(root, `assets/creatures/mobile/${creature.id}.png`)));
    const left = index % columns * cellWidth, top = Math.floor(index / columns) * cellHeight;
    drawContain(sheet, source, left + 10, top + 4, cellWidth - 20, 235);
    label(sheet, creature.id, left + 50, top + 248, 4);
  }
  await writeFile(path.join(output, `${rarity.toLowerCase()}.png`), PNG.sync.write(sheet));
  console.log(`${rarity}: ${creatures.length}`);
}
