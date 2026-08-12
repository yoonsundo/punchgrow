import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const catalog = JSON.parse(await readFile(path.join(root, 'production/catalog/creatures.json'), 'utf8'));

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunkTypes(source) {
  const types = [];
  for (let offset = 8; offset + 12 <= source.length;) {
    const length = source.readUInt32BE(offset);
    types.push(source.toString('ascii', offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

function addSrgbChunk(source) {
  if (chunkTypes(source).includes('sRGB')) return source;
  if (source.toString('ascii', 1, 4) !== 'PNG') throw new Error('Not a PNG file');
  const typeAndData = Buffer.concat([Buffer.from('sRGB'), Buffer.from([0])]);
  const chunk = Buffer.alloc(13);
  chunk.writeUInt32BE(1, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), 9);
  const ihdrEnd = 8 + 12 + source.readUInt32BE(8);
  return Buffer.concat([source.subarray(0, ihdrEnd), chunk, source.subarray(ihdrEnd)]);
}

let updated = 0;
for (const creature of catalog) {
  const imagePath = path.join(root, creature.imagePath);
  const source = await readFile(imagePath);
  const normalized = addSrgbChunk(source);
  if (normalized !== source) {
    await writeFile(imagePath, normalized);
    updated += 1;
  }
}

console.log(JSON.stringify({ total: catalog.length, updated, alreadyTagged: catalog.length - updated }, null, 2));
