import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const root = process.cwd();
const canonicalPath = path.join(root, 'production/catalog/creatures.json');
const catalog = JSON.parse(await readFile(canonicalPath, 'utf8'));

function colorDistance(left, right) {
  return Math.hypot(...left.map((channel, index) => channel - right[index]));
}

function hexToRgb(hex) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function hueDegrees(rgb) {
  const [red, green, blue] = rgb.map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta === 0) {
    return null;
  }
  let sector;
  if (maximum === red) {
    sector = ((green - blue) / delta) % 6;
  } else if (maximum === green) {
    sector = (blue - red) / delta + 2;
  } else {
    sector = (red - green) / delta + 4;
  }
  return (sector * 60 + 360) % 360;
}

function hueDistance(left, right) {
  const difference = Math.abs(left - right);
  return Math.min(difference, 360 - difference);
}

function chroma(rgb) {
  return Math.max(...rgb) - Math.min(...rgb);
}

async function paletteCandidates(entry) {
  const image = PNG.sync.read(await readFile(path.join(root, entry.imagePath)));
  const bins = new Map();
  let opaquePixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] < 128) continue;
    opaquePixels += 1;
    const rgb = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    const maximum = Math.max(...rgb);
    const minimum = Math.min(...rgb);
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
    if (maximum < 100 || saturation < 0.08) continue;
    const quantized = rgb.map((channel) => Math.min(248, Math.floor(channel / 8) * 8 + 4));
    const key = quantized.join(',');
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const minimumCount = Math.max(100, Math.ceil(opaquePixels * 0.0001));
  return [...bins.entries()]
    .filter(([, count]) => count >= minimumCount)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => ({ rgb: key.split(',').map(Number), count }));
}

const representativeAnchors = new Map([
  ['PG-L001', '#39E6E0'],
  ['PG-L025', '#66E6FF'],
  ['PG-L033', '#66E6FF'],
  ['PG-L047', '#63E6BE'],
]);

const semanticAnchorRules = [
  [/(?:시안|민트|청록|아쿠아)(?:색|빛|광)?/, '#40D8D0'],
  [/(?:하늘|청색|파랑|푸른)(?:색|빛|광)?/, '#58A8E0'],
  [/(?:연두|초록|황록|녹색)(?:색|빛|광)?/, '#80C840'],
  [/(?:황금|노랑|황색|레몬|전광노랑)(?:색|빛|광)?/, '#E8C040'],
  [/(?:주황|오렌지)(?:색|빛|광)?/, '#E87830'],
  [/(?:분홍|마젠타|자홍|핑크)(?:색|빛|광)?/, '#E878C0'],
  [/(?:보라|자주)(?:색|빛|광)?/, '#9870D0'],
  [/(?:붉은|빨강|적색|주홍|산호)(?:색|빛|광)?/, '#D85858'],
  [/(?:백색|진주|은빛|흰빛)(?:색|빛|광)?/, '#D8E8F0'],
  [/(?:크림|복숭아크림|상아)(?:색|빛|광)?/, '#E8C8A8'],
];

function findSemanticAnchorRule(text) {
  return semanticAnchorRules.find(([pattern]) => pattern.test(text));
}

function semanticAnchor(entry) {
  const glowPhrases = entry.generationPrompt.match(/[가-힣]{1,8}광[가-힣]{0,4}/g) ?? [];
  let matched;
  for (let index = glowPhrases.length - 1; index >= 0 && !matched; index -= 1) {
    matched = findSemanticAnchorRule(glowPhrases[index]);
  }
  matched ??= findSemanticAnchorRule(entry.generationPrompt);
  if (!matched) {
    throw new Error(`${entry.lineageId}: cannot infer glow-color semantics from start prompt`);
  }
  const inferredAnchor = hexToRgb(matched[1]);
  const explicit = representativeAnchors.get(entry.lineageId);
  if (!explicit) {
    return inferredAnchor;
  }

  const explicitAnchor = hexToRgb(explicit);
  const inferredHue = hueDegrees(inferredAnchor);
  const explicitHue = hueDegrees(explicitAnchor);
  if (inferredHue === null || explicitHue === null || hueDistance(inferredHue, explicitHue) > 45) {
    throw new Error(`${entry.lineageId}: representative anchor contradicts prompt glow semantics`);
  }
  return explicitAnchor;
}

