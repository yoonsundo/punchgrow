#!/usr/bin/env node

/** Safely import local ImageGen PNG bytes and derive deterministic 360px RGBA/sRGB runtime bytes. */

import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { canonicalStringify, sha256Bytes } from './lib/continuity-assignment/canonical-json.mjs';
import { writeFileAtomicNoFollow } from './lib/continuity-assignment/evidence.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SLOT = /^PG-[0-9]{3}$/; const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(message) { throw new Error(`continuity candidate intake: ${message}`); }
async function assertNoSymlinkAncestors(absolute, label) {
  const parsed = path.parse(absolute); let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component); const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`${label} contains a symlink ancestor`);
  }
}
export async function readLocalNoFollow(input, label, { beforeOpen = null } = {}) {
  if (input.includes('://')) fail('network/URL sources are forbidden');
  const absolute = path.resolve(input); await assertNoSymlinkAncestors(absolute, label); const info = await lstat(absolute, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail(`${label} must be an independent regular file`);
  if (beforeOpen) await beforeOpen({ absolute, info });
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.dev !== info.dev || current.ino !== info.ino
        || current.size !== info.size || current.mtimeNs !== info.mtimeNs || current.ctimeNs !== info.ctimeNs) fail(`${label} changed during intake`);
    const bytes = await handle.readFile(); const afterHandle = await handle.stat({ bigint: true }); const after = await lstat(absolute, { bigint: true });
    if (after.isSymbolicLink() || after.dev !== current.dev || after.ino !== current.ino || after.size !== current.size
        || after.mtimeNs !== current.mtimeNs || after.ctimeNs !== current.ctimeNs || afterHandle.size !== current.size
        || afterHandle.mtimeNs !== current.mtimeNs || afterHandle.ctimeNs !== current.ctimeNs) fail(`${label} changed during intake`);
    return bytes;
  }
  finally { await handle.close(); }
}

const sinc = (value) => value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
function lanczos(value, radius = 3) { const absolute = Math.abs(value); return absolute >= radius ? 0 : sinc(value) * sinc(value / radius); }
function contributions(sourceSize, targetSize) {
  const scale = targetSize / sourceSize; const filterScale = Math.min(1, scale); const support = 3 / filterScale;
  return Array.from({ length: targetSize }, (_, target) => {
    const center = (target + 0.5) / scale - 0.5; const first = Math.ceil(center - support); const last = Math.floor(center + support);
    const weights = []; let total = 0;
    for (let source = first; source <= last; source += 1) { const weight = lanczos((center - source) * filterScale); if (weight !== 0) { weights.push({ source: Math.max(0, Math.min(sourceSize - 1, source)), weight }); total += weight; } }
    for (const entry of weights) entry.weight /= total;
    return weights;
  });
}

function resizeRgbaLanczos(source, width, height) {
  const horizontalWeights = contributions(source.width, width); const verticalWeights = contributions(source.height, height);
  const horizontal = new Float64Array(width * source.height * 4);
  for (let y = 0; y < source.height; y += 1) for (let x = 0; x < width; x += 1) {
    const target = (y * width + x) * 4; let alpha = 0; let red = 0; let green = 0; let blue = 0;
    for (const { source: sourceX, weight } of horizontalWeights[x]) { const index = (y * source.width + sourceX) * 4; const a = source.data[index + 3] / 255; alpha += a * weight; red += source.data[index] * a * weight; green += source.data[index + 1] * a * weight; blue += source.data[index + 2] * a * weight; }
    horizontal[target] = red; horizontal[target + 1] = green; horizontal[target + 2] = blue; horizontal[target + 3] = alpha;
  }
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const target = (y * width + x) * 4; let alpha = 0; let red = 0; let green = 0; let blue = 0;
    for (const { source: sourceY, weight } of verticalWeights[y]) { const index = (sourceY * width + x) * 4; alpha += horizontal[index + 3] * weight; red += horizontal[index] * weight; green += horizontal[index + 1] * weight; blue += horizontal[index + 2] * weight; }
    const safeAlpha = Math.max(0, Math.min(1, alpha)); output[target + 3] = Math.round(safeAlpha * 255);
    if (safeAlpha > 1e-9) { output[target] = Math.max(0, Math.min(255, Math.round(red / safeAlpha))); output[target + 1] = Math.max(0, Math.min(255, Math.round(green / safeAlpha))); output[target + 2] = Math.max(0, Math.min(255, Math.round(blue / safeAlpha))); }
  }
  return output;
}

