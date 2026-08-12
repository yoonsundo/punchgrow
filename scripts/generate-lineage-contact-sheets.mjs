import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = process.cwd();
const argumentsList = process.argv.slice(2);
let outputDirectory = '/private/tmp/punchgrow-lineage-sheets';
let runtimeBundleDirectory = null;
let preferCandidates = false;

function pixelSha256(image) {
  return createHash('sha256')
    .update(`PNG-RGBA\nwidth=${image.width}\nheight=${image.height}\n`, 'utf8')
    .update(image.data)
    .digest('hex');
}

for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--prefer-candidates') {
    preferCandidates = true;
  } else if (argument === '--runtime-bundle') {
    if (!argumentsList[index + 1] || argumentsList[index + 1].startsWith('--')) {
      throw new Error('--runtime-bundle requires a bundle resource directory');
    }
    runtimeBundleDirectory = path.resolve(root, argumentsList[index + 1]);
    index += 1;
  } else if (!argument.startsWith('--')) {
    outputDirectory = argument;
  }
}

if (runtimeBundleDirectory && preferCandidates) {
  throw new Error('--runtime-bundle and --prefer-candidates cannot be used together');
}

const requiredRuntimeBundleDirectory = path.join(
  root,
  'macos/.build/PunchGrow.app/Contents/Resources/PunchGrowMenuBar_PunchGrowMenuBar.bundle',
);
if (runtimeBundleDirectory && runtimeBundleDirectory !== requiredRuntimeBundleDirectory) {
  throw new Error(`--runtime-bundle must be exactly ${requiredRuntimeBundleDirectory}`);
}

const catalogPath = runtimeBundleDirectory
  ? path.join(runtimeBundleDirectory, 'creatures.json')
  : path.join(root, 'production/catalog/creatures.json');
const catalogContents = await readFile(catalogPath);
const catalog = JSON.parse(catalogContents.toString('utf8'));
const normalCategories = new Set(['start', 'normal_evolution']);
const roots = catalog
  .filter((entry) => entry.category === 'start')
  .sort((left, right) => left.lineageId.localeCompare(right.lineageId));

if (roots.length !== 60) {
  throw new Error(`normal lineage root count must be 60, got ${roots.length}`);
}

const catalogByID = new Map(catalog.map((entry) => [entry.id, entry]));
const catalogByLineageStage = new Map();
for (const entry of catalog) {
  const key = `${entry.lineageId}:S${entry.stage}`;
  const matches = catalogByLineageStage.get(key) ?? [];
  matches.push(entry);
  catalogByLineageStage.set(key, matches);
}

function evolutionReferences(entry) {
  if (typeof entry.evolutionFrom === 'string') return [entry.evolutionFrom];
  if (Array.isArray(entry.evolutionFrom)) return entry.evolutionFrom;
  return [];
}

function resolveParentReference(child, reference) {
  if (/^PG-\d{3}$/.test(reference)) {
    const direct = catalogByID.get(reference);
    if (!direct) throw new Error(`${child.id}: unresolved evolutionFrom reference ${reference}`);
    return direct;
  }
  if (!/^PG-L\d{3}:S\d+$/.test(reference)) {
    throw new Error(`${child.id}: invalid evolutionFrom reference ${reference}`);
  }
  const matches = catalogByLineageStage.get(reference) ?? [];
  if (matches.length !== 1) {
    const state = matches.length === 0 ? 'unresolved' : `ambiguous (${matches.length} matches)`;
    throw new Error(`${child.id}: ${state} evolutionFrom reference ${reference}`);
  }
  return matches[0];
}

function resolvedParents(child) {
  const references = evolutionReferences(child);
  const expectedParentCount = child.category === 'mixed' ? 2 : 1;
  if (references.length !== expectedParentCount) {
    throw new Error(
      `${child.id} (${child.category}): expected ${expectedParentCount} evolutionFrom reference(s), got ${references.length}`,
    );
  }
  return references.map((reference) => resolveParentReference(child, reference));
}

