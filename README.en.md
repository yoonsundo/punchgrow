<div align="center">
  <img src="에셋/icon.png" width="132" alt="PunchGrow app icon" />

  <h1>PunchGrow</h1>

  <p><strong>The creature game that grows when you code</strong></p>
  <p>Earn tokens from Claude Code and Codex usage,<br />hatch and raise creatures, and complete a 240-creature collection.</p>

  <p>
    <a href="README.md">한국어</a>
    ·
    <a href="README.en.md"><strong>English</strong></a>
  </p>

  <p>
    <img alt="v0.2.0" src="https://img.shields.io/badge/version-v0.2.0-C6F84E?style=flat-square&logoColor=08111F" />
    <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-4DE1FF?style=flat-square&logo=apple&logoColor=white" />
    <img alt="Swift 6" src="https://img.shields.io/badge/Swift-6-FF4D9D?style=flat-square&logo=swift&logoColor=white" />
    <img alt="Local First" src="https://img.shields.io/badge/data-local--first-C6F84E?style=flat-square&logoColor=08111F" />
    <img alt="MIT source license" src="https://img.shields.io/badge/source-MIT-FFB84D?style=flat-square" />
  </p>

  <p>
    <a href="#quick-start">Quick start</a>
    ·
    <a href="docs/USAGE.en.md">User guide</a>
    ·
    <a href="macos/README.md">Developer guide</a>
    ·
    <a href="#privacy-model">Privacy</a>
    ·
    <a href="#contributing">Contributing</a>
  </p>
</div>

---

> **Project status: v0.2.0 alpha.** The intended public scope of this repository is the Apple Silicon macOS 14+ menu-bar app.

GitHub Actions with Full Xcode verifies the Swift test suite, Release build, 240-creature resource assembly, and ad-hoc signature. A public Homebrew binary still requires Developer ID signing and Apple notarization.

## The core experience

| Code | Collect | Grow | Stay private |
| --- | --- | --- | --- |
| Claude Code and Codex usage becomes game tokens. | Discover 240 creatures across six rarity tiers. | Feed, evolve, and find unique-color variants. | Prompts and code stay out of the data model and processing stays on your Mac. |

## Actual app screens

These are captures rendered by the current SwiftUI app. They use fixed documentation sample data and contain no user's private logs, prompts, or source code.

<p align="center">
  <img src="docs/screenshots/menu-popover.png" width="398" alt="PunchGrow main popup showing current rarity, growth potential, weekly usage, feeding, and draw controls" />
</p>

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/rarity-guide.png" width="360" alt="PunchGrow rarity index showing direct draw odds and final growth-potential lineage proportions" /><br /><strong>Rarity index</strong><br /><sub>Direct draw rarity is separate from final growth potential</sub></td>
    <td align="center"><img src="docs/screenshots/evolution-dex.png" width="372" alt="PunchGrow evolution dex showing stages, branches, current position, and automatic path" /><br /><strong>Evolution dex</strong><br /><sub>See the full lineage and the automatic path from the current species</sub></td>
  </tr>
</table>

[Open the complete user guide →](docs/USAGE.en.md)

## Featured creatures

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

> The featured creatures and other artwork are covered by the separate [visual asset license](ASSET-LICENSE.md).

## Game rules

| Rule | Alpha value |
| --- | --- |
| One draw | `500,000` tokens |
| Draw result | One of 60 PROCESS stage-one creatures · PROCESS 100% |
| ORIGIN lineage | 3 of 60 starts · 5% growth potential, not a direct ORIGIN pull |
| Normal food | Costs `100,000` tokens · XP `+25` · affinity `+3` |
| Large food | Costs `500,000` tokens · XP `+200` · affinity `+10` |
| Unique color | Independent `0.1%` chance per draw, with no stat advantage |
| Duplicate creatures | Kept as separate individuals that can be raised differently |
| Automatic evolution | Level 15 → stage 2 · level 25 → stage 3 · level 40 → stage 4 |
| Maximum level | Level 50. Legacy level 51–100 saves remain valid but cannot grow further |

### Growth and evolution

Draws never grant a higher-stage evolution directly. Every owned creature starts as PROCESS and evolves automatically through its catalog lineage as feeding raises its level. The UI separates the actual `Current <rarity>` from `Growth potential <final rarity>`. An ORIGIN-lineage draw is still a current PROCESS creature; the dedicated ORIGIN reveal is reserved for actually owning an ORIGIN species. A lineage with no next-stage catalog entry keeps its current form and can continue growing.

## Why PunchGrow exists

AI-assisted coding already produces a useful activity signal: token usage. PunchGrow makes that signal playful without collecting the work itself. The local collector is designed around numeric usage only—prompts, responses, source code, commands, project names, account identifiers, and raw file paths are outside the game data model.

## What's in this repository

| Area | Status | Purpose |
| --- | --- | --- |
| `macos/` | v0.2.0 | Native SwiftUI menu-bar game for Apple Silicon macOS 14+ |

The current game includes a 60-species stage-one draw pool, automatic evolution at levels 15, 25, and 40, six evolution tiers (`PROCESS` → `ORIGIN`), unique-color variants, feeding, local save/restore, and a 240-creature catalog.

