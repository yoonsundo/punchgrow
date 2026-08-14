# PunchGrow local web MVP

This directory contains the TypeScript browser client for PunchGrow's **local full-stack prototype**. It is not the public project homepage and is not deployed to `punchgrow.thundo.kr`.

- Public static homepage and dex: [`website/`](../website/README.md)
- Local API used by this client: [`server/`](../server/README.md)
- Deployment and directory map: [`docs/PROJECT_STRUCTURE.md`](../docs/PROJECT_STRUCTURE.md)

## Local run

The supported full-stack path uses the root Docker Compose file:

```bash
docker compose up -d --build
open http://localhost:5173
```

The services bind to loopback by default. The API's local authentication and session model are not intended for internet exposure.

For client-only iteration, keep the API running on `127.0.0.1:4001`, then run:

```bash
npm ci --prefix web
npm --prefix web run dev
```

## Verification

```bash
npm ci --prefix web
npm --prefix web test
```

`npm test` type-checks the client and rebuilds generated files in `web/dist/`, which is ignored by Git.
