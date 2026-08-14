<!-- readme-section:hero -->
<div align="center">
  <p><code>DIGITAL FAMILIAR SYSTEM // LOCAL MACOS ALPHA</code></p>
  <h1>PunchGrow</h1>
  <p><strong>The creature game that grows when you code</strong></p>
  <p>A local-first macOS creature game that turns<br />Claude Code and Codex usage into growth energy.</p>

  <p>
    <a href="README.md">한국어</a>
    ·
    <a href="README.en.md"><strong>English</strong></a>
    ·
    <a href="https://punchgrow.thundo.kr/en/">Official website</a>
  </p>

  <p>
    <img alt="v0.3.0 alpha release" src="https://img.shields.io/badge/release-v0.3.0_alpha-C6F84E?style=flat-square&logoColor=08111F" />
    <img alt="Apple Silicon macOS 14 or newer" src="https://img.shields.io/badge/Apple_Silicon-macOS_14%2B-4DE1FF?style=flat-square&logo=apple&logoColor=white" />
    <img alt="main has 256 creatures and release has 240 creatures" src="https://img.shields.io/badge/catalog-main_256_%7C_release_240-FFB84D?style=flat-square&logoColor=08111F" />
    <img alt="Local-first privacy" src="https://img.shields.io/badge/privacy-local--first-FF4D9D?style=flat-square&logoColor=white" />
  </p>

  <img src="docs/readme/neon-command-deck.png" width="960" alt="Neon Command Deck connecting the real PunchGrow menu popup, rarity index, Evolution Dex, and four Elemental Origin creatures" />

  <p>
    <a href="#quick-start"><strong>Install</strong></a>
    ·
    <a href="https://punchgrow.thundo.kr/en/dex/">Live dex</a>
    ·
    <a href="docs/USAGE.en.md">User guide</a>
    ·
    <a href="#privacy">Privacy</a>
    ·
    <a href="docs/PROJECT_STRUCTURE.md#english">Repository map</a>
  </p>
</div>

<table>
  <tr>
    <td width="33%" valign="top">
      <strong>PLAYER // INSTALL</strong><br />
      Install the app and wake your first creature.<br />
      <a href="#quick-start">Quick start →</a>
    </td>
    <td width="34%" valign="top">
      <strong>SCOUT // EXPLORE</strong><br />
      Inspect real screens, game rules, and the privacy boundary.<br />
      <a href="#live-systems">Explore the product →</a>
    </td>
    <td width="33%" valign="top">
      <strong>BUILDER // CONTRIBUTE</strong><br />
      Read the structure and verification flow, then build with us.<br />
      <a href="#contributing">Start contributing →</a>
    </td>
  </tr>
</table>

---

<!-- readme-section:status -->
> [!IMPORTANT]
> **Project status: v0.3.0 alpha development line.** The intended public scope of this repository is the Apple Silicon macOS 14+ menu-bar app.

| `RELEASE // v0.3.0` | `SOURCE // main` |
| --- | --- |
| The Homebrew release published on 2026-08-07 contains the **240-creature** catalog available at that time. The binary is ad-hoc signed; Developer ID signing and Apple notarization remain later release steps. | Current source and the public dex contain **64 starting lineages and 256 creatures**. The 16 later additions remain source-only on `main` until the next versioned app release. |