const crcTable = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
function crc32(buffer) { let crc = 0xFFFFFFFF; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }
function addSrgbChunk(source) {
  const typeAndData = Buffer.concat([Buffer.from('sRGB'), Buffer.from([0])]); const chunk = Buffer.alloc(13); chunk.writeUInt32BE(1, 0); typeAndData.copy(chunk, 4); chunk.writeUInt32BE(crc32(typeAndData), 9);
  const ihdrEnd = 8 + 12 + source.readUInt32BE(8); return Buffer.concat([source.subarray(0, ihdrEnd), chunk, source.subarray(ihdrEnd)]);
}
function descriptor(relativePath, bytes, width, height) { return { path: relativePath, sha256: sha256Bytes(bytes), bytes: bytes.length, width, height }; }
async function immutableWrite(root, relativePath, bytes) {
  const stagingRoot = path.join(root, 'assets/creatures/biological-continuity-v3');
  await mkdir(stagingRoot, { recursive: true }); await assertNoSymlinkAncestors(stagingRoot, 'v3 staging root');
  const target = path.resolve(root, relativePath); const relation = path.relative(stagingRoot, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) fail('output escapes private v3 staging root');
  try { const current = await readLocalNoFollow(path.join(root, relativePath), 'existing staged output'); if (current.equals(bytes)) return; fail(`refusing to overwrite different staged output: ${relativePath}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFileAtomicNoFollow(target, bytes, { containmentRoot: stagingRoot, mode: 0o644, allowedBasenames: new Set([path.basename(relativePath)]) });
}

export async function stageCandidate({ slotId, generationRunId, promptPath, sourcePath, repoRoot = DEFAULT_ROOT, testBeforeSourceOpen = null } = {}) {
  if (!SLOT.test(slotId)) fail('invalid slot'); if (!RUN.test(generationRunId)) fail('invalid generation run id');
  const [sourceBytes, promptBytes] = await Promise.all([readLocalNoFollow(sourcePath, 'source PNG', { beforeOpen: testBeforeSourceOpen }), readLocalNoFollow(promptPath, 'prompt file')]);
  if (!promptBytes.toString('utf8').trim()) fail('prompt file is empty'); if (!sourceBytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('source is not a PNG');
  let source;
  try { source = PNG.sync.read(sourceBytes, { checkCRC: true, skipRescale: false }); } catch (error) { fail(`invalid PNG/CRC: ${error.message}`); }
  if (source.width !== source.height || source.width < 1024) fail('master must be square and at least 1024px');
  const data = resizeRgbaLanczos(source, 360, 360);
  const encoded = PNG.sync.write({ width: 360, height: 360, data }, { colorType: 6, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9, deflateStrategy: 3 });
  const runtimeBytes = addSrgbChunk(encoded); // PNG.sync.write emits RGBA; this inserts rendering intent 0 after IHDR.
  const sourceSha = sha256Bytes(sourceBytes); const base = 'assets/creatures/biological-continuity-v3';
  const workspaceMaster = `${base}/workspace-masters/${generationRunId}/${slotId}/${sourceSha}.png`;
  const candidateRoot = `${base}/candidates/${generationRunId}/${slotId}`; const candidateMaster = `${candidateRoot}/master.png`; const runtime = `${candidateRoot}/runtime.png`;
  await immutableWrite(repoRoot, workspaceMaster, sourceBytes); await immutableWrite(repoRoot, candidateMaster, sourceBytes);
  await immutableWrite(repoRoot, `${candidateRoot}/prompt.txt`, promptBytes); await immutableWrite(repoRoot, runtime, runtimeBytes);
  const provenance = {
    schemaVersion: 'continuity-candidate-provenance-v1', slotId, generationRunId, sourceKind: 'local-built-in-imagegen-png', promptSha256: sha256Bytes(promptBytes),
    workspaceMaster: descriptor(workspaceMaster, sourceBytes, source.width, source.height), candidateMaster: descriptor(candidateMaster, sourceBytes, source.width, source.height), runtime: descriptor(runtime, runtimeBytes, 360, 360),
    derivation: { engine: 'pngjs', engineVersion: '3.4.0', resampler: 'LANCZOS3-premultiplied-alpha', width: 360, height: 360, mode: 'RGBA', colorSpace: 'sRGB', pngCompressionLevel: 9, metadataPolicy: 'strip-and-write-srgb-rendering-intent-0' },
  };
  await immutableWrite(repoRoot, `${candidateRoot}/provenance.json`, Buffer.from(canonicalStringify(provenance)));
  return { status: 'STAGED', slotId, masterSha256: sourceSha, runtimeSha256: provenance.runtime.sha256, provenance: `${candidateRoot}/provenance.json` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
  if (args.length !== 8) fail('usage: --slot PG-NNN --generation-run-id RUN --prompt-file FILE --source LOCAL_PNG');
  stageCandidate({ slotId: value('--slot'), generationRunId: value('--generation-run-id'), promptPath: value('--prompt-file'), sourcePath: value('--source') })
    .then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
