import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = process.cwd();
const catalogPath = path.join(root, 'production', 'catalog', 'creatures.json');
const reportPath = path.join(root, 'production', 'reports', 'global-image-qa.json');
const contactSheetDir = path.join(root, 'production', 'reports', 'contact-sheets');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const expectedWidth = 2048;
const expectedHeight = 2048;
const coverageMinimum = 0.08;
const coverageMaximum = 0.70;
const minimumEdgeMargin = 64;
const paletteAlphaThreshold = 128;
const paletteNearDistance = 45;
const paletteMaximumDistance = 60;
const minimumPalettePixels = 100;
const minimumPalettePixelRatio = 0.0001;

const missing = [];
const decodeErrors = [];
const wrongDimensions = [];
const wrongModes = [];
const opaqueCornersOrNoAlpha = [];
const missingSrgbTag = [];
const extremeCoverage = [];
const insufficientEdgeMargins = [];
const paletteColorDrift = [];
const catalogPathMismatches = [];
const hashes = new Map();
let decodedCount = 0;
let minimumCoverage = Number.POSITIVE_INFINITY;
let maximumCoverage = Number.NEGATIVE_INFINITY;

function hasPngChunk(source, expectedType) {
  for (let offset = 8; offset + 12 <= source.length;) {
    const length = source.readUInt32BE(offset);
    const type = source.toString('ascii', offset + 4, offset + 8);
    if (type === expectedType) {
      return true;
    }
    offset += 12 + length;
  }
  return false;
}

for (const creature of catalog) {
  const expectedPath = `assets/creatures/generated/${creature.id}.png`;
  if (creature.imagePath !== expectedPath) {
    catalogPathMismatches.push({ id: creature.id, expected: expectedPath, actual: creature.imagePath });
  }
  let source;
  try {
    source = await readFile(path.join(root, expectedPath));
  } catch (error) {
    if (error?.code === 'ENOENT') missing.push(creature.id);
    else decodeErrors.push({ id: creature.id, error: error.message });
    continue;
  }
  let image;
  try {
    image = PNG.sync.read(source);
  } catch (error) {
    decodeErrors.push({ id: creature.id, error: error.message });
    continue;
  }
  if (!hasPngChunk(source, 'sRGB')) {
    missingSrgbTag.push(creature.id);
  }
  decodedCount += 1;
  const hash = createHash('sha256').update(source).digest('hex');
  const matchingHashes = hashes.get(hash) ?? [];
  matchingHashes.push(creature.id);
  hashes.set(hash, matchingHashes);

  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    wrongDimensions.push({ id: creature.id, width: image.width, height: image.height });
  }
  if (image.colorType !== 6 || image.depth !== 8 || image.alpha !== true) {
    wrongModes.push({ id: creature.id, colorType: image.colorType, depth: image.depth, alpha: image.alpha });
  }
  const cornerOffsets = [
    3,
    (image.width - 1) * 4 + 3,
    (image.height - 1) * image.width * 4 + 3,
    (image.height * image.width - 1) * 4 + 3,
  ];
  if (!image.alpha || cornerOffsets.some((offset) => image.data[offset] !== 0)) {
    opaqueCornersOrNoAlpha.push(creature.id);
  }
  let nonTransparentPixels = 0;
  let opaquePixels = 0;
  let minimumX = image.width;
  let minimumY = image.height;
  let maximumX = -1;
  let maximumY = -1;
  const paletteTargets = Object.entries(creature.palette).map(([slot, hex]) => ({
    slot,
    hex,
    rgb: [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)),
    minimumDistance: Number.POSITIVE_INFINITY,
    nearbyPixelCount: 0,
  }));
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    if (image.data[pixel * 4 + 3] === 0) continue;
    nonTransparentPixels += 1;
    const x = pixel % image.width;
    const y = Math.floor(pixel / image.width);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
    if (image.data[pixel * 4 + 3] < paletteAlphaThreshold) continue;
    opaquePixels += 1;
    for (const target of paletteTargets) {
      const distance = Math.hypot(
        image.data[pixel * 4] - target.rgb[0],
        image.data[pixel * 4 + 1] - target.rgb[1],
        image.data[pixel * 4 + 2] - target.rgb[2],
      );
      target.minimumDistance = Math.min(target.minimumDistance, distance);
      if (distance < paletteNearDistance) target.nearbyPixelCount += 1;
    }
  }
  const coverage = nonTransparentPixels / (image.width * image.height);
  minimumCoverage = Math.min(minimumCoverage, coverage);
  maximumCoverage = Math.max(maximumCoverage, coverage);
  if (coverage < coverageMinimum || coverage > coverageMaximum) {
    extremeCoverage.push({ id: creature.id, coverage: Number(coverage.toFixed(6)) });
  }
  const edgeMargins = [minimumX, minimumY, image.width - 1 - maximumX, image.height - 1 - maximumY];
  if (Math.min(...edgeMargins) < minimumEdgeMargin) {
    insufficientEdgeMargins.push({ id: creature.id, edgeMargins });
  }
  const requiredPalettePixels = Math.max(minimumPalettePixels, Math.ceil(opaquePixels * minimumPalettePixelRatio));
  for (const target of paletteTargets.filter(({ minimumDistance, nearbyPixelCount }) => (
    minimumDistance >= paletteMaximumDistance || nearbyPixelCount < requiredPalettePixels
  ))) {
    paletteColorDrift.push({
      id: creature.id,
      slot: target.slot,
      target: target.hex,
      minimumDistance: Number(target.minimumDistance.toFixed(1)),
      pixelsWithin45: target.nearbyPixelCount,
      requiredPixelsWithin45: requiredPalettePixels,
    });
  }
}

