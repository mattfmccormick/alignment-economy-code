# Alignment Economy (AE) Platform

## The goal (read this first)

The objective is the most complete, correct, well-documented full-network codebase we can produce, ready to hand to a professional engineer or team who will harden it and deploy it to real miners and users. This is NOT a friends-at-home test or a quick demo.

Optimize for, in order:
1. **Correctness** (tests green, no known economic or consensus bugs)
2. **Completeness** (no half-built flows, no stub screens, every button does something real)
3. **Clean seams** (a pro can swap the database, the network transport, or the host without rewriting the economics)
4. **Handoff docs** (someone new can clone it, run it, read it, and find the edges in an afternoon)

Deployment-stage and operations work (NAT traversal, public bootstrap nodes, picking a host, code-signing certs, running infrastructure, external audits) is explicitly the professional team's job. We make the code ready for that work and document the seams. We do not have to operate it ourselves.

## Two-laptop bring-up audit (August 16, 2026)

First attempt to run the two-laptop LAN test from a clean `git clone`. It did not
work, and the reasons were not in the consensus layer. A code audit of the four
paths the test depends on (wallet account creation, genesis keystore identity,
the dev seeding script, send + miner registration) turned up a set of defects
that unit tests structurally could not catch, because every one of them lives in
the seam between two packages that are only ever tested apart.

### Fixed this session

