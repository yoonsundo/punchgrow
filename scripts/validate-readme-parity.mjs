import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePaths = {
  ko: path.join(root, "README.md"),
  en: path.join(root, "README.en.md"),
};
const readmes = {
  ko: await readFile(readmePaths.ko, "utf8"),
  en: await readFile(readmePaths.en, "utf8"),
};
const usageGuides = {
  ko: await readFile(path.join(root, "docs/USAGE.md"), "utf8"),
  en: await readFile(path.join(root, "docs/USAGE.en.md"), "utf8"),
};
const macosReadme = await readFile(path.join(root, "macos/README.md"), "utf8");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function collect(pattern, text, group = 1) {
  return [...text.matchAll(pattern)].map((match) => match[group]);
}

function sameSequence(label, left, right) {
  check(
    JSON.stringify(left) === JSON.stringify(right),
    label + " differ:\n  ko=" + JSON.stringify(left) + "\n  en=" + JSON.stringify(right),
  );
}

const expectedMarkers = [
  "hero",
  "status",
  "quick-start",
  "core-loop",
  "privacy",
  "screens",
  "game-rules",
  "creatures",
  "actual-plan-usage",
  "walkthrough",
  "repository",
  "source-build",
  "verification",
  "contributing",
  "licenses",
  "acknowledgement",
];

const markers = Object.fromEntries(
  Object.entries(readmes).map(([locale, text]) => [
    locale,
    collect(/<!-- readme-section:([a-z0-9-]+) -->/g, text),
  ]),
);
sameSequence("README section markers", markers.ko, markers.en);
sameSequence("README section contract", markers.ko, expectedMarkers);

const expectedAnchors = [
  "quick-start",
  "core-loop",
  "privacy",
  "live-systems",
  "game-engine",
  "creature-signal",
  "usage-signal",
  "first-run",
  "source-map",
  "source-build",
  "verification",
  "contributing",
  "license-boundary",
];
const anchors = Object.fromEntries(
  Object.entries(readmes).map(([locale, text]) => [
    locale,
    collect(/<a name="([^"]+)"><\/a>/g, text),
  ]),
);
sameSequence("README anchor sequence", anchors.ko, anchors.en);
sameSequence("README anchor contract", anchors.ko, expectedAnchors);