In the macOS popup, holding a normal/large food purchase or feed button accelerates repeated actions until release. Draw feedback and the main card show current rarity and final growth potential separately. The fixed footer's `Rarity` guide separates direct `PROCESS 100%` draws from final-lineage proportions such as `ORIGIN lineage 3/60 (5%)`, plus owned, discovered, and total creature counts by tier. `Collection` and `Settings` open the large window directly, while `Evolution` shows the selected creature's complete image-based lineage, branches, discovery state, level gates, and current-forward automatic path. Higher stages receive progressively richer badge, frame, and aura effects.

### Actual plan usage

The `C n%` and `X n%` values in the menu bar are not token-based estimates.

- In v0.2.0, `C` reads Claude's actual weekly percentage from `~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json`. It remains pending when that cache is unavailable.
- `X` reads Codex's actual weekly `used_percent` from session rate-limit metadata.
- With automatic collection enabled, PunchGrow checks approximately every ten seconds.
- Provider updates automatically reflect both increased usage and weekly resets.
- Missing data is shown as pending instead of inventing a `0%` value.

## Privacy model

The macOS app runs locally and collection is off until the user explicitly enables it.

- Claude Code usage is discovered from `~/.claude/projects/**/*.jsonl`.
- Codex usage is discovered from `~/.codex/sessions/**/*.jsonl`.
- Plan percentages come from Claude's local usage cache and Codex rate-limit metadata; PunchGrow does not store authentication tokens.
- The first scan establishes a non-crediting baseline; only later increases earn game tokens.
- PunchGrow stores normalized token counts, timestamps, opaque hashes, incremental cursors, and game state.
- It does **not** store prompts, responses, source code, commands, project names, raw paths, emails, or account/model identifiers.
- Disconnecting and deleting the PunchGrow cache does not edit or delete the original Claude Code or Codex logs.

See [the macOS documentation](macos/README.md) for the detailed collection and status model.

## Five-minute walkthrough

1. Launch PunchGrow and find its creature in the macOS menu bar rather than the Dock.
2. Open the popup, choose `Settings` in the footer, then select `Connections` in the large window's sidebar.
3. Choose `수집 동의 및 시작` to opt into checking numeric Claude Code and Codex usage approximately every ten seconds.
4. The first scan establishes a non-crediting baseline. Only later increases add spendable tokens.
5. Buy food, draw creatures, and use `Rarity` and `Evolution` to inspect long-term growth.

The [complete user guide](docs/USAGE.en.md) covers installation, collection states, gameplay, backup, removal, privacy, and troubleshooting with screenshots.

## Quick start

### Install with Homebrew (recommended)

Requirements: Apple Silicon, macOS 14 or newer.

```bash
brew tap yoonsundo/punchgrow https://github.com/yoonsundo/punchgrow
brew trust yoonsundo/punchgrow
brew install --cask punchgrow
xattr -d com.apple.quarantine /Applications/PunchGrow.app
```

The published binary is currently ad-hoc signed and not yet notarized by Apple, so the final `xattr` command is required to clear the quarantine attribute before the first launch. On Homebrew versions before 6, skip the `brew trust` step. The `--no-quarantine` flag from older guides was removed in Homebrew 6 and no longer works.

### Build from source

Requirements: Apple Silicon, macOS 14 or newer, and a matched Full Xcode / Command Line Tools installation.

First-time users can choose **Code → Download ZIP** on the GitHub repository page, extract it, and open the extracted `macos` directory in Terminal. The [user guide](docs/USAGE.en.md) gives the beginner-friendly sequence.

```bash
cd macos
./scripts/build-app.sh
open .build/PunchGrow.app
```

The assembled app is ad-hoc signed for local use. Developer ID signing and Apple notarization remain separate release-account steps; once complete, the quarantine-clearing (`xattr`) step will no longer be needed.

## Verification

Run the checks relevant to the area you changed:

```bash
cd macos
swift test
swift build -c release
./scripts/build-app.sh
```

Some macOS checks require a compatible installed Apple SDK. The creature verification commands validate the release-sized asset pack included in the repository; source artwork and generation history are intentionally excluded from Git.

## Contributing

Issues and focused pull requests are welcome. New to open source? The [contributing guide](CONTRIBUTING.en.md) walks through the whole fork-to-PR flow. Before opening a pull request:

1. Read the [macOS guide](macos/README.md) for collection and privacy boundaries.
2. Never add collection of prompts, responses, source code, commands, raw paths, email addresses, or account identifiers.
3. Add or update tests for behavior changes and run the relevant verification commands above.

Please report security or privacy-sensitive findings privately to the repository owner instead of opening a public issue.

## Licenses and artwork

Source code is available under the [MIT License](LICENSE).

Creature images and other visual artwork are **not** licensed under MIT. They are provided only so people can run, evaluate, and contribute to PunchGrow locally. Public forks must remove or replace the protected artwork unless they have separate written permission. Read [ASSET-LICENSE.md](ASSET-LICENSE.md) before redistributing a fork.

Third-party acknowledgements are listed in [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

## Acknowledgement

PunchGrow's local usage-discovery approach was inspired by [PokeTokenBar](https://github.com/chattymin/PokeTokenBar). PunchGrow is an independent implementation and does not include Pokémon names, sprites, or artwork.
