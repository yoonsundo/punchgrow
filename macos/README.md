# PunchGrow macOS menu-bar app

Apple Silicon macOS 14+ local single-player app. The menu-bar popup is the
primary play surface; the large window separates collection browsing,
integration setup, and local data settings.

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
  the local OAuth usage cache; Codex comes from `rate_limits.primary.used_percent`.
  Missing values remain pending rather than being estimated.
- Normal food costs 100,000 tokens and grants XP +25 / affinity +3. Large food
  is stored separately, costs 500,000 tokens, and grants XP +200 / affinity +10.
  Feed and purchase buttons support one click or accelerating press-and-hold.
- Previous/next browses owned creatures cyclically. The session-only current
  creature is the target for feeding and changes after a successful draw.
- Browsing and drawing never change the persisted representative. Use **대표로
  지정** to make the current creature the representative for future launches.
- Non-ORIGIN draw feedback stays in the popup. An ORIGIN draw opens the
  dedicated `origin-reveal` window. Normal, reduced-effects, and skipped paths
  reach the same completed reveal. Closing it does not reopen the popup; the
  acquired ORIGIN remains current and appears when the user next opens the
  popup.

The Claude and Codex badges share four evidence-based states: **중지됨**,
**로그 감시 중**, **방금 수신**, and **확인 필요**. **방금 수신** appears for ten seconds
only after a validated event is credited.

## Large window

Open **도감 · 연결 · 설정** from the popup. The sidebar contains:

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
license files, the resource manifest, and all 240 creature PNGs, then signs and
installs a fresh `.build/PunchGrow.app`. A prior app bundle is replaced rather
than updated in place, so removed resources cannot survive as stale files.

The script creates an ad-hoc signed local app. Developer ID signing,
notarization, and the public Cask URL are release-account steps documented in
`homebrew/README.md`.

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

## Diagnostic compatibility paths

The repository still contains the older loopback OpenTelemetry receiver and
PunchGrow-managed Codex app-server implementation for diagnostics and
compatibility testing. They are not started or configured from the current
**Connections** screen, and events from those paths do not award game tokens.
The opted-in local JSONL scanner is the sole crediting path, which prevents the
same activity being awarded through multiple collectors. No OpenTelemetry setup
command or PunchGrow-managed Codex session is required for normal use.