for (const lineageRoot of roots) {
  const entries = catalog
    .filter((entry) => entry.lineageId === lineageRoot.lineageId && normalCategories.has(entry.category))
    .sort((left, right) => left.stage - right.stage);
  const stages = entries.map((entry) => entry.stage);
  if (new Set(stages).size !== stages.length) {
    throw new Error(`${lineageRoot.lineageId}: duplicate normal stage`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.stage !== index + 1) {
      throw new Error(`${lineageRoot.lineageId}: missing or non-contiguous normal stage at S${index + 1}`);
    }
    const references = evolutionReferences(entry);
    const expectedReferenceCount = index === 0 ? 0 : 1;
    if (references.length !== expectedReferenceCount) {
      throw new Error(
        `${entry.id}: normal stage S${entry.stage} requires exactly ${expectedReferenceCount} evolutionFrom reference(s), got ${references.length}`,
      );
    }
    if (index > 0) {
      const reference = references[0];
      const parent = resolveParentReference(entry, reference);
      const expectedParent = entries[index - 1];
      if (parent.id !== expectedParent.id) {
        throw new Error(
          `${entry.id}: evolutionFrom reference ${reference} resolves to ${parent.id}, expected same-lineage previous stage ${expectedParent.id}`,
        );
      }
    }
  }
}

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
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
};

function setPixel(image, x, y, red, green, blue, alpha = 255) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.data[offset] = red;
  image.data[offset + 1] = green;
  image.data[offset + 2] = blue;
  image.data[offset + 3] = alpha;
}

function drawText(image, value, x, y, scale = 2) {
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

function composite(destination, source, destinationX, destinationY, size) {
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / size));
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / size));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const alpha = source.data[sourceOffset + 3] / 255;
      const destinationOffset = ((destinationY + y) * destination.width + destinationX + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        destination.data[destinationOffset + channel] = Math.round(
          source.data[sourceOffset + channel] * alpha
            + destination.data[destinationOffset + channel] * (1 - alpha),
        );
      }
      destination.data[destinationOffset + 3] = 255;
    }
  }
}

async function imagePathFor(entry) {
  if (runtimeBundleDirectory) {
    return path.join(runtimeBundleDirectory, `${entry.id}.png`);
  }
  if (preferCandidates) {
    for (const group of ['normal', 'branch-mixed', 'special', 'mutant']) {
      const candidatePath = path.join(
        root,
        'assets/creatures/continuity-fix/generated',
        group,
        `${entry.id}.png`,
      );
      try {
        await access(candidatePath);
        return candidatePath;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // 후보가 없는 그룹만 건너뛰고 다음 그룹 또는 현재 활성 자산으로 계속한다.
      }
    }
  }
  return path.join(
    root,
    `macos/Sources/PunchGrowMenuBar/Resources/Creatures/${entry.id}.png`,
  );
}

await mkdir(outputDirectory, { recursive: true });
const rowsPerSheet = 10;
const cellWidth = 280;
const cellHeight = 250;
const imageSize = 215;
const outputs = [];
const auditUnits = [];

for (let batchStart = 0; batchStart < roots.length; batchStart += rowsPerSheet) {
  const batch = roots.slice(batchStart, batchStart + rowsPerSheet);
  const sheet = new PNG({ width: cellWidth * 4, height: cellHeight * batch.length });
  for (let offset = 0; offset < sheet.data.length; offset += 4) {
    sheet.data[offset] = 8;
    sheet.data[offset + 1] = 14;
    sheet.data[offset + 2] = 28;
    sheet.data[offset + 3] = 255;
  }

  for (const [row, lineageRoot] of batch.entries()) {
    const entries = catalog
      .filter((entry) => entry.lineageId === lineageRoot.lineageId && normalCategories.has(entry.category))
      .sort((left, right) => left.stage - right.stage);
    for (const entry of entries) {
      const column = entry.stage - 1;
      const source = PNG.sync.read(await readFile(await imagePathFor(entry)));
      const originX = column * cellWidth;
      const originY = row * cellHeight;
      composite(sheet, source, originX + Math.floor((cellWidth - imageSize) / 2), originY + 4, imageSize);
      drawText(
        sheet,
        `${lineageRoot.lineageId.slice(-3)} S${entry.stage} ${entry.id}`,
        originX + 36,
        originY + 226,
      );
    }
  }

  const first = String(batchStart + 1).padStart(3, '0');
  const last = String(batchStart + batch.length).padStart(3, '0');
  const outputPath = path.join(outputDirectory, `normal-lineages-${first}-${last}.png`);
  await writeFile(outputPath, PNG.sync.write(sheet));
  outputs.push(outputPath);

  for (const [row, lineageRoot] of batch.entries()) {
    const entries = catalog
      .filter((entry) => entry.lineageId === lineageRoot.lineageId && normalCategories.has(entry.category))
      .sort((left, right) => left.stage - right.stage);
    auditUnits.push({
      unitId: `normal-${lineageRoot.lineageId}`,
      category: 'normal',
      sheet: path.basename(outputPath),
      row: row + 1,
      creatureIds: entries.map((entry) => entry.id),
      edges: entries.slice(1).map((entry, index) => ({
        parentId: entries[index].id,
        childId: entry.id,
      })),
    });
  }
}

