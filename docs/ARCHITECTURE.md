# Architecture & handoff guide

**Audience:** an engineer picking up this codebase to harden and deploy it.
**This doc** is the map of how the pieces fit and where the seams are. For
**project status, the build plan, and known issues** read `CLAUDE.md` (the
source of truth). For **how to run and configure a node** read `README.md`.

---

## The packages

A monorepo of six independent packages (no workspace tooling, each has its
own `package.json` and is built/tested on its own). Node 22+ is required
(`ae-node` uses the built-in `node:sqlite`).

| Package | What it is | Run (dev) | Test gate |
|---|---|---|---|
| `ae-node` | The protocol node: consensus, economics, API, P2P, storage. The heart of the system. | `npm run dev` | `npm test` (`tsx --test tests/*.test.ts`) |
| `ae-app` | User wallet (React + Vite + Electron). Hold keys, send/receive points, tag goods/spaces, get verified, use the court. | `npm run dev` (Vite :5173) | `npm run build` |
| `ae-miner` | Miner/verifier console (React + Vite + Electron). Review verification panels, vouch, serve juries, see income. | `npm run dev` (Vite :5174) | `npm run build` |
| `platform-server` | Optional custodial backend: email/password signup, encrypted vault, Gmail-style recovery, 2FA. Lets non-technical users skip self-custody. Separate service from `ae-node`. | `npm run dev` | `npm test` |
| `sdk` | `@alignmenteconomy/sdk`: typed client for third parties (read APIs + signed write helpers + `PlatformClient`). | `npm run build` | `npm test` |
| `explorer` | Read-only block explorer (React + Vite). Inspect blocks / txs / accounts. Depends on the SDK. | `npm run dev` (:5175) | `npm run build` |

The desktop apps bundle `ae-node` and spawn it as a child process
(`ae-app/electron/main.cjs`, `ae-miner/electron/main.cjs`): one installed app
= one local node. The bundled node runs in solo authority mode by default, or
as a BFT validator when a network config has been saved (see the onboarding
network-mode picker).

---

## ae-node: how a request becomes state

1. A signed transaction hits the API (`src/api/`, Express, mounted at
   `/api/v1`). `authMiddleware` verifies the ML-DSA signature and sets
   `req.accountId` from it. **Routes never trust an account id in the body**
   (a top-level id is accepted only as a back-compat shim and 403s on
   disagreement).
2. The tx is applied locally and gossiped to peers (`src/network/`).
3. The BFT-elected proposer includes pending txs in a block
   (`src/core/consensus/BftBlockProducer.ts`).
4. Consensus runs propose → prevote → precommit → commit (`BftDriver`,
   `BftRuntime`, `RoundController`). On commit the block's txs are applied.
5. Applying a tx (`src/core/transaction.ts`: `processTransaction` for the
   live path, `replayTransaction` for followers catching up) updates
   balances + the fee pool and writes append-only rows to `transaction_log`.

### Subsystems (where things live)

- **Consensus** (`src/core/consensus/`): Tendermint-style BFT.
  `BftDriver`/`BftRuntime`/`RoundController` (engine), `BftBlockProducer`
  (producer), `SqliteValidatorSet` (validator set + per-height snapshots),
  `IVrfProvider` + `Ed25519VrfProvider` (stake-weighted proposer selection),
  `commit-certificate.ts` / `votes.ts` / `vote-aggregator.ts`,
  `slashing.ts`, `registration.ts` / `validator-change.ts` (on-chain
  validator add/remove).
- **Economics** (`src/core/`): `transaction.ts` (transfers + the
  fee + percentHuman math), `account.ts`, `day-cycle.ts`, `treasury.ts`,
  `inheritance.ts`.
- **Day cycle** (`src/core/day-cycle.ts`): pure functions over a db handle.
  **Chain-driven, not wall-clock**: when a block's timestamp crosses
  08:59 UTC, every node runs `runExpireAndRebase` then `runMintAndAdvance`
  deterministically (catch-up cycles run if a node was offline across a
  boundary). Enforces the "blackout minute."
- **Storage** (`src/core/stores/`): repository interfaces (`IAccountStore`,
  `ITransactionStore`, `IBlockStore`, `IVerificationStore`, `IMiningStore`,
  `ICourtStore`) with `Sqlite*` implementations. The seam for swapping
  SQLite → Postgres. (Residual inline SQL for `day_cycle_state` is the last
  bit to extract behind an `ICycleStateStore`.)