function chooseSequence(entries, candidateSets) {
  const layers = [];
  const lineageAnchor = semanticAnchor(entries[0]);
  const anchorHue = hueDegrees(lineageAnchor);
  const requireHueMatch = chroma(lineageAnchor) >= 50;
  const semanticCandidateSets = candidateSets.map((candidates, index) => {
    const matching = candidates.filter((candidate) => {
      const candidateHue = hueDegrees(candidate.rgb);
      return colorDistance(candidate.rgb, lineageAnchor) <= 190
        && (!requireHueMatch || (
          chroma(candidate.rgb) <= 24
          || (anchorHue !== null
            && candidateHue !== null
            && hueDistance(candidateHue, anchorHue) <= 45)
        ));
    });
    if (matching.length === 0) {
      const nearest = candidates
        .map((candidate) => ({ ...candidate, distance: Math.round(colorDistance(candidate.rgb, lineageAnchor)) }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 5);
      throw new Error(`${entries[index].id}: no visible palette cluster matches lineage glow semantics; nearest=${JSON.stringify(nearest)}`);
    }
    return matching;
  });
  for (const [stageIndex, candidates] of semanticCandidateSets.entries()) {
    const current = hexToRgb(entries[stageIndex].palette.glow);
    const layer = candidates.map((candidate, candidateIndex) => {
      const ownCost = colorDistance(candidate.rgb, current) * 0.15
        + colorDistance(candidate.rgb, lineageAnchor) * 8
        - Math.log(candidate.count) * 2;
      if (stageIndex === 0) return { candidateIndex, cost: ownCost, previousIndex: -1 };
      let best = null;
      for (const previous of layers[stageIndex - 1]) {
        const transition = colorDistance(candidate.rgb, semanticCandidateSets[stageIndex - 1][previous.candidateIndex].rgb);
        if (transition > 120) continue;
        const cost = previous.cost + ownCost + transition * 2;
        if (!best || cost < best.cost) best = { candidateIndex, cost, previousIndex: previous.candidateIndex };
      }
      return best;
    }).filter(Boolean);
    if (layer.length === 0) {
      throw new Error(`${entries[0].lineageId}: no visible glow-color path with RGB distance <=120`);
    }
    layers.push(layer);
  }
  const sequence = Array(entries.length);
  let selected = layers.at(-1).reduce((best, item) => item.cost < best.cost ? item : best);
  for (let stageIndex = entries.length - 1; stageIndex >= 0; stageIndex -= 1) {
    sequence[stageIndex] = semanticCandidateSets[stageIndex][selected.candidateIndex].rgb;
    if (stageIndex > 0) selected = layers[stageIndex - 1].find(({ candidateIndex }) => candidateIndex === selected.previousIndex);
  }
  return sequence;
}

const starts = catalog.filter((entry) => entry.category === 'start');
let updatedGlowCount = 0;
for (const start of starts) {
  const lineageEntries = catalog
    .filter((entry) => entry.lineageId === start.lineageId && ['start', 'normal_evolution'].includes(entry.category))
    .sort((left, right) => left.stage - right.stage);
  const candidateSets = await Promise.all(lineageEntries.map(paletteCandidates));
  const sequence = chooseSequence(lineageEntries, candidateSets);
  for (const [index, entry] of lineageEntries.entries()) {
    const glow = rgbToHex(sequence[index]);
    const previous = entry.palette.glow;
    entry.palette.glow = glow;
    entry.generationPrompt = entry.generationPrompt.replaceAll(previous, glow);
    if (previous !== glow) {
      updatedGlowCount += 1;
    }
  }
}

const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
const segmentPaths = [
  'production/catalog/creatures-001-080.json',
  'production/catalog/creatures-081-160.json',
  'production/catalog/creatures-161-240.json',
];
for (const relativePath of segmentPaths) {
  const filePath = path.join(root, relativePath);
  const entries = JSON.parse(await readFile(filePath, 'utf8')).map((entry) => catalogById.get(entry.id));
  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`);
}
await writeFile(canonicalPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ lineages: starts.length, updated: updatedGlowCount }, null, 2));
