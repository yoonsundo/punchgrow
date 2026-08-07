# PunchGrow v0.2.0 User Guide

[한국어](USAGE.md) · [English](USAGE.en.md) · [Project README](../README.en.md)

PunchGrow is a local, single-player menu-bar game for Apple Silicon Macs. It turns the numeric Claude Code and Codex usage recorded on your Mac into game tokens, without storing prompts, responses, source code, commands, or raw log paths.

> **Distribution status:** the public Homebrew Cask is not available yet. The instructions below build and run a local app from this source checkout. Homebrew distribution will follow after Developer ID signing, Apple notarization, and a public release artifact are ready.

## Requirements

- Apple Silicon Mac
- macOS 14 or later
- Full Xcode with its matching Command Line Tools selected
- Swift 6 supplied by that Xcode installation

Confirm the active toolchain before building:

```bash
xcode-select -p
xcodebuild -version
swift --version
```

`xcode-select -p` should point inside the full Xcode application. A Command Line Tools-only path such as `/Library/Developer/CommandLineTools` does not satisfy the release build requirement.

## Build and run from source

On the GitHub repository page, choose **Code → Download ZIP** and extract it. Open Terminal, type `cd `, then drag the extracted `macos` folder from Finder into Terminal and press Return; macOS fills in the path for you. If you already use Git, cloning the repository and entering its `macos` directory is equivalent.

From that `macos` directory:

```bash
swift test
swift build -c release
./scripts/build-app.sh
open .build/PunchGrow.app
```

The build script creates an ad-hoc signed app at `macos/.build/PunchGrow.app`. You may run it there or copy it to `/Applications` in Finder for convenience. This local build is not Developer ID signed or notarized for public distribution.

## First launch

PunchGrow runs as a menu-bar app and does not show a Dock icon. After launch, select its creature icon in the macOS menu bar to open the play surface.

![PunchGrow menu popover showing the creature card, weekly usage, token balance, food controls, draw button, and footer actions](screenshots/menu-popover.png)

The screenshot is rendered by the real SwiftUI app with deterministic documentation data. It does not contain private user logs.

The popup separates three values that serve different purposes:

| Display | Meaning |
| --- | --- |
| **TOKEN BALANCE / 보유 토큰** | Spendable game currency. Purchases and draws reduce this balance. |
| **This week / 주간 사용량** | Numeric Claude Code and Codex token usage observed for the current week. Existing usage may appear here after the first scan. |
| **C n% / X n%** | The providers' actual weekly plan percentages: `C` for Claude and `X` for Codex. In v0.2.0, `C` is available when `~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json` exists. They are not calculated from the game token balance. |

If a provider has not written usable quota metadata, PunchGrow shows a pending state instead of inventing `0%`. While collection is enabled, the app checks for new local values about every 10 seconds and reflects usage increases or weekly resets after the provider records them.

## Enable local usage collection

Collection is off until you opt in.

1. Open **설정** (Settings) in the popup footer.
2. Select **Connections** in the large window sidebar.
3. Select **수집 동의 및 시작** (Consent and start collection).