GitHub Actions with Full Xcode verifies the Swift test suite, Release build, 256-creature resource assembly, and ad-hoc signature. The official website at [`punchgrow.thundo.kr`](https://punchgrow.thundo.kr/en/) is built and deployed from this repository's `website/` directory through GitHub Pages. It is a static product and 256-creature dex site with no backend or usage collection.

<!-- readme-section:quick-start -->
<a name="quick-start"></a>
## `01 // BOOT SEQUENCE` — Quick start

### Install with Homebrew (recommended)

Requirements: Apple Silicon, macOS 14 or newer.

```bash
brew tap yoonsundo/punchgrow https://github.com/yoonsundo/punchgrow
brew trust yoonsundo/punchgrow
brew install --cask punchgrow
xattr -d com.apple.quarantine /Applications/PunchGrow.app
```

Homebrew v0.3.0 contains the 240-creature release catalog. Build the current `main` source below to use the complete 256-creature catalog shown in the public dex; those 16 later additions are planned for the next versioned app release. The published binary is ad-hoc signed and not yet notarized by Apple, so the final `xattr` command is required to clear the quarantine attribute before the first launch. On Homebrew versions before 6, skip the `brew trust` step. The `--no-quarantine` flag from older guides was removed in Homebrew 6 and no longer works.

The [complete user guide](docs/USAGE.en.md) covers installation, collection states, gameplay, backup, removal, privacy, and troubleshooting with screenshots.

<!-- readme-section:core-loop -->
<a name="core-loop"></a>
## `02 // CORE LOOP` — The core experience

| `CODE` | `COLLECT` | `GROW` | `STAY PRIVATE` |
| --- | --- | --- | --- |
| Claude Code and Codex usage becomes game tokens. | Discover 256 creatures across 64 lineages. | Feed, branch-evolve, and find unique-color variants. | Prompts and code stay out of the data model and processing stays on your Mac. |

### Why PunchGrow exists

AI-assisted coding already produces a useful activity signal: token usage. PunchGrow makes that signal playful without collecting the work itself. The local collector is designed around numeric usage only—prompts, responses, source code, commands, project names, account identifiers, and raw file paths are outside the game data model.

<!-- readme-section:privacy -->
<a name="privacy"></a>
## `03 // TRUST BOUNDARY` — Privacy model

The macOS app runs locally and collection is off until the user explicitly enables it.

### `LOCAL READS`

- Claude Code usage is discovered from `~/.claude/projects/**/*.jsonl`.
- Codex usage is discovered from `~/.codex/sessions/**/*.jsonl`.
- Claude's plan percentage is read from the local cache Claude Code writes; PunchGrow only runs Claude Code's status-line script to keep that cache fresh. Codex comes from log rate-limit metadata. PunchGrow neither reads nor stores authentication tokens.
- The first scan establishes a non-crediting baseline; only later increases earn game tokens.

### `LOCAL STATE`

- PunchGrow stores normalized token counts, timestamps, opaque hashes, incremental cursors, and game state.
- It does **not** store prompts, responses, source code, commands, project names, raw paths, emails, or account/model identifiers.
- Disconnecting and deleting the PunchGrow cache does not edit or delete the original Claude Code or Codex logs.

### `NETWORK EDGE`

- The update check (comparing a public GitHub Releases tag against the installed version) is the only network request PunchGrow itself sends. It is unauthenticated and carries no usage numbers or game state. A successful check is followed by one a day later; a failed one retries on a backoff starting at 60 seconds and capped at 24 hours. Turn it off anytime from **Settings > Data & Settings > 업데이트**.
- Separately, while collection is enabled PunchGrow runs the Claude Code status-line script noted above about once a minute, and that script queries the provider for plan usage with its own credentials. The script sends the request, but it goes out when it does because PunchGrow spawned the script. PunchGrow never reads those credentials. Turning collection off stops those runs.

See [the macOS documentation](macos/README.md) for the detailed collection and status model.

<!-- readme-section:screens -->
<a name="live-systems"></a>
## `04 // LIVE SYSTEMS` — Actual app screens

These are captures rendered by the current SwiftUI app. They use fixed documentation sample data and contain no user's private logs, prompts, or source code.

<p align="center">
  <img src="docs/screenshots/menu-popover.png" width="398" alt="PunchGrow main popup showing current rarity, maximum reachable rarity, weekly usage, feeding, and draw controls" />
</p>

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/rarity-guide.png" width="360" alt="PunchGrow rarity index showing direct draw odds and maximum-reachable-rarity lineage proportions" /><br /><strong>Rarity index</strong><br /><sub>Direct draw rarity is separate from maximum reachable rarity</sub></td>
    <td align="center"><img src="docs/screenshots/evolution-dex.png" width="372" alt="PunchGrow Evolution Dex showing owned past forms, the current form, locked future branches, and fusion-collectible handling" /><br /><strong>Evolution Dex</strong><br /><sub>Past, current, and future forms stay distinct; fusion collectibles remain current-form-only</sub></td>
  </tr>
</table>

[Open the complete user guide →](docs/USAGE.en.md)

<!-- readme-section:game-rules -->
<a name="game-engine"></a>
## `05 // GAME ENGINE` — Game rules

| Rule | Alpha value |
| --- | --- |
| One draw | `500,000` tokens |
| Draw result | One of 64 PROCESS stage-one creatures · PROCESS 100% |
| ORIGIN lineage | 7 of 64 starts · about 10.9% maximum reachable rarity, not a direct ORIGIN pull |
| Normal food | Costs `100,000` tokens · XP `+25` · affinity `+3` |
| Large food | Costs `500,000` tokens · XP `+200` · affinity `+10` |
| Unique color | Independent `0.1%` chance per draw, with no stat advantage |
| Duplicate creatures | Kept as separate individuals that can be raised differently |
| Evolution levels | Level 15 → stage 2 · level 25 → stage 3 · level 40 → stage 4 |
| Evolution fork | Once at each fork · pick one of 2 paths yourself; pauses until you choose |
| Fusion collectibles | The 10 `mixed` species stay outside ordinary evolution; legacy owned fusions remain available as current-form-only collectibles |
| Mutation trigger | `10%` chance at the level-15 evolution · accept ends growth, decline continues to the original selected or automatically determined target |
| Mutation retry | `1,000,000` tokens per attempt · `10%` chance, guaranteed after `30` failures in a lineage |
| Inheritance | `5,000,000` tokens · get a new same-lineage individual from a fully grown creature |
| Maximum level | Level 50. Legacy level 51–100 saves remain valid but cannot grow further |

### Growth and evolution

Draws never grant a higher-stage evolution directly. Every owned creature starts as PROCESS and grows as feeding raises its level. The UI separates the actual `Current <rarity>` from `Maximum reachable rarity <rarity>` — the ceiling reachable through selectable paths, excluding mutations — and pairs it with a minimum guaranteed rarity so an unclaimed fork does not read as a promise.

At each evolution fork (level 15 or level 25), you choose the evolution direction yourself from 2 options. Evolution pauses at the fork with a badge until you choose, and the choice applies to that evolution only — the next fork asks again.

The 10 `mixed` species combine unrelated creature families, so they are treated as fusion collectibles rather than same-individual growth. They never appear in automatic evolution, fork choices, potential calculations, or ordinary Evolution Dex ancestry. Existing saves that already own one keep it safely; its Evolution Dex shows only the actual current fusion form and does not invent a parent history.

Lineages with a mutation candidate get a 10% chance to trigger a mutation offer at the level-15 evolution, asking you to accept or decline. Accepting ends growth on the spot as a terminal mutant form; declining continues the evolution to the original target selected by the user or automatically determined before the offer. A missed chance can be retried with `변이 재도전` (Mutation Retry, 1,000,000 tokens per attempt, 10% chance); 30 failed retries in the same lineage guarantee the next attempt succeeds.

A creature raised to its final stage can use `계승` (Inheritance, 5,000,000 tokens) to obtain a new individual of the same starting species for raising a different fork. An ORIGIN-lineage draw is still a current PROCESS creature; the dedicated ORIGIN reveal is reserved for actually owning an ORIGIN species. A lineage with no next-stage catalog entry keeps its current form and can continue growing.

<!-- readme-section:creatures -->
<a name="creature-signal"></a>
## `06 // CREATURE SIGNAL` — The creature world

### The four Elemental Origin lineages

Water, fire, wind, and earth each grow through `PROCESS → AGENT → DAEMON → ORIGIN`. They follow the same catalog rules as every other lineage, while their final forms share a primordial sigil that marks them as a special class of ORIGIN.

<table>
  <tr>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-244.png" width="170" alt="Nervasil, the Water ORIGIN" /><br /><strong>Nervasil</strong><br /><sub>Water · the first wave that preserves memory</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-248.png" width="170" alt="Karmag, the Fire ORIGIN" /><br /><strong>Karmag</strong><br /><sub>Fire · the first will that makes possibility real</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-252.png" width="170" alt="Velaum, the Wind ORIGIN" /><br /><strong>Velaum</strong><br /><sub>Wind · ruler of the paths and the first breath</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-256.png" width="170" alt="Grandor, the Earth ORIGIN" /><br /><strong>Grandor</strong><br /><sub>Earth · the first foundation that bears the world</sub></td>
  </tr>
</table>

[Browse all four lineages in the English dex →](https://punchgrow.thundo.kr/en/dex/) · [Open the canonical design source (Korean) →](문서/ELEMENTAL_ORIGINS.md)

### Featured creatures

<table>
  <tr>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-001.png" width="140" alt="Eilu" /><br /><strong>Eilu</strong><br /><sub>PROCESS · PG-001</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-102.png" width="140" alt="Litonion" /><br /><strong>Litonion</strong><br /><sub>AGENT · PG-102</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-109.png" width="140" alt="Majelonrak" /><br /><strong>Majelonrak</strong><br /><sub>DAEMON · PG-109</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-193.png" width="140" alt="Quinon" /><br /><strong>Quinon</strong><br /><sub>ORACLE · PG-193</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-166.png" width="140" alt="Jarpenrak" /><br /><strong>Jarpenrak</strong><br /><sub>ARCHITECT · PG-166</sub></td>
    <td align="center"><img src="macos/Sources/PunchGrowMenuBar/Resources/Creatures/PG-211.png" width="140" alt="Pityon" /><br /><strong>Pityon</strong><br /><sub>ORIGIN · PG-211</sub></td>
  </tr>
</table>

> [!CAUTION]
> The featured creatures and other artwork are covered by the separate [visual asset license](ASSET-LICENSE.md), not MIT.

<!-- readme-section:actual-plan-usage -->
<a name="usage-signal"></a>
## `07 // USAGE SIGNAL` — Actual plan usage

The `C n%` and `X n%` values in the menu bar are not token-based estimates.

| Signal | Actual data source |
| --- | --- |
| `C` | Reads Claude's actual weekly percentage from the `~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json` cache. Only Claude Code writes that cache, so PunchGrow runs its status-line script once a minute to keep the value from going stale. It stays pending when the cache is absent. |
| `X` | Reads Codex's actual weekly `used_percent` from session rate-limit metadata. |

- With automatic collection enabled, PunchGrow checks approximately every ten seconds.
- Provider updates automatically reflect both increased usage and weekly resets.
- Missing data is shown as pending instead of inventing a `0%` value.

<!-- readme-section:walkthrough -->
<a name="first-run"></a>
## `08 // FIRST RUN` — Five-minute walkthrough

1. Launch PunchGrow and find its creature in the macOS menu bar rather than the Dock.
2. Open the popup, choose `Settings` in the footer, then select `Connections` in the large window's sidebar.
3. Choose `수집 동의 및 시작` (Start Collection) to opt into checking numeric Claude Code and Codex usage approximately every ten seconds.
4. The first scan establishes a non-crediting baseline. Only later increases add spendable tokens.
5. Buy food, draw creatures, and use `Rarity` and `Evolution` to inspect long-term growth.

<!-- readme-section:repository -->
<a name="source-map"></a>
## `09 // SOURCE MAP` — What's in this repository

| Area | Status | Purpose |
| --- | --- | --- |
| `macos/` | v0.3.0 | Native SwiftUI menu-bar game for Apple Silicon macOS 14+ |
| `website/` | Public | GitHub Pages homepage and bilingual 256-creature dex |
| `app/`, `components/`, `src/mobile/` | Retained exploration | Expo Router mobile prototype and shared domain logic |
| `web/`, `server/` | Local MVP | Docker Compose web/PostgreSQL experiment. This is not the public homepage. |
| `docs/` | Public docs | Usage guides, repository map, and reproducible QA material |
| `문서/` | Product record | PRD, decisions, glossary, wireframes, and creature design rules |
| `production/`, `scripts/` | Verification base | Canonical catalog, public evidence, and reproducibility tools |

[Open the repository map with task-based starting points and dependencies →](docs/PROJECT_STRUCTURE.md#english)

The current game includes a 64-species stage-one draw pool, level 15/25/40 evolution with fork choices, mutations, inheritance, 10 standalone fusion collectibles outside ordinary evolution, six evolution tiers (`PROCESS` → `ORIGIN`), unique-color variants, feeding, local save/restore, and a 256-creature catalog.

In the macOS popup, holding a normal/large food purchase or feed button accelerates repeated actions until release. Draw feedback and the main card show current rarity and maximum reachable rarity separately. The fixed footer's `Rarity` guide separates direct `PROCESS 100%` draws from maximum-reachable-rarity lineage proportions such as `ORIGIN lineage 7/64 (about 10.9%)`, plus owned, discovered, and total creature counts by tier. `Evolution` shows the selected creature's complete image-based lineage and marks only the forms that this individual actually passed through as owned, previewable, and available to fix as its displayed appearance; future stages and unchosen sibling branches remain locked. `Collection` and `Settings` open the large window directly. Higher stages receive progressively richer badge, frame, and aura effects.

<!-- readme-section:source-build -->
<a name="source-build"></a>
## `10 // BUILD FROM SOURCE` — Build from source

Requirements: Apple Silicon, macOS 14 or newer, and a matched Full Xcode / Command Line Tools installation.

First-time users can choose **Code → Download ZIP** on the GitHub repository page, extract it, and open the extracted `macos` directory in Terminal. The [user guide](docs/USAGE.en.md) gives the beginner-friendly sequence.

```bash
cd macos
./scripts/build-app.sh
open .build/PunchGrow.app
```

The app assembled from current `main` contains 256 creatures and is ad-hoc signed for local use. Developer ID signing and Apple notarization remain separate release-account steps; once complete, the quarantine-clearing (`xattr`) step will no longer be needed.

<!-- readme-section:verification -->
<a name="verification"></a>
## `11 // VERIFICATION` — Verification

Run the checks relevant to the area you changed:

```bash
cd macos
swift test
swift build -c release
./scripts/build-app.sh

cd ../website
npm test
```

Some macOS checks require a compatible installed Apple SDK. The creature verification commands validate the release-sized asset pack included in the repository; source artwork and generation history are intentionally excluded from Git.

<!-- readme-section:contributing -->
<a name="contributing"></a>
## `12 // CONTRIBUTE` — Contributing

Issues and focused pull requests are welcome. New to open source? The [contributing guide](CONTRIBUTING.en.md) walks through the whole fork-to-PR flow. Before opening a pull request:

1. Read the [macOS guide](macos/README.md) for collection and privacy boundaries.
2. Never add collection of prompts, responses, source code, commands, raw paths, email addresses, or account identifiers.
3. Add or update tests for behavior changes and run the relevant verification commands above.

Use the [support guide](SUPPORT.md#english) for general help and the private path in the [security policy](SECURITY.md#english) for security or privacy-sensitive findings.

<!-- readme-section:licenses -->
<a name="license-boundary"></a>
## `13 // LICENSE BOUNDARY` — Licenses and artwork

<p>
  <img alt="Swift 6" src="https://img.shields.io/badge/Swift-6-FF4D9D?style=flat-square&logo=swift&logoColor=white" />
  <img alt="MIT source license" src="https://img.shields.io/badge/source-MIT-FFB84D?style=flat-square" />
</p>

Source code is available under the [MIT License](LICENSE).

Creature images and other visual artwork are **not** licensed under MIT. They are provided only so people can run, evaluate, and contribute to PunchGrow locally. A fork kept to propose changes back to the official repository (pull requests) may keep the artwork as is; any other public redistribution or standalone release must remove or replace the protected artwork unless it has separate written permission. Read [ASSET-LICENSE.md](ASSET-LICENSE.md) for the exact terms.

Third-party acknowledgements are listed in [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

<!-- readme-section:acknowledgement -->
## Acknowledgement

PunchGrow's local usage-discovery approach was inspired by [PokeTokenBar](https://github.com/chattymin/PokeTokenBar). PunchGrow is an independent implementation and does not include Pokémon names, sprites, or artwork.
