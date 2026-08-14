# PunchGrow macOS menu-bar app

Apple Silicon macOS 14+ local single-player app. The menu-bar popup is the
primary play surface; the large window separates collection browsing,
integration setup, and local data settings.

Current app version: **v0.3.0** (`CFBundleShortVersionString` in
`homebrew/Info.plist` is the single source the update check compares against).
For player-facing instructions, see the
[Korean user guide](../docs/USAGE.md) or [English user guide](../docs/USAGE.en.md).

PunchGrow stores normalized numeric token usage and game state under
Application Support. Claude prompts, responses, source code, commands, paths,
account IDs, model names, and emails are outside its usage/status data model.
Automatic collection is off until the user explicitly enables it in
**Connections**. Processing stays on the Mac and does not modify the original
Claude Code or Codex logs.

## Popup behavior

- **Token balance** is the spendable amount. It can include the 2,000,000-token
  starter balance and decreases when tokens are spent.
- **This week** is the Claude Code and Codex usage observed in local JSONL logs
  for the current week. It is a usage statistic, not the spendable balance: the
  first scan may show existing weekly activity but never credits that history.
  Only increases found after the baseline can increase the token balance.
- The menu-bar `C n%` and `X n%` values are the providers' actual weekly plan
  percentages, not a conversion from observed token totals. Claude comes from
  `~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json` when that
  local cache exists; Codex comes from `rate_limits.primary.used_percent`.
  Missing values remain pending rather than being estimated, so Claude stays
  pending when the oh-my-claudecode cache has not been created.
- Normal food costs 100,000 tokens and grants XP +25 / affinity +3. Large food
  is stored separately, costs 500,000 tokens, and grants XP +200 / affinity +10.
  Feed and purchase buttons support one click or accelerating press-and-hold.
- Draws select uniformly from the 60 PROCESS stage-one species, so direct draw
  rarity is PROCESS 100%. Feeding automatically
  evolves catalog-linked creatures at levels 15, 25, and 40. New growth caps at
  level 50; legacy level 51–100 saves remain valid but cannot gain more levels.
- Evolution preserves the owned instance, nickname, affinity, unique color,
  acquisition time, and representative selection. The popup reports the final
  result when one feed catches up through several overdue stages.
- Previous/next browses owned creatures cyclically. The session-only current
  creature is the target for feeding and changes after a successful draw.
- Browsing and drawing never change the persisted representative. Use **대표로
  지정** to make the current creature the representative for future launches.
- Draw results and the main creature card separate `현재 <rarity>` from
  `성장 잠재력 <final rarity>`. The latter is derived from the deterministic
  catalog evolution path and is not the creature's current rarity.
- Three of the 60 starting lineages currently end at ORIGIN, so the derived
  **ORIGIN lineage** chance is 3/60 = 5%. This must never be described as a
  direct ORIGIN pull: an ORIGIN-lineage draw still awards a PROCESS creature.
- Draw feedback stays in the popup because higher evolution stages are no
  longer drawn directly. **진화** opens a per-creature evolution dex with every
  reachable stage, image, branch, discovery state, and level gate. Only the
  forms that the selected individual actually passed through are owned and
  previewable; future stages and unchosen branches stay locked.
- The 10 `mixed` catalog species are standalone fusion collectibles, not
  same-individual evolution stages. They are excluded from automatic evolution,
  choices, potential, and lineage traversal. Existing saves keep an owned mixed
  creature safely, but its Evolution Dex shows only that current form.
- The fixed footer keeps **도감**, **등급표**, **진화**, **설정**, and **종료** visible
  as separate actions. 등급표 separates direct draw rarity (PROCESS 100%) from
  final-lineage proportions, including ORIGIN lineage 3/60 (5%), and shows
  owned/discovered/catalog counts for every rarity. 도감 and 설정 open the large
  window directly.
- The dedicated ORIGIN reveal remains reserved for owning a creature whose
  actual current species is ORIGIN. ORIGIN growth potential alone never opens it.

The Claude and Codex badges share four evidence-based states: **중지됨**,
**로그 감시 중**, **방금 수신**, and **확인 필요**. **방금 수신** appears for ten seconds
only after a validated event is credited.

## Large window

Open **도감** or **설정** from the popup footer. The large window opens directly
on that destination; **Connections** remains available from its sidebar:

- **Collection**: discovered/owned progress, search, discovered cards, and
  locked silhouettes for undiscovered creatures.
- **Connections**: consent and controls for automatic local JSONL collection,
  per-provider status, the most recent scan time, collection errors, and local
  incremental-cache deletion.
- **Data & Settings**: notification, sound, reduced-effects, `.pgrow` export,
  and restore controls.

Shop and detailed statistics are intentionally deferred.

## Build and test

Before treating build or test output as release evidence, confirm that Full
Xcode, Command Line Tools, and Swift resolve to a matched installation:

```bash
xcode-select -p
xcodebuild -version
swift --version
```

If `xcodebuild` is unavailable or Swift and the active SDK are mismatched, any
result is diagnostic only. Fix the toolchain and rerun the checks before
accepting or distributing a macOS binary release. A source-only snapshot may
still be published when this validation gap is stated prominently in the root
README and no binary is attached.

```bash
cd macos
swift test
swift build -c release
./scripts/build-app.sh
open .build/PunchGrow.app
```

`build-app.sh` uses the active toolchain's default SDK. Set `PUNCHGROW_SDKROOT`
to an explicit compatible SDK when necessary. Its Clang and SwiftPM module
caches can also be redirected with `PUNCHGROW_CLANG_CACHE` and
`PUNCHGROW_SWIFTPM_CACHE`. These overrides do not replace the matched-toolchain
release gate.