PunchGrow scans these local log locations:

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`

The first scan creates a **non-crediting baseline**. Current-week activity found during that scan may appear in the usage statistics, but it does not award a historical token windfall. Only validated increases recorded after the baseline can increase the spendable token balance. Consent persists across normal app restarts.

## Draw and grow creatures

### Draw

- One draw costs **500,000 tokens**.
- Select **가챠** to draw one of 60 stage-one creatures.
- Every direct draw is currently **PROCESS 100%**.
- Duplicate draws remain separate saved creatures, but the main popup collapses the same starting lineage to its earliest acquired creature. This keeps one visible representative per lineage without deleting duplicate ownership data.

### Buy and feed food

| Item | Purchase | Growth |
| --- | ---: | --- |
| Normal food | 100,000 tokens | XP +25, affinity +3 |
| Large food | 500,000 tokens | XP +200, affinity +10 |

Use **일반 구매** or **대형 구매** to add food to inventory, then use **일반 먹이** or **대형 먹이** on the currently displayed creature. A click performs one action. Press and hold a purchase or feed button to repeat the action at an accelerating rate; release to stop.

### Current rarity and growth potential

The creature card deliberately shows two different labels:

- **현재** (Current) is the creature's rarity right now.
- **성장 잠재력** (Growth potential) is the final rarity on its deterministic automatic evolution path.

An **ORIGIN lineage** means that the starting creature can eventually evolve to ORIGIN. Three of the 60 starting lineages currently do so, which is **3/60 = 5%**. This is **not** a 5% direct ORIGIN draw: an ORIGIN-lineage draw still gives you a PROCESS creature.

Open **등급표** (Rarity index) to compare direct draw rarity with final lineage potential.

![Rarity index separating PROCESS 100 percent direct draws from the 3 of 60 ORIGIN lineage potential](screenshots/rarity-guide.png)

This screenshot also uses deterministic documentation data, not private usage records.

### Evolution

Creatures evolve automatically when they reach these levels:

| Level | Evolution |
| ---: | --- |
| 15 | Stage 2 |
| 25 | Stage 3 |
| 40 | Stage 4, when the catalog lineage has one |

The normal level cap is **50**. Older saves containing levels 51–100 remain readable, but those creatures cannot gain additional levels.

Select **진화** (Evolution) to inspect the current creature's starting form, branches, level gates, discovery state, and automatic path. `AUTO` marks the path PunchGrow will choose.

![Evolution dex showing the current creature, growth potential, branch choices, automatic path, and level gates](screenshots/evolution-dex.png)

The evolution screenshot is generated from deterministic sample state and contains no private log data.

## Popup footer actions

The fixed bottom row keeps the main navigation available:

| Action | Opens |
| --- | --- |
| **도감** | Collection window with owned and discovered progress, search, creature cards, and locked silhouettes |
| **등급표** | Direct draw rarity and final growth-potential distribution |
| **진화** | Evolution dex for the currently displayed creature |
| **설정** | The large window, including Connections and Data & Settings |
| **종료** | Quits PunchGrow |

Use the left and right arrows on the creature card to browse owned creatures. Select **대표로 지정** to keep the displayed creature as the representative on future launches.

## Collection, settings, and backup

The large window contains three areas:

- **Collection**: owned and discovered counts, search, discovered cards, and undiscovered silhouettes.
- **Connections**: collection consent, per-provider status, last scan time, errors, stop, and disconnect controls.
- **Data & Settings**: notifications, sound, reduced effects, backup, and restore.

In **Data & Settings**:

- Select **백업 내보내기** (Export backup) to save a `.pgrow` file.
- Select **백업 복원** (Restore backup) to load a compatible `.pgrow` file.

A backup includes creatures, tokens, progression, inventory, and normalized usage numbers. It does not include prompts, responses, source code, commands, or raw local log content. Keep your `.pgrow` file before moving to another Mac or erasing local app data.

## Stop, disconnect, or uninstall

- **수집 중지** stops scanning and revokes collection consent, but retains PunchGrow's incremental cache and displayed game data. Starting again continues from that cache.
- **연결 해제 및 캐시 삭제** stops scanning, clears displayed observed usage totals, and deletes PunchGrow's incremental usage cache. It does not delete game progress or modify the original Claude Code and Codex logs. The next opt-in creates a new non-crediting baseline.
- **종료** quits the app without changing consent or saved progress.
- To uninstall a source build, quit PunchGrow and move `PunchGrow.app` to the Trash from its current location. Removing the app does not automatically remove saved game data.
- To erase the saved game after making any wanted `.pgrow` backup, open Finder, choose **Go > Go to Folder**, enter `~/Library/Application Support/PunchGrow`, and move that `PunchGrow` folder to the Trash. This removes local game state and the incremental usage cache.

If you copied the app to `/Applications`, remove that copy as well as any source-built copy you no longer need.

## Privacy model

PunchGrow processes usage locally and does not need to launch Claude Code or Codex.

It keeps only the numeric usage required for the game, timestamps, opaque hashes, incremental file cursors, provider quota percentages, reset times, and local game state. Its usage/status model excludes prompts, responses, source code, commands, project names, raw paths, email addresses, account or model identifiers, and original message/request IDs.

PunchGrow reads allowed usage fields from the original JSONL files but never edits or deletes those files. No account, cloud synchronization, ranking, or multiplayer service is part of v0.2.0.

## Troubleshooting

### The app does not appear

- Confirm that `macos/.build/PunchGrow.app` exists after the build.
- Run `open macos/.build/PunchGrow.app` from the repository root.
- Look in the menu bar, not the Dock.

### The build fails before compiling

- Run the three toolchain checks in [Requirements](#requirements).
- Select a full, compatible Xcode installation and rerun `swift test`, `swift build -c release`, and `./scripts/build-app.sh`.
- Do not treat a build made with mismatched Swift and macOS SDK versions as a distributable release.

### Usage is visible but the token balance did not increase

This is expected on the first opted-in scan. Existing activity establishes the non-crediting baseline. Continue using Claude Code or Codex; only later validated increases are eligible for game tokens.

### C or X shows a pending value

The relevant provider has not written readable weekly quota metadata yet, or PunchGrow needs attention reading the local cache. In v0.2.0, `C —` can remain pending when the `oh-my-claudecode` usage cache has not been created; `X —` can remain pending until Codex writes weekly rate-limit metadata into a local session. PunchGrow does not invent a percentage when either value is unavailable. Check **Connections** for a sanitized error or last-scan time.

### Collection says stopped or needs attention

- Open **Settings > Connections** and confirm that collection is enabled.
- `로그 감시 중` means the provider's local directory is being monitored even if it has no new event.
- `방금 수신` appears only for about 10 seconds after a validated post-baseline increase is credited.
- `확인 필요` means a local log or cache could not be read or saved safely; follow the recovery hint shown in Connections.

### A creature did not evolve

Confirm that it reached level 15, 25, or 40 and inspect **진화**. A lineage with no next catalog stage keeps its current appearance while continuing to grow up to level 50.
