# Alignment Economy (AE) Platform

> Last updated: May 4, 2026. 65 build phases. The chain runs end-to-end (multi-validator BFT, real txs, on-chain validator changes, sync replay) on a real WebSocket P2P layer. Phase 61: percentHuman as spend multiplier. Phase 62: `networkId` in genesis spec + P2P handshake. Phase 63: per-block fee distribution into BFT + Authority commit paths (20% Tier 1 / 80% Tier 2, 60/40 lottery/baseline; lottery via public-input hash). Phase 64: court burns route to fee pool instead of disappearing (defendant 80% on guilty, voucher stakes via `burnVouch`, minority juror stakes, innocent challenger stake, appeal-reversal clawback) — closes the small-network deflation hole, conserves total supply, miners pick up the value across blocks. Wallet (`ae-app`) has a working tag UI, verification status card, and a recovery-phrase export action on the More page. Miner (`ae-miner`) has a working vouch UI. Backend exposes `/api/v1/tags/*`. Court has a full case-detail flow with arguments, response, jury panel (schema v7). Genesis spec is at v2 (added `networkId`). CLI `npm run validator:setup` scaffolds a fresh validator identity for one-command join.
>
> **Repo layout:** This is `alignment-economy-code` (apps + protocol). The marketing website lives in a separate sibling repo at `alignment-economy-website` (was `ae-platform/`). Don't mix them.

## What This Project Is

The Alignment Economy is a new economic system designed to replace the broken incentive structures of both fiat money and cryptocurrency. It is being developed as a 501(c)(3) nonprofit. This codebase is the working prototype of the full platform.

The founder (Matt) is a strategy consultant, not a developer. He is vibe coding this project, meaning he will describe what he wants in natural language and you (Claude Code) will build it. He needs to visually see progress in the browser to give feedback. Always run the dev server so he can preview changes live.

## Core Philosophy (The "Why")

Human economies have gone through three eras:
1. **Capture** (take by force), went from win-lose to lose-lose when technology made destruction mutual (nuclear weapons)
2. **Convince** (take by manipulation), went from win-lose to lose-lose when AI-powered persuasion fractured shared reality
3. **Coordinate** (align incentives so cooperation wins), this is the Alignment Economy

The fundamental problem: every measuring stick humans have built (coins, ledgers, GDP, stock prices, click-through rates) could only see lower-order needs. It couldn't see a mother's work, a teacher shaping a mind, or a neighbor holding a community together. The AE fixes the measuring stick.

The real enemy is entropy (disorder, decay, things falling apart), not other humans. The economy should direct human attention toward fighting entropy, not toward fighting each other.

## How the AE Works (The Mechanics)

### Point Types and Daily Allocations

Every active individual receives points daily. These are NOT tokens to trade on exchanges. They are a new unit of account.

- **Active Points (1,440/day):** Given to every active individual. Expire every 24 hours. Cannot be hoarded. You spend them or lose them. This kills the hoarding instinct and ensures circulation.
- **Supportive Points (144/day):** Flow automatically to the durable goods a person is actively using (chair, laptop, shoes, tools). The longer an object stays in use, the more it earns for its maker. Rewards durability over planned obsolescence.
- **Ambient Points (14.4/day):** Flow to the physical spaces a person occupies (buildings, parks, roads). More time people choose to spend somewhere = more that place earns. Replaces taxation with presence-based funding.
- **Earned Points:** Anything received from another person (payment for work, care, service). These CAN be saved without limit. This is how caregiving, teaching, and community work finally show up in the economy.

**Verification gates spending, not minting.** Every active individual receives the full daily mint regardless of percentHuman. When they spend, the value transferred to the recipient (and into the fee pool) is multiplied by `percentHuman / 100`. The remainder burns as `burn_unverified`. A new joiner at 0% sees their daily allocation accumulating (the visible carrot to seek verification), but every spend evaporates to zero until a miner raises their score. This closes the sybil vector — duplicate accounts can mint freely but cannot move value — while making onboarding visible instead of empty.

### Daily Schedule (Fixed Global Clock)

All daily operations run on a fixed EST clock (UTC-5, no daylight saving adjustment). This is a global protocol, the schedule does not shift with US daylight saving. Users in EDT will see operations happen one hour later on their wall clock during summer.

- **3:59 AM EST (08:59 UTC):** Expire all unspent daily points (active, supportive, ambient balances go to zero), then run the daily rebase. The rebase adjusts all earned and locked balances so that total purchasing power per person remains constant as new participants join.
- **4:00 AM EST (09:00 UTC):** Mint fresh daily allocations (active, supportive, ambient) for all active individuals (regardless of percentHuman).
- **Between 3:59 and 4:00 AM EST:** This is the "blackout minute." Daily point types (active, supportive, ambient) are all zero. Transactions using these point types are blocked during this window. Earned-point transactions are unaffected. The system sets a cycle phase of `between_cycles` during this gap.

**Current state:** Implemented. The day cycle is anchored to UTC and triggered by block timestamps (Phase 40, chain-driven). When a block whose timestamp crosses 08:59 UTC commits, every node runs `runExpireAndRebase`, then `runMintAndAdvance` deterministically. Catch-up cycles run if a node was offline for one or more boundaries. The blackout minute is enforced.

### Daily Rebase

