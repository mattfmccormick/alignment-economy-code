# Alignment Economy

A new economic system designed to replace the broken incentive structures
of fiat money and cryptocurrency. Developed as a 501(c)(3) nonprofit.

This monorepo holds the working prototype of the full platform.

## Structure

```
ae-node/      Backend protocol engine (TypeScript, Express, WebSocket P2P,
              SQLite, Tendermint-style BFT consensus). Listens on :3000.

ae-app/       Participant wallet (React + Vite + Tailwind, Electron desktop
              build). Connects to ae-node. Listens on :5173 in dev.

ae-miner/     Verifier / juror dashboard (React + Vite + Tailwind, Electron
              desktop build). Connects to ae-node. Listens on :5174 in dev.

ae-platform/  Public marketing and onboarding site (Next.js).

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
cd ae-platform && npm install && npm run dev  # landing on :3001
```

For the 2-person test setup see `CLAUDE.md` (search "2-Person Testing").

## CI

GitHub Actions runs the `ae-node` test suite on every push and PR. See
`.github/workflows/test.yml`. Required job covers all 503 protocol tests
except the documented multi-runner BFT timing flakes (phase60, smoke-
multiblock), which run in a separate non-blocking job.
