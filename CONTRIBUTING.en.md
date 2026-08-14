# Contributing to PunchGrow

[한국어](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

Thank you for your interest in PunchGrow. No repository permission is required to contribute: fork the repo, push to your fork, and open a pull request.

If `git push` fails with `Permission denied (403)`, you pushed to the original repository instead of your fork. Point your remote at your fork:

```bash
git remote set-url origin https://github.com/<your-account>/punchgrow.git
```

## Workflow

1. Fork [yoonsundo/punchgrow](https://github.com/yoonsundo/punchgrow) on GitHub.
2. Clone **your fork** and create a branch: `git checkout -b fix/short-description`
3. Make your change and run the checks for that area. The basic macOS checks are:

   ```bash
   cd macos
   swift test
   ./scripts/build-app.sh
   ```

4. Push the branch to your fork and open a pull request describing what changed, why, and which checks you ran.

## Environment setup

Base requirements: Apple Silicon Mac, macOS 14+.

1. Install **Full Xcode** from the App Store and launch it once to finish component installation and license agreement. Command Line Tools alone cannot produce the release build.
2. Point Command Line Tools at Xcode (requires an admin password):

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```

3. Verify the toolchain:

   ```bash
   xcode-select -p     # must point inside /Applications/Xcode.app
   xcodebuild -version
   swift --version     # Swift 6.x
   ```

4. Build and test (all app code lives under `macos/`):

   ```bash
   cd macos
   swift test
   swift build -c release
   ./scripts/build-app.sh
   open .build/PunchGrow.app
   ```

5. If you touched UI, render snapshots to check for clipping or overlap:

   ```bash
   ./scripts/render-popover-snapshot.sh                      # default state
   ./scripts/render-popover-snapshot.sh fresh.png menu-fresh # fresh-setup state
   ```

If the build fails, check the [user guide troubleshooting](docs/USAGE.en.md) first. SDK mismatch errors can be resolved by pointing `PUNCHGROW_SDKROOT` at a compatible SDK.

## Area-specific verification

The similarly named `website/` and `web/` directories are separate projects. `website/` is the public homepage; `web/` + `server/` is a local full-stack MVP. See the [repository structure guide](docs/PROJECT_STRUCTURE.md) for the complete boundary.

| Changed area | Required checks |
| --- | --- |
| macOS app (`macos/`) | `cd macos && swift test && ./scripts/build-app.sh` |
| Public homepage (`website/`) | `npm ci --prefix website && npm --prefix website test` |
| Local web client (`web/`) | `npm ci --prefix web && npm --prefix web test` |
| Local API (`server/`) | `npm ci --prefix server && npm --prefix server test` |
| Expo prototype | `npm ci && npm run typecheck:app && npm run test:mobile` |

For API integration changes, also run `docker compose up -d --build` followed by `npm --prefix server run test:integration`. List the commands and results in the pull request, and include before/after images for UI changes.

## Is it OK that my fork contains the creature artwork?

Yes. The visual assets are not MIT-licensed ([ASSET-LICENSE.md](ASSET-LICENSE.md)), but keeping them unmodified in a fork that exists to propose changes back to the official repository (pull requests) is explicitly permitted. What is not permitted: shipping releases or binaries from a fork, using the assets in another project, or promoting a fork as a standalone product.

## Boundaries

- Never add features that collect prompts, responses, source code, commands, raw paths, emails, or account identifiers. See the [macOS docs](macos/README.md) for the privacy model.
- Redistributing or releasing from a fork requires removing or replacing the protected artwork; a PR-purpose fork may keep it.
- Behavior changes need new or updated tests.

For features or structural changes, please open an [issue](https://github.com/yoonsundo/punchgrow/issues) first. Report security or privacy concerns privately through the [security policy](SECURITY.md), and see [support](SUPPORT.md) for setup and usage help.