const headings = Object.fromEntries(
  Object.entries(readmes).map(([locale, text]) => [
    locale,
    collect(/^(#{1,6})\s+/gm, text).map((hashes) => hashes.length),
  ]),
);
sameSequence("Heading depth sequence", headings.ko, headings.en);

const commandBlocks = Object.fromEntries(
  Object.entries(readmes).map(([locale, text]) => [
    locale,
    collect(/```bash\n([\s\S]*?)```/g, text).map((block) => block.trim()),
  ]),
);
sameSequence("Bash command blocks", commandBlocks.ko, commandBlocks.en);
check(
  commandBlocks.ko.length === 3,
  "Expected 3 Bash command blocks, found " + commandBlocks.ko.length,
);

const imageSources = Object.fromEntries(
  Object.entries(readmes).map(([locale, text]) => [
    locale,
    collect(/<img\b[^>]*\bsrc="([^"]+)"/g, text),
  ]),
);
sameSequence("Image source sequence", imageSources.ko, imageSources.en);

const tableSignals = Object.fromEntries(
  Object.entries(readmes).map(([locale, text]) => [
    locale,
    {
      markdownRows: collect(/^\|/gm, text, 0).length,
      htmlRows: collect(/<tr>/g, text, 0).length,
      htmlCells: collect(/<td\b/g, text, 0).length,
    },
  ]),
);
check(
  JSON.stringify(tableSignals.ko) === JSON.stringify(tableSignals.en),
  "Table structures differ: ko=" +
    JSON.stringify(tableSignals.ko) +
    " en=" +
    JSON.stringify(tableSignals.en),
);

const semanticClaims = [
  ["release version", /v0\.4\.0/],
  ["Apple Silicon", /Apple Silicon/],
  ["macOS 14+", /macOS 14\+/],
  ["256-creature release and main catalog", /256/],
  ["64 starting lineages", /64/],
  ["ad-hoc signing", /ad-hoc/],
  ["notarization status", /(공증|notari[sz])/i],
  ["10 mixed fusion collectibles", /(mixed[\s\S]{0,80}10|10[\s\S]{0,80}mixed)/i],
  ["Claude JSONL path", /~\/\.claude\/projects\/\*\*\/\*\.jsonl/],
  ["Codex JSONL path", /~\/\.codex\/sessions\/\*\*\/\*\.jsonl/],
  ["Claude usage cache", /usage-cache-anthropic\.json/],
  ["local-first boundary", /local-first/i],
  ["MIT source license", /MIT/],
];

for (const [label, pattern] of semanticClaims) {
  for (const [locale, text] of Object.entries(readmes)) {
    check(pattern.test(text), locale + " README is missing semantic claim: " + label);
  }
}

const localizedClaims = [
  [
    "mutation decline continues the planned evolution",
    /거절하면 발동 전에 사용자가 선택했거나 시스템이 자동으로 정한 원래 대상으로/,
    /declining continues the evolution to the original target selected by the user or automatically determined/,
  ],
  [
    "owned past forms can become the displayed appearance",
    /미리 보거나 외형으로 고정/,
    /available to fix as its displayed appearance/,
  ],
  [
    "user guide includes privacy coverage",
    /백업·삭제·개인정보 보호·문제 해결/,
    /backup, removal, privacy, and troubleshooting/,
  ],
];
for (const [label, koreanPattern, englishPattern] of localizedClaims) {
  check(koreanPattern.test(readmes.ko), "ko README is missing localized claim: " + label);
  check(englishPattern.test(readmes.en), "en README is missing localized claim: " + label);
}
check(!/평생 최대 1회/.test(readmes.ko), "ko README must describe choices per fork, not as a lifetime flag");
check(!/once per lifetime/i.test(readmes.en), "en README must describe choices per fork, not as a lifetime flag");

const usageGuideClaims = [
  ["current-main screenshot scope", /현재 `main` 앱이 직접 렌더링/, /current `main` SwiftUI app/],
  [
    "v0.4.0 64-creature draw pool",
    /가챠 1회 · Homebrew v0\.4\.0 \| 500,000 토큰 · 64종 PROCESS 시작형/,
    /Homebrew v0\.4\.0 draws from 64 stage-one creatures/,
  ],
  [
    "current-main 64-creature draw pool",
    /가챠 1회 · 현재 `main` \| 500,000 토큰 · 64종 PROCESS 시작형/,
    /Current `main` draws from 64 stage-one creatures/,
  ],
  ["v0.4.0 and current-main 7 of 64 ORIGIN lineages", /v0\.4\.0 배포본과 현재 `main` 소스[\s\S]{0,100}\*\*7\/64, 약 10\.9%\*\*/, /v0\.4\.0 release and on current `main`[\s\S]{0,100}\*\*7\/64, or about 10\.9%\*\*/],
  [
    "mutation decline continues the planned evolution",
    /거절하면 발동 전에 사용자가 선택했거나 시스템이 자동으로 정한 원래 대상으로/,
    /declining continues the evolution to the original target selected by the user or automatically determined/,
  ],
];
for (const [label, koreanPattern, englishPattern] of usageGuideClaims) {
  check(koreanPattern.test(usageGuides.ko), "ko usage guide is missing claim: " + label);
  check(englishPattern.test(usageGuides.en), "en usage guide is missing claim: " + label);
}

const staleUsageGuideClaims = [
  ["ko", /거절하면 갈림길 선택으로 돌아갑니다/],
  ["en", /declining returns you to the fork choice/],
];
for (const [locale, pattern] of staleUsageGuideClaims) {
  check(!pattern.test(usageGuides[locale]), locale + " usage guide still contains stale catalog or mutation copy");
}
check(!/once per lifetime/i.test(usageGuides.en), "en usage guide must describe choices per fork, not as a lifetime flag");
check(
  /published Homebrew v0\.4\.0 release and current `main` both contain 64[\s\S]{0,80}starting lineages and 256 creatures/.test(macosReadme),
  "macOS README must state the shared v0.4.0 and current-main catalog sizes",
);
check(
  /Seven of the 64 starting lineages on current `main` and in the published[\s\S]{0,160}proportion is 7\/64, about 10\.9%/.test(macosReadme),
  "macOS README must state the shared current-main and v0.4.0 ORIGIN proportion",
);

check(
  readmes.ko.includes('href="https://punchgrow.thundo.kr"'),
  "Korean README must link to the Korean website root",
);
check(
  readmes.en.includes('href="https://punchgrow.thundo.kr/en/"'),
  "English README must link to the English website route",
);
check(
  readmes.ko.includes("https://punchgrow.thundo.kr/dex/"),
  "Korean README must link to the Korean dex",
);
check(
  readmes.en.includes("https://punchgrow.thundo.kr/en/dex/"),
  "English README must link to the English dex",
);

const localTargetPattern = /(?:href|src)="([^"]+)"|\[[^\]]*\]\(([^)]+)\)/g;
for (const [locale, text] of Object.entries(readmes)) {
  const explicitIds = new Set(collect(/<a name="([^"]+)"><\/a>/g, text));
  for (const match of text.matchAll(localTargetPattern)) {
    const rawTarget = match[1] ?? match[2];
    if (!rawTarget || /^(?:https?:|mailto:)/.test(rawTarget)) continue;
    if (rawTarget.startsWith("#")) {
      const fragment = decodeURIComponent(rawTarget.slice(1));
      check(
        explicitIds.has(fragment),
        locale + " README has an unresolved local anchor: " + rawTarget,
      );
      continue;
    }

    const [filePart] = rawTarget.split("#", 1);
    if (!filePart) continue;
    const targetPath = path.resolve(root, decodeURIComponent(filePart));
    check(
      targetPath.startsWith(root + path.sep),
      locale + " README target escapes repository: " + rawTarget,
    );
    try {
      await access(targetPath);
    } catch {
      failures.push(locale + " README target does not exist: " + rawTarget);
    }
  }
}

