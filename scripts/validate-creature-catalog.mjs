import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const catalogDir = path.join(root, 'production', 'catalog');
const files = (await readdir(catalogDir))
  .filter((file) => /^creatures-\d{3}-\d{3}\.json$/.test(file))
  .sort();

if (files.length === 0) throw new Error('No catalog segments found');

const entries = [];
for (const file of files) {
  const value = JSON.parse(await readFile(path.join(catalogDir, file), 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${file} must contain an array`);
  entries.push(...value);
}
const canonicalPath = path.join(catalogDir, 'creatures.json');
const canonicalEntries = JSON.parse(await readFile(canonicalPath, 'utf8'));
if (JSON.stringify(canonicalEntries) !== JSON.stringify(entries)) {
  throw new Error('creatures.json is out of sync with catalog segments; rebuild it explicitly before validation');
}

const required = [
  'id', 'koName', 'enName', 'lineageId', 'category', 'stage', 'rarity',
  'bodyForm', 'tone', 'identity', 'lore', 'shapeDNA', 'palette',
  'sharedMotifs', 'imagePath', 'generationPrompt',
];
const categories = new Set(['start', 'normal_evolution', 'branch', 'mixed', 'special', 'mutant']);
const rarities = new Set(['PROCESS', 'AGENT', 'DAEMON', 'ORACLE', 'ARCHITECT', 'ORIGIN']);
const bodyFormAliases = new Map([
  ['네발짐승', 'quadruped_beast'], ['quadruped_beast', 'quadruped_beast'],
  ['두발짐승', 'biped_beast'], ['biped_beast', 'biped_beast'],
  ['조류', 'avian'], ['avian', 'avian'],
  ['수생형', 'aquatic'], ['aquatic', 'aquatic'],
  ['부유 정령형', 'floating_spirit'], ['floating_spirit', 'floating_spirit'],
  ['곤충·기계구조체', 'insect_mech'], ['insect_mech', 'insect_mech'],
  ['기타 무정형·식물형', 'plant_amorph'], ['plant_amorph', 'plant_amorph'],
  ['거대 용형', 'giant_dragon'], ['giant_dragon', 'giant_dragon'],
]);
const motifAliases = new Map([
  ['발광 회로', 'luminous_circuits'], ['luminous circuits', 'luminous_circuits'],
  ['다각형 신화문자', 'polygonal_myth_glyphs'], ['polygonal myth glyphs', 'polygonal_myth_glyphs'],
  ['부유 고리', 'floating_rings'], ['부유하는 고리', 'floating_rings'], ['floating rings', 'floating_rings'],
]);
const errors = [];
const seenIds = new Set();
const seenKoNames = new Set();
const seenEnNames = new Set();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hexToRgb(hex) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function colorDistance(left, right) {
  return Math.hypot(...left.map((channel, index) => channel - right[index]));
}

function canonicalMotifs(entry) {
  if (!Array.isArray(entry.sharedMotifs)) {
    return [];
  }
  return entry.sharedMotifs.map((motif) => motifAliases.get(motif)).filter(Boolean);
}

for (const [index, entry] of entries.entries()) {
  for (const key of required) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === '') {
      errors.push(`entry ${index}: missing ${key}`);
    }
  }
  if (!/^PG-\d{3}$/.test(entry.id)) errors.push(`entry ${index}: invalid id ${entry.id}`);
  if (seenIds.has(entry.id)) errors.push(`duplicate id: ${entry.id}`);
  if (seenKoNames.has(entry.koName)) errors.push(`duplicate koName: ${entry.koName}`);
  if (seenEnNames.has(entry.enName)) errors.push(`duplicate enName: ${entry.enName}`);
  seenIds.add(entry.id);
  seenKoNames.add(entry.koName);
  seenEnNames.add(entry.enName);

  if (!categories.has(entry.category)) errors.push(`${entry.id}: invalid category ${entry.category}`);
  if (!Number.isInteger(entry.stage) || entry.stage < 1 || entry.stage > 4) {
    errors.push(`${entry.id}: stage must be an integer from 1 to 4`);
  }
  if (!rarities.has(entry.rarity)) errors.push(`${entry.id}: invalid rarity ${entry.rarity}`);
  if (!bodyFormAliases.has(entry.bodyForm)) errors.push(`${entry.id}: unknown bodyForm ${entry.bodyForm}`);
  if (!Array.isArray(entry.shapeDNA) || entry.shapeDNA.length !== 3 || !entry.shapeDNA.every(isNonEmptyString)) {
    errors.push(`${entry.id}: shapeDNA must contain exactly 3 non-empty strings`);
  }
  if (!Array.isArray(entry.sharedMotifs) || entry.sharedMotifs.length < 1 || entry.sharedMotifs.length > 2) {
    errors.push(`${entry.id}: sharedMotifs must contain 1-2 items`);
  } else {
    const canonical = canonicalMotifs(entry);
    const unknown = entry.sharedMotifs.filter((_, motifIndex) => !canonical[motifIndex]);
    if (unknown.length > 0) errors.push(`${entry.id}: unknown sharedMotifs ${unknown.join(', ')}`);
    if (new Set(canonical).size !== canonical.length) errors.push(`${entry.id}: duplicate canonical sharedMotifs`);
  }
  if (!entry.palette || !['primary', 'secondary', 'glow'].every((key) => /^#[0-9A-F]{6}$/i.test(entry.palette[key]))) {
    errors.push(`${entry.id}: palette must contain primary, secondary, and glow as hex colors`);
  }
  const exactImagePath = `assets/creatures/generated/${entry.id}.png`;
  if (entry.imagePath !== exactImagePath) errors.push(`${entry.id}: imagePath must be ${exactImagePath}`);
  if (!isNonEmptyString(entry.generationPrompt)) errors.push(`${entry.id}: generationPrompt must be a non-empty string`);
}

const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
const entriesByLineageStage = new Map();
for (const entry of entries) {
  const key = `${entry.lineageId}:S${entry.stage}`;
  const matches = entriesByLineageStage.get(key) ?? [];
  matches.push(entry);
  entriesByLineageStage.set(key, matches);
}

function resolveEvolutionReference(reference, owner) {
  if (!isNonEmptyString(reference)) {
    errors.push(`${owner.id}: evolutionFrom references must be non-empty strings`);
    return null;
  }
  if (/^PG-\d{3}$/.test(reference)) {
    const resolved = entriesById.get(reference);
    if (!resolved) errors.push(`${owner.id}: evolutionFrom references missing creature ${reference}`);
    return resolved ?? null;
  }
  const symbolic = /^(PG-L\d{3}):S([1-4])$/.exec(reference);
  if (!symbolic) {
    errors.push(`${owner.id}: invalid evolutionFrom reference ${reference}`);
    return null;
  }
  const matches = entriesByLineageStage.get(`${symbolic[1]}:S${symbolic[2]}`) ?? [];
  if (matches.length !== 1) {
    errors.push(`${owner.id}: ${reference} must resolve to exactly one creature, got ${matches.length}`);
    return null;
  }
  return matches[0];
}

const insignificantShapeWords = new Set([
  '형', '큰', '작은', '짧은', '긴', '개의', '개', '세', '두', '한', '갈래', '단계',
]);
function shapeTokens(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter((token) => token.length >= 2 && !insignificantShapeWords.has(token));
}

function shapeFeatureMatches(left, right) {
  const leftTokens = shapeTokens(left);
  const rightTokens = shapeTokens(right);
  return leftTokens.some((leftToken) => rightTokens.some(
    (rightToken) => leftToken.includes(rightToken) || rightToken.includes(leftToken),
  ));
}

const genericShapeVariationPattern = /(?:(?:\d+\s*)?단계(?:에서)?|stage\s*\d+|한\s*겹|더|다층(?:으로)?|확장(?:된|형)?|강화(?:된|형)?|완성(?:된|형)?|최종(?:형)?|진화(?:한|된|형)?|고도화(?:한|된)?|발달(?:한|된)?|증대(?:한|된)?|상위(?:형)?|고급(?:형)?|구조|형태|개체|버전|변화|변형)/gi;
const maximumLineageGlowDistance = 120;
function normalizeShapeFeatureForVariation(value) {
  return value
    .replace(genericShapeVariationPattern, ' ')
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(Boolean)
    .join(' ');
}

function sortedNormalizedShapeDNA(shapeDNA) {
  return (shapeDNA ?? []).map(normalizeShapeFeatureForVariation).sort();
}

function promptMentionsStage(prompt, stage) {
  if (stage === 1) return /(?:초기형|1\s*단계|stage\s*1|initial|starter)/i.test(prompt);
  return new RegExp(`(?:${stage}\\s*단계|stage\\s*${stage})`, 'i').test(prompt);
}

function promptContradictsStage(prompt, stage) {
  const mentionsAnotherStage = [1, 2, 3, 4]
    .filter((candidate) => candidate !== stage)
    .some((candidate) => new RegExp(`(?:${candidate}\\s*단계|stage\\s*${candidate}(?!\\d))`, 'i').test(prompt));
  const claimsInitialForm = stage > 1 && (
    /초기형\s*(?:이다|입니다|으로\s*(?:묘사|표현))/i.test(prompt)
    || /\b(?:is|depicted\s+as|rendered\s+as)\s+(?:an?\s+)?(?:initial|starter)\s+(?:form|creature)\b/i.test(prompt)
  );
  return mentionsAnotherStage || claimsInitialForm;
}

for (const entry of entries) {
  let references = [];
  if (entry.category === 'start') {
    if (entry.evolutionFrom !== null) errors.push(`${entry.id}: start evolutionFrom must be null`);
    if (entry.stage !== 1) errors.push(`${entry.id}: start creature must be stage 1`);
  } else if (entry.category === 'mixed') {
    if (!Array.isArray(entry.evolutionFrom) || entry.evolutionFrom.length !== 2) {
      errors.push(`${entry.id}: mixed evolutionFrom must contain exactly 2 references`);
    } else {
      references = entry.evolutionFrom;
      if (new Set(references).size !== 2) errors.push(`${entry.id}: mixed evolutionFrom references must be unique`);
    }
  } else if (!isNonEmptyString(entry.evolutionFrom)) {
    errors.push(`${entry.id}: ${entry.category} evolutionFrom must be exactly one string reference`);
  } else {
    references = [entry.evolutionFrom];
  }

  if (!promptMentionsStage(entry.generationPrompt, entry.stage)) {
    errors.push(`${entry.id}: generationPrompt does not identify stage ${entry.stage}`);
  }
  if (promptContradictsStage(entry.generationPrompt, entry.stage)) {
    errors.push(`${entry.id}: generationPrompt contradicts stage ${entry.stage}`);
  }

  for (const reference of references) {
    const parent = resolveEvolutionReference(reference, entry);
    if (!parent) continue;
    if (parent.id === entry.id) errors.push(`${entry.id}: evolutionFrom cannot reference itself`);
    if (parent.stage !== entry.stage - 1) {
      errors.push(`${entry.id}: parent ${parent.id} must be stage ${entry.stage - 1}, got ${parent.stage}`);
    }
    if (entry.category === 'normal_evolution' && parent.lineageId !== entry.lineageId) {
      errors.push(`${entry.id}: normal evolution must preserve lineageId ${parent.lineageId}`);
    }
    if (entry.category !== 'mixed' && parent.bodyForm !== entry.bodyForm) {
      errors.push(
        `${entry.id}: single-parent evolution must preserve bodyForm ${parent.bodyForm} from ${parent.id}`,
      );
    }
    if (entry.lineageId === parent.lineageId) {
      const glowDistance = colorDistance(hexToRgb(entry.palette.glow), hexToRgb(parent.palette.glow));
      if (glowDistance > maximumLineageGlowDistance) {
        errors.push(`${entry.id}: lineage glow drifts too far from parent ${parent.id} (${glowDistance.toFixed(1)} > ${maximumLineageGlowDistance})`);
      }
    }

    const preservedShapeFeatures = (parent.shapeDNA ?? []).filter((parentFeature) =>
      (entry.shapeDNA ?? []).some((feature) => shapeFeatureMatches(parentFeature, feature)));
    if (preservedShapeFeatures.length < 2) {
      errors.push(`${entry.id}: shapeDNA preserves ${preservedShapeFeatures.length}/3 features from ${parent.id}; expected at least 2`);
    }
    if (JSON.stringify(sortedNormalizedShapeDNA(entry.shapeDNA)) === JSON.stringify(sortedNormalizedShapeDNA(parent.shapeDNA))) {
      errors.push(`${entry.id}: shapeDNA must add at least 1 concrete anatomical change from direct parent ${parent.id}`);
    }

    const parentMotifs = new Set(canonicalMotifs(parent));
    if (!canonicalMotifs(entry).some((motif) => parentMotifs.has(motif))) {
      errors.push(`${entry.id}: sharedMotifs has no canonical continuity with ${parent.id}`);
    }
  }
}

const normalChildrenByLineage = new Map();
for (const entry of entries.filter((candidate) => candidate.category === 'normal_evolution')) {
  normalChildrenByLineage.set(entry.lineageId, (normalChildrenByLineage.get(entry.lineageId) ?? 0) + 1);
}
for (const start of entries.filter((entry) => entry.category === 'start')) {
  if (!normalChildrenByLineage.has(start.lineageId)) {
    errors.push(`${start.id}: start lineage ${start.lineageId} has no normal evolution child`);
  }
  const lineageStages = entries
    .filter((entry) => entry.lineageId === start.lineageId && ['start', 'normal_evolution'].includes(entry.category))
    .map((entry) => entry.stage)
    .sort((left, right) => left - right);
  const expectedStages = Array.from({ length: Math.max(...lineageStages) }, (_, index) => index + 1);
  if (JSON.stringify(lineageStages) !== JSON.stringify(expectedStages)) {
    errors.push(`${start.id}: lineage ${start.lineageId} stages must be contiguous and unique, got ${lineageStages.join(',')}`);
  }
}

function countCategories(selectedCategories) {
  return entries.filter((entry) => selectedCategories.includes(entry.category)).length;
}

const expected = { total: 256, start: 64, normal: 133, special: 34, mutant: 25 };
const actual = {
  total: entries.length,
  start: countCategories(['start']),
  normal: countCategories(['normal_evolution']),
  special: countCategories(['branch', 'mixed', 'special']),
  mutant: countCategories(['mutant']),
};

for (const key of Object.keys(expected)) {
  if (actual[key] !== expected[key]) errors.push(`${key}: expected ${expected[key]}, got ${actual[key]}`);
}

const ids = [...seenIds].sort();
for (let number = 1; number <= 256; number += 1) {
  const id = `PG-${String(number).padStart(3, '0')}`;
  if (!seenIds.has(id)) errors.push(`missing id: ${id}`);
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, files, actual, errorCount: errors.length, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, files, actual, first: ids[0], last: ids.at(-1) }, null, 2));