The app assembler resolves the current release product directory directly from
SwiftPM, builds into a private staging directory, verifies `Info.plist`, both
license files, the resource manifest, and all 256 creature PNGs, then signs and
installs a fresh `.build/PunchGrow.app`. A prior app bundle is replaced rather
than updated in place, so removed resources cannot survive as stale files.

The script creates an ad-hoc signed local app. Developer ID signing,
notarization, and the public Cask URL are release-account steps documented in
`homebrew/README.md`.

### Documentation screenshots

The checked-in README images are rendered by the actual SwiftUI views with a
deterministic documentation fixture, so they do not expose a contributor's
private logs or game save. Regenerate and dimension-check them with:

```bash
./scripts/render-popover-snapshot.sh ../docs/screenshots/menu-popover.png menu
./scripts/render-popover-snapshot.sh .build/menu-popover-fresh.png menu-fresh
./scripts/render-popover-snapshot.sh ../docs/screenshots/rarity-guide.png rarity
./scripts/render-popover-snapshot.sh ../docs/screenshots/evolution-dex.png evolution
```

## Automatic Claude Code and Codex usage collection

After the user selects **수집 동의 및 시작** in **Connections**, PunchGrow scans
local usage logs every 10 seconds. Consent persists across normal restarts, so
collection resumes automatically after relaunch. **수집 중지** revokes that
consent and stops scanning while retaining PunchGrow's incremental cache.
**연결 해제 및 캐시 삭제** stops collection, clears the displayed observed
totals, and deletes PunchGrow's incremental cache; it never deletes or edits the
original Claude Code or Codex logs.

The same scan refreshes plan percentages. Usage increases and weekly resets
appear after Claude or Codex writes a new quota value. If neither provider has
written quota metadata yet, the UI reports a pending state instead of deriving
a percentage from token counts.

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`

The first scan establishes a baseline and never grants a historical token
windfall. Existing current-week usage can appear in **This week**, while only
usage discovered after the baseline is credited to the game balance. Deleting
the cache means the next opt-in scan establishes a new non-crediting baseline.

The cache stores opaque hashes, token counts, timestamps, file size/offset
cursors, content-prefix hashes, provider quota percentages, and reset times. It never stores prompts, responses, source
code, commands, project names, raw paths, account/model details, or original
message/request IDs, and it is not included as raw log content in `.pgrow`
backups.

Claude streaming duplicates are reconciled by message/request identity. Codex
cached input is separated from non-cached input, exact duplicate frames are
removed, and fork replay is excluded. Users continue running Claude Code and
Codex normally; PunchGrow does not need to launch either tool and does not
receive their prompts or responses.

### Status shown in Connections

- **중지됨**: collection or that provider's scan has stopped.
- **로그 감시 중**: collection is actively monitoring that provider's local log
  directory, even when it contains no log yet, with no newly credited usage in
  the last ten seconds.
- **방금 수신**: a validated post-baseline increase was credited during the last
  ten seconds.
- **확인 필요**: the local logs or cache could not be read or saved safely. The
  displayed message gives a sanitized recovery hint.

The page also shows whether automatic collection is running and the most recent
successful scan time. A stopped collector never presents a stale provider as
actively connected.

## Update checks

PunchGrow checks GitHub Releases once 24 hours have passed since its last
**successful** check, comparing the latest published tag against the running
app's `CFBundleShortVersionString`. That timestamp is persisted, so a relaunch
inside the window skips the request. A failed check does not consume the daily
budget: it leaves the timestamp alone and retries on an exponential backoff
starting at 60 seconds and capped at 24 hours, so a brief outage does not
swallow a day of notices. The request is an unauthenticated `GET` against
`https://api.github.com/repos/yoonsundo/punchgrow/releases/latest`. It never
sends usage numbers, game state, prompts, source code, or any identifier.

This is the only network request the app itself makes. It is **not** the only
network traffic the app causes: while collection is enabled,
`LocalUsageService` runs `ClaudeUsageCacheRefresher` about once a minute, which
spawns Claude Code's status-line script, and that script calls the provider's
usage API with its own Keychain-held credentials (see
`ClaudeUsageCacheRefresher.swift` — the app deliberately stays out of the
credential path). Disabling the update check silences the app's own request;
silencing the refresher requires turning collection off.

When a newer version is found, PunchGrow shows a banner above the popup menu
and, if the existing **알림** (notifications) toggle in Data & Settings is on,
a single macOS Notification Center alert per version. The banner and the
update panel in **Data & Settings** both offer copying the
`brew upgrade --cask punchgrow` command, opening the release notes, and
skipping that version; a skipped version stays silent until a higher version
is published.

PunchGrow never installs the update itself. Installation is the user running
`brew upgrade --cask punchgrow`. Because the app is distributed as a Homebrew
cask and the current build is ad-hoc signed (pre-notarization), having the
app replace its own bundle would desync the version Homebrew tracks from the
version actually installed.

Turn the check off from **Data & Settings > 업데이트** by disabling
**새 버전 자동 확인**. The same panel has a **지금 확인** button and
shows the last successful check time. Relevant `UserDefaults` keys:
`updateCheckEnabled`, `updateLastCheckedAt`, `updateSkippedVersion`,
`updateNotifiedVersion`. The notified-version key is written only when an alert
is actually sent, so turning notifications back on still surfaces a version
found while they were off.

## Diagnostic compatibility paths

The repository still contains the older loopback OpenTelemetry receiver and
PunchGrow-managed Codex app-server implementation for diagnostics and
compatibility testing. They are not started or configured from the current
**Connections** screen, and events from those paths do not award game tokens.
The opted-in local JSONL scanner is the sole crediting path, which prevents the
same activity being awarded through multiple collectors. No OpenTelemetry setup
command or PunchGrow-managed Codex session is required for normal use.
