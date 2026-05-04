# Alignment Economy: Apps + Protocol

A new economic system designed to replace the broken incentive structures
of fiat money and cryptocurrency. Developed as a 501(c)(3) nonprofit.

This repo (`alignment-economy-code`) holds the protocol node and the two
apps that talk to it. The marketing site is in a separate repo,
`alignment-economy-website`.

## Structure

```
ae-node/      Backend protocol engine (TypeScript, Express, WebSocket P2P,
              SQLite, Tendermint-style BFT consensus). Listens on :3000.

ae-app/       Participant wallet (React + Vite + Tailwind, Electron desktop
              build). Connects to ae-node. Listens on :5173 in dev.

ae-miner/     Verifier / juror dashboard (React + Vite + Tailwind, Electron
              desktop build). Connects to ae-node. Listens on :5174 in dev.

scripts/      Workspace-level scripts (SSL setup, etc.)
docker-compose.yml  Multi-service local orchestration.
CLAUDE.md     Authoritative project notes - architecture, known issues,
              development principles. Read this first.
AE_PROJECT_BRIEF.md  Original project brief.
```

## Quick start (dev)

Run each project from its own directory:

```bash
cd ae-node && npm install && npm run dev      # protocol on :3000
cd ae-app && npm install && npm run dev       # wallet on :5173
cd ae-miner && npm install && npm run dev     # miner dashboard on :5174
```

For the 2-person test setup see `CLAUDE.md` (search "2-Person Testing").

## Configuration

### Environment variables

| Variable | Where | Required? | Effect |
|---|---|---|---|
| `AE_ADMIN_SECRET` | `ae-node` | Optional | If set, exposes `POST /admin/*` endpoints (e.g. `advance-day` for testing) gated behind an `X-Admin-Secret` header that must match this value. If unset, all admin endpoints return `403 ADMIN_DISABLED`. **Set this in production only on operator-run nodes you trust to advance the day cycle manually.** Use a long random value (`openssl rand -hex 32`). |
| `VITE_WS_URL` | `ae-app`, `ae-miner` | Optional | Override the WebSocket URL the client connects to. Defaults to `ws://localhost:3000/ws` for Electron / `file://` builds, otherwise the same host as the page. |

### Admin endpoint usage

```bash
# Start the node with admin enabled
AE_ADMIN_SECRET="$(openssl rand -hex 32)" npm run dev --prefix ae-node

# Advance the day cycle (requires the same secret)
curl -X POST http://localhost:3000/api/v1/admin/advance-day \
  -H "X-Admin-Secret: <the secret you set>"
```

Without the env var, the endpoint returns 403 with `ADMIN_DISABLED`. With
the env var but a missing or wrong header, it returns 401 with
`ADMIN_AUTH_FAILED` (constant-time comparison, no timing side channel).

## CI

GitHub Actions runs the `ae-node` test suite on every push and PR. See
`.github/workflows/test.yml`. Required job covers all 503 protocol tests
except the documented multi-runner BFT timing flakes (phase60, smoke-
multiblock), which run in a separate non-blocking job.
