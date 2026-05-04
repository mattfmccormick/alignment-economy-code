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

### Next (Before / During 2-Person Testing)

These are real but not test-blockers. Matt and his wife will hit some of them; document and patch as needed.

- **No "request a vouch" UI in `ae-app`.** Backend endpoint exists (`POST /api/v1/miners/vouch-requests`) and the miner side handles incoming requests. The wallet's `Verify.tsx` shows received vouches but has no button to *send* a request. Add a small modal mirroring the miner's send form. (Note: also already shipped per the AE Code session — verify here before re-implementing.)
- **`dev-bump-ph.mjs` is the dev shortcut to bump test accounts to 100% and seed earned balance.** Used during testing instead of running the full genesis CLI. Run from `ae-node/` with `node scripts/dev-bump-ph.mjs`. Document this so testers don't re-discover.

### Before Public Beta (Not Blocking 2-Person Test)

- **Admin endpoint protection.** Already gated by `AE_ADMIN_SECRET` env var (admin routes return 403 when unset). Document the env var in deploy docs.
- **`tweetnacl` dependency is dead.** Listed in `package.json` but no longer imported (replaced by `@noble`). Remove during cleanup.

### Future (Phase 2+)

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
