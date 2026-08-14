# PunchGrow website

Dependency-free public project site for `punchgrow.thundo.kr`. This directory is
the GitHub Pages source; the separate root `web/` and `server/` directories are
a local-only web MVP and are not deployed here.

## Routes

- `/` and `/en/` — Korean and English project homepages
- `/dex/` and `/en/dex/` — public 256-creature dex
- `/404.html` — bilingual recovery page

The build reads the canonical creature catalog from
`../production/catalog/creatures.json` and release-sized images from
`../assets/creatures/mobile/`.

## Develop and verify

```bash
npm ci
npm test
npm run preview
```

`npm run build` creates the deployable site in ignored `dist/`. `npm test`
checks locale parity, metadata, links, assets, the custom domain, install copy,
and the 256-entry catalog. Keep the site framework-free unless a repository
decision explicitly changes that constraint.