const heroPath = path.join(root, "docs/readme/neon-command-deck.png");
const hero = await readFile(heroPath);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
check(hero.subarray(0, 8).equals(pngSignature), "README hero is not a valid PNG");
if (hero.length >= 24) {
  check(
    hero.readUInt32BE(16) === 1600,
    "README hero width must be 1600, got " + hero.readUInt32BE(16),
  );
  check(
    hero.readUInt32BE(20) === 900,
    "README hero height must be 900, got " + hero.readUInt32BE(20),
  );
}
check(
  hero.length <= 1_500_000,
  "README hero must stay at or below 1.5 MB, got " + hero.length + " bytes",
);

const screenshotContracts = [
  ["docs/screenshots/menu-popover.png", 398, 670],
  ["docs/screenshots/rarity-guide.png", 360, 490],
  ["docs/screenshots/evolution-dex.png", 372, 550],
];
for (const [relativePath, expectedWidth, expectedHeight] of screenshotContracts) {
  const screenshot = await readFile(path.join(root, relativePath));
  check(screenshot.subarray(0, 8).equals(pngSignature), relativePath + " is not a valid PNG");
  if (screenshot.length >= 24) {
    check(
      screenshot.readUInt32BE(16) === expectedWidth,
      relativePath + " width must be " + expectedWidth,
    );
    check(
      screenshot.readUInt32BE(20) === expectedHeight,
      relativePath + " height must be " + expectedHeight,
    );
  }
}
const assetLicense = await readFile(path.join(root, "ASSET-LICENSE.md"), "utf8");
check(
  assetLicense.includes("`docs/readme/`"),
  "ASSET-LICENSE.md must cover the derived README visual directory",
);

if (failures.length > 0) {
  console.error("README parity validation failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log(
  "README parity OK: " +
    expectedMarkers.length +
    " paired sections, " +
    commandBlocks.ko.length +
    " command blocks, " +
    imageSources.ko.length +
    " shared images, 1600x900 hero",
);
