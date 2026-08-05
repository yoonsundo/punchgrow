# Homebrew release path

The Cask is a release template, not a claim that an unsigned artifact is
already public. Before publishing:

1. Build `PunchGrow.app` for arm64.
2. Sign with Developer ID and hardened runtime.
3. Submit for Apple notarization and staple the ticket.
4. Zip the app, publish a versioned GitHub release, and generate the final
   Cask from `Casks/punchgrow.rb.in` with the real version and SHA-256. The
   repository intentionally contains no runnable Cask with disabled integrity checks.
5. Run `brew style`, `brew audit --cask --strict`, install, launch, uninstall,
   and zap tests.

For local development, use `../scripts/build-app.sh`. The script uses the active
toolchain's default SDK; set `PUNCHGROW_SDKROOT` to select a verified compatible
SDK explicitly. `PUNCHGROW_CLANG_CACHE` and `PUNCHGROW_SWIFTPM_CACHE` can move
the module caches for isolated builders. The assembler uses SwiftPM's exact
current release-product path, validates the staged app's metadata, licenses,
resource manifest, and 240 creature PNGs, then ad-hoc signs and replaces the
local app bundle without retaining stale files. Homebrew publication remains
gated on signing credentials and a real release URL.