const exceptionalEvolutions = catalog
  .filter((entry) => !normalCategories.has(entry.category))
  .sort((left, right) => left.id.localeCompare(right.id));

for (let batchStart = 0; batchStart < exceptionalEvolutions.length; batchStart += rowsPerSheet) {
  const batch = exceptionalEvolutions.slice(batchStart, batchStart + rowsPerSheet);
  const sheet = new PNG({ width: cellWidth * 4, height: cellHeight * batch.length });
  for (let offset = 0; offset < sheet.data.length; offset += 4) {
    sheet.data[offset] = 8;
    sheet.data[offset + 1] = 14;
    sheet.data[offset + 2] = 28;
    sheet.data[offset + 3] = 255;
  }

  for (const [row, child] of batch.entries()) {
    const parents = resolvedParents(child);
    const visibleEntries = [...parents.slice(0, 2), child];
    for (const [column, entry] of visibleEntries.entries()) {
      const source = PNG.sync.read(await readFile(await imagePathFor(entry)));
      const originX = column * cellWidth;
      const originY = row * cellHeight;
      composite(sheet, source, originX + Math.floor((cellWidth - imageSize) / 2), originY + 4, imageSize);
      const label = column < parents.length ? `P${column + 1} ${entry.id}` : `CH ${entry.id}`;
      drawText(sheet, label, originX + 48, originY + 226);
    }
    drawText(sheet, child.category.toUpperCase(), cellWidth * 3 + 24, row * cellHeight + 106, 2);
  }

  const first = String(batchStart + 1).padStart(3, '0');
  const last = String(batchStart + batch.length).padStart(3, '0');
  const outputPath = path.join(outputDirectory, `exceptional-evolutions-${first}-${last}.png`);
  await writeFile(outputPath, PNG.sync.write(sheet));
  outputs.push(outputPath);

  for (const [row, child] of batch.entries()) {
    const parents = resolvedParents(child);
    auditUnits.push({
      unitId: `${child.category}-${child.id}`,
      category: child.category,
      sheet: path.basename(outputPath),
      row: row + 1,
      creatureIds: [...parents.map((parent) => parent.id), child.id],
      edges: parents.map((parent) => ({ parentId: parent.id, childId: child.id })),
    });
  }
}

const visualArtifacts = [];
for (const outputPath of outputs) {
  const contents = await readFile(outputPath);
  const image = PNG.sync.read(contents);
  visualArtifacts.push({
    path: path.basename(outputPath),
    pixelSha256: pixelSha256(image),
    width: image.width,
    height: image.height,
  });
}

const coveredCreatureIds = [...new Set(auditUnits.flatMap((unit) => unit.creatureIds))].sort();
const assets = [];
for (const entry of [...catalog].sort((left, right) => left.id.localeCompare(right.id))) {
  const assetPath = await imagePathFor(entry);
  const contents = await readFile(assetPath);
  const image = PNG.sync.read(contents);
  const assetInfo = await stat(assetPath);
  assets.push({
    id: entry.id,
    path: path.relative(root, assetPath),
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: assetInfo.size,
    width: image.width,
    height: image.height,
  });
}
const catalogSha256 = createHash('sha256').update(catalogContents).digest('hex');
const resourcesFingerprint = createHash('sha256')
  .update(catalogSha256)
  .update(assets.map((asset) => `${asset.id}:${asset.sha256}`).join('\n'))
  .digest('hex');
const manifest = {
  schemaVersion: 1,
  source: runtimeBundleDirectory ? 'runtime-app-bundle' : preferCandidates ? 'continuity-candidates' : 'source-resources',
  sourceDirectory: runtimeBundleDirectory ? path.relative(root, runtimeBundleDirectory) : null,
  catalogPath: path.relative(root, catalogPath),
  catalogSha256,
  resourcesFingerprint,
  assetCount: assets.length,
  creatureCount: coveredCreatureIds.length,
  unitCount: auditUnits.length,
  edgeCount: auditUnits.reduce((total, unit) => total + unit.edges.length, 0),
  coveredCreatureIds,
  assets,
  visualArtifacts,
  units: auditUnits,
};
const manifestPath = path.join(outputDirectory, 'evolution-audit-manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  outputDirectory,
  manifestPath,
  creatureCount: manifest.creatureCount,
  unitCount: manifest.unitCount,
  edgeCount: manifest.edgeCount,
  outputs,
}, null, 2));