A daily adjustment keeps everyone's share of the total economy constant as new people join. The number in your account might change, but purchasing power doesn't. This solves Bitcoin's two fatal paradoxes:
- No first-mover advantage (everyone gets points daily regardless of when they join)
- No deflation trap (hoarding gains you nothing)

### Proof of Human (Mining)

Instead of proof-of-work (burning electricity), the AE uses proof-of-human. Miners verify that each account belongs to a real, singular human being.

Every participant carries a **percent-human score** built through:
- Biometrics
- Government ID
- Vouching: other verified humans staking their own points that you are real (ten people vouching can bring someone to full participation without documents)

The system doesn't require trust in institutions. It requires skin in the game.

### Dispute Resolution (Courts)

The system needs a decentralized court/arbitration mechanism for disputes about identity verification, point allocation, fraudulent accounts, and vouching disputes. Court bootstrapping (jury sizes scale with population) is implemented and tested at the small-network level.

## Consensus: Tendermint-style BFT

The chain runs a Tendermint-style BFT consensus engine. Sessions 12 through 54 built it from primitives.

- **Validator set:** persisted in SQLite (`SqliteValidatorSet`). Each validator is `{accountId, nodePublicKey, vrfPublicKey, stake, isActive}`.
- **Proposer selection:** weighted by stake, deterministic per round, derived from a chain-anchored seed via the `IVrfProvider` interface (`Ed25519VrfProvider` is the production impl; an HMAC stub remains for tests).
- **Round flow:** propose → prevote → precommit → commit. Locking and polka-unlock implemented per the Tendermint spec.
- **Crypto:** ML-DSA-65 (post-quantum) for account-level signing, Ed25519 (`@noble/curves`) for node identity and VRF.
- **Slashing:** double-sign and downtime detection wired to the validator set; conflicting precommits at the same height/round produce slashable evidence.
- **Snapshots:** `ValidatorSetSnapshot` records the active set per height so historical certs can be verified at the right epoch.

### Validator-Change Lifecycle (Sessions 48-58)

Adding/removing validators happens entirely on-chain.

1. **Genesis seed** (`buildGenesisSet`, `writeGenesisSet`): the CLI `npm run genesis:init` produces a shared `genesis.json` plus one private keystore per validator. Each operator boots from the same spec.
2. **API entry** (`POST /validator/register`, `POST /validator/deregister`): the candidate signs an intent with their ML-DSA key. The local node validates, queues, then the producer pulls from the queue when proposing the next block.
3. **On-chain commitment**: validator changes ride the block as `block.validatorChanges`. Block-hash includes them (Phase 58), so a block can't be reorged to swap who's in the set.
4. **Sync replay** (Phase 57): a follower catching up replays validator changes per block, snapshotting the pre-change set, so cert verification at every historical height uses the correct validator set.
5. **End-to-end** (Phase 59): a candidate can boot, sign a register tx, POST it, and both runners commit + apply via the chain. No out-of-band coordination.

### Multi-runner Bootstrap (Session 54 hardening)

`AENodeRunner` boots two-validator BFT cleanly:
- `routeProposal` / `routeVote` buffer pre-startup so peers can talk before consensus is wired.
- `startupDelayMs` gives peers time to mesh before the first proposal.
- Parent-cert-in-gossip fix (Session 53): blocks at height >= 2 carry the prior block's cert so followers don't ban the producer for "missing parent cert."

The `smoke-multiblock` regression test is the canary: two runners commit blocks 1, 2, 3 in sequence with matching hashes.

## Platform Sides (What We Are Building)

This is a multi-sided platform. Each side has its own interface:

### 1. User Side (Participants)
- Dashboard showing daily Active/Supportive/Ambient/Earned point balances
- Send/receive points to other users
- Register durable goods (objects) to receive Supportive point flows
- View spaces they occupy and Ambient point flows
- Transaction history
- Percent-human score display
- Vouch for other users (stake points on someone's humanity)

### 2. Miner Side (Verifiers)
- Queue of pending identity verification requests
- Tools for reviewing biometric submissions, government ID, and vouching chains
- Approve/flag/reject interface
- Miner reputation and accuracy score
- Rewards dashboard (what miners earn for verification work)

### 3. Court Side (Dispute Resolution)
- Queue of disputes (identity challenges, fraud reports, vouching disputes)
- Evidence submission and review interface
- Arbitration panel assignment
- Ruling interface with precedent tracking
- Appeals process

### 4. Admin/Protocol Side
- Rebase engine visualization (show the daily rebase in action)
- Network health metrics (total participants, verification rates, point velocity)
- Protocol parameter dashboard
- Manual day-advance trigger for testing (`POST /admin/advance-day`, implemented)

### 5. Public/Marketing Side
- Landing page explaining the AE to newcomers
- The Bridge narrative (the story version of why this matters)
- White paper access
- Join/onboarding flow

## Tech Stack

- **Backend:** TypeScript, Express 5, WebSocket (`ws`) (ae-node)
- **Frontend:** Vite + React + Tailwind CSS (ae-app wallet, ae-miner dashboard)
- **Database:** SQLite (`node:sqlite`, WAL mode), designed for migration to Postgres then sharded storage (see Scaling Roadmap)
- **Crypto:**
  - **Account signing:** ML-DSA-65 (post-quantum) via `@noble/post-quantum`
  - **Node identity + VRF:** Ed25519 via `@noble/curves` (`Ed25519VrfProvider`)
  - **Hashing:** SHA-256 via `@noble/hashes` and `node:crypto`
  - `tweetnacl` is still in `package.json` but on the way out as ML-DSA / @noble fully replaces it
- **Consensus:** custom Tendermint-style BFT (`BftDriver`, `BftRuntime`, `BftBlockProducer`, `RoundController`)
- **State Management:** React hooks
- **Charts/Visualization:** Recharts
- **Deployment:** Docker + docker-compose, multi-stage builds

## Scaling Roadmap

The code should be correct at any scale, even if it only needs to handle 3 people today. Build interfaces and abstractions that allow the underlying implementation to change without rewriting business logic.

### Phase 1: Now to ~10,000 users
- SQLite, multi-validator BFT, exactly what we have
- Good enough for all testing and early adoption
- Focus: get the economics right, prove the mechanics with real humans

### Phase 2: 10,000 to ~1,000,000 users
- Migrate to Postgres (the schema is already relational, this is a weekend migration)
- Same BFT consensus, validator set grows
- Rebase moves from JS loop to single SQL UPDATE statement (push math into the database, eliminate JS memory pressure)
- Multiple read replicas for API serving

### Phase 3: 1,000,000 to ~100,000,000 users
- Sharded database, larger validator set
- The rebase becomes a protocol-level event: publish the multiplier, each validator applies it to their shard
- Real ECVRF (RFC 9381) replaces the current Ed25519-based VRF where stricter unbiasability proofs are needed

### Phase 4: 100,000,000 to 5,000,000,000 users
- Full state-tree architecture (Merkle Patricia tries or equivalent)
- Thousands of validators, each responsible for a shard of accounts
- Rebase runs in parallel across all shards (5B accounts / 1000 shards = 5M per shard, ~2 min wall clock)
- The single-SQL rebase pattern still works per-shard

### What "build it right from the start" means in practice:
- **Separate business logic from storage.** Use repository interfaces (e.g., `IAccountStore`, `IBlockStore`) so the underlying database can be swapped without touching the economics code. (Partial. `IBlockStore` exists; account/transaction stores still have inline SQL. Fine for Phase 1, needs extraction before Phase 2.)
- **Separate the scheduler from the cycle logic.** The day cycle functions (expire, rebase, mint) are pure functions over a db handle; the scheduler is chain-driven (block timestamps trigger cycles). (Done.)
- **Design the rebase to be parallelizable.** Every account's rebase is independent. Never introduce cross-account dependencies in the rebase step. (Done.)
- **Keep block production separate from consensus.** `BftBlockProducer` is the producer; `BftRuntime` / `BftDriver` are the consensus engine. They talk through narrow interfaces. (Done.)
- **Treat the VRF as a pluggable interface.** `IVrfProvider` exists with `Ed25519VrfProvider` (production) and an HMAC stub (tests). (Done.)

## Known Issues

### Done (Fixed)

- ~~**No manual day-advance endpoint.**~~ `POST /admin/advance-day` exists behind the admin auth gate.
- ~~**Mempool has no deduplication.**~~ Mempool class checks txId before inserting, evicts oldest when full.
- ~~**Minting is not idempotent.**~~ Mint step gates on a per-day reference id; resumeCycle is safe across crashes.
- ~~**No seed data script.**~~ `npm run seed:test` exists. Genesis CLI (`npm run genesis:init`) covers full multi-validator setup.
- ~~**No end-to-end test harness.**~~ 503 tests across 59 suites. Multi-runner E2E (Phase 49, 53, 57, 59, smoke-multiblock).
- ~~**expireDaily iterates ALL accounts, not just individuals.**~~ Filters to accounts with non-zero daily balances.
- ~~**Court bootstrapping problem.**~~ Jury selection uses `Math.min(jurySize, pool.length)`. Protocol params are configurable for small networks.
- ~~**P2P layer has no authentication.**~~ Fixed Session 8: signed handshakes, peer identity verification, ban list, message signing on consensus traffic.
- ~~**Consensus is single-point-of-failure.**~~ Full Tendermint-style BFT (Sessions 12-54). Multi-validator chain runs end-to-end.
- ~~**Day cycle runs on wall-clock interval, not anchored to UTC.**~~ Fixed Phase 40: chain-driven. Block timestamps crossing 08:59 UTC trigger expire+rebase, then mint deterministically across all nodes.
- ~~**New accounts start at percentHuman: 0, which means zero daily allocations.**~~ Fixed Phase 61 (Option B). The percentHuman gate moved from minting to spending. Every active individual receives the full daily mint regardless of percentHuman; every spend (transactions + supportive/ambient tag finalization) multiplies the recipient's value by `percentHuman / 100`. The remainder burns as `burn_unverified` so the ledger conserves. Sybil resistance still holds because unverified accounts can mint freely but cannot move value. New joiners see their allocation accumulating, which is the visible carrot to seek verification.
- ~~**Tagging has no constraint on total minutes.**~~ Both `submitSupportiveTags` and `submitAmbientTags` reject submissions where total minutes > 1,440. Re-submission deletes prior active tags so users can edit but never exceed the cap.
- ~~**Tag UI was a stub.**~~ `ae-app/src/pages/Tag.tsx` is now functional: two tabs (products / spaces), inline registration forms, per-item minute inputs with live point allocation preview, 1,440-minute cap, sticky save. Backed by `/api/v1/tags/*` routes (`tags.ts`).
- ~~**Vouch UI was missing in `ae-miner`.**~~ `ae-miner/src/pages/Vouch.tsx` ships request/inbox/active-stakes flow. Inbox accept calls `submitVouch` then `updateVouchRequest('accepted')` in order so a failed stake doesn't leave a stale "accepted" record.
- ~~**`ae-miner` API client didn't wrap unwrapped responses.**~~ `request()` in `ae-miner/src/lib/api.ts` now wraps bare JSON in `{success: true, data: ...}`, matching `ae-app`. Side effect: sidebar tier badge now correctly shows "TIER 1 NODE" instead of falling back to "MINER".
- ~~**Court had no case detail, evidence, or defense response.**~~ New `court_arguments` table (schema v7), append-only log of text submissions by the challenger or defendant. `fileChallenge` accepts an optional `openingArgument` that becomes the first argument row. New `POST /court/cases/:id/arguments` route (auth-gated to challenger or defendant). `GET /court/cases/:id` returns `arguments` alongside the case + jury. New `CaseDetail.tsx` page in both apps at `/court/:id`, with color-coded argument timeline (challenger orange, defendant teal), response/evidence form, jury panel with sealed votes, and a juror vote card on the miner side. Court list rows in both apps now link through to detail. Miner's File Challenge form has an opening-argument textarea (5,000 char limit).
- ~~**Court bounty/burn split drains the economy at small scale.**~~ Fixed Phase 64. Every burn site in the court flow (defendant 80% on guilty, voucher stakes via `burnVouch`, minority juror stakes, innocent challenger stake, appeal-reversal clawback) routes the burned amount into the fee pool via `addToFeePool`. Total network supply is conserved across a verdict; miners pick up the value across subsequent blocks. Conservation invariant `pre_supply + pre_pool == post_supply + post_pool` covered in `phase64.test.ts`.
- ~~**Mnemonic export is one-way.**~~ Wallet's More page now has a "Recovery Phrase" card. Default offers an "Export Recovery Phrase" button; clicking opens a confirm step (red shoulder-surfing warning, Cancel / Show Phrase). Confirming reveals the 12 words in a 3-column grid with Hide and Copy 12 Words. V1 wallets (no mnemonic) see a notice that recovery export isn't available. Path: `ae-app/src/pages/More.tsx`.
- ~~**`ae-miner` Login shows "Registration failed" when the account is already a miner.**~~ Already fixed in `Login.tsx:handleRegister` (catches 409 and proceeds when `isMiner === true`).
- ~~**WS `court:argument` events don't auto-refresh.**~~ Already added to the allowed event types in `ae-node/src/api/websocket.ts`.
- ~~**WebSocket subscribe has no authentication.**~~ Audited Phase 65. Backend `setupWebSocket` already verifies a signed `{action:'subscribe', accountId, role}` payload + timestamp via the account's stored publicKey, with a 5-minute window. Both clients (`ae-app/src/lib/websocket.ts` and `ae-miner/src/lib/websocket.ts`) sign with the wallet's ML-DSA private key on `onopen`. New `phase65.test.ts` (5/5 pass) covers the four failure modes (no sig, wrong sig, stale timestamp, unauthenticated client) plus the happy path that an authenticated client receives its account-specific events.
- ~~**`tweetnacl` dependency is dead.**~~ Removed from `ae-node/package.json`. No source under `alignment-economy-code/` imports it (full-codebase grep, and crypto fully runs on `@noble/post-quantum` for ML-DSA + `@noble/curves` for Ed25519 VRF + `@noble/hashes` for SHA-256). Phase 1 + Phase 65 still pass post-removal.
- ~~**Admin endpoint protection / docs.**~~ Already gated by `AE_ADMIN_SECRET` (constant-time compare, fail-closed when unset). Now documented in `README.md` under "Configuration" with usage example. Operators set the env var to a long random value (`openssl rand -hex 32`) to enable `/admin/advance-day`; without it the endpoint returns `403 ADMIN_DISABLED`.

## Roadmap to Full Build

**End state:** Anyone can download an installer and join a real Alignment Economy network with friends. Multi-validator BFT, real txs, real verification, real court. Not a demo, not a "two-person test." A working network.

**Why this section exists:** Without a goal-driven roadmap we keep picking small fixes (which are easy to identify) and never make decisive progress on the big build (which is where the value is). Pick the top open milestone below and march to it. Don't drift back into small fixes unless a critical bug forces it.

**Working in this codebase:** When you finish a milestone task, check it off here AND add the matching one-liner to "Done (Fixed / Shipped)." When a milestone fully completes, mark it ✅ and start on the next.

### Milestone 1: Downloadable public testnet (NEXT)

Goal: Anyone can download an installer, run it, and join a real Alignment Economy network with friends over the public internet. Multi-validator BFT, real txs, real verification, real court. The protocol already works (Phases 12-65). The missing layer is the install/join UX, public infra, NAT traversal, and the polish that makes the whole thing usable.

LAN testing happens *as we build* — don't ship a LAN-only release as a separate milestone. LAN is the dev environment. The shipping target is "you and your friends each download this installer and end up on the same chain."

**Install/join UX (no networking complexity needed for these tasks):**
- [x] **Bundle `ae-node` inside `ae-miner`** ~~(currently only the wallet bundles it; `ae-miner/electron/main.cjs` is just the UI). Mirror the wallet's pattern: spawn ae-node as a child, poll /health, store DB under userData.~~ Done. `ae-miner/electron/main.cjs` now mirrors ae-app's spawn-and-poll-health pattern. Bundled node runs on port **3001** (wallet uses 3000) so two installed apps don't collide. DB lives under `userData/ae-miner-data/`. Smoke-tested: built ae-node, ran with the env vars main.cjs sets, `/api/v1/health` returned 200.
- [x] **First-launch network mode picker.** ~~When the wallet boots and there's no wallet yet, show a chooser: (1) Solo / Authority node (current default), (2) Start a new network (run genesis, become founder), (3) Join an existing network (paste genesis hash + bootstrap address + your validator keystore, or scan an invite link).~~ Done. New `network-mode` screen in `ae-app/src/pages/Onboarding.tsx` between Welcome and account creation. Three cards (Solo / Start a new network / Join an existing network); each writes the choice to `localStorage['ae_network_mode']`. Solo continues to the existing `createAccount()` → recovery-phrase flow. Start new and Join existing route to placeholder screens that explain the next milestone task will wire them up. Browser-verified all five paths (welcome → picker → each card → back).
- [x] **"Start a new network" flow.** ~~Run the existing `genesis:init` CLI from inside the app, write the spec to disk, show the user a "share this `genesis.json` with the people you want to invite" screen with a copy/export action AND an invite link (see invite-link task below).~~ Done. New `POST /api/v1/founder/generate-genesis` endpoint on ae-node wraps `buildGenesisSet` (the same library function the CLI uses) and returns the spec + per-validator keystores + spec hash. Wallet's "Start a new network" picker option now opens a 3-step flow (form → generating → result). The result screen shows the spec hash, lets the user download the public `genesis.json` and each private `<name>.keystore.json`, and the founder's own keystore becomes their wallet identity on continue (saved via new `saveFounderWallet`). Invite link is the next sub-task. Phase 66 test (7/7) covers happy path, keystore shape, accountId distinctness, and four validation failures.
- [x] **"Join existing network" flow.** ~~Form for genesis hash + bootstrap address (or invite link), generate the validator keystore inline via `validator:setup`. Wire bundled ae-node to validator mode (not authority mode) when this path is taken.~~ Done for the founder-distributes-keystore path: the "Join an existing network" picker option now shows two file inputs (genesis.json + your keystore.json), parses both, validates that the keystore's `account.publicKey` matches one of the validator entries in the spec, and persists the keystore as the wallet identity (`saveJoinerWallet`) plus the spec (`saveJoinedNetwork` → `localStorage.ae_joined_network`). Wrong-network keystores get a clear "Keystore not in this network" warning and the Join button stays disabled. Browser-verified positive (matched pair) and negative (mismatched pair) paths. Inline-generation-via-validator:setup (for joiners NOT pre-allocated by the founder) is still TODO. The main.cjs ae-node restart logic is its own task below.
- [x] **Wire `main.cjs` to honor network choice.** ~~Today's `ae-app/electron/main.cjs` and `ae-miner/electron/main.cjs` always boot ae-node in single-validator authority mode regardless of the user's network-mode choice...~~ Done. New `electron/preload.cjs` in both apps exposes `window.aeNetwork.saveConfig({mode, spec, keystore})` via contextBridge. Onboarding's `continueAsFounder` and `joinNetworkAsValidator` call it after persisting the wallet, which writes `userData/ae-network/{network-config.json,genesis.json,keystore.json}` from main. On next boot, `startAeNode()` reads the config and sets `AE_CONSENSUS_MODE=bft + AE_GENESIS_CONFIG_PATH + AE_NODE_KEY_PATH + AE_BFT_LOCAL_ACCOUNT_ID` so ae-node loads the spec and runs as a real BFT validator. Solo / no-config keeps today's authority defaults. Bonus: explicit `AE_P2P_PORT` (9000 for wallet, 9001 for miner) so two installed apps on one machine don't collide. Smoke-tested with a real generated spec; `/api/v1/health` returns 200 and the log shows "Applied genesis spec ... 2 accounts, 2 validators" + "BFT consensus loop started."
- [x] **"Restart to apply" notice + "Apply now" button.** The running ae-node child still has the old (solo) spawn env after `saveConfig` writes; the user has to relaunch for BFT mode to take effect. New `aeNetwork:relaunch` IPC + `window.aeNetwork.relaunch()` preload bridge handles a clean tear-down + relaunch via `app.relaunch(); app.exit(0)`. Onboarding flows now navigate to a `restart-to-apply` screen after Start-new or Join-existing instead of `/` directly: shows network ID + accountId, "Apply now (restart app)" button, "Continue without restarting" fallback. In plain browser dev (no `window.aeNetwork`) the screen is skipped entirely. Verified all four paths (browser-dev → /, mock-Electron → restart screen, Apply now → relaunch IPC fires, Continue → / without relaunch).
- [x] **Invite link / QR code.** ~~A founder generates a shareable URL/QR encoding genesis hash + bootstrap address. Joiner scans or pastes, app fills the join form automatically.~~ Done for the link half (QR is a follow-up that needs a small library). New `ae-app/src/lib/invite.ts` encodes a spec into `https://invite.alignmenteconomy.org/v1#<base64url(spec-json)>` (everything in the URL fragment so the spec never goes to a server even on accidental clicks). Founder result screen now shows the link with a "Copy invite link" button alongside the genesis.json download. Joiner form has a textarea at the top: pasting any valid AE invite link parses the spec and pre-fills the genesis side, so the joiner only needs to upload their personal keystore. Invalid links show "That doesn't look like a valid AE invite link." Browser-verified all three paths (founder generates → joiner pastes valid link → spec recognized; joiner pastes invalid link → error). Bootstrap address isn't in the link yet because there's no public bootstrap; that's the next milestone task.

**Internet reach:**
- [ ] **Public bootstrap node.** Cheapest VPS (~$5/mo Hetzner / DigitalOcean). Permanent address, runs `ae-node` in validator mode, holds the canonical AE testnet genesis spec.
- [ ] **Bake testnet address into installer.** "Join the AE testnet" button on first launch hits the bootstrap node, downloads genesis spec, runs validator setup automatically.
- [ ] **NAT traversal.** Two laptops on home WiFi can't peer directly. Pick one approach (tunnel service like tailscale embedded, WebRTC peer connections, or a hosted relay) and ship it.

**Polish so non-technical users can actually use it:**
- [ ] **Onboarding tuned for non-technical users.** Today's flow assumes you know what a recovery phrase is. Add education, not just a 12-word screen.
- [x] **Better error states.** ~~"Could not reach bootstrap node" with retry. "You're offline." "Your wallet is on a different network than this transaction expected."~~ First pass done. `ae-app/src/lib/api.ts` now distinguishes three failure modes via the new `getNodeStatus()` / `subscribeNodeStatus()` exports: `offline` (navigator.onLine false), `node-down` (fetch threw, but online), `ok`. AppShell mounts a top-of-window banner that reflects the live status: "You're offline..." in offline mode and "Can't reach the local node. Try restarting the app." in node-down mode. Browser-verified the node-down banner appears within ~2s of a failed API call. The "Could not reach bootstrap node" + "transaction on the wrong network" cases are TODO once peering is live.
- [x] **Auto-update.** ~~`electron-updater` wired to GitHub Releases so testers don't re-download by hand.~~ Done. Both apps now depend on `electron-updater@^6.8.3`. `electron/main.cjs` lazy-loads `autoUpdater`, registers error / update-available / update-downloaded listeners, and calls `autoUpdater.checkForUpdatesAndNotify()` after `app.whenReady()` in packaged production builds (skipped in dev). `package.json` build block has a `publish` config pointing at `mattfmccormick/alignment-economy-code` GitHub Releases. Once a release with both `Setup.exe` files + a `latest.yml` manifest exists on GitHub, installed clients will auto-download and prompt to install on quit. The Releases pipeline (CI workflow that runs `electron-builder --publish always`) is a separate task.

**Verification + ship:**
- [ ] **End-to-end LAN test on dev machine.** 3 simulated runners on `localhost:3001/3002/3003`, walked through the chooser flow, peer up, register, commit blocks, transact, court works. (This is the dev gate, NOT a release.) **In progress:** `scripts/test-lan-multi-validator.mjs` orchestrates three ae-node subprocesses with a shared genesis. They boot, start the BFT loop, and respond on /health, but don't currently form a peer mesh from the script. The same protocol code path is green in-process per `tests/smoke-multiblock.test.ts` and phase49+ multi-runner tests, so this is a script-level debugging task, not a protocol bug. Manual inspection (leave the script running, curl /network/status) works.
- [ ] **End-to-end internet test.** Two machines on different home networks join the public testnet, transact, verify each other.
- [x] **Build + sign installers** ~~for Win/Mac/Linux, both apps.~~ Windows half done. `npm run electron:build:win` produces ~106 MB NSIS installers for both apps: `ae-app/release/Alignment Economy Wallet Setup 0.1.0.exe` and `ae-miner/release/Alignment Economy Miner Setup 0.1.0.exe`. Each contains the bundled `ae-node` (`win-unpacked/resources/ae-node/dist/node/cli.js`) and the Electron + React app. Mac (`.dmg`) and Linux (`.AppImage`) need their respective platforms; a GitHub Actions workflow with macOS + Linux runners is the right answer there. Code-signing is also future work (today's Win installer is unsigned, so Windows SmartScreen will warn). Release artifacts are gitignored; distribute by hand for now.
- [x] **Write `docs/start-a-network.md`** ~~(founder flow) and `docs/join-a-network.md` (joiner flow). One page each.~~ Both written. `docs/start-a-network.md` walks a founder through the genesis ceremony, keystore distribution, spec-hash confirmation. `docs/join-a-network.md` walks a joiner through pasting the invite link, uploading their keystore, comparing hashes, restart. Each ~1 page; covers the LAN-only state today and notes that public-internet peering is the next milestone.
- [ ] **Wider tester rollout.** Friends, family, early supporters.

### Milestone 2: Whitepaper completeness

Real protocol features the whitepaper requires that aren't built yet. The AE isn't fully the AE without these. Milestone 1 ships without them; they're additive.

- [x] **In-person co-sign (+2.5% credit).** ~~Two parties dual-sign a tx, both get a percent-human bump. Whitepaper §6.3 / Vegas Guy plan Phase 1.6 + 3.5.~~ Protocol-side done (UI handshake — NFC / QR — is a follow-up). Phase 67. New `receiverSignature` field on `Transaction` / `TransactionInput` / `ReplayInput` / `WireTransaction`. processTransaction + replayTransaction now reject `isInPerson=true` txs without a valid countersignature signed by the recipient over the same canonical payload + timestamp. Schema bumped to v8 with an `ALTER TABLE transactions ADD COLUMN receiver_signature TEXT` migration. API route /transactions accepts `receiverSignature` on the request body. The +2.5% decay-offset credit was already wired (verification/decay.ts counts in-person txs for both `from` and `to`); the new piece is dual consent. Phase 67 test (5/5 pass) covers reject-no-sig, reject-forged-by-sender, accept-valid, regular-tx-still-works, reject-third-party-sig. Phase 1 + 61 + 64 still pass.
- [x] **Inheritance: multi-sig + dead-man-switch.** ~~Lost-key accounts pollute the rebase target forever otherwise. Whitepaper §10. Vegas Guy plan Phase 7.9.~~ Phase 69. Schema bumped to v9 with two new columns on `accounts`: `last_activity_at` (unix sec; bumped on every successful outbound tx by the sender) and `inheritance` (JSON config or NULL). New `core/inheritance.ts` exposes `setInheritance(db, ownerId, {beneficiaries, threshold, deadManSwitchDays})` with validation (no self-beneficiary, no duplicates, threshold in [1, beneficiaries.length], minimum 30-day inactivity threshold) and `claimInheritance(db, deceasedId, ts, signatures)` that verifies the dead-man-switch is armed (`now - lastActivityAt >= deadManSwitchDays * 86400`), counts valid beneficiary signatures over `{action:'claim_inheritance', deceasedId}` + timestamp, requires `>= threshold` valid signers, drains the deceased's earnedBalance evenly to the signers (not all listed beneficiaries), and deactivates the account so it leaves the rebase target. Phase 69 test (10/10 pass): config validation, lastActivityAt stamping (sender only, recipients don't bump), pre-arm refusal, sub-threshold refusal, successful drain + deactivate, outsider/forged signature rejection. Phases 1, 61, 64, 67, 68 still green.
- [x] **Smart contract DSL execution engine.** ~~`tagging/smart-contracts.ts` is a schema today, no VM. Whitepaper §5. Vegas Guy plan Phase 6.4.~~ Phase 70. Scope clarification: a full Turing-complete VM is overkill for what the whitepaper actually asks for ("smart contracts between participants and entities" — recurring, conditional value flow). Phase 70 extends the existing executable contract framework with a fourth type, `earned_recurring`, that sends a fixed display-unit amount of earned points to a target on schedule (daily / weekly / weekend / weekday). Skipped if the sender's balance is short — recurring transfers don't accumulate IOUs. Honors `percentHuman` and the standard 0.5% fee path exactly like a normal tx (0% sender drains earned, recipient gets nothing — same Option B semantics as everywhere else). Plus stronger validation in `createSmartContract` for both new and existing types: `active_standing` and `earned_recurring` now require a real, active recipient at creation time; self-targeting is rejected; zero/negative amounts rejected. Reuses `allocationPercent` column for the fixed amount to avoid a schema bump. Phase 70 test (8/8) covers create, reject zero/negative, reject missing/inactive/self target, full execute path with fee, skip-on-insufficient, skip-on-inactive-recipient, percentHuman=0 burn, schedule honor (weekend-only skips on Wednesday). Future expressive primitives (conditional triggers, multi-leg flows) layer on as additional contract types under the same dispatcher.
- [x] **Block explorer (separate viewer).** ~~Public read-only chain inspection. Vegas Guy plan Phase 9.1.~~ Done. New `explorer/` Vite+React+Tailwind app at the repo root, depends on `@alignmenteconomy/sdk` via a `file:../sdk` link. Pages: Home (network stats grid + latest blocks table, polls every 5s), `/block/:number` (hash, parent, authority, prev/next nav), `/tx/:id` (placeholder until ae-node exposes a tx-by-id endpoint), `/account/:id` (balances grid + 50 most recent transactions with sent/received indicator). Search bar at the top routes by input shape: digit-only → block, UUID → tx, anything else → account. Browser-verified all four routes against a running ae-node: Home loads with real day/height/participant counts, Block 0 detail renders, account creation + navigation works, search routes correctly. Dev server runs on :5175 with `/api/v1` and `/ws` proxied to localhost:3000.
- [x] **TypeScript SDK** ~~+ dev portal. So third parties can integrate. Vegas Guy plan Phases 9.5, 9.6.~~ SDK v0.1 done; dev portal is a follow-up (the README + inline doc comments cover the SDK surface for now). New `sdk/` package at the repo root publishes as `@alignmenteconomy/sdk`. Includes `AlignmentEconomyClient` (typed wrappers around `/api/v1/health`, `/accounts`, `/transactions`, `/network/status`, `/network/blocks`, `/founder/generate-genesis`) + `signTransaction` helper + crypto re-exports (`generateKeyPair`, `deriveAccountId`, `signPayload`, `verifyPayload`, `newMnemonic`, `mnemonicToKeypair`). Bigints round-trip as base-10 strings. Errors throw `SDKError` with `.code` + `.httpStatus`. 7/7 smoke tests pass against a real spawned ae-node (boot, health, account create/get, network status, mnemonic round-trip, sign+verify, founder genesis ceremony). Court / verification / mining / vouching / tag endpoints land in v0.2.
- [x] **Treasury / ecosystem fund.** ~~Today the 0.5% fee goes 100% to miners. Nothing funds the explorer, audits, or the nonprofit running this. Whitepaper is silent on this.~~ Phase 68. New `treasury.fee_share` param (default 0.10) carves a slice off the top of every block's fee distribution and routes it to a deterministic protocol-owned account whose private key isn't held by anyone (sentinel publicKey of all zeros, accountId derived from that). `mining.tier1_fee_share` reduced 0.20 → 0.18 to make room; tier2 gets the implicit 0.72. New `core/treasury.ts` with `ensureTreasuryAccount(db)` + `TREASURY_ACCOUNT_ID` constant. Wired into `distributeFeesPublicLottery` (the production path). Treasury auto-creates on first fee distribution; balance accumulates across blocks. Phase 68 test (7/7) covers default 10%, accumulation, 3-way split arithmetic, opt-out via 0 share, no-miners edge case, idempotency, and accountId determinism. Phase 4 + 63 expectations updated for the new defaults. Spending from treasury (governance) is a follow-up.

### Milestone 3: Mainnet readiness

The credibility layer. None of this is fast.

- [ ] External cryptographic audit (Ed25519, ML-DSA, VRF, canonical encoding)
- [ ] External protocol audit (rebase math, fee distribution, court flow correctness)
- [ ] Sybil + vouching-ring threat modeling and hardening
- [ ] Privacy review (no PII on-chain confirmed, evidence storage standards)
- [ ] Regulatory posture (money transmitter, securities, KYC/AML interface)
- [ ] Bug bounty program (HackerOne or Immunefi)
- [ ] Mainnet genesis ceremony + initial validator set
- [ ] Disaster recovery playbooks

---

### Open small items (NOT in the milestones)

These are real but small. They go here so they don't get lost, but they should NOT pull us off the milestone above. Pick them up only if convenient, or batch them at the end of a milestone.

- **`dev-bump-ph.mjs`.** Dev shortcut to bump test accounts to 100% and seed earned balance. Documented in CLAUDE.md but worth a short README mention so testers find it.
- **`ae-platform` (now `alignment-economy-website`) is half-built.** `/demo`, `/memes`, `/api` routes are stubs. No "Download wallet" or "Join beta" CTA. Lives in the sibling `alignment-economy-website` repo — touch when shipping installers, not before.

### Future (Phase 2+ scaling — not on the immediate roadmap)

- **Rebase precision loss.** Integer division in the rebase loop truncates fractional dust each cycle. Over many rebases, small accounts slowly lose value. Add a remainder-distribution pass or a dust accumulator.
- **Fee math loses precision at scale.** Mixed bigint/Number arithmetic caps precision at ~2^53. Use pure bigint arithmetic throughout.
- **VRF could be stricter.** `Ed25519VrfProvider` is the production VRF. For Phase 3+ adversarial settings, swap in ECVRF (RFC 9381) behind the same `IVrfProvider` interface.
- **Rate limiting is in-memory only.** Rate limit maps reset on every node restart. Move to Redis or DB for Phase 2+.
- **No privacy layer.** Every transaction, balance, vouch, and ambient tag (physical location and duration) is stored in plain text. Plan for encrypted state or zero-knowledge proofs in Phase 3+.
- **`setParam` has no governance.** Anyone who can call `setParam()` can change fee rates, jury sizes, decay schedules. The `updatedBy` and `signature` fields exist but aren't enforced.
- **Smart contract tagging has no execution engine.** `smart-contracts.ts` has a schema for condition-based flows but no scripting language, VM, or sandbox. This is a placeholder, not a feature.
- **SQLite won't scale past a single machine.** Use the repository pattern (see Scaling Roadmap) so the database layer can be swapped. Don't add more raw SQL to business logic functions.
- **Phase 17 sync test is timing-flaky.** `await wait(500)` after `startSync()` is occasionally too tight under load. Bump or replace with an event-based wait.
- **Phase 60 restart test is timing-flaky.** Multi-runner BFT test with 4 validators occasionally fails Phase B (live runners catching up after one is killed and restarted). Same family as Phase 35/49/53/59 flake. Not related to any code path my changes touched.
- **`ae-platform` is half-built.** Landing `page.tsx` exists, but `/demo`, `/memes`, `/api` routes are stubs. No "Download wallet" or "Join beta" CTA. Update before showing funders.

## Development Approach

- **Work from the roadmap.** The "Roadmap to Full Build" section is the path. Pick the top open milestone and march. Don't drift into small fixes unless something is genuinely broken and blocking. If you find yourself proposing a small one-off change, ask whether it's on the milestone path or whether it's a distraction.
- **Don't frame work as "two-person testing."** The goal is a downloadable network multiple people can join, not a one-off test with Matt's wife. The wife test has happened in earlier sessions; it's not the destination.
- Build each platform side as its own app (ae-app, ae-miner) with shared backend (ae-node)
- Make it look real and polished, this will be shown to potential funders and collaborators
- Mobile-responsive from the start
- Every new feature needs at least one test that exercises the happy path and one that exercises the primary failure mode
- Test fixtures use neutral names (`validator-1`, `validator-2`, `alice`, `bob`, `candidate`). Don't put real-life identities into source.

## Matt's Preferences

- Preserve his voice in any copy/text, don't make it sound like AI wrote it
- Don't use em dashes, use commas or parentheses instead
- Show progress visually at every step (keep the dev server running)
- Explain what you're doing in plain language, he's not a developer
- When in doubt, build something he can see and react to rather than asking for specifications
- Use concise, punchy language. No hedging, no filler.
- When Matt asks for an honest assessment, give the honest worst-case framing, not the softened version
