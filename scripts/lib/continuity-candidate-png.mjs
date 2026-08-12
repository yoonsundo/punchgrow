import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { sha256Bytes } from './continuity-assignment/canonical-json.mjs';
import { assertCanonicalRelativePath } from './continuity-assignment/evidence.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fail = (message) => { throw new Error(`continuity candidate PNG: ${message}`); };

export const CONTINUITY_RUNTIME_DERIVATION_V1 = Object.freeze({
  engine: 'pngjs', engineVersion: '3.4.0', resampler: 'LANCZOS3-premultiplied-alpha',
  width: 360, height: 360, mode: 'RGBA', colorSpace: 'sRGB', pngCompressionLevel: 9,
  metadataPolicy: 'strip-and-write-srgb-rendering-intent-0',
});

function crcTable() {
  return Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
}
const CRC_TABLE = crcTable();
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function addSrgbChunk(source) {
  const typeAndData = Buffer.concat([Buffer.from('sRGB'), Buffer.from([0])]);
  const chunk = Buffer.alloc(13);
  chunk.writeUInt32BE(1, 0); typeAndData.copy(chunk, 4); chunk.writeUInt32BE(crc32(typeAndData), 9);
  const ihdrEnd = 8 + 12 + source.readUInt32BE(8);
  return Buffer.concat([source.subarray(0, ihdrEnd), chunk, source.subarray(ihdrEnd)]);
}

const sinc = (value) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
function lanczos(value, radius = 3) { const absolute = Math.abs(value); return absolute >= radius ? 0 : sinc(value) * sinc(value / radius); }
function contributions(sourceSize, targetSize) {
  const scale = targetSize / sourceSize; const filterScale = Math.min(1, scale); const support = 3 / filterScale;
  return Array.from({ length: targetSize }, (_, target) => {
    const center = (target + 0.5) / scale - 0.5; const first = Math.ceil(center - support); const last = Math.floor(center + support);
    const weights = []; let total = 0;
    for (let source = first; source <= last; source += 1) {
      const weight = lanczos((center - source) * filterScale);
      if (weight !== 0) { weights.push({ source: Math.max(0, Math.min(sourceSize - 1, source)), weight }); total += weight; }
    }
    for (const entry of weights) entry.weight /= total;
    return weights;
  });
}

function resizeRgbaLanczos(source, width, height) {
  const horizontalWeights = contributions(source.width, width); const verticalWeights = contributions(source.height, height);
  const horizontal = new Float64Array(width * source.height * 4);
  for (let y = 0; y < source.height; y += 1) for (let x = 0; x < width; x += 1) {
    const target = (y * width + x) * 4; let alpha = 0; let red = 0; let green = 0; let blue = 0;
    for (const { source: sourceX, weight } of horizontalWeights[x]) {
      const index = (y * source.width + sourceX) * 4; const a = source.data[index + 3] / 255;
      alpha += a * weight; red += source.data[index] * a * weight; green += source.data[index + 1] * a * weight; blue += source.data[index + 2] * a * weight;
    }
    horizontal[target] = red; horizontal[target + 1] = green; horizontal[target + 2] = blue; horizontal[target + 3] = alpha;
  }
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const target = (y * width + x) * 4; let alpha = 0; let red = 0; let green = 0; let blue = 0;
    for (const { source: sourceY, weight } of verticalWeights[y]) {
      const index = (sourceY * width + x) * 4;
      alpha += horizontal[index + 3] * weight; red += horizontal[index] * weight; green += horizontal[index + 1] * weight; blue += horizontal[index + 2] * weight;
    }
    const safeAlpha = Math.max(0, Math.min(1, alpha)); output[target + 3] = Math.round(safeAlpha * 255);
    if (safeAlpha > 1e-9) {
      output[target] = Math.max(0, Math.min(255, Math.round(red / safeAlpha)));
      output[target + 1] = Math.max(0, Math.min(255, Math.round(green / safeAlpha)));
      output[target + 2] = Math.max(0, Math.min(255, Math.round(blue / safeAlpha)));
    }
  }
  return output;
}

function decode(bytes, label) {
  if (!Buffer.from(bytes).subarray(0, SIGNATURE.length).equals(SIGNATURE)) fail(`${label} is not a PNG`);
  try { return PNG.sync.read(bytes, { checkCRC: true, skipRescale: false }); }
  catch (error) { fail(`${label} PNG/CRC is invalid: ${error.message}`); }
}

export function deriveContinuityRuntimePng(masterBytes) {
  const source = decode(Buffer.from(masterBytes), 'master');
  if (source.width !== source.height || source.width < 1024) fail('master must be square and at least 1024px');
  const data = resizeRgbaLanczos(source, 360, 360);
  const encoded = PNG.sync.write({ width: 360, height: 360, data }, {
    colorType: 6, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9, deflateStrategy: 3,
  });
  return addSrgbChunk(encoded);
}

export function inspectContinuityPng(bytes, { label = 'PNG', master = false, runtime = false } = {}) {
  const normalized = Buffer.from(bytes); const decoded = decode(normalized, label);
  if (master && (decoded.width !== decoded.height || decoded.width < 1024)) fail(`${label} must be square and at least 1024px`);
  if (runtime && (decoded.width !== 360 || decoded.height !== 360 || normalized[25] !== 6 || !normalized.includes(Buffer.from('sRGB')))) {
    fail(`${label} must be 360x360 RGBA/sRGB`);
  }
  return Object.freeze({ sha256: sha256Bytes(normalized), bytes: normalized.length, width: decoded.width, height: decoded.height });
}

export async function readStableContainedFile(repoRoot, relativePath, label = relativePath) {
  assertCanonicalRelativePath(relativePath, label);
  const root = path.resolve(repoRoot); const target = path.resolve(root, relativePath); const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail(`${label} escapes repository root`);
  let cursor = root;
  for (const component of relation.split(path.sep)) {
    cursor = path.join(cursor, component); const info = await lstat(cursor, { bigint: true });
    if (info.isSymbolicLink()) fail(`${label} contains a symlink`);
  }
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  const resolvedRelation = path.relative(resolvedRoot, resolvedTarget);
  if (!resolvedRelation || resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) fail(`${label} resolves outside repository root`);
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail(`${label} must be an independent regular file`);
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) fail(`${label} changed before read`);
    const bytes = await handle.readFile(); const afterHandle = await handle.stat({ bigint: true }); const afterPath = await lstat(target, { bigint: true });
    for (const current of [afterHandle, afterPath]) if (!current.isFile() || current.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) fail(`${label} changed during read`);
    if (BigInt(bytes.length) !== before.size) fail(`${label} size changed during read`);
    return bytes;
  } finally { await handle.close(); }
}

export function assertRuntimeDerivedFromMaster(masterBytes, runtimeBytes) {
  inspectContinuityPng(masterBytes, { label: 'master', master: true });
  inspectContinuityPng(runtimeBytes, { label: 'runtime', runtime: true });
  if (!deriveContinuityRuntimePng(masterBytes).equals(Buffer.from(runtimeBytes))) fail('runtime bytes are not the deterministic derivative of master bytes');
  return true;
}
