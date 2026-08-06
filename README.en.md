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
    <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-4DE1FF?style=flat-square&logo=apple&logoColor=white" />
    <img alt="Swift 6" src="https://img.shields.io/badge/Swift-6-FF4D9D?style=flat-square&logo=swift&logoColor=white" />
    <img alt="Local First" src="https://img.shields.io/badge/data-local--first-C6F84E?style=flat-square&logoColor=08111F" />
    <img alt="MIT source license" src="https://img.shields.io/badge/source-MIT-FFB84D?style=flat-square" />
  </p>

  <p>
    <a href="#quick-start">Quick start</a>
    ·
    <a href="macos/README.md">macOS guide</a>
    ·
    <a href="#privacy-model">Privacy</a>
    ·
    <a href="#contributing">Contributing</a>
  </p>
</div>

---

> **Project status: v0.1.1 alpha.** This public repository is dedicated to the Apple Silicon macOS 14+ menu-bar app.

GitHub Actions with Full Xcode verifies the Swift test suite, Release build, 240-creature resource assembly, and ad-hoc signature. A public Homebrew binary still requires Developer ID signing and Apple notarization.

## The core experience

| Code | Collect | Grow | Stay private |
| --- | --- | --- | --- |
| Claude Code and Codex usage becomes game tokens. | Discover 240 creatures across six rarity tiers. | Feed, evolve, and find unique-color variants. | Prompts and code stay out of the data model and processing stays on your Mac. |

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
| Draw result | One of 60 stage-one creatures |
| Normal food | Costs `100,000` tokens · XP `+25` · affinity `+3` |
| Large food | Costs `500,000` tokens · XP `+200` · affinity `+10` |
| Unique color | Independent `0.1%` chance per draw, with no stat advantage |
| Duplicate creatures | Kept as separate individuals that can be raised differently |
| Automatic evolution | Level 15 → stage 2 · level 25 → stage 3 · level 40 → stage 4 |
| Maximum level | Level 50. Legacy level 51–100 saves remain valid but cannot grow further |

### Growth and evolution

Draws never grant a higher-stage evolution directly. Every owned creature starts at stage one and evolves automatically through its catalog lineage as feeding raises its level. A lineage with no next-stage catalog entry keeps its current form and can continue growing.

## Why PunchGrow exists

AI-assisted coding already produces a useful activity signal: token usage. PunchGrow makes that signal playful without collecting the work itself. The local collector is designed around numeric usage only—prompts, responses, source code, commands, project names, account identifiers, and raw file paths are outside the game data model.

## What's in this repository

| Area | Status | Purpose |
| --- | --- | --- |
| `macos/` | v0.1.1 | Native SwiftUI menu-bar game for Apple Silicon macOS 14+ |

The current game includes a 60-species stage-one draw pool, automatic evolution at levels 15, 25, and 40, six evolution tiers (`PROCESS` → `ORIGIN`), unique-color variants, feeding, local save/restore, and a 240-creature catalog.

In the macOS popup, holding a normal/large food purchase or feed button accelerates repeated actions until release. The `Evolution stages` popover shows the level 15/25/40 milestones and current progress, while higher stages receive progressively richer badge, frame, and aura effects.

### Actual plan usage

The `C n%` and `X n%` values in the menu bar are not token-based estimates.

- `C` reads Claude's actual weekly percentage from its local OAuth usage cache.
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

## Quick start

### macOS menu-bar app

Requirements: Apple Silicon, macOS 14 or newer, and a matched Full Xcode / Command Line Tools installation.

```bash
cd macos
swift test
swift build -c release
./scripts/build-app.sh
open .build/PunchGrow.app
```

The assembled app is ad-hoc signed for local use. Developer ID signing, notarization, and a public Homebrew Cask are separate release-account steps.

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

Issues and focused pull requests are welcome. Before opening a pull request:

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