- **P2P** (`src/network/`): `peer.ts` (`PeerManager`: dial, signed handshake,
  ban list, gossip relay), `node.ts` (`AENode`: WebSocket server + the
  periodic catch-up sync tick), `sync.ts` (`ChainSync`: `get_blocks` catch-up
  + live-gossip apply), `discovery.ts` (seed nodes via `AE_SEED_NODES`).
- **API** (`src/api/`): `server.ts` → `createApp(db)`, routes in
  `routes/`, `authMiddleware` gating every state-changing route.
- **Mining / verification / court / tagging**: `src/mining/` (fee
  distribution + rewards), `src/verification/` (evidence, vouching, panels),
  `src/court/` (challenges, juries, verdicts), `src/tagging/` (supportive +
  ambient point flows, smart contracts).

### Data model (SQLite, `src/db/schema.ts`)

Key tables: `accounts`; `transactions`; **`transaction_log`** (append-only
audit trail of every balance change — the source of truth for follower
replay and the wallet/miner ledger views); `blocks`; `fee_pool`;
`rebase_events`; `day_cycle_state`; `protocol_params`; the validator set +
snapshots; `verification_evidence` / `verification_panels` /
`panel_reviews`; `vouches`; `miners`; `court_*`. The schema is versioned
(v9 at last count — see the migration ladder in `schema.ts`).

---

## The seams a deployment team will care about

1. **Database.** Business logic goes through the `I*Store` interfaces, so a
   Postgres implementation drops in without touching economics. (Mostly
   extracted; one `day_cycle_state` seam remains.)
2. **Network transport — the #1 deployment blocker.** `peer.ts` dials peers
   with `new WebSocket('ws://host:port')` and `node.ts` listens with
   `WebSocketServer`. This assumes a **directly-reachable** address, so two
   machines behind home routers cannot peer today. **NAT traversal / a relay
   / a tunnel inserts here.** Peering, handshake, gossip, and sync all sit on
   top of the `ws` connection object, so a transport presenting the same
   `send` / `on('message')` / `on('close')` surface drops in without touching
   consensus.
3. **VRF.** `IVrfProvider` (Ed25519 today). Swap ECVRF (RFC 9381) for
   stricter unbiasability in adversarial settings.
4. **Custodial host.** `platform-server` ships a Dockerfile, `fly.toml`, and
   `render.yaml`. Pick a host: `docs/deploy-platform-server.md`.

---

## Crypto

- **Account signing:** ML-DSA-65 (post-quantum) via `@noble/post-quantum`.
- **Node identity + VRF:** Ed25519 via `@noble/curves`.
- **Hashing:** SHA-256 via `@noble/hashes` / `node:crypto`.

---

## Testing notes

- `ae-node`: `npm test` runs 70+ phase suites + smoke/LAN harnesses (580+
  tests). **Use the canonical `npm test`** — the `--test-force-exit` flag
  falsely marks suites that leave a listening handle open (e.g. an API-server
  test) as failed. The multi-runner BFT tests (phase49/53/57/59/60,
  `smoke-multiblock`) spin up several in-process nodes and are timing-
  sensitive under heavy machine load; run them on their own if a flake
  appears.
- `platform-server`, `sdk`: `npm test`.
- The React apps: the build (`tsc -b && vite build`) is the gate; there is no
  unit-test suite for the UI yet.

---

## What's not done / for the deployment team

See CLAUDE.md "Build plan to handoff" for the full list, tagged
`[CODE]` / `[MATT]` / `[PRO]`. Headlines: NAT traversal + a public bootstrap
node (no public-internet peering yet), Mac/Linux installer code-signing,
deploying `platform-server` to a real host, external crypto + protocol
audits, and the consensus-critical pure-bigint rebase/fee precision pass
(deliberately deferred — it is Phase-2/scaling and negligible at current
scale; change it carefully, with full-suite verification, not in passing).

---

## Where to start reading

1. `src/db/schema.ts` — the data model.
2. `src/core/transaction.ts` — how value moves (fee + percentHuman math).
3. `src/core/day-cycle.ts` — the daily expire / rebase / mint.
4. `src/core/consensus/BftBlockProducer.ts` + `BftRuntime.ts` — how blocks
   are made and committed.
5. `src/network/sync.ts` + `peer.ts` — how nodes talk and catch up.
