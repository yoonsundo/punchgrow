# Homebrew release path

## Current distribution (v0.3.0)

PunchGrow is currently distributed through the public repository itself acting
as a Homebrew tap: the generated Cask lives at `Casks/punchgrow.rb` in the
public repo, and the release asset (`PunchGrow-<version>-arm64.zip`, ad-hoc
signed, real SHA-256) is attached to the matching GitHub release. Users install
with:

```bash
brew tap yoonsundo/punchgrow https://github.com/yoonsundo/punchgrow
brew trust yoonsundo/punchgrow
brew install --cask punchgrow
xattr -d com.apple.quarantine /Applications/PunchGrow.app
```

That v0.3.0 release asset contains the 240-creature catalog published on
2026-08-07. The current `main` source and public dex contain 256 creatures; the
16 later additions remain source-only until the next versioned app release.

Because the binary is not yet notarized, the Cask documents the `xattr`
quarantine-clearing step in its caveats. (`brew install --no-quarantine` was
removed in Homebrew 6.) A dedicated lightweight tap repository
(`yoonsundo/homebrew-punchgrow`) can replace the URL tap later.

## Notarized release path (target)

The steps below remain the goal for a fully signed distribution. Before
publishing a notarized build:

1. Build `PunchGrow.app` for arm64.
2. Sign with Developer ID and hardened runtime.
3. Submit for Apple notarization and staple the ticket.
4. Zip the app, publish a versioned GitHub release, and update the root
   `Casks/punchgrow.rb` from `macos/homebrew/Casks/punchgrow.rb.in` with the
   real version and SHA-256. The committed v0.3.0 Cask is runnable and uses the
   release asset's verified checksum; future releases must replace both values
   together.
5. Run `brew style`, `brew audit --cask --strict`, install, launch, uninstall,
   and zap tests.

For local development, use `../scripts/build-app.sh`. The script uses the active
toolchain's default SDK; set `PUNCHGROW_SDKROOT` to select a verified compatible
SDK explicitly. `PUNCHGROW_CLANG_CACHE` and `PUNCHGROW_SWIFTPM_CACHE` can move
the module caches for isolated builders. The assembler uses SwiftPM's exact
current release-product path, validates the staged app's metadata, licenses,
resource manifest, and 256 creature PNGs, then ad-hoc signs and replaces the
local app bundle without retaining stale files. The current Homebrew release is
published with an ad-hoc signature and an honest quarantine-removal caveat;
Developer ID signing and notarization remain future release work.
