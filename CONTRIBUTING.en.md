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
3. Make your change (the macOS app lives in `macos/`) and verify it:

   ```bash
   cd macos
   swift test
   ./scripts/build-app.sh
   ```

4. Push the branch to your fork and open a pull request describing what changed, why, and which checks you ran.

## Requirements

- Apple Silicon Mac, macOS 14+
- Full Xcode with matching Command Line Tools (`xcode-select -p` must point inside Xcode)

## Boundaries

- Never add features that collect prompts, responses, source code, commands, raw paths, emails, or account identifiers. See the [macOS docs](macos/README.md) for the privacy model.
- Creature artwork is **not** MIT-licensed; see [ASSET-LICENSE.md](ASSET-LICENSE.md) before redistributing a fork.
- Behavior changes need new or updated tests.

For features or structural changes, please open an [issue](https://github.com/yoonsundo/punchgrow/issues) first. Report security or privacy concerns privately to the repository owner instead of opening a public issue.
