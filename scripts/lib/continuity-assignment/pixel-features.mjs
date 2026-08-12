import { PNG } from 'pngjs';
import { sha256Bytes } from './canonical-json.mjs';
import { fail } from './evidence.mjs';

const SILHOUETTE_SIZE = 32;
const BACKGROUND = [0x08, 0x11, 0x1f];

function isForeground(r, g, b, a) {
  if (a < 16) return false;
  const distance = Math.abs(r - BACKGROUND[0]) + Math.abs(g - BACKGROUND[1]) + Math.abs(b - BACKGROUND[2]);
  return distance > 30;
}
function sampleGray(png, x, y) {
  const px = Math.min(png.width - 1, Math.max(0, Math.floor(x)));
  const py = Math.min(png.height - 1, Math.max(0, Math.floor(y)));
  const offset = (py * png.width + px) * 4;
  const a = png.data[offset + 3] / 255;
  const r = png.data[offset] * a + BACKGROUND[0] * (1 - a);
  const g = png.data[offset + 1] * a + BACKGROUND[1] * (1 - a);
  const b = png.data[offset + 2] * a + BACKGROUND[2] * (1 - a);
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function perceptualHash(png) {
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    const row = [];
    for (let x = 0; x < 9; x += 1) row.push(sampleGray(png, ((x + 0.5) * png.width) / 9, ((y + 0.5) * png.height) / 8));
    for (let x = 0; x < 8; x += 1) bits += row[x] > row[x + 1] ? '1' : '0';
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function extractPixelFeatures(bytes, { expectedWidth, expectedHeight, label = 'PNG' } = {}) {
  let png;
  try { png = PNG.sync.read(bytes, { checkCRC: true }); } catch (error) { fail(`${label} is not a valid PNG: ${error.message}`); }
  if (expectedWidth && png.width !== expectedWidth) fail(`${label} width drift: expected ${expectedWidth}, received ${png.width}`);
  if (expectedHeight && png.height !== expectedHeight) fail(`${label} height drift: expected ${expectedHeight}, received ${png.height}`);

  let count = 0; let sumX = 0; let sumY = 0;
  let minX = png.width; let minY = png.height; let maxX = -1; let maxY = -1;
  const mask = new Uint8Array(png.width * png.height);
  const palette = new Map();
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const [r, g, b, a] = png.data.subarray(offset, offset + 4);
      if (!isForeground(r, g, b, a)) continue;
      mask[y * png.width + x] = 1; count += 1; sumX += x; sumY += y;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      const key = `${r >> 4}${g >> 4}${b >> 4}`;
      palette.set(key, (palette.get(key) ?? 0) + 1);
    }
  }
  if (count === 0) fail(`${label} contains no foreground pixels`);

  let bitString = '';
  for (let cellY = 0; cellY < SILHOUETTE_SIZE; cellY += 1) {
    for (let cellX = 0; cellX < SILHOUETTE_SIZE; cellX += 1) {
      const x0 = Math.floor((cellX * png.width) / SILHOUETTE_SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((cellX + 1) * png.width) / SILHOUETTE_SIZE));
      const y0 = Math.floor((cellY * png.height) / SILHOUETTE_SIZE);
      const y1 = Math.max(y0 + 1, Math.floor(((cellY + 1) * png.height) / SILHOUETTE_SIZE));
      let foreground = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) foreground += mask[y * png.width + x];
      bitString += foreground * 2 >= (x1 - x0) * (y1 - y0) ? '1' : '0';
    }
  }
  const silhouetteBitmap = Buffer.from(bitString.match(/.{8}/g).map((part) => Number.parseInt(part, 2))).toString('base64');
  const quantizedPalette = [...palette.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([bin, pixels]) => ({ bin, fractionPpm: Math.round((pixels * 1_000_000) / count) }));

  return {
    width: png.width, height: png.height,
    foregroundBounds: { minX, minY, maxX, maxY },
    foregroundCentroidPpm: { x: Math.round((sumX * 1_000_000) / count / Math.max(1, png.width - 1)), y: Math.round((sumY * 1_000_000) / count / Math.max(1, png.height - 1)) },
    foregroundOccupancyPpm: Math.round((count * 1_000_000) / (png.width * png.height)),
    silhouetteSize: SILHOUETTE_SIZE,
    silhouetteBitmap,
    silhouetteSha256: sha256Bytes(Buffer.from(silhouetteBitmap, 'base64')),
    perceptualHash: perceptualHash(png),
    quantizedPalette,
  };
}