- **Transaction signatures were broken for every send.** `ae-app`'s Send page and
  the public SDK's `signTransaction` both built a 6-key payload
  (`from, to, amount, pointType, isInPerson, memo`), while `ae-node` verifies a
  7-key one that also carries `recipientIsHuman` (`core/transaction.ts`). Both
  sides hash a raw `JSON.stringify` with no key canonicalization
  (`core/crypto.ts`), so the byte strings differed and ML-DSA verification
  returned false 100% of the time. Every wallet send returned
  `400 INVALID_SIGNATURE`. Fixed in `ae-app/src/pages/Send.tsx` and
  `sdk/src/client.ts` by signing `recipientIsHuman: false` in the position the
  node expects. Verified two ways: byte-level (old payload rejected, new one
  accepted by the node's own `verifyPayload`) and end-to-end against a throwaway
  node (old → `400 INVALID_SIGNATURE`, new → `200`, recipient balance moved).
  **Why 663 green tests missed it:** the node's tests build the correct 7-key
  payload themselves, and `ae-app/src/pages/Send.test.tsx` mocks the API client.
  Nothing anywhere signs with the wallet's code and verifies with the node's.
  That seam is still untested and should get a contract test, in the spirit of
  `api-shape-contract.test.ts` but for signing payloads.
- **Six onboarding screens were unreachable.** `network-mode`, `start-new-form`,
  `start-new-generating`, `start-new-result`, `join-existing-form` and
  `restart-to-apply` formed an island: the only `setFlow('network-mode')` calls
  were the "Back" buttons on screens inside the island itself. `what-is-ae` was
  orphaned the same way. The genesis ceremony and the validator keystore import,
  the entire operator path documented in `docs/start-a-network.md` and
  `docs/join-a-network.md`, could not be reached from the shipped app. Added two
  text links on the welcome screen. Both target screens already had working Back
  buttons, so the loop closes. Verified by clicking through to the keystore
  upload in a real browser.
- **Miner assignment dead-ended on small networks.** `mining/fifo-queue.ts`
  returned `[]` when the conflict-of-interest filter emptied the pool, which is
  guaranteed on a two-person network the moment the pair transacts. That created
  a panel with zero assignments, and `api/routes/verification.ts` 403s
  `NOT_ASSIGNED` for any miner without an assignment row, so the panel could
  never complete. Panel completion is one of only two writers of `percentHuman`,
  so the account was stuck with no in-app escape. Added a small-network fallback
  mirroring the heartbeat bootstrap allowance already in the same function: if
  the conflict filter empties the pool, keep the conflicted miners and log a
  warning. The file header comment claimed both filters already degraded
  gracefully; only the heartbeat one did. Now both do.
- **`scripts/dev-bump-ph.mjs` was a silent one-shot.** The `AND percent_human <
  100` predicate meant a second run changed zero rows while printing output
  indistinguishable from success, so it could not be used to top an account back
  up. It also had no path guard: run from a directory that happens to contain a
  `data/` folder, `DatabaseSync` created a 0-byte DB and the script died on
  `no such table: accounts`; run from anywhere else it died on `unable to open
  database file`. Both are raw stack traces rather than "run this from
  ae-node/". Now guards with `existsSync`, drops the predicate so it is
  idempotent and re-runnable as a top-up, and reports the actual changed-row
  count so a no-op run is visible.
- **`.gitignore` did not cover genesis keystores.** `npm run genesis:init` writes
  one keystore per validator named by bare accountId (`1cedf4e2….json`), matching
  neither `*-key.json` nor `*-keys.json`. Nothing stopped a `git add .` from
  committing live ML-DSA private keys. Added `**/keys/*.json` and `**/testnet/`.
- **README skipped the SDK build.** `ae-app` and `ae-miner` both depend on
  `@alignmenteconomy/sdk` via `file:../sdk`, whose `main` points at gitignored
  `dist/`. A fresh clone that follows the README verbatim gets a blank page from
  both apps, and the only symptom is a vite `Failed to resolve import` in the
  terminal, never in the browser. Documented as a required first step.

### Second pass, same day: the two consensus blockers

- **Accounts now replicate.** `createAccount` was called from exactly two
  places, the API route and `seed-test.ts`, and was a plain local `INSERT` with
  no gossip, no mempool, and no transaction type. An account created in the
  wallet existed only on that node's SQLite, so `replayTransaction` threw
  `Replay: sender account not found` on every other node the moment a block
  carrying its transaction arrived. This was the single biggest thing blocking
  a real two-machine test.
  Added a `new_account` gossip message following exactly the discipline
  `new_transaction` already uses (authenticated sender, dedupe by id, relay
  onward), plus `applyPeerAccountRegistration` in `core/account.ts` which is
  idempotent and re-derives the accountId from the public key, so a peer
  cannot inject a row under an id whose key it does not hold. A peer can never
  set `percentHuman` or any balance: replicated accounts are empty shells, and
  value only ever moves through replayed transactions.
  `POST /accounts` is now idempotent for client-custody keys as well. Since the
  id is `sha256(publicKey)` truncated, re-registering the same key is provably
  a no-op on an identical row, so it returns the existing account with
  `alreadyRegistered: true` instead of 409. That also makes mirroring an
  account onto a second node a safe, repeatable operation.
- **The block-apply path fail-stops instead of killing the node.**
  `BftBlockProducer`'s commit loop and `BftDriver.onCommit` had no try/catch. A
  throw aborted the apply and then propagated out through the transport into a
  raw `ws.on('message')` listener; with no `uncaughtException` handler anywhere
  in `ae-node`, the process died with a bare stack trace. The sync and gossip
  paths both caught; the consensus commit path did not.
  `BftDriver.onCommit` now catches, calls `stop()`, and fires a new
  `onApplyFailed` hook. Critically it does **not** advance the height: a node
  that skipped a block it could not apply would be silently and permanently
  forked, and since blocks carry no state root nothing downstream would ever
  detect it. The runner records the halt (`getConsensusHalt()`) and logs why in
  plain language. `cli.ts` also gained `uncaughtException` and
  `unhandledRejection` handlers so anything that still escapes is at least
  diagnosable. Regression test: `tests/phase26.test.ts`, "fail-stops without
  advancing or throwing when onCommit fails to apply".

### Remaining limits of the account fix (worth knowing before Phase 2)

Gossip closes the live case: a node that is online when an account is created
gets it within a round trip, long before anyone can type a send. It does not
close the offline case. A node that is down when the account is created, then
catches up by syncing blocks, still has no row for it, because `ChainSync`
ships blocks and certs only. It will fail-stop on the first block carrying
that account rather than crash, which is a real improvement, but it is still a
halt.

Closing that properly means putting account registrations **in the block**, the
way `validatorChanges` already ride one. `computeBlockHash` takes its optional
parts as `?? ''`, so an `accountRegistrationsHash` appended the same way hashes
identically for blocks that carry none, which makes it a backward-compatible
change. That plus mirroring the Phase 57 sync-replay logic would make account
creation consensus-ordered, forgery-resistant, and available to any node that
can sync. That is the right next step and is deliberately not rushed in
alongside the fixes above.

### Open blockers (not fixed, ordered by severity)

1. **Blocks carry no state root.** `computeBlockHash` covers number, previous
   hash, timestamp, merkle root, day, prev cert and validator changes. No
   balance or account commitment, and no `stateRoot`/`appHash` anywhere in the
   codebase. Balance divergence surfaces only indirectly, as a
   `Replay: insufficient <type> balance` throw the first time a divergent
   account spends. `percentHuman` divergence produces no error at all, ever,
   because `replayTransaction` takes `netAmount` off the wire verbatim and never
   re-derives the spend multiplier locally.
2. **Followers vote on blocks they cannot apply.** `validateStashedBlock` checks
   stash presence and timestamp only, never dry-runs the transactions. Its own
   comment concedes "a stash-presence check IS the content check for now". A
   follower will prevote and precommit a block that is guaranteed to throw on
   its own apply. That now costs a clean fail-stop rather than a dead process,
   but the right fix is to vote NIL on a block that fails a dry-run instead of
   discovering it at apply time.
3. **The default "Create Account" needs a platform server nothing starts.**
   `ae-app/src/lib/platform.ts` falls back to `http://localhost:3500/api/v1`.
   Electron's `main.cjs` spawns only `ae-node`, and `extraResources` copies only
   `ae-node`, so a packaged install does not even contain platform-server. The
   user sees a raw "Failed to fetch" because the SDK never wraps the fetch
   rejection, which means the friendly "Is the platform server running?" string
   at `Onboarding.tsx:226` is unreachable on the exact failure it was written
   for. Workaround today: the "Expert: I'll hold my own keys instead" link.
4. **Genesis validator accounts cannot sign into either app.** Genesis keystores
   hold a raw ML-DSA keypair generated by `generateKeyPair()`, with no BIP39
   mnemonic. Both apps' sign-in requires accountId plus a 12-word phrase and
   checks the derived public key matches, so no phrase can ever reproduce a
   genesis key. Validator identity and wallet identity are separate things
   today. The wallet can now at least reach keystore import again (see fixed
   above); `ae-miner` still has no keystore path at all, though
   `saveMinerWallet` exists unused and the Electron bridge is wired but never
   called from the UI.
5. **Vouching never moves `percentHuman`.** `createVouch` locks real stake and
   inserts a row but never calls `updatePercentHuman`. The only writers are
   panel completion and decay. A tester watches the secondary "Evidence Score"
   tile climb while the large %Human gauge and the wallet's spend multiplier
   both stay pinned at 0, and nothing tells them a miner panel is still
   required. Miner-in-the-loop is the intended design; the gap is that the UI
   never says so.
6. **The second person cannot become a miner.** `registerMiner` exempts only the
   first miner from the `percentHuman >= 50` floor, and raising a score requires
   a panel, which requires a miner. The register failure is also rendered as a
   raw API string in the miner UI.
7. **Supportive and ambient points never pay out.** `finalizeSupportiveTags` and
   `finalizeAmbientTags` have no production caller anywhere in `ae-node/src`;
   they are referenced only from tests (phase6, phase12, phase61). Two of the
   four point types in the white paper do not currently reach anyone's balance.
8. **The legacy genesis path is sticky.** The genesis branch is gated on
   `if (!getLatestBlock(db))`. A node that boots once without
   `AE_GENESIS_CONFIG_PATH` writes a random-timestamp genesis; setting the path
   afterwards does not retro-apply accounts, it only sets `networkId`. The node
   then advertises the real network over a legacy genesis hash and fails the
   peer handshake on `genesisHash`. The only fix is deleting the DB.

### Note on the operator docs

`docs/start-a-network.md` and `docs/join-a-network.md` describe the packaged
desktop flow. The two-laptop PDF Matt was working from describes a raw
terminal flow. Both are missing the SDK build step, and the PDF's Windows
instructions use `set VAR=value`, which is Command Prompt syntax that silently
does nothing in PowerShell (it is an alias for `Set-Variable`, so the node boots
with no BFT config at all). PowerShell needs `$env:VAR="value"`.

## Current honest status (July 29, 2026)

- **UX review round is live (July 29).** A full frontend screenshot walkthrough (every wallet + miner screen, captured headless against a running node) shipped as `AE-Frontend-Walkthrough.pdf` for Matt's markup. The walkthrough + the new shape-contract suite surfaced and fixed **four real frontend bugs** that all unit tests missed: (1) miner declared `account.balances.{...}` nested while the API sends flat `activeBalance` fields — every authed miner screen crashed blank; (2) miner rendered the evidence-score breakdown object directly as a React child — same crash; (3) miner declared the miner row snake_case (`is_active`/`registered_at`) vs the API's camelCase — Dashboard showed "Inactive / Registered --" and a 0% uptime gauge for real active miners; (4) miner's API client hardcoded `localhost:3001` in browser dev so its Vite proxy was dead code and every dev API call was connection-refused. Guards now exist so this class can't silently recur: `ae-node/tests/api-shape-contract.test.ts` pins the wire shapes the frontends declare, and `scripts/smoke-pages.mjs` renders all 19 wallet+miner routes in a real headless browser against a live node (19/19 green).
- **July 29 UX changes from Matt's review:** welcome tagline reworded ("A new economic scoreboard… Make Money Human!"); home-screen share % is now tappable → `/share` line chart of your day-by-day slice of the economy (new `GET /accounts/:id/share-history` reconstructs history from the ledger); Tag page reframed in points (144 / 14.4 caps), auto-saves ~800ms after edits (Save button removed); Verify "prove you're human" card compressed to a 4-dot strength list.
- **Backend (`ae-node`): 607 blocking tests across 84 suites, all green** (measured July 29; the deterministic `npm test` gate, which excludes the non-blocking `*.e2e.ts` multi-runner set and now includes the 6-test shape-contract suite). 75 build phases. WP v2 alignment complete (July 3): true burns, deleted treasury, percentage-based vouching, human tag on transactions, court escrow, parameter governance (Appendix A), blockchain pruning (7-year rolling window). Foundation hardening (Phase 73) shipped pure bigint math across all fee/court/tagging paths and a supply-conservation integration test. Run tests with the canonical `npm test`.
- **SDK: 20/20 green. platform-server: 36/36 green.** All three React apps (`ae-app`, `ae-miner`, `explorer`) build clean with zero TypeScript errors.
- **Frontend: WP v2 UI updates complete.** Percentage-based vouch staking in both apps, escrow banners on wallet/send/court screens, court stake percentages shown, `isEscrowed` wired through API and hooks. All previous completeness gaps remain closed (`ae-miner` Income/Audit show real data, verification evidence is file-hash-on-device, miner is mobile-responsive, error/empty/loading states tightened). Remaining frontend gap: the start-network / join-network onboarding flows only fully work inside the packaged desktop app (they need Electron to write keys to disk); the brand-new-friend join path is networking-blocked (see [PRO]).
- **Docs + hygiene:** `CLAUDE.md` (status + build plan), `README.md` (run + config), and `docs/ARCHITECTURE.md` (handoff map: the six packages, request-to-state flow, data model, and the seams a deployment team needs). Loose ends swept: the one source TODO resolved (explorer block lookup), dead `tweetnacl` removed, installer publisher metadata set, no stray debug statements.
- **Foundation hardening (`docs/FOUNDATION_BUILD_PLAN.md`, July 4):** a second hardening pass beyond Phase 73, tracked in its own plan. Done: GitHub Actions CI gates all three apps (lint + test + build) on every push, with the timing-flaky multi-runner BFT tests split off as non-blocking `*.e2e.ts`; typed `AppError` classes + zod validation on write routes; integer-string money at the API boundary; the day-cycle store extracted behind `ICycleStateStore`. **Frontend fully typed:** both `ae-app` and `ae-miner` are at **0 `any`** with `no-explicit-any` promoted from warn to **error**, so a new `any` fails the build (the burn-down caught 8 latent bugs hiding behind `any`). **Component/flow tests:** a jsdom + React Testing Library harness in both frontends covers the money/verification-critical paths — wallet Send (base-unit-string conversion + error surfacing), wallet Verify (vouch request), miner Vouch accept (stake-locks-before-accept ordering). **D9 done (July 5):** the flaky-e2e determinism sweep is complete — shared `waitForCondition` helper (`tests/helpers/wait.ts`) and all fixed-sleep files (phase10/14/15/16/27/32/36) converted to poll-to-deadline; the residual flake in the ban / multi-runner-commit tests is genuine multi-process nondeterminism (the event sometimes doesn't happen at all), so those stay non-blocking by design. **D2 (encrypted keystore) is done (July 5):** both `ae-app` and `ae-miner` can passphrase-encrypt keys/mnemonics at rest (WebCrypto PBKDF2→AES-GCM, opt-in and non-destructive, in-memory unlock keeps `loadWallet()` synchronous, UnlockGate at boot, add/remove card in More/Dashboard; 10 tests each). D1 (shared-store rate limiting) is genuinely pre-production infra and correctly deferred.
- **White-paper alignment audit (`docs/FOUNDATION_BUILD_PLAN.md` Group W, July 5):** a claim-by-claim pass over the July white paper. Almost every mechanic matches to the exact constant. Five divergences found; the three buildable ones are **done**: **W1** ✅ duplicate-account verdict now branches on case type (a challenge names the earlier counterpart; guilty verdict closes the duplicate and burns 2× the overlap allocations from the survivor — schema v12, verdict logic, API, miner UI, tests); **W2** ✅ the wallet Send screen shows the percentHuman verification burn and offers a one-tap gross-up (protocol math was already correct); **W4** ✅ follower catch-up sync has a stall watchdog (retry then free `isSyncing`, safe against duplicate replies). **W3 and W5 resolved (Matt, July 5):** **W3** ✅ proposer selection is now weighted by proof-of-human accuracy, not capital — `ValidatorInfo.proposerWeight` (from `getCompositeAccuracy`, deterministic on-chain), `selectProposer` weights by it (falls back to `stake` for fixtures); safe because quorum is count-based and validation checks the commit cert, not the proposer, so it only affects *who proposes*. Economic `stake` untouched. **W5** ✅ nullifier duplicate-check built; the rest are intentionally off-protocol (enrollment fee = miner-attested checkbox, smart-contract collection = external app, 11-miner review = one-time operational).

See "Build plan to handoff" below for the ownership-tagged to-do list.

> Last updated: August 16, 2026 (see "Two-laptop bring-up audit" above; the
> paragraph below is the July 29 state and its test counts predate that audit).
> July 29, 2026. 75 build phases, 663 blocking tests (607 ae-node incl. the new shape-contract suite + 20 SDK + 36 platform-server) plus the non-blocking multi-runner e2e set and the 19-route page smoke script. The chain runs end-to-end (multi-validator BFT, real txs, on-chain validator changes, sync replay) on a real WebSocket P2P layer. **Milestone 2 (Whitepaper completeness) is 6/6 done.** **WP v2 alignment is complete** (7 build groups, July 2026): (1) treasury deleted, fee split now 20/80 Tier 1/Tier 2; (2) court burns are true burns (supply decreases), innocent verdict splits 50/50 (compensation/burn); (3) rebase target raised from 14,400 to 525,600 (1 minute = 1 point); (4) percentHuman discount applies only to daily-point spends (not earned); (5) mandatory `humanTag` field on every transaction; (6) percentage-based vouching (stake % of total holdings, not fixed points); (7) court escrow (defendant's earned transfers blocked while case is open); (8) parameter governance (Constitutional/Bounded/Algorithmic/Open classes per Appendix A); (9) blockchain pruning (7-year rolling window, governed 3-15 year bounds). Phase 73 foundation hardening: pure bigint fee/court/tagging math, supply conservation integration test, rebase stress test at 500 accounts.
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
  - `tweetnacl` fully removed from all packages; crypto runs entirely on `@noble` (ML-DSA via `@noble/post-quantum`, Ed25519 + VRF via `@noble/curves`, SHA-256 via `@noble/hashes`)
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
- **Separate business logic from storage.** Use repository interfaces (e.g., `IAccountStore`, `IBlockStore`) so the underlying database can be swapped without touching the economics code. (Mostly done. `IAccountStore`, `ITransactionStore`, `IVerificationStore`, `IMiningStore`, `ICourtStore`, and `IBlockStore` all exist with Sqlite implementations under `ae-node/src/core/stores/`. A little residual inline SQL remains in `transaction.ts` (cycle-phase guard) and `day-cycle.ts`; an `ICycleStateStore` is the last piece before Phase 2.)
- **Separate the scheduler from the cycle logic.** The day cycle functions (expire, rebase, mint) are pure functions over a db handle; the scheduler is chain-driven (block timestamps trigger cycles). (Done.)
- **Design the rebase to be parallelizable.** Every account's rebase is independent. Never introduce cross-account dependencies in the rebase step. (Done.)
- **Keep block production separate from consensus.** `BftBlockProducer` is the producer; `BftRuntime` / `BftDriver` are the consensus engine. They talk through narrow interfaces. (Done.)
- **Treat the VRF as a pluggable interface.** `IVrfProvider` exists with `Ed25519VrfProvider` (production) and an HMAC stub (tests). (Done.)

## Known Issues

### Done (Fixed)

- ~~**Frontend types could silently drift from the API's real shapes.**~~ Fixed July 29 after the drift bit four times in one day (see honest status). `ae-node/tests/api-shape-contract.test.ts` boots the API and pins the exact wire shapes the frontends hand-declare: flat account balances (and asserts NO nested `balances` key), evidence score as a breakdown object, camelCase miner row, network status, ledger envelope, share-history points. A route shape change now fails this suite as the reminder to update `ae-app/src/lib/types.ts` and `ae-miner/src/lib/api.ts` in the same commit.
- ~~**"Tests green" and "pages render" were different claims.**~~ `scripts/smoke-pages.mjs` (July 29) spawns a headless Edge/Chrome (spawn + `puppeteer.connect`, immune to the Edge-150 launcher handoff that breaks `puppeteer.launch`), creates a throwaway account on the running node, injects it into localStorage, loads all 12 wallet + 7 miner routes, and fails on blank pages or console errors. 19/19 green. Prereqs + usage in the script header; `puppeteer-core` is a devDependency of `ae-app`.
- ~~**Miner app unusable in browser dev without a magic env var.**~~ `ae-miner/src/lib/api.ts` hardcoded `localhost:3001` (its packaged-Electron port) as the default API base, so `npm run dev` had every API call connection-refused and the Vite `/api` proxy was dead code. Now mirrors the WS client: `VITE_API_URL` override → `file:` origin gets 3001 → browser dev gets same-origin `/api/v1` through the proxy.
- ~~**Miner Dashboard showed "Inactive / Registered --" and a 0% uptime gauge for real active miners.**~~ The miner row was declared snake_case (`is_active`, `registered_at` string) but `GET /miners/status/:id` sends camelCase (`isActive`, `registeredAt` unix-seconds number). Fixed the type + all reads (Dashboard, Audit, Sidebar), with `registeredAt * 1000` for date rendering. Pinned by the shape-contract suite.

- ~~**Five red tests in the follower sync / catch-up path.**~~ Fixed May 28. All five green; the work surfaced and closed six real bugs:
  1. **Stale `receiverSignature` replay bind** (Phase 17 x3, Phase 38). `ReplayInput` gained a required `receiverSignature` in Phase 67, but these tests still built replay inputs without it, so `undefined` hit a SQLite bind and threw "parameter 9." Inside the block-apply handler that throw was swallowed (`catch → return false`), so a follower silently dropped the block and stalled mid-sync with no log. `replayTransaction` now coerces a missing countersignature to `null` (the in-person branch still enforces a real one when required); the stale tests pass the field.
  2. **Genesis hash advertised as the chain head** (`runner.ts`). The P2P handshake used `getLatestBlock().hash` as the network's "genesis hash." That only equals the real genesis at height 0, so any node that had advanced (especially one restarting from disk with blocks already on it) advertised its head hash and every peer rejected it with "genesis hash mismatch." A killed validator could never rejoin its own network. Pinned to block 0.
  3. **BFT nodes never advertised their committed height.** The gossip-layer height was only updated in the authority/sync apply paths, never when `BftBlockProducer` commits. So a BFT validator looked frozen at height 0 to its peers and catch-up sync could never trigger. The node now refreshes its advertised height every 2s from the DB head.
  4. **Banning peers for being ahead** (`sync.ts`). A behind node receiving a live gossip block ahead of its head treated the height gap as a bannable offense and banned all its peers, isolating itself. Being-ahead now means "I'm behind, let sync catch up," not "you misbehaved"; only a genuinely invalid next-height block bans.
  5. **Peer height frozen at handshake** (`peer.ts`). A peer's height was recorded once at handshake and never refreshed, so a node couldn't tell a peer had advanced after connect. Heights now update from gossiped blocks via a new `recordPeerHeight`.
  6. **BigInt crash serializing sync replies** (`sync.ts`). The `get_blocks` response shipped the validator snapshot with `stake` as a bigint, which `JSON.stringify` can't encode, so every sync reply containing a block N>=2 threw and the catch-up died. Now string-encoded on the wire, mirroring the live-gossip path (the receiver already parses it back). Bonus: catch-up sync was one-shot (`setTimeout`), so a reconnect that finished after the single attempt never retried; it is now a recurring interval, cleared on stop.
  Net effect: a validator can be killed mid-chain, restart from disk, reconnect, and catch up to the head with matching hashes. `phase60.test.ts` (both tests) green; verified no regressions across the gossip / validation / transaction-replay / multi-runner suites.
- ~~**Loose-ends cleanup (May 28).**~~ (1) The explorer could only look up blocks in the latest 100 (a real in-code TODO). Added `GET /network/blocks/:number` (ae-node), `getBlock(n)` (SDK), and switched the explorer's `BlockDetail` to a direct lookup, so any block resolves; covered by `block-by-number.test.ts` (3/3). (2) Removed the dead `tweetnacl` devDependency from `ae-app`. (3) Set installer publisher metadata (`author` + `build.copyright`) on both desktop apps. (4) Confirmed zero stray `console.log` / `debugger` / `alert(` in the app source.
- ~~**No manual day-advance endpoint.**~~ `POST /admin/advance-day` exists behind the admin auth gate.
- ~~**Mempool has no deduplication.**~~ Mempool class checks txId before inserting, evicts oldest when full.
- ~~**Minting is not idempotent.**~~ Mint step gates on a per-day reference id; resumeCycle is safe across crashes.
- ~~**No seed data script.**~~ `npm run seed:test` exists. Genesis CLI (`npm run genesis:init`) covers full multi-validator setup.
- ~~**No end-to-end test harness.**~~ 60+ phase test suites covering schema, day cycle, BFT consensus, court flow, verification, fee distribution, treasury, inheritance, smart contracts. Multi-runner E2E (Phase 49, 53, 57, 59, smoke-multiblock). LAN test harness `scripts/test-lan-multi-validator.mjs` runs 3 ae-node subprocesses end-to-end (3/3 passing). SDK has its own 14/14 smoke suite that boots a real ae-node.
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
- ~~**Court bounty/burn split drains the economy at small scale.**~~ WP v2 alignment: court burns are now true burns (value destroyed, not routed to fee pool). The rebase re-inflates everyone proportionally so small networks don't deflate over time. Innocent verdict now splits the challenger's stake 50% to defendant as compensation, 50% true-burned. Phase 64 tests updated to assert supply decrease + fee pool unchanged.
- ~~**WP v2 full alignment (July 2026, Phases 73-75).**~~ Seven build groups aligning the codebase to the second white paper: (1) Treasury deleted, fee split 20/80 Tier 1/Tier 2 with no treasury cut. `core/treasury.ts` removed, `treasury.*` params deleted, Phase 68 test deleted. (2) Court burns are true burns (supply decreases, not routed to fee pool). Innocent verdict 50/50 (compensation/burn). (3) Rebase target raised from 14,400 to 525,600. (4) `percentHuman` discount narrowed to daily-point spends only (earned-point spending is not discounted). (5) Mandatory `humanTag` on every transaction. (6) Percentage-based vouching: vouchers stake a percentage of total holdings (earned + locked), not a fixed point amount. `rebalanceVouchLocks` runs daily to keep locked amounts current as balances change. (7) Court escrow: defendant's earned-point transfers blocked while case is open (`is_escrowed` flag on accounts). Plus: Phase 74 parameter governance (Constitutional/Bounded/Algorithmic/Open classes per WP Appendix A, `governance.ts`); Phase 75 blockchain pruning (7-year rolling window, preserves genesis, `blockchain.history_window_years` bounded 3-15). UI updates across both apps: percentage vouch staking, escrow banners, court stake display.
- ~~**Mnemonic export is one-way.**~~ Wallet's More page now has a "Recovery Phrase" card. Default offers an "Export Recovery Phrase" button; clicking opens a confirm step (red shoulder-surfing warning, Cancel / Show Phrase). Confirming reveals the 12 words in a 3-column grid with Hide and Copy 12 Words. V1 wallets (no mnemonic) see a notice that recovery export isn't available. Path: `ae-app/src/pages/More.tsx`.
- ~~**`ae-miner` Login shows "Registration failed" when the account is already a miner.**~~ Already fixed in `Login.tsx:handleRegister` (catches 409 and proceeds when `isMiner === true`).
- ~~**WS `court:argument` events don't auto-refresh.**~~ Already added to the allowed event types in `ae-node/src/api/websocket.ts`.
- ~~**WebSocket subscribe has no authentication.**~~ Audited Phase 65. Backend `setupWebSocket` already verifies a signed `{action:'subscribe', accountId, role}` payload + timestamp via the account's stored publicKey, with a 5-minute window. Both clients (`ae-app/src/lib/websocket.ts` and `ae-miner/src/lib/websocket.ts`) sign with the wallet's ML-DSA private key on `onopen`. `phase65.test.ts` (5/5 pass) covers the four failure modes (no sig, wrong sig, stale timestamp, unauthenticated client) plus the happy path. Follow-up tightening: `setupWebSocket(server, db)` now takes a required `db` parameter — previously it was optional with a "skip verification when missing" branch that would have let a future caller accidentally accept an unverified `accountId` straight from the client. Type system now makes that impossible.
- ~~**`tweetnacl` dependency is dead.**~~ Removed from `ae-node/package.json` and, in the May-28 cleanup, from `ae-app/package.json` (the last place it lingered as a devDependency). No source anywhere imports it; crypto runs entirely on `@noble/post-quantum` (ML-DSA) + `@noble/curves` (Ed25519 VRF) + `@noble/hashes` (SHA-256).
- ~~**Admin endpoint protection / docs.**~~ Already gated by `AE_ADMIN_SECRET` (constant-time compare, fail-closed when unset). Now documented in `README.md` under "Configuration" with usage example. Operators set the env var to a long random value (`openssl rand -hex 32`) to enable `/admin/advance-day`; without it the endpoint returns `403 ADMIN_DISABLED`.

## Roadmap to Full Build

**End state:** A complete, correct, well-documented full-network codebase, handed to a professional engineer or team who deploys it to real miners and users. Multi-validator BFT, real txs, real verification, real court, all green, all wired, with clean seams and handoff docs. We finish and harden the code; the pro operates and deploys it. (This is not a friends-at-home test, and not a thing we run ourselves.)

**Why this section exists:** Without a goal-driven roadmap we keep picking small fixes (which are easy to identify) and never make decisive progress on the big build (which is where the value is). Pick the top open milestone below and march to it. Don't drift back into small fixes unless a critical bug forces it.

**Working in this codebase:** When you finish a task, check it off here AND add the matching one-liner to "Done (Fixed / Shipped)."

### Build plan to handoff (who owns what)

Live to-do list to reach a handoff-ready codebase, split by who can do each piece. Tags: **[CODE]** Claude can do it solo, no outside input. **[MATT]** needs your decision, money, an account, or a real-world action. **[PRO]** belongs to the professional team at deployment, we only make the code ready.

#### Backend (`ae-node`): finish and harden
- [x] **~~Get the 5 red tests green.~~** DONE (May 28). All five green. Surfaced and fixed six real bugs in the follower sync / catch-up path (stale receiverSignature bind, genesis-hash-as-head, BFT height never advertised, ban-on-behind, peer height frozen at handshake, BigInt in sync replies). A killed validator can now restart from disk, reconnect, and catch up. See "Done (Fixed)" for the full writeup.
- [x] **~~Make follower sync robust.~~** Mostly done (May 28). The six bug fixes above plus recurring catch-up sync mean a node offline for N blocks now reconnects and catches up cleanly (`phase60.test.ts`). Phase 17's fixed `wait(500)` was replaced with a poll-to-deadline so it no longer flakes under load. Residual: a few other multi-runner tests still use fixed `wait()`s that could be made event-based, but they are no longer failing.
- [x] **~~Finish the storage-interface extraction.~~** DONE. The `I*Store` interfaces (`IAccountStore`, `ITransactionStore`, `IVerificationStore`, `IMiningStore`, `ICourtStore`, `IBlockStore`) plus `ICycleStateStore` (`SqliteCycleStateStore`, the D3 build) now own all state access — the residual `day_cycle_state` inline SQL in `transaction.ts` / `day-cycle.ts` routes through the store. A pro can swap SQLite for Postgres behind these interfaces without touching the economics.
- [x] **~~Cleanly abstract and document the P2P transport.~~** DONE. `src/network/transport.ts` codifies `IPeerTransport` + `IPeerConnection` (the exact `send` / `close` / `readyState` / `on(open|message|close|error)` surface the peering layer uses); `docs/ARCHITECTURE.md` seam #2 points at it as the NAT-traversal insertion point. We define the seam; the pro implements the transport over their chosen wire.
- [x] **~~Pure-bigint fee and rebase math + dust pass.~~** DONE. Phase 73 made all fee / court / tagging math pure bigint; the rebase runs a dust-distribution pass so `sum(post-rebase earned + locked) == targetTotal` exactly (asserted at 500 accounts in `phase73-foundation.test.ts`).
- [x] **~~Tidy: remove dead code, tighten types.~~** DONE. Both frontends are at **0 `any`** with `no-explicit-any` promoted from warn to error; a ts-prune sweep removed the only two dead internal exports in `ae-node` (which has zero real `any` in source). Auth-gate coverage was already in place (`phase71` / `phase72`).

#### Frontend (`ae-app` wallet + `ae-miner`): finish so you can review
- [x] **~~Build the two miner stub pages for real.~~** DONE. New `GET /accounts/:id/ledger` endpoint serves the `transaction_log` audit trail (newest first, paginated). `Income` now shows real income history (payments, court bounties, fee-pool / mining distributions) plus a by-source breakdown; `Audit`'s Activity Log shows the full ledger with per-change-type labels and colors. Shared classifier in `ae-miner/src/lib/ledger.ts`. Endpoint covered by `ledger-endpoint.test.ts` (3/3); both apps build clean. Live browser check still pending (fold into the frontend review).
- [x] **~~Real evidence handling on verification.~~** DONE. The wallet's Verify page picks a file, hashes it on-device (`lib/hash.ts` `hashFileSHA256`), and submits only the digest with a clear "your document never leaves your device" flow — no raw-hash pasting. (The miner side reviews the hash; it never handles the file.) The hash is now also enforced as a nullifier: the same credential can't verify two accounts (W5a).
- [x] **~~Make `ae-miner` mobile-responsive.~~** DONE. The miner pages use responsive Tailwind breakpoints to match the wallet's mobile-first layout.
- [x] **~~Finish the join-as-new-friend flow.~~** DONE (July 5). The join screen offers a "Join as a new member" path that generates a fresh self-custody wallet inline (mnemonic → keypair) from an invite link / genesis spec — no pre-allocated validator keystore required. (Remote peering for a fresh follower is still [PRO] networking.)
- [x] **~~Tighten error / empty / loading states.~~** Done where it mattered: the wallet History page (previously blank on failure) now has loading / error / empty states; both Tag save paths (products + spaces) now catch network failures instead of hanging on "Saving…". Send already handled its failures; the miner pages already had loading/error states.
- **[MATT] Review the finished frontend** and tell me what copy, layout, or flow to change. This is the step you want; everything above gets it ready for you.

#### Deployment and operations: professional team
- **[PRO] NAT traversal** (Tailscale embed, relay, or WebRTC). The real internet-peering blocker, genuine networking engineering.
- **[PRO] Public bootstrap node** on a VPS, its address baked into the installer.
- **[PRO] Mac / Linux installer builds + code signing** (needs the 501(c)(3), a D-U-N-S number, an Apple Developer account).
- **[PRO] Pick a host and deploy `platform-server`** (code and Docker/Fly/Render configs are done, see `docs/platform-track-plan.md`).
- **[PRO] External crypto + protocol audits, regulatory posture, bug bounty** (Milestone 3 below).

#### What I need from you (`[MATT]`) to unblock the rest
- Whether the platform (custodial) track ships in v1 or waits, since it needs an email-provider key and a host.
- Sign-off on any user-facing copy I draft (I keep your voice, you approve).
- Anything that costs money or needs an external account: hosts, domains, certs, email provider.

The milestones below stay as detailed reference for what shipped and what is left.

### Milestone 1: Downloadable network code (was "public testnet")

Goal: Anyone can download an installer, run it, and join a real Alignment Economy network with friends over the public internet. Multi-validator BFT, real txs, real verification, real court. The protocol already works (Phases 12-65). The missing layer is the install/join UX, public infra, NAT traversal, and the polish that makes the whole thing usable.

LAN testing happens *as we build* — don't ship a LAN-only release as a separate milestone. LAN is the dev environment. The shipping target is "you and your friends each download this installer and end up on the same chain."

**Install/join UX (no networking complexity needed for these tasks):**
- [x] **Bundle `ae-node` inside `ae-miner`** ~~(currently only the wallet bundles it; `ae-miner/electron/main.cjs` is just the UI). Mirror the wallet's pattern: spawn ae-node as a child, poll /health, store DB under userData.~~ Done. `ae-miner/electron/main.cjs` now mirrors ae-app's spawn-and-poll-health pattern. Bundled node runs on port **3001** (wallet uses 3000) so two installed apps don't collide. DB lives under `userData/ae-miner-data/`. Smoke-tested: built ae-node, ran with the env vars main.cjs sets, `/api/v1/health` returned 200.
- [x] **First-launch network mode picker.** ~~When the wallet boots and there's no wallet yet, show a chooser: (1) Solo / Authority node (current default), (2) Start a new network (run genesis, become founder), (3) Join an existing network (paste genesis hash + bootstrap address + your validator keystore, or scan an invite link).~~ Done. New `network-mode` screen in `ae-app/src/pages/Onboarding.tsx` between Welcome and account creation. Three cards (Solo / Start a new network / Join an existing network); each writes the choice to `localStorage['ae_network_mode']`. Solo continues to the existing `createAccount()` → recovery-phrase flow. Start new and Join existing route to placeholder screens that explain the next milestone task will wire them up. Browser-verified all five paths (welcome → picker → each card → back).
- [x] **"Start a new network" flow.** ~~Run the existing `genesis:init` CLI from inside the app, write the spec to disk, show the user a "share this `genesis.json` with the people you want to invite" screen with a copy/export action AND an invite link (see invite-link task below).~~ Done. New `POST /api/v1/founder/generate-genesis` endpoint on ae-node wraps `buildGenesisSet` (the same library function the CLI uses) and returns the spec + per-validator keystores + spec hash. Wallet's "Start a new network" picker option now opens a 3-step flow (form → generating → result). The result screen shows the spec hash, lets the user download the public `genesis.json` and each private `<name>.keystore.json`, and the founder's own keystore becomes their wallet identity on continue (saved via new `saveFounderWallet`). Invite link is the next sub-task. Phase 66 test (7/7) covers happy path, keystore shape, accountId distinctness, and four validation failures.
- [x] **"Join existing network" flow.** ~~Form for genesis hash + bootstrap address (or invite link), generate the validator keystore inline via `validator:setup`. Wire bundled ae-node to validator mode (not authority mode) when this path is taken.~~ Done for the founder-distributes-keystore path: the "Join an existing network" picker option now shows two file inputs (genesis.json + your keystore.json), parses both, validates that the keystore's `account.publicKey` matches one of the validator entries in the spec, and persists the keystore as the wallet identity (`saveJoinerWallet`) plus the spec (`saveJoinedNetwork` → `localStorage.ae_joined_network`). Wrong-network keystores get a clear "Keystore not in this network" warning and the Join button stays disabled. Browser-verified positive (matched pair) and negative (mismatched pair) paths. Inline-generation-via-validator:setup (for joiners NOT pre-allocated by the founder) is still TODO. The main.cjs ae-node restart logic is its own task below.
- [x] **Wire `main.cjs` to honor network choice.** ~~Today's `ae-app/electron/main.cjs` and `ae-miner/electron/main.cjs` always boot ae-node in single-validator authority mode regardless of the user's network-mode choice...~~ Done. New `electron/preload.cjs` in both apps exposes `window.aeNetwork.saveConfig({mode, spec, keystore})` via contextBridge. Onboarding's `continueAsFounder` and `joinNetworkAsValidator` call it after persisting the wallet, which writes `userData/ae-network/{network-config.json,genesis.json,keystore.json}` from main. On next boot, `startAeNode()` reads the config and sets `AE_CONSENSUS_MODE=bft + AE_GENESIS_CONFIG_PATH + AE_NODE_KEY_PATH + AE_BFT_LOCAL_ACCOUNT_ID` so ae-node loads the spec and runs as a real BFT validator. Solo / no-config keeps today's authority defaults. Bonus: explicit `AE_P2P_PORT` (9000 for wallet, 9001 for miner) so two installed apps on one machine don't collide. Smoke-tested with a real generated spec; `/api/v1/health` returns 200 and the log shows "Applied genesis spec ... 2 accounts, 2 validators" + "BFT consensus loop started."
- [x] **"Restart to apply" notice + "Apply now" button.** The running ae-node child still has the old (solo) spawn env after `saveConfig` writes; the user has to relaunch for BFT mode to take effect. New `aeNetwork:relaunch` IPC + `window.aeNetwork.relaunch()` preload bridge handles a clean tear-down + relaunch via `app.relaunch(); app.exit(0)`. Onboarding flows now navigate to a `restart-to-apply` screen after Start-new or Join-existing instead of `/` directly: shows network ID + accountId, "Apply now (restart app)" button, "Continue without restarting" fallback. In plain browser dev (no `window.aeNetwork`) the screen is skipped entirely. Verified all four paths (browser-dev → /, mock-Electron → restart screen, Apply now → relaunch IPC fires, Continue → / without relaunch).
- [x] **Invite link / QR code.** ~~A founder generates a shareable URL/QR encoding genesis hash + bootstrap address. Joiner scans or pastes, app fills the join form automatically.~~ Done for the link half. **QR resolved as infeasible (July 29):** the encoded link is ~11.3K chars (the spec embeds ML-DSA public keys at 3,904 hex chars each) and QR byte-mode caps at ~2,953 — a QR would need a hosted link-shortener, which is [PRO] infra and would also break the spec-never-touches-a-server privacy property. Copy/paste link stays the mechanism. New `ae-app/src/lib/invite.ts` encodes a spec into `https://invite.alignmenteconomy.org/v1#<base64url(spec-json)>` (everything in the URL fragment so the spec never goes to a server even on accidental clicks). Founder result screen now shows the link with a "Copy invite link" button alongside the genesis.json download. Joiner form has a textarea at the top: pasting any valid AE invite link parses the spec and pre-fills the genesis side, so the joiner only needs to upload their personal keystore. Invalid links show "That doesn't look like a valid AE invite link." Browser-verified all three paths (founder generates → joiner pastes valid link → spec recognized; joiner pastes invalid link → error). Bootstrap address isn't in the link yet because there's no public bootstrap; that's the next milestone task.

**Internet reach (professional team / deployment, see "Build plan to handoff" above):**
- [ ] **Public bootstrap node.** Cheapest VPS (~$5/mo Hetzner / DigitalOcean). Permanent address, runs `ae-node` in validator mode, holds the canonical AE testnet genesis spec.
- [ ] **Bake testnet address into installer.** "Join the AE testnet" button on first launch hits the bootstrap node, downloads genesis spec, runs validator setup automatically.
- [ ] **NAT traversal.** Two laptops on home WiFi can't peer directly. Pick one approach (tunnel service like tailscale embedded, WebRTC peer connections, or a hosted relay) and ship it.

**Custodial track (in progress, see `docs/platform-track-plan.md`):**
- [ ] **Platform signup option.** Self-custody stays the default for power users; new track lets ordinary users sign in with email and password, the platform server holds an encrypted vault, password reset works like Gmail. Soft Flavor 2 design: server cannot decrypt the vault in normal operation but can decrypt the recovery blob through a verified flow. Phase 1 (custody scaffold) is done as of `0489191`. Phases 2-7 (auth endpoints, recovery flow, email, SDK, wallet UI, deploy) tracked in `docs/platform-track-plan.md`.

**Polish so non-technical users can actually use it:**
- [x] **Onboarding tuned for non-technical users.** ~~Today's flow assumes you know what a recovery phrase is. Add education, not just a 12-word screen.~~ Three new educational gates total. **Wallet** (`ae-app/src/pages/Onboarding.tsx`): (1) "New here? What is this?" link on the welcome screen opens a `what-is-ae` screen with 5 plain-language cards (everyone gets points daily, most expire daily, earned points last forever, real humans only, no bank runs this) — the 60-second AE primer for someone who has never used a wallet. (2) New `learn-recovery` step inserted between account creation and the 12-word reveal. Four cards walking through: it's the only key to your account, no one can reset it, write it on paper (no screenshots / no email / no notes app), you'll need it on a new device. The "show me the words" CTA continues to `show-key` only after the user has acknowledged the warnings. Browser-verified end-to-end. **Miner** (`ae-miner/src/pages/Login.tsx`): same `learn_recovery` step inserted between Create Account and the existing `show_key` step (which already had the 12-word grid + write-on-paper checkbox + Register-as-Miner button). Same four cards, miner-styled (`bg-bg border-border`). Browser-verified: Create Account tab → body Create Account button → "Before you see your phrase" (4 cards + "Find a pen and paper" footer) → "show me the words" → "Save Your Recovery Phrase" (12 words rendered, Register as Miner button shown).
- [x] **Better error states.** ~~"Could not reach bootstrap node" with retry. "You're offline." "Your wallet is on a different network than this transaction expected."~~ First pass done. `ae-app/src/lib/api.ts` now distinguishes three failure modes via the new `getNodeStatus()` / `subscribeNodeStatus()` exports: `offline` (navigator.onLine false), `node-down` (fetch threw, but online), `ok`. AppShell mounts a top-of-window banner that reflects the live status: "You're offline..." in offline mode and "Can't reach the local node. Try restarting the app." in node-down mode. Browser-verified the node-down banner appears within ~2s of a failed API call. The "Could not reach bootstrap node" + "transaction on the wrong network" cases are TODO once peering is live.
- [x] **Auto-update.** ~~`electron-updater` wired to GitHub Releases so testers don't re-download by hand.~~ Done. Both apps now depend on `electron-updater@^6.8.3`. `electron/main.cjs` lazy-loads `autoUpdater`, registers error / update-available / update-downloaded listeners, and calls `autoUpdater.checkForUpdatesAndNotify()` after `app.whenReady()` in packaged production builds (skipped in dev). `package.json` build block has a `publish` config pointing at `mattfmccormick/alignment-economy-code` GitHub Releases. Once a release with both `Setup.exe` files + a `latest.yml` manifest exists on GitHub, installed clients will auto-download and prompt to install on quit. The Releases pipeline is done (July 29): `.github/workflows/release.yml` builds both apps on Windows/macOS/Linux runners on every `v*` tag push (ae-node built first for the extraResources bundle) and publishes via `electron-builder --publish always`. Unsigned until certs exist (`CSC_IDENTITY_AUTO_DISCOVERY=false`). First real proof-run happens on the first tag push.

**Verification + ship:**
- [x] **End-to-end LAN test on dev machine.** ~~3 simulated runners on `localhost:3001/3002/3003`, walked through the chooser flow, peer up, register, commit blocks, transact, court works. (This is the dev gate, NOT a release.)~~ Working. `scripts/test-lan-multi-validator.mjs` orchestrates three ae-node subprocesses with a shared genesis spec, peers them up over WebSocket, runs BFT consensus, and asserts that all three converge on the same chain head with matching block hashes at the highest mutual height. Three back-to-back runs converged on heights 24/24/25, 26/27/27, 24/24/24 (each "PASS: 3-validator BFT chain advanced past min height with matching hashes"). Two fixes landed together: (1) `peer.ts` outbound-connect path was silent on every failure mode (refused, banned, network-mismatch, genesis-mismatch, malformed handshake) — now logs the close code + reason via the existing logger so operators can actually see why a seed dial failed; (2) the script bumps `AE_BFT_STARTUP_DELAY_MS` from the default 3000ms to 12000ms, which gives all three subprocesses time to spawn + bind their WebSocket ports + finish the handshake with each other before BFT round 0 fires. Without the longer delay, the first node was racing through round 0 alone while the third process was still booting. Total runtime per LAN test ~80s on a dev laptop.
- [ ] **End-to-end internet test.** Two machines on different home networks join the public testnet, transact, verify each other.
- [x] **Build + sign installers** ~~for Win/Mac/Linux, both apps.~~ Windows half done. `npm run electron:build:win` produces ~106 MB NSIS installers for both apps: `ae-app/release/Alignment Economy Wallet Setup 0.1.0.exe` and `ae-miner/release/Alignment Economy Miner Setup 0.1.0.exe`. Each contains the bundled `ae-node` (`win-unpacked/resources/ae-node/dist/node/cli.js`) and the Electron + React app. Mac (`.dmg`) and Linux (`.AppImage`) need their respective platforms; a GitHub Actions workflow with macOS + Linux runners is the right answer there. Code-signing is also future work (today's Win installer is unsigned, so Windows SmartScreen will warn). Release artifacts are gitignored; distribute by hand for now.
- [x] **Write `docs/start-a-network.md`** ~~(founder flow) and `docs/join-a-network.md` (joiner flow). One page each.~~ Both written. `docs/start-a-network.md` walks a founder through the genesis ceremony, keystore distribution, spec-hash confirmation. `docs/join-a-network.md` walks a joiner through pasting the invite link, uploading their keystore, comparing hashes, restart. Each ~1 page; covers the LAN-only state today and notes that public-internet peering is the next milestone.
- [ ] **Wider tester rollout.** Friends, family, early supporters.

### Milestone 2: Whitepaper completeness ✅ (6/6 done)

Real protocol features the whitepaper requires. Milestone 1 ships without them; they're additive. All six are now done — Phase 67 in-person co-sign, Phase 69 inheritance + dead-man-switch, Phase 70 smart contract DSL, the block explorer at `explorer/`, the TypeScript SDK at `sdk/`, and Phase 68 treasury (later removed in WP v2 alignment).

- [x] **In-person co-sign (+2.5% credit).** ~~Two parties dual-sign a tx, both get a percent-human bump. Whitepaper §6.3 / Vegas Guy plan Phase 1.6 + 3.5.~~ Protocol-side done (UI handshake — NFC / QR — is a follow-up). Phase 67. New `receiverSignature` field on `Transaction` / `TransactionInput` / `ReplayInput` / `WireTransaction`. processTransaction + replayTransaction now reject `isInPerson=true` txs without a valid countersignature signed by the recipient over the same canonical payload + timestamp. Schema bumped to v8 with an `ALTER TABLE transactions ADD COLUMN receiver_signature TEXT` migration. API route /transactions accepts `receiverSignature` on the request body. The +2.5% decay-offset credit was already wired (verification/decay.ts counts in-person txs for both `from` and `to`); the new piece is dual consent. Phase 67 test (5/5 pass) covers reject-no-sig, reject-forged-by-sender, accept-valid, regular-tx-still-works, reject-third-party-sig. Phase 1 + 61 + 64 still pass.
- [x] **Inheritance: multi-sig + dead-man-switch.** ~~Lost-key accounts pollute the rebase target forever otherwise. Whitepaper §10. Vegas Guy plan Phase 7.9.~~ Phase 69. Schema bumped to v9 with two new columns on `accounts`: `last_activity_at` (unix sec; bumped on every successful outbound tx by the sender) and `inheritance` (JSON config or NULL). New `core/inheritance.ts` exposes `setInheritance(db, ownerId, {beneficiaries, threshold, deadManSwitchDays})` with validation (no self-beneficiary, no duplicates, threshold in [1, beneficiaries.length], minimum 30-day inactivity threshold) and `claimInheritance(db, deceasedId, ts, signatures)` that verifies the dead-man-switch is armed (`now - lastActivityAt >= deadManSwitchDays * 86400`), counts valid beneficiary signatures over `{action:'claim_inheritance', deceasedId}` + timestamp, requires `>= threshold` valid signers, drains the deceased's earnedBalance evenly to the signers (not all listed beneficiaries), and deactivates the account so it leaves the rebase target. Phase 69 test (10/10 pass): config validation, lastActivityAt stamping (sender only, recipients don't bump), pre-arm refusal, sub-threshold refusal, successful drain + deactivate, outsider/forged signature rejection. Phases 1, 61, 64, 67, 68 still green.
- [x] **Smart contract DSL execution engine.** ~~`tagging/smart-contracts.ts` is a schema today, no VM. Whitepaper §5. Vegas Guy plan Phase 6.4.~~ Phase 70. Scope clarification: a full Turing-complete VM is overkill for what the whitepaper actually asks for ("smart contracts between participants and entities" — recurring, conditional value flow). Phase 70 extends the existing executable contract framework with a fourth type, `earned_recurring`, that sends a fixed display-unit amount of earned points to a target on schedule (daily / weekly / weekend / weekday). Skipped if the sender's balance is short — recurring transfers don't accumulate IOUs. Honors `percentHuman` and the standard 0.5% fee path exactly like a normal tx (0% sender drains earned, recipient gets nothing — same Option B semantics as everywhere else). Plus stronger validation in `createSmartContract` for both new and existing types: `active_standing` and `earned_recurring` now require a real, active recipient at creation time; self-targeting is rejected; zero/negative amounts rejected. Reuses `allocationPercent` column for the fixed amount to avoid a schema bump. Phase 70 test (8/8) covers create, reject zero/negative, reject missing/inactive/self target, full execute path with fee, skip-on-insufficient, skip-on-inactive-recipient, percentHuman=0 burn, schedule honor (weekend-only skips on Wednesday). Future expressive primitives (conditional triggers, multi-leg flows) layer on as additional contract types under the same dispatcher.
- [x] **Block explorer (separate viewer).** ~~Public read-only chain inspection. Vegas Guy plan Phase 9.1.~~ Done. New `explorer/` Vite+React+Tailwind app at the repo root, depends on `@alignmenteconomy/sdk` via a `file:../sdk` link. Pages: Home (network stats grid + latest blocks table, polls every 5s), `/block/:number` (hash, parent, authority, prev/next nav), `/tx/:id` (full from/to/amount/fee/net/in-person/memo/sig/timestamp/block; live since the SDK got `getTransaction`), `/account/:id` (balances grid + 50 most recent transactions with sent/received indicator). Search bar at the top routes by input shape: digit-only → block, UUID → tx, anything else → account. Browser-verified all four routes against a running ae-node: Home loads with real day/height/participant counts, Block 0 detail renders, account creation + navigation works, search routes correctly, `/tx/<unknown>` shows "No transaction found with id …" via SDK's typed NOT_FOUND error. Dev server runs on :5175 with `/api/v1` and `/ws` proxied to localhost:3000.
- [x] **TypeScript SDK** ~~+ dev portal. So third parties can integrate. Vegas Guy plan Phases 9.5, 9.6.~~ SDK v0.3 done; dev portal is a follow-up (the README + inline doc comments cover the SDK surface for now). New `sdk/` package at the repo root publishes as `@alignmenteconomy/sdk`. v0.1 covered `AlignmentEconomyClient` (typed wrappers around `/api/v1/health`, `/accounts`, `/transactions`, `/transactions/:id`, `/network/status`, `/network/blocks`, `/founder/generate-genesis`) + `signTransaction` helper + crypto re-exports (`generateKeyPair`, `deriveAccountId`, `signPayload`, `verifyPayload`, `newMnemonic`, `mnemonicToKeypair`). v0.2 adds the read-only court / miner / tag surface: `getCases`, `getCase(id)`, `getJuryDuty(accountId)`, `getMyCases(accountId)`, `getMinerStatus(accountId)`, `getVouches(accountId)`, `getProducts`, `getSpaces`, `getCurrentDay`. New types exported (`CourtCase`, `CaseType`, `CaseLevel`, `CaseStatus`, `Verdict`, `MinerStatus`, `Vouch`, `VouchesForAccount`, `Product`, `Space`). v0.3 adds the first write helper, `submitVouch({voucherId, voucherPrivateKey, vouchedId, stakeAmountBaseUnits})`, against `POST /miners/vouches`. The SDK signs `{vouchedId, stakeAmount}` locally with the voucher's private key and posts the envelope; ae-node's authMiddleware verifies the signature before any state changes. Bigints round-trip as base-10 strings. Errors throw `SDKError` with `.code` + `.httpStatus`. 14/14 smoke tests pass against a real spawned ae-node (8 from v0.1 + 4 new v0.2 reads + 2 v0.3 write paths: insufficient-balance rejection on the happy auth path, plus a wrong-key path that proves authMiddleware actually blocks impersonation with HTTP 401). Court-argument submission and jury voting (which DO have auth on ae-node) land in v0.4 once the signing payload format is unified across SDK + wallet + miner.
- [x] ~~**Treasury / ecosystem fund.**~~ Removed in WP v2 alignment (July 2026). The white paper v2 deleted the infrastructure-funding section entirely. Fee split is now 20% Tier 1 / 80% Tier 2, no treasury cut. `core/treasury.ts` deleted, `treasury.fee_share` and `treasury.account_id` params removed, Phase 68 test deleted. Enrollment fee (separate from miner fees) goes to miners per Matt's direction.

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

- ~~**`dev-bump-ph.mjs`.** Dev shortcut to bump test accounts to 100% and seed earned balance. Documented in CLAUDE.md but worth a short README mention so testers find it.~~ Done. Added "Dev shortcut: bump every account to 100% verified" + "LAN multi-validator test" sections to the repo-root `README.md`. Testers cloning the repo see them in the Quick start area.
- **`ae-platform` (now `alignment-economy-website`) is half-built.** `/demo`, `/memes`, `/api` routes are stubs. No "Download wallet" or "Join beta" CTA. Lives in the sibling `alignment-economy-website` repo — touch when shipping installers, not before.
- **Installer publisher metadata + code signing.** Today the Windows installer triggers a SmartScreen "Unknown publisher" warning. Two parts:
  - ~~**(Free, ~5 min, do this anytime):** Set `author` + company metadata on both apps.~~ DONE (May 28). Both `ae-app` and `ae-miner` package.json now set `"author": "The Alignment Economy Foundation"` and `build.copyright`, so the .exe metadata and Add/Remove Programs show the right name. SmartScreen still warns (no signature), but the dialog reads "The Alignment Economy Foundation" instead of "Unknown publisher" once the user clicks "More info."
  - **(Paid, after 501(c)(3) is registered + D-U-N-S in hand):** Buy a code-signing cert from Sectigo or SSL.com (~$200/yr standard, ~$400/yr EV with hardware token). Drop the cert path into `package.json`'s build block, electron-builder signs both installers automatically. Standard cert removes "Unknown publisher" but SmartScreen reputation still ramps up over time. EV cert gives instant trust. Mac and Linux signing is separate (Apple Developer Program $99/yr + GPG signing for AppImage); same model.
- ~~**`POST /miners/vouches` has no auth middleware.** Surfaced by the SDK v0.3 work — the `voucherId` in the request body is taken at face value, with no signature check linking it to the calling client. Anyone can vouch on someone else's behalf. The vouch still costs the body-supplied account real earned balance, so it's not free, but it lets any third party drain a victim's balance into vouches they didn't authorize. Add `authMiddleware(db)` + verify `req.accountId === voucherId` on the route. Small surgical fix.~~ Fixed. Route now runs `authMiddleware(db)` and reads `voucherId` from `req.accountId` (the signature-verified caller), not from the body. A back-compat shim still accepts a top-level `voucherId` in the body but rejects the request with 403 `VOUCHER_MISMATCH` if it disagrees with the authenticated account. Wallet (`ae-app/src/lib/api.ts:createVouch`), miner (`ae-miner/src/lib/api.ts:submitVouch`), and SDK (`@alignmenteconomy/sdk:submitVouch`) all now sign `{vouchedId, stakeAmount}` with the voucher's private key before posting. Miner UI (`ae-miner/src/pages/Vouch.tsx`) loads the wallet inline at vouch-accept time to access the private key. SDK has 14/14 smoke tests including a new "submitVouch with a wrong private key fails authMiddleware (401)" assertion that proves the auth path is real.
- ~~**`POST /tags/supportive` and `POST /tags/ambient` had no auth middleware.** A third party could redirect any account's daily 144 supportive + 14.4 ambient point flows toward a product or space they own. The route header even claimed "tag forgery has no economic gain" — that was wrong: tagging redirects the victim's flow at the victim's percentHuman, so a fully-verified victim is the most valuable target.~~ Fixed. Both routes now run `authMiddleware(db)` and read accountId from `req.accountId`. Back-compat shim rejects with 403 `ACCOUNT_MISMATCH` if a top-level `accountId` in the body disagrees with the signed caller. Wallet (`ae-app/src/lib/api.ts` + `ae-app/src/pages/Tag.tsx`) now signs `{day, tags}` with the wallet's private key before posting. ae-node + ae-app both build clean.

### Auth-audit (closed)

The May 5 sweep added `authMiddleware(db)` to every previously-unauthenticated POST/PUT route that took an accountId-like field from the request body. Each closed an impersonation vector — some real (theft of earned balance, redirected daily point flows, sybil-bypass via fake evidence), some lower-impact (author attribution, contact-list manipulation). Pattern is uniform: read accountId from `req.accountId` (the signature-verified caller), accept a top-level body field for back-compat but 403 with `*_MISMATCH` on disagreement.

- ~~**`POST /miners/vouches`**~~ — Fixed. authMiddleware + 403 VOUCHER_MISMATCH on mismatched body voucherId. Wallet (`createVouch`), miner (`submitVouch`), SDK (`submitVouch`) all sign before posting.
- ~~**`POST /miners/register`**~~ — Fixed. authMiddleware + 403 ACCOUNT_MISMATCH.
- ~~**`POST /miners/evidence`**~~ — Fixed. Same shape. Wallet's `Verify.tsx` signs `{evidenceTypeId, evidenceHash}`.
- ~~**`POST /miners/vouch-requests`**~~ — Fixed. The signed account becomes fromId; 403 FROM_MISMATCH on disagreement.
- ~~**`PUT /miners/vouch-requests/:id`**~~ — Fixed. Auth'd AND ownership-checked: only the request's `toId` can respond; 403 NOT_REQUEST_RECIPIENT otherwise. Added `findVouchRequestById` to `IVerificationStore` + `SqliteVerificationStore` for the lookup.
- ~~**`POST /tags/supportive`** + **`POST /tags/ambient`**~~ — Fixed. Same shape; wallet's `Tag.tsx` signs `{day, tags}`.
- ~~**`POST /tags/products`**~~ — Fixed. Signed account becomes `createdBy`; 403 ACCOUNT_MISMATCH on disagreement.
- ~~**`POST /tags/spaces`**~~ — Fixed. Auth-gated even though the schema doesn't track creator today; future analytics or schema additions will be attributable.
- ~~**`POST /contacts/`**~~ — Fixed. Signed account becomes `ownerId`; 403 OWNER_MISMATCH.
- ~~**`PUT /contacts/:id/favorite`**, **`PUT /contacts/:id`**, **`DELETE /contacts/:id`**~~ — Fixed. Auth'd AND ownership-checked via the new `ownsContact` helper; 403 NOT_CONTACT_OWNER if the caller isn't the row's owner.
- ~~**`POST /recurring/`**~~ — Fixed. Signed account becomes `fromId`; 403 FROM_MISMATCH on disagreement. Vestigial today (no executor wires the day cycle to fire recurring rows), but auth is in place so when that wiring lands the path is safe by default.
- ~~**`PUT /recurring/:id`**, **`DELETE /recurring/:id`**~~ — Fixed. Auth'd AND ownership-checked via a new `ownsRecurring` helper; 403 NOT_TRANSFER_OWNER if the caller didn't create the row.

**Regression coverage:** `phase71.test.ts` (10/10 pass) exercises the auth gate on `/miners/vouches`, `/tags/supportive`, and `/contacts/` POST. For each it covers: unsigned body → 401 AUTH_MISSING, forged signature (different keypair) → 401 AUTH_INVALID, mismatched body identity field → 403 *_MISMATCH, correctly signed envelope → auth passes (subsequent failure modes are protocol-layer, not auth-layer). Three diverse routes are enough to catch a regression in the shared `authMiddleware` shape.

**Audit complete.** Every previously-unauthenticated POST/PUT/DELETE route that takes an accountId-like field now runs through `authMiddleware(db)`.

### Foundation Hardening (Phase 73) — [CODE]

A code-level audit (June 29, 2026) identified five categories of foundation weakness. These are the kinds of things that don't show up as bugs today but would bite at scale or under adversarial conditions. Fixing them now means the codebase a professional team receives is structurally sound, not just feature-complete.

**F1. Pure bigint fee distribution math** (`rewards.ts`)
- **Problem:** 5 sites convert `totalFees` (bigint) to `Number`, multiply by a float share, floor, convert back. Silently loses precision when totalFees > 2^53 (~90M earned points at 10^8 precision). Will corrupt fee distribution in a mature network.
- **Fix:** Replace `BigInt(Math.floor(Number(bigint) * share))` with rational arithmetic: `(bigint * BigInt(Math.round(share * 10000))) / 10000n`. The only Number involved is the small param share (0.18, 0.10, etc.), never the balance. Add dust recovery: remainder from per-miner equal splits goes to the first miner (same pattern as `inheritance.ts`).
- [x] Done.

**F2. Pure bigint court/tagging stake math** (`court.ts`, `ambient.ts`, `smart-contracts.ts`)
- **Problem:** `Math.round(percent * 100)` introduces ~0.5% rounding error on judicial stakes and tag allocations. Lower risk than F1 (the bigint itself isn't converted to Number), but still imprecise.
- **Fix:** Standardize on a `pctToBigint(balance, percentNumber)` helper that uses rational arithmetic with appropriate scale factors (10000n for 2-decimal percentages, 100n for integer percentages). Apply consistently in court stakes, juror stakes, tagging hierarchy collection.
- [x] Done.

**F3. Supply conservation integration test**
- **Problem:** Individual operations (rebase, fees, court) are tested in isolation. No test verifies the invariant across a combined sequence: rebase → transactions → court verdict → inheritance claim.
- **Fix:** Write `phase73-foundation.test.ts` that runs the full sequence with 100+ accounts and asserts total supply + fee pool is conserved at every step.
- [x] Done.

**F4. Rebase stress test at scale**
- **Problem:** Largest rebase test uses ~12 accounts. No evidence the rebase is correct or performant at 500+.
- **Fix:** Stress test with 500 accounts, verifying: (a) total earned supply is conserved to the unit, (b) every account's share of the economy is unchanged, (c) wall-clock time is reasonable.
- [x] Done.

**F5. Fee distribution dust recovery**
- **Problem:** Per-miner equal splits (`tier1Pool / BigInt(tier1Count)`) lose up to (N-1) base units per distribution. The remainder is never credited to anyone, a slow supply leak.
- **Fix:** First miner in each tier gets `perMiner + remainder`. Same pattern the rebase dust-distribution pass and inheritance already use.
- [x] Done (part of F1).

### Future (Phase 2+ scaling — not on the immediate roadmap)

- ~~**Rebase precision loss.** Integer division in the rebase loop truncates fractional dust each cycle.~~ Already has a dust-distribution pass (day-cycle.ts lines 241-251). Verified in Phase 73 stress test.
- ~~**Fee math loses precision at scale.** Mixed bigint/Number arithmetic caps precision at ~2^53.~~ Fixed in Phase 73 F1. All fee splits now use rational bigint arithmetic.
- **VRF could be stricter.** `Ed25519VrfProvider` is the production VRF. For Phase 3+ adversarial settings, swap in ECVRF (RFC 9381) behind the same `IVrfProvider` interface.
- **Rate limiting is in-memory only.** Rate limit maps reset on every node restart. Move to Redis or DB for Phase 2+.
- **No privacy layer.** Every transaction, balance, vouch, and ambient tag (physical location and duration) is stored in plain text. Plan for encrypted state or zero-knowledge proofs in Phase 3+.
- ~~**`setParam` has no governance.**~~ Fixed Phase 74. Parameter governance now classifies every param as Constitutional (immutable), Bounded (governable within hardcoded floor/ceiling), Algorithmic (auto-set by formula), or Open (freely governable). `governance.ts` exports the classification table and `validateParamChange()` enforces it. Constitutional params reject all changes; Bounded params enforce floor/ceiling via `BOUNDED_RANGES`.
- **SQLite won't scale past a single machine.** Use the repository pattern (see Scaling Roadmap) so the database layer can be swapped. Don't add more raw SQL to business logic functions.
- **Phase 17 sync test is timing-flaky.** `await wait(500)` after `startSync()` is occasionally too tight under load. Bump or replace with an event-based wait.
- **Phase 60 restart test is timing-flaky.** Multi-runner BFT test with 4 validators occasionally fails Phase B (live runners catching up after one is killed and restarted). Same family as Phase 35/49/53/59 flake.
- **Smart contract DSL is type-bounded, not Turing-complete.** Phase 70 added `earned_recurring` on top of the three existing executable contract types (`supportive_auto`, `ambient_auto`, `active_standing`). Any future expressive primitives (conditional triggers, multi-leg flows) layer on as additional types under the same dispatcher. A real VM with a scripting language is still future work and probably overkill for the whitepaper-stated use cases.

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
