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

platform-server/  Optional custodial backend (email/password signup,
              encrypted vault, recovery, 2FA). Separate service from ae-node.
sdk/          @alignmenteconomy/sdk: typed client for third-party integration.
explorer/     Read-only block explorer (React + Vite). Listens on :5175 in dev.

scripts/      Workspace-level scripts (SSL setup, LAN multi-validator test).
docs/         Operator + handoff docs. Start with docs/ARCHITECTURE.md.
docker-compose.yml  Multi-service local orchestration.
CLAUDE.md     Authoritative project notes - status, build plan, known issues,
              development principles. Read this first.
docs/ARCHITECTURE.md  Architecture + handoff map: how the pieces fit, the
              seams (DB / transport / host), where to start reading.
AE_PROJECT_BRIEF.md  Original project brief.
```

## Quick start (dev)

Run each project from its own directory:

**Build the SDK first.** `ae-app` and `ae-miner` both depend on
`@alignmenteconomy/sdk` via `file:../sdk`, and its `package.json` points
`main` at `dist/index.js`. `dist/` is gitignored, so a fresh clone does not
have it. Skip this step and both apps serve a blank page: vite fails with
`Failed to resolve import "@alignmenteconomy/sdk"` and returns 500 for every
module. The error appears only in the terminal running vite, never in the
browser, which makes it very easy to misdiagnose.

```bash
cd sdk && npm install && npm run build        # REQUIRED before ae-app / ae-miner
cd ae-node && npm install && npm run dev      # protocol on :3000
cd ae-app && npm install && npm run dev       # wallet on :5173
cd ae-miner && npm install && npm run dev     # miner dashboard on :5174
```

Re-run `npm run build` in `sdk/` after any change to `sdk/src/` — the apps
consume the built `dist/`, not the TypeScript source, so edits are invisible
until you rebuild.

For the 2-person test setup see `CLAUDE.md` (search "2-Person Testing").

### Dev shortcut: bump every account to 100% verified

Local testing constantly hits the percent-human gate (new accounts at 0%
can mint but spend 0). To skip past it on a dev DB, run the bump script
from `ae-node/`:

```bash
node scripts/dev-bump-ph.mjs            # uses ./data/ae-node.db
node scripts/dev-bump-ph.mjs path.db    # explicit DB path
node scripts/dev-bump-ph.mjs --check    # print the state root, change nothing
```

Requires `npm run build` first — the script reuses the node's own state-root
code so the cross-machine comparison below is meaningful.

It opens the DB in WAL mode, sets every individual account's `percentHuman`
to 100, and sets each earned balance to 5,000 points so you have something
to spend. Safe to run while the node is running, and safe to re-run (it is
idempotent, so it doubles as a top-up when you spend a test account dry).

Run it from `ae-node/` or pass an explicit path. It refuses to run against a
missing DB rather than silently creating an empty one.

**On a multi-node network, follow the procedure below.** This writes account
state directly to one node's SQLite file, outside consensus, and nothing
replicates it. There are two ways to fork state with it: run it on one node
only, or run it on every node but at different moments (it only touches
accounts that exist locally at that instant, so if one node has not yet learned
about an account the other has, the two bump different sets). Either way the
first block touching a divergent account cannot be applied by somebody and
consensus fail-stops.

Safe procedure:

1. Stop every node.
2. Run the script on every node.
3. Compare the `STATE ROOT` each run prints. Identical means the nodes agree.
   Different means **do not start the chain** — fix the account sets first.
4. Restart every node.

To compare two machines without changing anything:

```bash
node scripts/dev-bump-ph.mjs --check          # prints STATE ROOT only
```

The state root is computed by the node's own `computeStateRoot`, not a copy, so
a match is meaningful rather than cosmetic.

The miner dashboard picks up the change within 30 seconds (it polls). The
wallet does not poll and a raw SQL write emits no `balance:updated` event, so
switch tabs or reload to see new numbers there.

### LAN multi-validator test

Want to confirm 3-validator BFT works end-to-end on this machine?

```bash
node scripts/test-lan-multi-validator.mjs
```

Spawns three ae-node subprocesses with a shared genesis spec, peers
them up over WebSocket, runs BFT consensus, and asserts they all
converge on the same chain head with matching block hashes. ~80s.
Pass criterion: "PASS: 3-validator BFT chain advanced past min height
with matching hashes." Set `LAN_TEST_VERBOSE=1` to see all node logs.

## Configuration

### Environment variables

| Variable | Where | Required? | Effect |
|---|---|---|---|
| `AE_ADMIN_SECRET` | `ae-node` | Optional | If set, exposes `POST /admin/*` endpoints (e.g. `advance-day` for testing) gated behind an `X-Admin-Secret` header that must match this value. If unset, all admin endpoints return `403 ADMIN_DISABLED`. **Set this in production only on operator-run nodes you trust to advance the day cycle manually.** Use a long random value (`openssl rand -hex 32`). |
| `VITE_WS_URL` | `ae-app`, `ae-miner` | Optional | Override the WebSocket URL the client connects to. Defaults to `ws://localhost:3000/ws` for Electron / `file://` builds, otherwise the same host as the page. |
| `AE_EXECUTION_MODE` | `ae-node` | Optional | `commit` (default) or `receipt`. When a transaction's effect on balances happens. **Must be identical on every node of a network.** See below. |

### Execution mode

`commit` (the default) applies a transaction's balance effect when the block
carrying it commits. `receipt` applies it the moment the API or gossip accepts
it, which is the legacy behaviour and is kept only for comparison.

`receipt` has a double-spend vector. Submit two conflicting spends to two
different validators at the same moment and each accepts the one it saw first,
because each is individually valid against the state that node holds. The two
nodes then disagree about the sender's balance, and the first block containing
both is unappliable on both of them. State ends up a function of message
arrival order rather than of the chain.

Mixing modes across a network is worse than either: half the validators will
have applied a transaction the other half have not.

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