function groupedValues(values, keyForValue) {
  const groups = new Map();
  for (const value of values) {
    const key = keyForValue(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const groupByDimensions = groupedValues(
  wrongDimensions,
  ({ width, height }) => `${width}x${height}`,
).map((group) => ({ width: group[0].width, height: group[0].height, ids: group.map(({ id }) => id) }));
const groupByMode = groupedValues(
  wrongModes,
  ({ colorType, depth, alpha }) => `colorType=${colorType};depth=${depth};alpha=${alpha}`,
).map((group) => ({
  colorType: group[0].colorType,
  depth: group[0].depth,
  alpha: group[0].alpha,
  ids: group.map(({ id }) => id),
}));
const duplicateSha256Groups = [...hashes.entries()]
  .filter(([, ids]) => ids.length > 1)
  .map(([sha256, ids]) => ({ sha256, ids }));
const summary = {
  missing: missing.length,
  decodeErrors: decodeErrors.length,
  wrongDimensions: wrongDimensions.length,
  wrongMode: wrongModes.length,
  opaqueCornersOrNoAlpha: opaqueCornersOrNoAlpha.length,
  missingSrgbTag: missingSrgbTag.length,
  extremeCoverage: extremeCoverage.length,
  insufficientEdgeMargins: insufficientEdgeMargins.length,
  paletteColorDrift: paletteColorDrift.length,
  duplicateSha256Groups: duplicateSha256Groups.length,
  catalogPathMismatches: catalogPathMismatches.length,
};
const report = {
  schemaVersion: 1,
  catalog: path.relative(root, catalogPath),
  scanRoot: 'assets/creatures/generated',
  range: 'PG-001..PG-240',
  scannedAt: new Date().toISOString(),
  expectedCount: catalog.length,
  presentCount: catalog.length - missing.length,
  decodedCount,
  criteria: {
    dimensions: `${expectedWidth}x${expectedHeight}`,
    mode: '8-bit RGBA',
    corners: 'all alpha 0',
    colorSpace: 'PNG sRGB chunk present',
    extremeCoverage: `nontransparent pixel ratio <${coverageMinimum} or >${coverageMaximum}`,
    minimumEdgeMargin: `${minimumEdgeMargin}px on every side`,
    paletteColorDistance: `for alpha>=${paletteAlphaThreshold} pixels, each catalog color needs RGB distance <${paletteMaximumDistance} and max(${minimumPalettePixels}, ${minimumPalettePixelRatio * 100}% opaque pixels) within distance <${paletteNearDistance}`,
  },
  summary,
  coverageRange: decodedCount === 0
    ? []
    : [Number(minimumCoverage.toFixed(6)), Number(maximumCoverage.toFixed(6))],
  missing,
  decodeErrors,
  wrongDimensionGroups: groupByDimensions,
  wrongModeGroups: groupByMode,
  opaqueCornersOrNoAlpha,
  missingSrgbTag,
  extremeCoverage,
  insufficientEdgeMargins,
  paletteColorDrift,
  duplicateSha256Groups,
  catalogPathMismatches,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const glyphs = {
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
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
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  J: ['00001','00001','00001','00001','10001','10001','01110'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
};

function setPixel(image, x, y, red, green, blue, alpha = 255) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }
  const offset = (y * image.width + x) * 4;
  image.data[offset] = red;
  image.data[offset + 1] = green;
  image.data[offset + 2] = blue;
  image.data[offset + 3] = alpha;
}

function drawText(image, value, x, y, scale = 3) {
  let cursor = x;
  for (const character of value.toUpperCase()) {
    const glyph = glyphs[character] ?? glyphs[' '];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            setPixel(image, cursor + column * scale + dx, y + row * scale + dy, 225, 235, 246);
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

function alphaComposite(destination, source, destinationX, destinationY, destinationWidth, destinationHeight) {
  for (let y = 0; y < destinationHeight; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / destinationHeight));
    for (let x = 0; x < destinationWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / destinationWidth));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const alpha = source.data[sourceOffset + 3] / 255;
      if (alpha === 0) continue;
      const targetX = destinationX + x;
      const targetY = destinationY + y;
      const destinationOffset = (targetY * destination.width + targetX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        destination.data[destinationOffset + channel] = Math.round(
          source.data[sourceOffset + channel] * alpha + destination.data[destinationOffset + channel] * (1 - alpha),
        );
      }
      destination.data[destinationOffset + 3] = 255;
    }
  }
}

await mkdir(contactSheetDir, { recursive: true });
const columns = 5;
const rows = 8;
const cellWidth = 640;
const cellHeight = 300;
for (let batchStart = 0; batchStart < catalog.length; batchStart += columns * rows) {
  const batch = catalog.slice(batchStart, batchStart + columns * rows);
  const sheet = new PNG({ width: columns * cellWidth, height: rows * cellHeight, colorType: 6 });
  for (let offset = 0; offset < sheet.data.length; offset += 4) {
    sheet.data[offset] = 13;
    sheet.data[offset + 1] = 20;
    sheet.data[offset + 2] = 32;
    sheet.data[offset + 3] = 255;
  }
  for (const [index, creature] of batch.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const originX = column * cellWidth;
    const originY = row * cellHeight;
    const source = PNG.sync.read(await readFile(path.join(root, `assets/creatures/generated/${creature.id}.png`)));
    const imageSize = 250;
    alphaComposite(sheet, source, originX + Math.floor((cellWidth - imageSize) / 2), originY + 8, imageSize, imageSize);
    drawText(sheet, creature.id, originX + 20, originY + 270, 3);
    drawText(sheet, creature.enName.slice(0, 22), originX + 180, originY + 270, 3);
  }
  const firstId = batch[0].id;
  const lastId = batch.at(-1).id;
  await writeFile(path.join(contactSheetDir, `contact-sheet-${firstId}-${lastId.slice(3)}.png`), PNG.sync.write(sheet));
}

console.log(JSON.stringify({ report: path.relative(root, reportPath), contactSheets: Math.ceil(catalog.length / 40), summary }, null, 2));
if (Object.values(summary).some((count) => count > 0)) process.exit(1);
