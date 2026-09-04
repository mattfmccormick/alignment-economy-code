# Alignment Economy (AE) Platform

## The goal (read this first)

The objective is the most complete, correct, well-documented full-network codebase we can produce, ready to hand to a professional engineer or team who will harden it and deploy it to real miners and users. This is NOT a friends-at-home test or a quick demo.

Optimize for, in order:
1. **Correctness** (tests green, no known economic or consensus bugs)
2. **Completeness** (no half-built flows, no stub screens, every button does something real)
3. **Clean seams** (a pro can swap the database, the network transport, or the host without rewriting the economics)
4. **Handoff docs** (someone new can clone it, run it, read it, and find the edges in an afternoon)

Deployment-stage and operations work (NAT traversal, public bootstrap nodes, picking a host, code-signing certs, running infrastructure, external audits) is explicitly the professional team's job. We make the code ready for that work and document the seams. We do not have to operate it ourselves.

## Launch-readiness audit (September 3, 2026)

Before opening the network up, an eight-dimension adversarial audit read the
whole codebase (consensus, economics, crypto/auth, determinism, scale, network,
operations, app surface). Every finding was verified against the source by a
second reviewer instructed to refute it; 28 survived. This session fixed 25 of
them and began the largest of the rest - the "all state comes from the chain"
cluster (#4/#16) - by putting vouching fully on-chain. What remains: miner
registration and verification panels on-chain, then re-deriving transaction
value; plus the complete (post-interim) versions of #3 and #9. All scoped at the
end of "Known Issues" below.

**The one that mattered most is fixed: the BFT deadlock (#1).** A locked
proposer never re-proposed its locked value, so a locked validator voted NIL on
every fresh proposal forever and the height deadlocked in silence - the 3-node
"all quiet for 90s" flake, roughly 1 run in 3. The proposer now re-serves its
locked block, and the early-round prevote/precommit timeouts were raised from
1000ms to 2500ms so the staggered cold-start nodes align on round 0 instead of
the first one timing out and voting NIL. Together these took the 3-node startup
from ~1-in-3 failing to 13 consecutive clean runs, with the 2-node canary still
clean. (At n=3, quorum = n = unanimity, so this is the pragmatic fix; the full
valid-value/POL rule is the deeper large-set work.)

**Fixed and pushed this session (25 of 28, plus the vouch slice of #4/#16):**
- Consensus: the deadlock (#1) - a locked proposer now re-proposes its locked
  value AND the early-round prevote/precommit timeouts were raised from 1000ms to
  2500ms, which together took the 3-node startup deadlock from ~1-in-3 to 0 in 13
  consecutive LAN runs (the residual was the startup stagger: the first node
  timed out and precommitted NIL before the staggered later nodes prevoted). At
  n=3 (quorum = n = unanimity) this is the pragmatic fix; n>=4 gets true fault
  tolerance and the full valid-value/POL rule remains the deeper large-set work.
  Also: a committed block with no local content now
  halts loudly instead of writing a chain hole (#23); catch-up sync no longer
  strips signature fields (#14).
- Determinism / forks: the daily mint no longer reads the node-local miners
  table (#6); miner iteration is ordered (#5/#7); the fee pool is in the state
  root so fee-distribution drift is visible (#5/#7). The deeper "all state must
  come from the chain" work is the remaining cluster below.
- Crypto / auth: transaction replay is rejected (id derived from the signature)
  and signatures are no longer published (#2); a transaction signature can no
  longer authenticate a request (#3, interim guard); a missing payload no longer
  downgrades to a signature over {} (#15); the spoofable per-account rate limit
  that let anyone lock out any account is gone (#24).
- Network: a malformed gossip packet can no longer crash the node, and the peers
  message authenticates and is bounded (#8/#18); bans expire with backoff so one
  bad block cannot permanently partition honest nodes (#9, interim); the
  duplicate-connection tiebreak is deterministic and reconnect is jittered (#22);
  pre-handshake sockets are size-capped, count-capped and time-limited (#19).
- Economics: the fee lottery seeds on the parent hash, not the proposer-chosen
  block hash, so a validator-miner cannot grind to win (#17).
- App / ops: sealed jury votes are not leaked by the jury-duty endpoint (#13);
  the wallet recurring-edit unit bug that divided transfers by 1e8 is fixed
  (#21); account search no longer leaks balances (#27); share-history has a
  response cache to blunt its DoS (#12, partial); the docs' fault-tolerance
  claim is corrected - 3 validators is NOT fault tolerant, 4 is (#25).
- The tool this project shipped for adding a validator was writing to one node's
  DB instead of the chain; it now targets /propose-register (#11), with a test.

Every batch kept the ae-node unit suite green (795 tests) and, for the consensus
and network changes, the 3-validator LAN test green.

## Multi-node bring-up audit (August 16 – September 2, 2026)

Running the network across real machines: two laptops first, then a dedicated
mini PC as an always-on node. Almost nothing that broke was in the consensus
algorithm. The failures were in the seams — between packages, between the live
path and the sync path, between what a screen said and what the code did, and
in the test harness meant to catch all of it.

**Current state:** chain live across machines, 815 ae-node tests green (+ 92 app
tests), blocks paced at 10s. Snapshot sync ships. The startup deadlock is
effectively gone (13/13 LAN runs). Vouching, miner registration, AND
verification panels are all chain-ordered end to end (node + both apps) and
gossiped for fast inclusion. With panels done, `percentHuman` is now a pure
function of the chain (its three writers - vouch withdraw, panel completion, and
unwired decay - are all chain-driven or dormant), which unblocks the #4 value
fix. Joining no longer means replaying from genesis.

**Next up:** more validators on the live network. Note the quorum math, which an
earlier version of this file got wrong: quorum is `floor(2n/3)+1`, so 3
validators need 3 of 3 (a third machine adds a proposer but NO fault tolerance -
one down still halts the chain, same as two). **Four is the first size that
survives one machine going down.** The tooling exists end to end
(`validator:setup` -> fund -> `validator:register`, which now correctly targets
the chain-replicated `/propose-register` endpoint); what remains is running it
with the existing machines up. A permanently-dead validator cannot yet be removed
by anyone but itself (audit #25).



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

### Third pass, same day: four more closed

- **Validators no longer vote for blocks they cannot apply.** Content
  validation was stash-presence plus a timestamp check, and the comment in
  `BftBlockProducer` said so outright: "a stash-presence check IS the content
  check for now". A follower would prevote and precommit a block guaranteed to
  throw on its own apply, and only find out after a commit certificate already
  existed — the worst possible ordering, because then every affected validator
  has to fail-stop. `validateStashedBlock` now dry-runs the block's
  transactions against local state and votes NIL if they do not apply, so the
  round fails cleanly and retries instead. Extracted as
  `dryRunBlockTransactions` so it is directly testable; rollback is via a
  sentinel thrown through the depth-aware `runTransaction`, and the tests pin
  that neither a passing nor a failing dry run leaves any trace.
  New suite: `tests/block-dry-run.test.ts` (8 tests).
- **Supportive and ambient points actually pay out now.**
  `finalizeSupportiveTags` and `finalizeAmbientTags` were correct and tested,
  but nothing in `ae-node/src` ever called them — the only callers were the
  tests. On a live network you could tag your chair and your office all day and
  the points expired at 03:59 with everything else. Two of the white paper's
  four point types never reached a single balance. New `finalizeDailyTags` runs
  at the top of `runExpireAndRebase`, before `expireDaily`, because
  finalization debits the very balances expiry zeroes (reverse the order and
  every tag silently pays nothing). Per-account failures are contained and
  counted so one bad row cannot stop the network's day rolling over.
  New suite: `tests/tag-payout-cycle.test.ts` (6 tests), which drives the
  cycle rather than the finalizers — the gap the old unit tests could not see.
- **A second person can become a miner.** The bootstrap exemption covered only
  the very first miner, so from person two onward the `percentHuman >= 50`
  floor applied — and raising a score needs a panel, a panel needs a miner, and
  a miner needed a score. A network could never have more than one verifier,
  and every applicant after the first had nobody independent to review them.
  New governed parameter `mining.bootstrap_miner_count` (default 3, matching
  panel size) exempts a small window instead, so a network can seat exactly
  enough reviewers to run its first genuine panel before the floor takes over.
  The rejection message now explains what to do instead of quoting a number.
- **The sticky legacy-genesis trap fails loudly at boot.** A node that booted
  once without `AE_GENESIS_CONFIG_PATH` wrote a random-timestamp genesis;
  pointing it at a spec afterwards only set `networkId`, leaving it advertising
  the real network over a legacy genesis hash with none of the genesis accounts
  or validators. It then failed every peer handshake while looking healthy
  locally. Genesis is fully determined by the spec, so the runner now
  recomputes the expected block-0 hash, compares, and refuses to start with an
  explicit "delete the DB and restart" message rather than running a node that
  can never peer.

### Fourth pass: state divergence is detectable, and the UI stops lying

- **Nodes can now tell when they disagree.** Blocks commit to their
  transactions via `merkleRoot` but never to the state those transactions
  produce, and no `stateRoot`/`appHash` existed anywhere. Two nodes could
  disagree about every balance on the network and nothing would say so: balance
  drift surfaced only as an incidental `Replay: insufficient <type> balance`
  throw the first time a divergent account overspent, and `percentHuman` drift
  produced no error at any point, ever, because `replayTransaction` takes
  `netAmount` off the wire verbatim and never re-derives the spend multiplier.
  New `core/state-root.ts` hashes every account's id, type, percentHuman and
  five balances, ordered by id, reading balances as the TEXT they are stored as
  so precision above 2^53 survives. The proposer publishes its root for the
  PARENT block in the gossip payload; receivers compare against their own
  before voting and log the divergence with a message naming the likely cause.
  Parent state rather than post-apply state, because every receiver already
  holds it, so no prediction of fee distribution or day-cycle side effects is
  needed.
  **Diagnostic only, deliberately** — see the open-items note below. The first
  version voted NIL on a mismatch, which deadlocks the chain whenever an
  account has reached one node and not another. Corrected before it reached a
  real network.
  **Scope, deliberately:** the root rides the payload, it is not yet folded
  into the block hash. That needs no schema migration and no change to how
  historical blocks verify during sync, so it lands without risking a working
  chain, and it already solves the real problem (accidental divergence going
  unnoticed). What it does not yet do is make the claim unforgeable — nothing
  signs over it. Folding `stateRootHash` into `computeBlockHash` the way
  `validatorChangesHash` already is closes that and is backward compatible,
  since the optional parts hash as `''` when absent. Written up in the module
  header. New suite: `tests/state-root.test.ts` (10 tests).
- **The Verify screen no longer implies vouches raise your score.** Two numbers
  move independently there and people read them as the same thing: Evidence
  Score climbs as vouches and documents arrive, while the large %Human gauge
  does not move until a miner panel completes and writes the median of the
  reviewers' scores. Someone who collected five vouches and watched their
  spendable value stay at zero reasonably concluded the app was broken. The
  card now says plainly that evidence is the case and the panel is the verdict,
  shown only when the score is still 0 and evidence exists.
- **Platform-server failures explain themselves.** The default account-creation
  track talks to a service on :3500 that nothing starts and the packaged build
  does not even contain. Worse, the generic branch rendered `e.message`, and
  since the SDK never wraps its fetch rejection the thrown value is a
  `TypeError` — so what reached the screen was "Failed to fetch" and the
  friendly "Is the platform server running?" string written for exactly this
  case was unreachable. All four platform error paths now route through one
  explainer that names the situation and points at the self-custody option,
  which needs nothing but `ae-node`.
- **Miner registration failures are actionable.** The raw API string went
  straight to the screen, so the most likely failure for the second person on a
  network read as a defect rather than a next step.

- **Validators can sign into the miner.** Genesis keystores hold a raw ML-DSA
  keypair from `generateKeyPair()` with no BIP39 mnemonic anywhere in the file,
  so the accountId + phrase form could never accept one: no phrase reproduces
  that public key. Every genesis validator was locked out of `ae-miner`
  entirely, with an on-chain account that was funded and at 100% human and no
  door into the app. Added a keystore file picker on the sign-in screen. The
  raw-key persistence path (`saveMinerWallet`) and the reader that handles its
  shape (`parseStoredWallet`) both already existed and had no production
  caller; the only missing piece was a way to reach them. The importer takes
  the ML-DSA pair from `account`, not the Ed25519 node identity at the top
  level, and verifies against the node before persisting so a keystore from
  another network fails immediately instead of producing a wallet that signs
  perfectly and is rejected by every route. `persistAndEnter` also had to learn
  the second custody shape: storing a keystore user as a v2 wallet with an
  empty mnemonic wrote a record `parseStoredWallet` cannot read back, locking
  them out right after a successful registration.

### Fifth pass: account registrations go on-chain (schema v13)

Gossip closed the live half of account replication. This closes the other half.

A node that was offline when an account was created and later caught up by
syncing had no way to learn about it — `ChainSync` ships blocks and certs only,
so an account that never rode a block was invisible to it forever, and the
first block referencing that account fail-stopped it.

Registrations now ride the block exactly the way `validatorChanges` do, which
is the pattern the codebase already had:

- `core/account-registration.ts`: the `AccountRegistration` shape (accountId,
  publicKey, type, joinedDay — deliberately no balance, no percentHuman, and no
  createdAt, which comes from the block timestamp so every node writes the same
  value), the canonical hash, the apply function, and the proposer's queue.
- `computeAccountRegistrationsHash` is folded into `computeBlockHash`, so
  dropping an entry or substituting one whose id does not match its public key
  breaks hash verification on every receiver. `block-validator.ts` re-derives
  it from the payload rather than trusting the producer's claim.
- Schema v13 adds `blocks.account_registrations` and
  `pending_account_registrations`, mirroring `pending_validator_changes`.
- `BftBlockProducer` drains the queue into each candidate block and applies
  registrations on commit; `runner.ts` does the same on the sync-replay path.
- `POST /accounts` queues alongside the existing gossip, so a new account is
  available to peers immediately AND lands on-chain in the next block.

**Ordering:** registrations apply BEFORE the block's transactions, on both the
live commit path and the sync path. A newly registered account starts empty, so
within its own block it can only receive, and the credit needs somewhere to
land. Get this backwards and a block that onboards someone and pays them in one
go fails on every node.

**Backward compatibility, which is the risky part and is tested explicitly:**
`computeBlockHash` appends the new part and treats absent as `''`, so every
block ever committed keeps exactly the digest it had. Verified end to end by
constructing a genuine v12 database with real rows, rewinding the schema, and
running the upgrade: column and queue table appear, `schema_version` goes to
13, existing accounts keep their `percentHuman`, and the genesis hash is
unchanged — which matters because the genesis hash is the network's identity in
the P2P handshake. New hash parts must always be appended, never inserted.

New suite: `tests/account-registration-onchain.test.ts` (11 tests).

### Sixth pass: recovery, MAX, and a swallowed failure

- **Twelve words are now genuinely enough to recover a wallet.** They were not.
  `handleLogin` derived the keypair, threw it away with `void publicKey`, and
  set the error "To recover on a fresh device, also enter your Account ID
  below." The comment above it proposed adding a `GET /accounts/by-public-key`
  endpoint to remove that step one day. That is a data-loss trap: the app
  generates twelve words, tells you to write them down, calls them a recovery
  phrase — and then also requires a 40-character hex id it never told you to
  keep. Anyone who followed the instructions exactly was locked out for good.
  No endpoint was needed. `accountId` is `sha256(publicKey).slice(0, 20)` and
  the phrase determines the keypair, so the id is a pure offline derivation.
  Added `deriveAccountId` to `ae-app/src/lib/crypto.ts` and made the login use
  it; the Account ID field is still accepted as a cross-check when someone has
  it. Pinned by a test against ae-node's own derivation, because if the two
  ever drift, recovery silently resolves to a phantom account and the symptom
  reads as "account not found" rather than "the wallet is computing the wrong
  id".
- **The MAX button could produce an amount you cannot send.** It fed
  `displayPoints` — the HUMAN formatter, lossy on purpose — back into the
  amount field. Above a million points that emits `"1.23M"`, which `Number()`
  reads as NaN and `toBaseUnits` rejects; below that it rounds to two decimals,
  which can round UP past the balance and come back as "insufficient balance".
  On the one button whose entire promise is "all of it". New
  `baseUnitsToExactDisplay` truncates rather than rounds, emits no separators
  or suffixes, and works in bigint. `toBaseUnits` also now parses plain decimal
  strings digit-by-digit in bigint: `Math.round(n * 1e8)` is only exact below
  about 90 million points, past which it silently rounds someone's balance.
- **Platform signup no longer swallows an ae-node failure.** It caught and
  discarded the error from registering the account on the node, justified as
  "the account may already exist". The result was a user dropped into a wallet
  whose accountId did not exist on the node — every screen errors, nothing
  explains why. Since re-registering the same public key is now an explicit
  no-op, a failure there is a real failure, and it is surfaced.

### Seventh pass: commit-time execution (schema v14)

The execution model was the root cause behind both the un-enforceable state
root and a real double-spend vector. Fixed.

**What was wrong.** A transaction moved balances the instant the API or gossip
accepted it; the block that later contained it merely recorded that it had
happened. `block.ts` said so outright: "every transaction's state effect is
applied at API-receipt time by processTransaction, so the in-block ordering
carries no execution meaning."

That is a double-spend vector. Submit two conflicting spends to two different
validators simultaneously: each is individually valid against the state that
node holds, so each accepts the one it saw first. The two nodes now disagree
about the sender's balance, and the first block containing both is unappliable
on both of them. The chain fail-stops, having acknowledged spends totalling
twice the balance. It also made a state root permanently unenforceable, because
honest nodes legitimately differ whenever messages arrive in different orders.

Ordering is the one thing a blockchain is for. Doing the work before the
ordering exists gives it away.

**What changed.**

- `AE_EXECUTION_MODE` (`commit` | `receipt`), defaulting to `commit`. Must be
  identical on every node of a network — mixed modes are the divergence this
  removes.
- Schema v14 adds `transactions.applied`, defaulting to 1 so every existing row
  is correctly treated as already applied. Defaulting to 0 would make a node
  re-apply its entire history and double every balance.
- `processTransaction(db, input, { defer })` validates and persists unapplied;
  no balance, fee-pool or audit-log effect until commit.
- `replayTransaction` now gates on `applied` rather than on row existence,
  because under commit-time execution a row is known long before it is applied.
- New `acceptPendingTransaction` for the gossip path: verifies signature and
  accounts, then files the transaction rather than applying it, so garbage can
  never reach the pending set and be proposed into an unappliable block.
- Balance validation nets off `pendingOutgoingTotal`, since pending spends have
  not reduced the balance yet. Receipt-time got this free by mutating on the
  spot.
- `selectApplicableTransactions` filters the proposer's candidate set: pending
  transactions can legitimately conflict, and a block carrying two of them is
  unappliable on every node including its author. Deterministic (ORDER BY id),
  so every proposer would choose identically, and rolled back so selection
  leaves no trace.

**Verification.** New suite `tests/commit-time-execution.test.ts` (9 tests)
covers both modes, double-apply idempotency, the pending-aware balance check,
proposer conflict filtering, and gossip filing without applying. And
`scripts/test-lan-multi-validator.mjs` passes with commit mode as the default:
three real processes to height 23 with identical hashes.

**Still receipt-time:** vouching, court actions and verification-panel outcomes
mutate balances and `percentHuman` at API time. Those must move to
block-ordered application before the state root can be enforced — transactions
were the largest piece, not the only one.

### Eighth pass: peer addresses, vouch withdrawal, and a correction

- **The LAN test was flaky, and the cause was a real peering bug.** Three
  healthy nodes, matching genesis, zero blocks in 90s; passed on re-run. A peer
  that connects TO us is recorded with port 0 (the socket reports its ephemeral
  source port, not its listen port), and that address was included in the peer
  list gossiped during peer exchange — so every other node learned an address it
  could only fail to dial, and burned a reconnect slot on it every interval
  while real peers went unconnected. Node also reports IPv4 on a dual-stack
  listener as `::ffff:127.0.0.1`, which is not a legal URL host unbracketed, so
  the dial threw `Invalid URL` before it could fail honestly. Fixed at all three
  choke points (dial, discovery memory, gossiped list), hosts normalised so the
  mapped and plain forms stop double-storing. LAN test 3/3 clean after.
  `tests/peer-address.test.ts`.
- **Vouchers can withdraw, and it costs the vouched account.** WP §7.2 requires
  it; there was no route and `withdrawVouch` had no production caller, so
  staking was a one-way ratchet whose only exit was a guilty verdict. New
  `POST /miners/vouches/:id/withdraw`, auth-gated to the voucher (otherwise
  anyone could withdraw someone else's vouch and knock down a third party's
  score — pinned by a 403 test that also asserts the score did not move).
  Withdrawal returns the stake and drops the vouched account's `percentHuman` by
  that vouch's contribution (`stakedPercentage`, the same weight
  `calculateScore` credits), floored at 0. Without the score drop a ring could
  park a stake just long enough to get someone verified and then reclaim it.
  Wired in `ae-miner`'s Vouch page behind a confirm step that states the cost to
  the vouched account before the click — they are not in the room to object and
  the drop is immediate.
  **POST, not DELETE, deliberately:** the auth envelope must travel in a signed
  body, `express.json()` leaves `req.body` undefined for DELETE here, and
  intermediaries may strip a DELETE body. Every other auth-gated route in this
  API is a signed POST/PUT.
- **The wallet can withdraw too, and a duplicated type is gone.** `ae-app`'s
  Verify screen listed "Your Vouches for Others" with no way to release one.
  Same two-step confirm as the miner. Fixing it surfaced why it had never been
  built: Verify.tsx declared its own local `Vouch` interface that omitted `id`,
  so nothing on the screen could reference a specific vouch. Replaced with an
  alias to the canonical `VouchData` in `lib/types.ts`, which also brings the
  screen under the shape-contract suite. Worth noting `npx tsc --noEmit` did
  **not** catch the missing field; `npm run build` did (different tsconfig), so
  the build is the real gate for the frontends.
- **`dev-bump-ph.mjs` can now prove two machines agree.** The two-laptop guide
  tells the operator to run it on both nodes, and it writes account state
  outside consensus, so it is a way to fork the network — either by running it
  on one node only, or by running it on both at different moments (it touches
  only the accounts that exist locally at that instant, so nodes with different
  account sets bump different rows). Since block-apply now fail-stops, that
  shows up as a halted chain rather than silent drift. The script now prints a
  `STATE ROOT` after bumping, and takes `--check` to print it without changing
  anything, so operators can compare the two machines directly. It imports the
  node's own `computeStateRoot` rather than re-deriving it — a drifted second
  copy would make disagreeing nodes print matching roots, which is worse than
  no check. Verified: two DBs with the same account set converge to an
  identical root, a DB with one extra account does not. The old header warning
  claiming "blocks carry no state root, so divergence cannot be detected" was
  stale and is corrected in both the script and `README.md`.
- **`cd sdk && npm test` failed six tests on a fresh clone.** Not a code bug:
  `platform-server` is a separate workspace with its own dependencies and
  nothing in the documented setup installs it, so the spawned server had no
  `tsx` to run. The symptom was `platform-server did not start within 15s`,
  which reads as a hang or a port clash and sends you looking in the wrong
  place. The test now checks for `platform-server/node_modules` **before**
  spawning and says exactly what to run; the timeout message now states that
  node_modules was present, so a real startup failure is distinguishable from a
  missing install. README documents the workspace and that it is only needed
  for the hosted account track and these tests. With it installed: sdk 20/20,
  platform-server 36/36.
- **Package install status across the repo (checked this pass).** `sdk`,
  `ae-node`, `ae-app`, `ae-miner` were installed; `platform-server` and
  `explorer` were not, and neither is covered by the README quick start.
  `explorer` builds clean once installed. Worth knowing before a handoff: a
  "fresh clone builds everything" claim is only true for four of the six
  packages.
- **`authMiddleware` returned 500 instead of 401 on every protected route.** It
  destructured `req.body` directly, and `express.json()` leaves that undefined
  when there is no parseable JSON body (no Content-Type, empty body, or a
  method it does not treat as carrying one). The TypeError became an unhandled
  API error, so the most likely malformed request — an auth-gated route called
  with no body — reported itself as a server fault rather than the 401 it is.
  Now defaults to `{}`. Found while testing the withdraw route; it affected
  every protected endpoint.
- **Correction: vouch burns are true burns and I broke that.** A state-mutation
  audit flagged the missing `addToFeePool` in `burnVouch` as a supply leak. The
  code reading was right, the intent reading was wrong: WP v2 made every court
  burn destroy supply on purpose, pinned by `phase64.test.ts`. The change was
  reverted and the behaviour is now pinned from the vouching side too so the two
  cannot drift. The legacy folder's Phase 62 note describing fee-pool routing is
  stale — Phase 64 superseded it. **Lesson worth keeping: "the code does not do
  X" is not evidence that it should.**

### Ninth pass: joining a running network (September 1-2, 2026)

Bringing a third machine (a dedicated mini PC) onto the live chain, which
exercised catch-up sync properly for the first time.

- **A new node could not join any chain that had been used.** It synced to
  block 4,690 and then failed the same block forever with
  `Replay: insufficient active balance ... has 0, needs 10000000000`. The
  sender genuinely had zero: `BftBlockProducer.onCommit` calls
  `applyChainDayCycle` after every block, and the sync path in `runner.ts` did
  not. A catching-up node replayed registrations and transactions while never
  minting, expiring or rebasing, so every account stayed empty and the first
  historical transaction that spent minted points threw.

  The scope is larger than one stuck machine: existing nodes were fine only
  because they lived through the mints in real time. Catch-up sync had
  evidently never been run against a chain with real activity on it.
  `onSyncBlockApply` now runs the cycle in the same position, with the same
  catch-and-log, as the commit path. `sync-day-cycle.test.ts` pins the three
  properties sync depends on.

- **BFT is paced at 10s per block.** There was no pacing at all: `onCommit`
  advanced the height and called `startRound()` immediately, so a healthy
  network produced a block roughly every 2.7 seconds regardless of activity.
  `blockIntervalMs` has defaulted to 10s all along but only ever reached the
  legacy Authority path.

  Measured on the live chain: **30,932 blocks carrying 4 transactions**, 64 MB
  on disk, ~32,400 blocks/day. The real cost is joinability rather than disk — a
  new node replays every block, so if sync is slower than production a node that
  falls behind can never catch up, and the threshold tightens as the chain
  grows. 10s takes blocks/day from ~32,400 to 8,640: 4x off sync, disk, and the
  per-block state-root scan at once.

  The pause is unconditional rather than "skip it when transactions are
  waiting", because nodes decide that independently and would enter rounds at
  different times. **Every validator on a network must use the same value.**

### The LAN test was lying, and it gates every consensus change

Worth its own heading because it invalidated several judgements made today.

`scripts/test-lan-multi-validator.mjs` is the only end-to-end gate on consensus
work. Its `teardown()` sent `SIGTERM` and scheduled a `SIGKILL` two seconds
later. Neither worked on Windows: SIGTERM does not take down a Node child tree,
and the timer never fired because callers invoke `process.exit()` immediately.

**Every run leaked its three nodes.** They kept holding ports 4001-4003 and
9301-9303, so the next run hit `EADDRINUSE` on startup and had its handshake
answered by a survivor carrying a different genesis. The test failed roughly a
third of the time for reasons having nothing to do with consensus.

This nearly caused a correct change to be rejected. First measurements of the
block-interval work were 3/6 with pacing against 4/6 without — which reads as a
consensus regression. The captured failure said otherwise once actually read
rather than inferred from pass rates: `FATAL listen EADDRINUSE :::4002`, then
`network mismatch: peer is on "ae-lan-test-m…"`.

Fixed with `taskkill /T /F` synchronously. After: **baseline 4/5, with 10s
pacing 5/5**, no orphans. Treat pre-fix LAN results as unreliable, including the
peering work earlier in the audit.

**Correction (September 3): 5/5 was a lucky sample, and quoting it as the
current state was wrong.** A larger run measured **baseline 3/4 and 4/7 with
this session's changes** — statistically the same, and both well short of
reliable. The number was re-measured because a single failing run looked like a
regression from the state-root work; it was not, and neither is the flake new.

What the failure actually looks like is sharper than "timing flake", and worth
recording because it points somewhere different. In a passing run block 1
commits within a second of the startup delay elapsing, then 2 and 3 arrive on
the 10s pacing — the whole thing is done in ~32s of a 90s budget. In a failing
run **nothing happens at all**: all three nodes log "BFT consensus loop
started" and then go completely silent for the full 90 seconds. Never a partial
commit, never a stalled height, never an error. So this is not the deadline
being too tight; round 0 never produces a block and no later round recovers,
even though propose/prevote/precommit timeouts (3s/1s/1s, scaling per round)
should burn through dozens of rounds in the remaining 78 seconds. **That diagnosis was wrong.** I guessed "the nodes never meshed" because peer
connections are not logged and I could not see past that. An adversarial audit
later the same day found the real cause, and it is a consensus bug, not a
networking one: a validator can lock on a block hash that no future proposer
ever re-proposes, and the lock can never be broken. See "Pre-launch risk audit"
below, finding 1.

For a 3-node network this is more than test noise: it is "the chain sometimes
does not start", and the same mechanism can halt a chain that is already
running.

### Sync does not scale, and pacing only buys time

The block interval is a constant-factor win, not a fix. Sync time still grows
without bound, just 4x slower. At 10s a year of chain is ~3.2M blocks and a new
node still replays all of them.

Every comparable chain solved this the same way, and none of them by keeping the
chain small:

- **Bitcoin** tolerates full replay only because 10-minute blocks keep the count
  low, and even then defaults to `assumevalid` (skip signature checks before a
  hardcoded hash), offers pruning, and recently added a UTXO-snapshot path.
- **Ethereum** made full replay impractical, so **snap sync** is the default:
  fetch current state, verify against a recent block, replay only the tail.
- **Solana** never pretended replay was viable; validators start from a
  snapshot.

**AE now does the same.** Shipped as `ae-node/scripts/snapshot.mjs`
(`export` / `verify` / `import`), backed by schema v16, which records the state
root on every block.

**The blocker was that the root was not persisted.** `computeStateRoot` existed,
but the value only ever travelled in the gossip payload: a receiver compared it
once, logged on mismatch, and threw it away. Nothing could answer "what was the
state at height N?" after the fact, so a joiner had nothing authenticated to
check a snapshot against and a malicious donor could serve fabricated state with
a matching fabricated root. `blocks.state_root` (v16) closes that, written by
`recordStateRoot` at the end of all three commit paths — BFT commit, BFT sync
replay, Authority apply.

**Recorded after the day cycle, not before.** A block crossing 08:59 UTC expires,
rebases and mints; a root taken before that describes state no node ever settles
on. All three paths record at the same point in the sequence, from the same
inputs, which is what makes two machines' roots comparable at all.

**What it is, said plainly:** operator-assisted snapshot sync, the same model as
Bitcoin's `assumeutxo` and Solana's snapshot download. It is NOT trustless P2P
state sync, and the distinction is not hedging:

- The file carries its own root, so `verify` catches truncation, corruption and
  the torn copy you get from `cp`-ing a live WAL database. It cannot catch a
  donor who fabricated both the state and the root, because nothing in the chain
  commits to the root yet.
- So the check with teeth is `--peer`: ask independent nodes for their recorded
  root at that height and require agreement. A donor would have to control every
  node you ask. Verifying against one node run by the person who gave you the
  file proves nothing, and the CLI says so when you skip `--peer`.

**Whole database, not a state-only extract.** The cost being removed is replay
time, not disk. A state-only snapshot leaves the joiner with no blocks below the
snapshot height, which breaks parent lookups, chain validation and its ability
to serve sync onward — that needs a "this chain starts at height H" concept
threaded through the store layer, which is a real feature and not something to
fake with a truncated file. Export uses `VACUUM INTO` rather than a file copy,
because on a WAL database the newest committed pages live in the `-wal` sidecar
and a hand copy silently omits them.

**Still open:** folding the root into `computeBlockHash` so it is
consensus-enforced. Order matters and it is not next: account state has to
become a pure function of the chain first (registrations are on-chain as of
schema v13, but gossip still front-runs them). Fold it in first and the deadlock
just moves into hash verification. Until then, cross-checking peers is what makes
a snapshot sound.

### Storage: validator snapshots stored on change, not on every block

Every block carried a full JSON copy of the validator set — about 617 bytes
recording something that changes a handful of times in a chain's life. On the
live chain that was 30,932 near-identical copies of a two-validator list, and
roughly 30% of total storage.

Dropping the duplicates is only safe because the READ resolves *the set in force
at height N* (most recent row at or before N), not *the row stored at height N*.
A height with no row inherits the earlier one, which is the same answer. The
write now compares against the set already in force and returns early when it
matches, ordering by accountId first so a different `listAll()` ordering is not
mistaken for a real change — that would defeat the deduplication without being
incorrect, which is the kind of bug that hides for months.
`validator-snapshot-dedupe.test.ts` pins the equivalence: what a caller gets
back is identical to what the old store-on-every-block scheme returned.

Deliberately NOT the same lookup shape as the new state root, which is
exact-match. A validator set persists until something changes it, so inheriting
is correct. A state root describes one height and nothing else, so inheriting
would let a snapshot verify against state it does not contain — a false pass on
the one check that matters.

### Third validator: the missing step was tooling, not protocol

The on-chain machinery has worked since Session 59. What did not exist was a way
for an operator to actually use it: `validator:setup` generated keys and then
said "submit a signed validator/register transaction via the API", which is not
an instruction anyone can follow. New `npm run validator:register` closes it —
reads the keystore, signs the intent with the account's ML-DSA key, POSTs it.

**The trap it exists to prevent.** A validator change is not gossiped like a
transaction. The API writes it to a *local* queue (`enqueueValidatorChange`),
and that queue is drained in exactly one place: when **that** node proposes a
block. A candidate's own node is not in the set yet, so it never proposes, so the
change sits in its queue forever. The POST returns 200, the queue row is real,
and nothing anywhere reports an error. From the outside it is indistinguishable
from a slow network.

So `--node` must point at a node ALREADY in the active set, usually not your
own. The CLI checks the target's `/status` and refuses rather than let that
happen, and it checks the other two preconditions before signing anything: the
candidate's account exists on that chain, and holds the stake in *earned* points
(daily points expire and cannot be staked). A named precondition beats a
`REGISTER_FAILED` arriving after the fact.

`GET /api/v1/status` now reports `node.accountId`, `node.consensusMode` and
`node.isActiveValidator`, which is what makes that check possible from outside
the process — and answers "which node am I looking at?" generally.

### MIN_VALIDATOR_STAKE is off by four orders of magnitude

Found while wiring the register CLI, **not fixed**, deliberately.

`MIN_VALIDATOR_STAKE` is `100_00n`, written on the assumption of 2-decimal fixed
point and commented "100.00 points". `PRECISION` is `10^8`. Every caller converts
display units with `PRECISION` and then compares against this constant, so the
minimum a validator actually has to stake is **0.0001 points, not 100**. A second
comment in `genesis-init.ts` claimed "1.00 in display units", also wrong. Both
comments now state the real number.

This is the parameter that is supposed to make the validator set expensive to
flood. Anyone holding a fraction of a point currently clears it.

Not silently changed because raising it to `100n * PRECISION` is a consensus
parameter change: every genesis spec, every registered validator and about a
dozen tests are written against `10000n`, so it needs a coordinated restart of
every node rather than a quiet edit. **Matt's call.** Do it before the network
has validators worth attacking — the cost of the change only goes up.

## Pre-launch risk audit (September 3, 2026)

A multi-agent adversarial audit across eight dimensions: consensus, economics,
crypto/auth, determinism, scale, network, operations, app surface. 31 findings
filed, **28 survived** a refutation pass in which every finding was handed to a
separate reviewer instructed to refute it by reading the source. 3 were refuted
and dropped.

Four were then verified BY HAND with a running reproduction, because they change
what happens next. Those four are stated as fact. The other 24 carry the audit's
confidence, not mine, and should be re-checked before anyone acts on them.

### Verified by hand, with a reproduction

**1. A transaction signature is a valid login token for that account.**

`signPayload` signs `JSON.stringify(payload) + timestamp` and nothing else
(`core/crypto.ts:50-65`). No accountId, no HTTP method, no path, no domain tag.
So the envelope a wallet signs to send money also verifies as the envelope
`authMiddleware` checks. And the public, unauthenticated
`GET /accounts/:id/transactions` returns the signature column verbatim, because
`SqliteTransactionStore` selects `*`.

Working proof of concept, start to finish: victim sends a payment (200); an
attacker holding no credentials reads the victim's history (200) and lifts the
signature; the attacker replays that signature as an auth envelope on
`POST /miners/register` and **registers the victim as a miner (200)**.

Every auth-gated route that derives the actor from `req.accountId` and the
target from a URL param, without inspecting the payload, is exploitable this way
inside the 5-minute replay window: validator deregistration, miner registration,
court actions, contacts, recurring transfers.

The fix is domain separation. Bind accountId, method and path into the signed
bytes behind a per-purpose prefix, and stop returning `signature` from public
read routes. Both halves are needed; either alone leaves a path open.

**2. `npm run validator:register` never put anything on the chain.**

My bug, shipped and documented the same morning. The CLI POSTed to
`/api/v1/validators/register`, which calls `registerValidator()` and performs
three purely LOCAL writes inside one transaction: debit earned, credit locked,
INSERT into `validators`. It never enqueues, never gossips, never rides a block.
The chain-replicated route is `/propose-register`, which calls
`enqueueValidatorChange`.

Worse, both the CLI's own preflight and `docs/running-a-node.md` insisted you
aim it at an ACTIVE VALIDATOR, which is the worst possible target: that node's
`quorumCount` (floor(2n/3)+1) rises while its peers' does not, so it demands more
prevotes than can exist and precommits NIL forever. The chain halts with no error
anywhere, because the state root that would notice the divergence is diagnostic
only and not folded into the block hash.

**Fixed.** The CLI now signs with `signValidatorChangeRegister` and POSTs to
`/propose-register`, and `validator-register-goes-onchain.test.ts` pins both
routes' behaviour so they cannot be confused again.

**3. The daily cycle blocks the whole node for roughly 0.7 ms per account.**

Measured on this machine, not estimated. Expire + rebase + mint, second sample:

| accounts | expire | rebase | mint | total | state root, per block |
|---|---|---|---|---|---|
| 25,000 | 1.4 s | 1.1 s | 7.6 s | **10.1 s** | 46 ms |
| 50,000 | 13.5 s | 8.7 s | 15.8 s | **38.0 s** | 293 ms |
| 100,000 | 25.6 s | 17.7 s | 30.0 s | **73.3 s** | 532 ms |

It runs synchronously inside `applyChainDayCycle`, called from
`BftBlockProducer.onCommit`, on every validator at the same instant (08:59 UTC).
Node is single-threaded, so for that entire time the node cannot answer a vote or
a proposal. Consensus timeouts are propose 3 s, prevote 1 s, precommit 1 s.

At 10k users the cycle already exceeds one 10-second block. At 50k the whole
network is unresponsive for over half a minute, every single day, simultaneously.
The catch-up loop multiplies it: a node offline for 30 days runs 30 cycles back
to back before it can participate.

**4. The consensus engine has zero logging.**

`bft-driver.ts` and `BftRuntime.ts` contain **0** `logger.` calls between them.
Peer count is exposed by no API route. `onRoundFailed` is declared but has no
production caller.

That is why the halt in finding 1 presents as total silence, and why it survived
several sessions of investigation including my own wrong guess this morning:
there is nothing to look at. Cheapest high-value fix on this list.

### The 28 confirmed findings

Ranked by verified severity. "Bites at" is when it starts to matter, not when it
was introduced.

- **[CRITICAL / consensus] A single validator locking on a stale block hash deadlocks the height forever — proposers never re-propose a locked value (this is the 3-node LAN 90s-silence bug)**  
  Where: `ae-node/src/core/consensus/BftBlockProducer.ts:365 and :559-586`  
  Bites at: now — reproduces roughly 1 run in 3 on the 3-validator LAN test. Any network where a single stale-locked validator breaks quorum (N=3 exactly; N=4-5 needs two such validators) can halt permanently.  
  Fix (large): Implement Tendermint's valid-value/POL rule. Track lockedValue + lockedRound and validValue + validRound in BftDriver, pass them into RoundController, and have the proposer path use them: change `blockProviderFor` so that when the driver holds a lock at this height it re-proposes the locked hash (re-serving the stashed payload) instead of calling buildCandidateBlock, and carry `validRound` on the Proposal so unlocked validators know they may prevote it. Separately add the round-skip rule (on seeing f+1 votes from a round > currentRound, jump to that round) in bft-driver.ts routeVote instead of dropping them, so a staggered node catches up rather than staying one round behind indefinitely.

- **[CRITICAL / economics] percentHuman spend multiplier is node-local and the wire carries netAmount verbatim, so any participant running a node mints unlimited value from sybil accounts**  
  Where: `ae-node/src/core/transaction.ts:348 (burnedUnverified derived from wire fee/netAmount), :264 (only sanity check), :440-448 (signed payload excludes fee/netAmount), :493-499 (the only place the multiplier is derived)`  
  Bites at: now — one adversarial node and one sybil account is enough; profit scales linearly with sybil count  
  Fix (large): Two changes, both needed. (1) In replayTransaction and acceptPendingTransaction, re-derive effectiveAmount/fee/netAmount/burn locally from the sender row exactly as processTransaction does, and reject the transaction if the wire values disagree; better still, drop fee/netAmount from the wire entirely and let every node compute them. (2) That is only sound once percentHuman is chain state, so make verification score changes a signed, block-ordered operation (a panel_score transaction type applied deterministically at commit) rather than a direct write from POST /verification/panels/:id/score. As an interim hard cap that removes the unbounded case without the full refactor, enforce `fee + netAmount <= amount * localPercentHuman / 100` for daily-point spends by individuals on both wire paths, which fails closed for a sender the local node has not seen verified.

- **[CRITICAL / economics] Fee distribution pays miners out of a node-local, never-replicated miners table, so every node credits different accounts for the same block**  
  Where: `ae-node/src/mining/rewards.ts:155-160 and :295-317 (commitBlockSideEffects)`  
  Bites at: now — first fee-bearing transaction on any network where the miner set is not identical on every node, which is the default since nothing makes it identical  
  Fix (large): Make miner registration, deactivation and tier changes chain-ordered operations (signed, mempool-admitted, applied at commit) exactly as the transaction path now is, so getActiveMiners returns the same rows on every node. Move the heartbeat signal onto the chain or drop uptime from the tier rule; runMinerTierEvaluation must not read Date.now() or node-local rows from inside runExpireAndRebase. Pass the block timestamp into runExpireAndRebase instead of the three Date.now() calls at day-cycle.ts:413-426. Until that lands, remove the fee payout from commitBlockSideEffects and let the pool accumulate rather than diverge.

- **[CRITICAL / crypto-auth] Any transaction can be replayed forever by anyone, using data the public API hands out**  
  Where: `ae-node/src/core/transaction.ts:501 (txId = uuid())`  
  Bites at: now - one payment by one user is enough  
  Fix (medium): Make the transaction id a function of the signed bytes and reject duplicates: derive txId = sha256(canonical payload || timestamp || from) instead of uuid(), add UNIQUE(signature) (or UNIQUE on the derived id) to the transactions table, and check for an existing row before applying. Independently add a monotonically increasing per-account nonce to the signed payload, rejecting any tx whose nonce is not sender.nonce + 1, plus a timestamp-freshness window inside processTransaction. Also stop returning `signature` and `receiver_signature` from GET /accounts/:id/transactions.

- **[CRITICAL / crypto-auth] The signing scheme has no domain separation, so a publicly-readable transaction signature is a valid login token for that account**  
  Where: `ae-node/src/core/crypto.ts:50-65 (signPayload/verifyPayload)`  
  Bites at: now - one payment by a validator or voucher within the last 5 minutes  
  Fix (medium): Domain-separate and context-bind the signature. Have signPayload/verifyPayload sign a canonical string containing a fixed domain tag, the accountId, the HTTP method and the full request path including URL params, alongside the payload and timestamp - e.g. `ae-auth-v1|POST|/api/v1/validators/deregister|<accountId>|<canonical payload>|<timestamp>`. Give transactions a distinct tag ('ae-tx-v1') so the two can never be interchanged, and update ae-app/src/lib/crypto.ts and ae-miner/src/lib/crypto.ts in lockstep. Add a server-side seen-signature cache covering the 5-minute window so an envelope is single-use.

- **[CRITICAL / determinism] Daily mint is gated on the node-local `miners` table, so two nodes mint different balances for the same account**  
  Where: `ae-node/src/core/day-cycle.ts:198,203`  
  Bites at: now — the live network already has miners registered per-machine, and it fires on the first day boundary after any miner registration  
  Fix (large): Make miner registration ride a block the way `AccountRegistration` already does (core/account-registration.ts, schema v13): a signed `MinerRegistration` type, a `pending_miner_registrations` queue drained by the proposer, `computeMinerRegistrationsHash` appended to `computeBlockHash`, applied before transactions on both the commit and sync-replay paths. Until that lands, the interim correct behaviour is to drop the miner exclusion from `mintDaily` entirely (day-cycle.ts:198-203), because minting from a node-local set is strictly worse than minting to everyone.

- **[CRITICAL / determinism] Fee-pool payouts run at every commit against the node-local miner registry, and the fee pool is not in the state root**  
  Where: `ae-node/src/mining/rewards.ts:272-317, :154-157, :161`  
  Bites at: now for the ordering/remainder divergence; guaranteed the moment any node joins by catch-up sync or snapshot, which is the documented path for the planned third validator  
  Fix (large): Two parts. Short term, add `ORDER BY account_id ASC` to `findActiveMiners` (SqliteMiningStore.ts:51-60) and add the fee-pool row to `computeStateRoot` so this class of drift is at least visible. Real fix is the same as the miner-registration finding — miner set must be chain-derived — after which `commitBlockSideEffects` becomes a pure function of committed state. Also correct the two comments that claim cross-node identity (BftBlockProducer.ts:777-779, runner.ts:456-457); they are the reason this path was not on the audit list.

- **[CRITICAL / scale] Unappliable pending transactions are never evicted, so every block proposal reloads and re-replays the whole accumulated garbage set**  
  Where: `ae-node/src/core/transaction.ts:235-285 (acceptPendingTransaction)`  
  Bites at: now (3 nodes) -- one overdrawn signed transaction is enough to seed it; a deliberate flood halts the chain at any size  
  Fix (small): Add a LIMIT plus a deterministic ORDER BY to findUnblockedTransactions so block building is bounded, and add a sweep that deletes pending rows (applied=0, block_number IS NULL) older than a fixed number of blocks or seconds. Also reject in acceptPendingTransaction anything the sender's current balance plus pendingOutgoingTotal cannot cover, so obvious garbage never enters the table.

- **[CRITICAL / network] One unauthenticated `peers` message with a non-array payload kills any node process**  
  Where: `ae-node/src/network/peer.ts:252-255, ae-node/src/network/peer.ts:307-310, ae-node/src/network/discovery.ts:80-87, ae-node/src/node/cli.ts:14-17`  
  Bites at: now — any node with a reachable P2P port, single attacker, one packet per node  
  Fix (small): Wrap the body of `handleMessage` (and the two `ws.on('message')` callbacks at peer.ts:204-207 and 252-255) in try/catch that logs and drops the message. Separately, shape-validate before emitting: `if (!Array.isArray(msg.data)) return;` in the `peers` case, and add `isAuthenticatedSender` to `peers`/`get_peers` so pre-handshake sockets cannot reach the discovery layer at all. The same null-deref exists in `new_block` (`(msg.data as {hash}).hash` at peer.ts:314) and `new_transaction` (peer.ts:327) for any handshaken peer.

- **[CRITICAL / network] Gossip relays blocks before validating them, and the receiver bans the relayer, so one bad block makes honest nodes permanently ban each other**  
  Where: `ae-node/src/network/peer.ts:312-323, ae-node/src/network/sync.ts:400-445, ae-node/src/network/peer.ts:150-161`  
  Bites at: now — any node that can complete a handshake, which requires only public information  
  Fix (medium): Validate before relaying: move the relay so it runs only after the block passes `validateIncomingBlock`, or have the `block:received` listener return an accept/reject the peer layer honours. Independently, stop attributing a relayed payload's badness to the relay hop: ban on the inner signed producer identity (the block's own producer key / cert signers), not on `msg.publicKey`. Add ban expiry and a strike counter so a single bad message is not a permanent partition.

- **[CRITICAL / operations] `npm run validator:register` — the documented way to add a validator — writes to one node's local DB and never touches the chain**  
  Where: `ae-node/src/scripts/register-validator.ts:288,329`  
  Bites at: now — the first time anyone adds a third validator  
  Fix (medium): Point the CLI at `/propose-register` / `/propose-deregister`: build and sign a `ValidatorChange` with `validator-change.ts`'s canonical signer instead of the auth-middleware `{accountId,timestamp,signature,payload}` envelope. Then delete the local-only `/register` and `/deregister` routes, or gate them behind the admin secret and rename them so they cannot be reached by an operator following the docs. Fix the running-a-node.md prose to describe the endpoint actually used.

- **[HIGH / consensus] Catch-up sync strips recipientIsHuman and receiverSignature from block transactions, permanently wedging any node that falls behind**  
  Where: `ae-node/src/network/sync.ts:347-360`  
  Bites at: now, on the first restart-after-downtime that spans any block containing an in-person or recipientIsHuman transaction.  
  Fix (small): In sync.ts:347-360 add `recipientIsHuman: t.recipientIsHuman` and `receiverSignature: t.receiverSignature` to the mapped object — the columns are already on the TransactionRow the store returns, and the live-gossip path (BftBlockProducer's txRowToWire) already ships them. Then extend validateIncomingBlock step 7 to reject a payload whose transactions are missing signature-relevant fields, so a truncation like this fails loudly at validation instead of silently at replay.

- **[HIGH / economics] Tier-2 fee lottery is seeded on the block hash the proposer chooses, so a validator who is also a miner wins the lottery on every block it proposes**  
  Where: `ae-node/src/mining/rewards.ts:203-210 and :216 (winner = lowest sha256(blockHash|accountId))`  
  Bites at: as soon as there are two or more Tier-2 miners and any validator also operates a miner; profit scales with the fee pool and with the validator's proposer share  
  Fix (medium): Do not seed the lottery on a value the proposer controls. Either wire up the existing VRF path (selectLotteryWinner, rewards.ts:93) so each miner's ticket is a VRF output over a chain-anchored seed the proposer cannot pick, or seed on an aggregate the proposer does not author — e.g. the concatenated precommit signatures in the block's commit certificate, which no single validator fixes. A cheaper partial mitigation is to seed on the hash of a block k heights back and tighten DEFAULT_MAX_TIMESTAMP_DRIFT_SEC, but that only raises the grinding cost rather than removing it.

- **[HIGH / crypto-auth] Omitting the `payload` key downgrades the signature to a signature over `{}` while the route reads its parameters from the unsigned body**  
  Where: `ae-node/src/api/middleware/auth.ts:58 (`payload || {}`)`  
  Bites at: now - any account that has registered as a miner or deregistered as a validator  
  Fix (small): Stop treating a missing `payload` as an empty signed payload. In authMiddleware reject with 401 when `req.body.payload` is not a present object instead of defaulting to `{}`. Remove the `req.body.payload || req.body` fallback from every route handler and the `'payload' in req.body ? ... : req.body` fallback from validateBody - the envelope shape should be mandatory. That also removes the need for the per-route `claimed*` mismatch guards, which only function when the wrapper exists.

- **[HIGH / determinism] Supportive and ambient payouts at commit are computed from node-local tag tables**  
  Where: `ae-node/src/core/day-cycle.ts:407, :73-125`  
  Bites at: the first time any user submits a tag on a multi-node network; the Tag screen auto-saves ~800ms after any edit, so this is normal wallet use, not an edge case  
  Fix (large): Tags must be chain-ordered like transactions: a signed tag-submission operation admitted to the mempool, included in a block, applied deterministically at commit. Same shape as the commit-time execution change transactions already went through (schema v14). Interim mitigation that keeps the ledger consistent though not correct: gossip tag submissions the way `new_account` is gossiped (network/node.ts:218), which closes the online case but not the sync case.

- **[HIGH / scale] The daily cycle runs synchronously inside the block-commit callback and already exceeds one block interval at 10k accounts, growing every day because transaction_log is never pruned**  
  Where: `ae-node/src/core/consensus/BftBlockProducer.ts:851 (applyChainDayCycle inside onCommit)`  
  Bites at: crosses the 10 s block interval at ~5-10k accounts within the first weeks, and at ~2-3k accounts after a few months of history  
  Fix (medium): Three parts: (1) add an index on transaction_log(reference_id, change_type) so the idempotency probe stops scanning the whole mint bucket; (2) actually call pruneChain and extend it to cycle reference ids, or stop writing one log row per account per point type per day and record a single day-level event instead; (3) move the cycle off the commit callback (or chunk it across blocks) so a slow cycle cannot freeze consensus, the API, and the P2P layer at once.

- **[HIGH / network] Unauthenticated peer-list injection poisons the address table without bound and triggers a dial storm every 30 seconds**  
  Where: `ae-node/src/network/peer.ts:302-311, ae-node/src/network/discovery.ts:61-72, ae-node/src/network/discovery.ts:90-122`  
  Bites at: now — a single unauthenticated message; harm scales with the size of the list the attacker sends  
  Fix (medium): Gate `peers` and `get_peers` behind `isAuthenticatedSender` like every other non-handshake type. Cap the injected list length (e.g. 50 entries), validate `host` against an IP/hostname pattern with a length bound, cap `knownAddresses` with LRU eviction, and prefer seed/self-observed addresses over gossiped ones. Fix the loop-invariant break in `maintainConnections` by recomputing `getPeerCount()` inside the loop, and bound outstanding dials per tick.

- **[HIGH / network] Pre-handshake sockets are unlimited and untimed, and a single recorded `ping` packet can be replayed to pin the node's CPU**  
  Where: `ae-node/src/network/node.ts:224-229, ae-node/src/network/peer.ts:245-267, ae-node/src/network/peer.ts:386-389, ae-node/src/network/messages.ts:106-123`  
  Bites at: now for the replay/CPU path; the 100 MiB frame and connection-count paths bite as soon as the node is on a public address  
  Fix (medium): Set `maxPayload` on the `WebSocketServer` to a few hundred KB (the largest legitimate message is a 100-block sync reply, so size that explicitly). Add a handshake deadline (close any socket that has not completed `addPeer` within a few seconds) and a cap on concurrent pre-handshake connections, plus a per-IP connection limit. Reject any non-`handshake` message type on a socket that has not handshaken, before `parseMessage` runs, so unauthenticated signature verification is impossible. Add a freshness window and a per-peer rate limit to `verifyMessage`/`ping` so one captured packet cannot be replayed indefinitely.

- **[HIGH / app-surface] Unauthenticated GET /accounts/:id/share-history does a full-table scan plus a 365x all-accounts loop, blocking the consensus event loop**  
  Where: `ae-node/src/api/routes/accounts.ts:237-320 (query at :258 and :268-273, loop at :303-312)`  
  Bites at: now — measurably degraded at 2,000 accounts (186ms/request measured), node-halting at ~10,000, which is the stated Phase 1 ceiling  
  Fix (medium): Two changes, both small. (1) Bound the work: cap the account scan and the log query (e.g. restrict the log SELECT to the 365-day window and index on timestamp), or precompute a daily share snapshot table and serve it. (2) Fix the rate-limit key so GET routes are actually throttled per account — either move `rateLimitMiddleware()` inside each router after params are bound, or key on a path segment parsed from `req.path` instead of `req.params`. Adding `authMiddleware(db)` and restricting the endpoint to the account's own history would also remove the anonymous vector, though it does not fix the cost.

- **[HIGH / app-surface] GET /court/jury-duty/:accountId returns a juror's vote unauthenticated, defeating the sealed-vote rule the case-detail endpoint enforces**  
  Where: `ae-node/src/api/routes/court.ts:308-345 (SELECT at :313, `myVote: r.vote` at :333)`  
  Bites at: now — any case with more than one juror, on any network size  
  Fix (small): Gate `GET /court/jury-duty/:accountId` behind `authMiddleware(db)` and reject when `req.accountId !== req.params.accountId` (the pattern already used for `/cases/:id/escalate`, court.ts:161-166). Since it is a GET and this API's auth envelope travels in a signed body, either convert it to a signed POST like `/miners/vouches/:id/withdraw` was, or null out `vote`/`votedAt` in the response for any case whose jury has not fully voted. Also stop emitting `jurorAccountId` in `GET /court/cases/:id` until `allVoted` is true.

- **[MEDIUM / consensus] Two validators that dial each other within one RTT both tear down both sockets and lose the peer entirely for at least 30 seconds**  
  Where: `ae-node/src/network/peer.ts:464-515 (addPeer, esp. 493-500) and peer.ts:215-230 (outbound close handler)`  
  Bites at: now for any deployment where two nodes list each other as seeds and restart together; also on every network-blip-induced simultaneous reconnect.  
  Fix (medium): Make the duplicate-connection tiebreak deterministic and identical on both sides instead of arrival-order dependent: in addPeer, when a second socket appears for a nodeId already connected, keep the connection whose (lower publicKey hex) node is the dialer — both sides compute the same verdict from data they already have, so exactly one socket is closed. Add jitter to discovery's reconnectInterval (e.g. 30s ± 30%) so simultaneous redials do not stay in phase, and shorten the first retry after a total peer loss.

- **[MEDIUM / consensus] A validator that commits a block it has no stashed content for advances its consensus height without applying the block, and can then write a permanent hole in its own chain**  
  Where: `ae-node/src/core/consensus/BftBlockProducer.ts:698-705`  
  Bites at: N>=4 validators, on the first dropped or clock-rejected block-content gossip. Not reachable at N=3, where quorum equals N.  
  Fix (medium): Make the missing-stash case a hard error rather than a silent return: throw from BftBlockProducer.onCommit when the payload is absent so BftDriver's existing fail-stop (bft-driver.ts:511-517, onApplyFailed) engages and the node halts loudly instead of skipping a height. Better still, add a 'fetch block by hash' request to the peer protocol and block the commit on retrieving the content. Independently, add a contiguity assertion in SqliteBlockStore.insert (reject a non-genesis block whose number != current max + 1 or whose previousHash != current head hash) so a gap can never be written, and re-anchor BftDriver.currentHeight from the persisted chain head after any commit that did not apply.

- **[MEDIUM / crypto-auth] Per-account write rate limit is keyed on an unauthenticated body field, so anyone can lock any account out of all writes**  
  Where: `ae-node/src/api/middleware/rateLimit.ts:53-57`  
  Bites at: now - single attacker, single IP, any known accountId  
  Fix (small): Move the per-account bucket behind authentication: let authMiddleware set req.accountId, then apply the account-scoped limiter as router-level middleware after it so only verified signers consume an account's quota. Keep the IP limiter app-wide as the pre-auth defense, and add a separate tighter IP-keyed counter for requests that fail auth so unauthenticated write attempts throttle on the attacker's own key rather than the victim's.

- **[MEDIUM / scale] computeStateRoot does a full accounts scan and builds one giant string 3-4 times per block, for a value the code itself says is diagnostic only**  
  Where: `ae-node/src/core/state-root.ts:77-107`  
  Bites at: noticeable around 50k accounts, breaks round timing at ~100k, hard chain halt around 1M  
  Fix (medium): Compute the root once per height at commit and reuse the cached value in the vote gate instead of recomputing per prevote/precommit; move the computeStateRoot call inside dryRunTransactions so it shares the existing per-block-hash cache. For real scale, replace the full scan with an incremental accumulator or Merkle tree updated only for the accounts a block touched, or sample it every Nth block while it remains diagnostic.

- **[MEDIUM / operations] A validator whose machine dies permanently cannot be removed, and the docs overstate fault tolerance by one validator**  
  Where: `ae-node/src/core/consensus/SqliteValidatorSet.ts:116-124`  
  Bites at: now — any 2- or 3-validator network, on the first permanent hardware loss  
  Fix (large): Two parts. (1) Correct docs/running-a-node.md: the first fault-tolerant size is four validators, not three. (2) Add an operator-usable removal path that does not require the dead validator's key — either downtime-based deactivation (count consecutive heights with no precommit from a validator and emit a deregister validatorChange from the proposer), or a documented, tested emergency procedure to rewrite the validator set on every surviving node plus the matching validator-set snapshot row, so historical cert verification still resolves the right set.

- **[MEDIUM / app-surface] Wallet's recurring-transfer edit form is in base units on read and display units on write, so any edit silently divides the transfer by 100,000,000**  
  Where: `ae-app/src/pages/Recurring.tsx:110 vs :145 and :323`  
  Bites at: now — first time any user edits an existing recurring transfer  
  Fix (small): In Recurring.tsx:323 seed the input from `baseUnitsToExactDisplay(String(t.amount))` (the exact-display helper already in ae-app/src/lib/formatting.ts), and in handleSaveEdit:145 send `Number(toBaseUnits(editAmount))`, matching handleCreate:110; update the optimistic setState at :150 to store the base-unit value. Server-side, add `validateBody` to `PUT /recurring/:id` with the same `baseUnitAmount` regex the transaction schema uses so a display-unit write is rejected rather than stored.

- **[LOW / scale] Rebase crash-resume is O(n^2): getAllAccounts() is called inside the per-account loop**  
  Where: `ae-node/src/core/day-cycle.ts:290-295 (inside runTransaction opened at :286)`  
  Bites at: painful at ~10k accounts (minutes), effectively unrecoverable at ~100k (hours)  
  Fix (small): Build the lookup once outside the loop: `const fresh = new Map(getAllAccounts(db).map(a => [a.id, a]))` before the `for`, then index into it. Better still, skip the full reread and select just earned_balance and locked_balance for the one account id.

- **[LOW / app-surface] Contacts and recurring-transfer rows are write-protected by ownership checks but readable by anyone who knows an account id, which the search endpoint hands out**  
  Where: `ae-node/src/api/routes/contacts.ts:35-43 and :111-121`  
  Bites at: now — it is cheaper the smaller the network, since fewer prefixes cover everyone  
  Fix (small): Put the same ownership predicate on the reads that already guards the writes: convert both list endpoints to signed requests (`authMiddleware(db)` plus `req.accountId === req.params.ownerId/accountId`), following the signed-POST pattern the codebase already uses for `/miners/vouches/:id/withdraw` where a GET body was not workable. Separately, drop `earned_balance` from the `/contacts/search/accounts` projection — the search UI only needs id, type and percent_human — and require a longer prefix to blunt enumeration.


### Refuted, recorded so they are not raised again

- The chain-driven day cycle settling court and panel deadlines from
  `Date.now()` rather than the block timestamp.
- Validator restart losing its Tendermint lock and producing self-slashing
  evidence.
- Version skew being ungated in the P2P handshake and the schema initializer.

### Audit status (court + verification panels)

A multi-agent audit with an adversarial refute stage confirmed **14 defects in
court money paths** plus **4 in verification panels**. Every one below was
reproduced against the real modules, not inferred.

**Fixed and pinned by tests**

- Court stakes now rescale with the daily rebase (`rebaseCourtStakes`, called
  from `rebase()`). Correction to an earlier assumption of mine: a down-rebase
  is **the steady state, not an edge case** — `rebase()` sets the pool to
  exactly `targetTotal`, and spending converts minted active points into
  recipients' *earned* balances, so `preRebaseTotal` exceeds `targetTotal` on
  any day the network transacts at all. With 7-day arbitration and 7-day voting
  windows, every case crosses at least one rebase. `court-rebase-stakes.test.ts`.
- `updateBalance` refuses to write a negative balance. This whole class used to
  land silently: the column is TEXT, so `-14744000000000` reads back as a valid
  bigint and feeds `totalEarnedPool()`, shrinking the next day's rebase
  denominator and perturbing **every other account on the network**. It also
  dragged `rebalanceVouchLocks`'s `totalHoldings` down, under-collateralising
  every vouch that account backed.
- Free challenges rejected (`court-free-challenge.test.ts`); defendant excluded
  from their own jury; one-juror juries refused; stalled cases dismissable via
  `dismissStalledCase`, returning the stake and lifting escrow
  (`court-jury-seating.test.ts`).
- Vouch-then-withdraw is no longer a free score ratchet. **This one was mine**,
  introduced earlier the same day implementing WP §7.2. `createVouch` never
  raises `percentHuman` (only a completed panel writes it) and vouching needs no
  consent, so an unconditional subtraction on withdrawal was pure downward
  pressure at zero cost: verified attack taking a victim 100 → 75 → 50 → 25 → 0
  in four round trips with the attacker's balance unchanged, leaving them
  burning 100% of every daily-point spend. The drop now applies only when the
  vouch predates the panel that set the score, so it could actually have counted
  toward it. `vouch-withdraw-ratchet.test.ts`.

**Also fixed since**

- **Deadlines are enforced.** `arbitration_deadline` and `voting_deadline` were
  written at filing and seating, returned by the API and rendered in both apps,
  and no code anywhere compared them to a clock. Nothing expired, so one juror
  who never voted froze the case, the defendant's escrowed balance and every
  juror's stake permanently — `resolveVerdict` throws `NO_VOTES` on an empty
  set, and with a partial set nothing called it at all. `expireCourtDeadlines`
  now runs at the top of `runExpireAndRebase`, *before* the rebase, so a case
  already over settles against the balances it was decided on. Votes cast →
  resolve on those votes (silent jurors forfeit their say, not the case); no
  votes, or no jury ever seated → dismiss neutrally, stake returned in full and
  escrow lifted, because the network failing to produce jurors is nobody's
  fault. `court-deadlines.test.ts`.
- **A verdict resolves exactly once.** Every payout in the settlement is an
  unconditional balance move, so a second `resolveVerdict` burned the defendant
  twice, paid the bounty twice, and unlocked juror stakes already unlocked —
  reachable from an HTTP retry. Same guard on `resolveAppeal`.
- **Appeals settle through the appeal path.** The vote route called
  `resolveVerdict` for every case, so `resolveAppeal` had *zero* production
  callers and a reversal never reopened the defendant's account or clawed back
  the bounty. New `resolveCase` dispatches on `level`; every call site uses it.
  `court-appeal-routing.test.ts`.
- **Panel scores are whole numbers, and final.** An odd-sized panel took
  `sorted[mid]` verbatim, so a miner submitting `87.5` wrote `87.5` into
  `percent_human` — SQLite stores a real in an INTEGER column happily. Every
  daily-point spend then calls `BigInt(percentHuman)`, which throws `RangeError`
  on a non-integer, permanently bricking that account's ability to spend with
  the error surfacing nowhere near its cause. Now rejected at input, and the
  median rounds on both branches for rows written before the check existed. A
  completed panel also refuses further scores; a late miner used to recompute
  the median and silently rewrite a published verification.
- **The duplicate-account counterpart is excluded from the jury**, alongside the
  defendant and challenger.

- **Panel deadlines are enforced, and doing the work now counts.**
  `mining.verification_deadline_hours` (72 by default) was stamped on every
  assignment and never read — `markAssignmentMissed` had no production caller.
  One assigned miner who never opened their queue stranded the applicant
  permanently, and the symptom looked like nothing happening rather than an
  error: a panel completes when `scores.length >= assignedCount`, an assignment
  never marked missed keeps counting toward `assignedCount` forever, and a miner
  who never reviews never contributes a score. The applicant sat at their
  existing percentHuman, which for a new joiner is zero, so every spend burned.
  `expireOverdueAssignments` now runs in `runExpireAndRebase` beside the court
  sweep, and `getAssignedCount` counts only live assignments.

  Writing the test surfaced a second one: **`markAssignmentComplete` had no
  production caller either**, so submitting a score never closed the assignment.
  Every miner's `countMinerAssignmentsCompleted` — the number their reliability
  is judged on — stayed at zero no matter how many panels they reviewed.
  `submitPanelScore` now closes it. `panel-deadlines.test.ts`.

**Still open**

1. ~~**`phase64`'s conservation assertion cannot catch minted value.**~~ Fixed.
   The guilty path over-credited spendable `earned` while the shortfall parked
   in negative `locked`, and the test summed the two, so the errors cancelled
   exactly and the suite stayed green over genuinely minted value. It now
   asserts per column, plus a direct `negativeHolders()` check. The code hole
   was already closed by `updateBalance` rejecting negatives; this closes the
   *assertion shape* that let it hide. **Worth generalising: a conservation
   test that sums across columns can only catch errors that do not cancel.**
2. **Court and panel state is still node-local** — the point below about state
   not being a function of the chain applies to everything in this section. The
   fixes above make each node behave correctly; they do not make two nodes agree.

### The dominant defect shape: code that exists and is never called

Six defects in this audit were all the same thing — an exported function that
exists, is correct, has passing unit tests, and which no production code ever
reaches: `withdrawVouch`, `resolveAppeal`, `markAssignmentMissed`,
`markAssignmentComplete`, `finalizeSupportiveTags`, `finalizeAmbientTags`.

`tests/no-orphan-exports.test.ts` now enforces this automatically: it walks
`src/`, finds every `export function`, and fails if nothing in `src/` references
it. New orphans break the build. Existing ones are baselined in `KNOWN_ORPHANS`
with a reason each, and **removing an entry from that list is the definition of
done** for the item.

**The guard does not catch the harder variant, and that variant has now bitten
twice.** Where a second caller exists but does *less* than the first, the
function is referenced, so the orphan check passes:

- `applyChainDayCycle` — called on the BFT commit path, absent from the sync
  path. Result: a new node could not join any chain that had been used.
- `commitBlockSideEffects` — present on both paths, but the sync path lacked
  everything the commit path did around it.

Both are "two paths that must agree, and only one does the work." Worth a guard
of its own: any function called from the commit path should probably be called
from the sync path too, and the diff between those two functions is a review
checklist in its own right.

Running it for the first time found **34 orphans**. Most are benign (client-side
signing, operator helpers, dead code superseded by `db/schema.ts`). These are
not — each is a white-paper mechanism that does not happen on a running network:

- ~~**`fileAppeal`**~~ **FIXED.** No route filed an appeal, so the entire appeal
  system was unreachable from both apps — a verdict was final regardless of what
  the white paper says, and the appeal settlement fixed earlier could never run
  because nothing could create an appeal to settle. New
  `POST /court/cases/:id/appeal`.

  `fileAppeal` checks that the case is appealable but says nothing about **who**
  may appeal, so standing is enforced in the route: only the losing party has it
  (guilty → the defendant's to appeal, innocent → the challenger's). Without
  that, either side could appeal a result they won, or an uninvolved account
  could drag a settled case back open. `court-appeal-route.test.ts` covers the
  winner and the stranger both getting 403.
- **`runDecayForAll`** — **DO NOT WIRE THIS UNTIL IT IS REDESIGNED.** Decay
  never runs, so the white paper's "scores decay 10% per 30 days without
  activity" does not happen. But wiring it as written would be far worse than
  leaving it off, and this was measured, not reasoned about:

  ```
  account joined day 1, percentHuman 100, no inactivity
    after day-cycle run 1: percentHuman = 26
    after day-cycle run 2: percentHuman = 7
    after day-cycle run 3: percentHuman = 5
  ```

  Two compounding mistakes. It passes `daysSinceJoin` where `applyDecay`
  expects `daysSinceActivity`, so a long-standing **active** account is treated
  as having been idle since the day it joined. And `applyDecay` recomputes the
  full decay from that number on every call rather than applying only the
  periods elapsed since the last run, so the same 13 windows are re-applied
  daily. `periods = floor(399/30) = 13`, `score × 0.9^13 ≈ 25%`, every single
  day.

  Since `percentHuman` is the multiplier on every daily-point spend, running
  this on a live network would take the entire population to ~5% within three
  day cycles — 95% of everyone's spending burning — while looking like a
  correctly-scheduled maintenance job.

  A correct version needs a real last-activity signal (the transaction store
  has no `lastActivityAt`; it would have to be added) and a
  `decayed_through_day` marker on the account so each run applies only new
  periods. That is a schema change plus a redesign, not a wiring job.
- ~~**`recordHeartbeat`** / **`cleanOldHeartbeats`** / **`evaluateMinerTier`**~~
  **FIXED — the miner incentive system now has feedback.** `recordHeartbeat`
  carried a comment saying "the protocol records a heartbeat every block" and
  nothing called it, so `countHeartbeatsSince` always returned 0 and
  `calculateUptime` always returned 0%. Uptime was not a low number, it was an
  unmeasured one — and the tier-1 threshold is 90%, so nobody could ever meet
  it. `evaluateMinerTier` then had no caller either, so a tier was whatever it
  was at registration, permanently.

  New `POST /miners/heartbeat` (auth-gated, 60s cadence to match
  `mining.heartbeat_interval_seconds`); a miner here is an API client rather
  than necessarily a validator, so the honest signal is the client saying it is
  available, not something inferred from block production. New
  `runMinerTierEvaluation` runs once per day cycle over every active miner,
  with per-miner failures contained so one bad row cannot stop the network's
  rollover, and prunes heartbeats past twice the rolling window — the table is
  append-only at one row per minute per miner, roughly 525k rows per miner per
  year, and nothing pruned it. `miner-tier-heartbeat.test.ts` covers demotion
  for going dark, promotion on merit, and the pruning.

  Worth stating plainly: tier 2 is who gets seated on juries, so while this was
  inert, jury composition never reflected conduct.
- ~~**`applyAccuracyImpact`**~~ **FIXED, and it hid a second bug.** Wiring it
  into `resolveVerdict`'s guilty path was not enough, because
  `getVerificationAccuracy` was a stub that returned 100% for every miner
  unconditionally:

  ```ts
  // For now, every completed verification counts as correct. Phase 5 (court)
  // retroactively decrements this when fraud is found.
  const correct = completed;
  ```

  Nothing ever did. `applyAccuracyImpact` writes a court-contradicted
  verification back with `missed = 1`, and that flag was never read — so a
  miner who waved through fraudulent accounts kept a perfect record and could
  never be demoted no matter how many of their calls the court overturned. Now
  counts `completed AND NOT missed` via `countMinerAssignmentsCorrect`.
  `court-accuracy-impact.test.ts` proves a tier-2 miner who passed an account
  the court finds guilty loses tier 2, and that being right costs nothing.
- **`claimInheritance`** — inheritance cannot be claimed.
- **`setPolicy`** — verification policy cannot be changed at runtime.
- **`linkManufacturer`** — products cannot be linked to a manufacturer, which is
  how supportive points are supposed to reach a maker.
- **`distributeFees`** / **`distributeFromFeePool`** — needs checking against
  `commitBlockSideEffects`, which may do fee distribution by another path.

Smart contracts (`createSmartContract`, `overrideContract`,
`resetDailyOverrides`) are already documented elsewhere as a placeholder, so
those are expected.

This list is the honest answer to "how much of the white paper actually runs?"
The consensus, transaction, tagging and court paths do. Several of the
incentive and accountability mechanisms are written but inert.

### Original repro notes (superseded by the audit above)

An audit agent left a repro harness in the repo. Running it reproduced **six**
distinct defects. These are real, observed outputs, not model claims. One is
fixed; five are open and none has a test yet.

**FIXED — free challenges froze anyone's money.** The court stake is a
percentage of the challenger's *own* earned balance, so a challenger holding
zero staked zero, and the guard above it (`stakeAmount > earnedBalance`) passed
because `0 > 0` is false. Filing escrowed the defendant anyway. Observed:
`stake locked by broke challenger: 0`, `defendant is_escrowed: true`. A
zero-cost, repeatable freeze on any account's earned balance — register as a
miner (the first miner on a fresh network needs no percentHuman), hold nothing,
and deny someone their money. `fileChallenge` now rejects a stake of zero.
`tests/court-free-challenge.test.ts`.

**OPEN 1 — the daily rebase drives locked balances negative.** Court stakes are
stored as a nominal amount at selection time, but `rebase` scales
`locked_balance`. After a down-rebase the stored stake exceeds what is actually
locked, and the verdict subtracts it anyway. Observed: 12 accounts with
negative balances, e.g. `locked= -14744000000000`. Negative balances are supply
corruption and every downstream sum is then wrong. Vouches already solve this
with `rebalanceVouchLocks`; court stakes have no equivalent.

**OPEN 2 — the same rebase strands locked value forever.** With an up-rebase the
opposite happens: juror stake stored 25,000,000,000, locked after rebase
2,318,823,529,411, and after the verdict 2,293,823,529,411 — it should be 0.
That value is locked with nothing left to release it.

**OPEN 3 — a case with too small a jury pool freezes the defendant forever.**
With one tier-2 miner: `jurors seated: 0`, status stuck at
`court_waiting_jury`, `defendant escrowed: true`, challenger stake still
locked, and re-running `escalateToFull` throws `Can only escalate from
arbitration`. No other route re-runs `selectJury`, so the case, the escrow and
the stake are permanently stuck.

**OPEN 4 — the defendant can be seated on their own jury.** Observed:
`defendant minerId in jury? true`. They vote on their own case.

**OPEN 5 — zero-balance tier-2 miners are silently skipped, producing a
one-juror "jury".** Pool of 3, `jurors actually seated: 1`, and the case
advanced to `court_voting` regardless. A single juror then decides a verdict
that burns 80% of the defendant's balance.

Common threads worth fixing at the root rather than one at a time: court stakes
are not rebase-aware (1 and 2), and jury selection reports success without
checking that it actually seated a viable jury (3, 4, 5).

### The verification panel has nothing to verify (architectural)

The miner's review screen is the core of a proof-of-human network, and it shows
the reviewer a raw evidence type id and twelve characters of a SHA-256 hash.
There is no selfie, no ID, no video — **the protocol stores only
`evidence_hash`, never the artefact** (`ae-node/src/verification/evidence.ts`).
A miner cannot inspect what they are attesting to, because nothing was kept.

Mitigated in the UI, not solved: evidence types now render human-readable
names, the screen states plainly that these are commitments rather than
evidence, and the score no longer arrives pre-filled at 80 with the submit
button live — a miner had been able to pass a stranger as human in one click
having looked at nothing. `Verify.test.tsx` pins the no-default rule, because
that "convenience" is exactly the sort that creeps back.

Solving it properly is a protocol decision, and a privacy-sensitive one. The
options are roughly: store encrypted artefacts the assigned panel can decrypt
and nobody else; keep artefacts off-chain with the hash as the on-chain
commitment and a separate retrieval channel; or accept that miners judge
metadata plus vouches and design the scoring around that honestly. Today the
code implies the first and implements the third.

### Roadmap: protocol features, not scheduling or UI work

These are not bugs. Each needs a protocol capability that does not exist yet, so
none can be closed by wiring up what is already there.

**Scheduled transfers need a signed standing mandate.** The recurring-transfer
executor lives in the wallet (`ae-app/src/lib/recurring.ts`) and fires only
while the app is open. That is a constraint, not laziness: every transaction
carries an ML-DSA signature made with the user's private key, the node does not
hold that key and must never hold it, and `recurring_transfers` rows are not
replicated between nodes — so a node-side scheduler would have to either forge
an unsigned transfer or move balances from state its peers cannot see.

For points that expire every 24 hours, "only fires when you open the app" is a
real limitation. Closing it properly means a **signed standing mandate**: the
user signs an authorisation once ("up to N points/day to account X until I
revoke"), it rides on-chain like a validator change, and any node can execute
against it without ever holding the key. That is a new operation type with its
own canonical bytes, replay rules and revocation path.

**Internationalisation is a picker with nothing behind it.** Both apps ship 12
locale files (`src/locales/`), both depend on `i18next`, both render a language
selector — and there are **zero `t()` calls in either app**. Every visible
string is hardcoded English. `More.tsx` and the miner `Sidebar.tsx` call
`i18n.changeLanguage()`; nothing reads the result. A user picks Español and the
app stays entirely in English.

Same defect shape as the orphaned exports: translations written, picker built,
wiring never done. Scope is 43 components across both apps. Sequence matters —
do the copy pass FIRST, then extract and wire, or you translate strings you are
about to rewrite. Until then the picker promises something the app cannot
deliver and should be hidden.

**Displayed amounts need an audit, not a spot fix.** The activity list showed
received transactions using `amount` (what the sender paid) rather than
`netAmount` (what arrived). Those differ on every transaction from a
partially-verified sender, because the percentHuman discount burns the
difference — so every incoming payment in a user's history was overstated.
Fixed in Wallet.tsx and TransactionDetail.tsx.

The lesson generalises: `amount`, `fee`, `netAmount` and the implied burn are
four different numbers, and which one is correct depends on whose screen it is.
Every surface showing a transaction amount needs checking against that question,
including History.tsx, the explorer, and anything added later.

### Open blockers (not fixed, ordered by severity)

0. **Joining a network requires replaying every block.** The 10s interval makes
   the chain grow 4x slower; it does not remove the wall. A node that falls far
   enough behind can never catch up, and the threshold tightens as the chain
   grows — the one problem here that gets strictly worse with time. Snapshot
   sync is the fix, and `computeStateRoot` is already the piece that makes it
   trustworthy. See "Sync does not scale" above. Cheap at 30k blocks, a
   migration at 30M.

1. **The state root is diagnostic, and must stay that way for now.** It travels
   in the gossip payload and receivers compare it, but it does not gate a vote
   and is not folded into `computeBlockHash`.
   That is a correctness requirement, not a shortcut, and the first version of
   it got this wrong. Account rows legitimately appear on different nodes at
   different moments: gossip reaches peers that are online, and the on-chain
   registration reaches everyone else only when a block carrying it commits, so
   two honest nodes hold different roots for a while. Voting NIL on that
   deadlocks the chain — a node that missed the gossip rejects every block,
   including the one carrying the registration that would fix it, failing
   exactly where the replication work is supposed to help. Caught before it
   reached a real network; pinned by "two honest nodes legitimately differ
   while a new account propagates" in `tests/state-root.test.ts`.
   Enforcement lives in the pre-vote dry run, which asks the question that
   actually matters (can this node apply this block?) and distinguishes "you
   reference an account I have never heard of" from "I am seconds behind on
   registrations".
   Making the root enforceable is a genuine follow-up, in this order: first
   make account state a pure function of the chain (registrations are on-chain
   as of v13, but gossip still front-runs them), then fold a `stateRootHash`
   into `computeBlockHash`. Doing it in the other order just moves the deadlock
   into hash verification.
2. ~~**Platform-server is not shipped with the app.**~~ Fixed. `ae-app`'s
   `extraResources` now copies `platform-server/dist`, `package.json` and
   `node_modules`, and `electron/main.cjs` spawns it on :3500 alongside
   ae-node, killing it on `window-all-closed` and `before-quit`. Started
   fire-and-forget and NOT health-polled: self-custody works without it, so
   blocking startup on an optional service would turn it into a hard
   dependency, which is the opposite of the bug.

   **What this does not do, and the UI now says so.** Running the service on
   localhost gives email + password unlock and a local encrypted vault. It does
   not give what an email/password screen implies: the vault is on that
   machine, so there is no signing in from a second device and no recovery
   after the computer is gone, and `AE_PLATFORM_EMAIL_MODE` is `dev` because no
   SMTP credentials ship with an installer. The signup screen now states
   plainly that the account lives on this computer and points at the 12-word
   self-custody path for anyone who wants real portability. Making it a genuine
   hosted service is a deployment task (stand up an instance, set
   `VITE_PLATFORM_URL` at build time, skip the spawn), not a code one.
3. **Vouching, court and panel scores still mutate state at API time.** See the
   state-mutation audit section above. This is the same root cause as blocker 1:
   until every balance and `percentHuman` write is a function of committed
   blocks, the state root cannot be enforced. The
   `POST /miners/vouches/:id/withdraw` route adds one more such writer,
   consistent with `createVouch` beside it but moving the wrong way.

### Remaining after the Sept 3 audit: the large four

Four confirmed findings were deliberately NOT fixed this session, because each
is a large, correctness-critical change that must be built and validated as its
own unit (the way the deadlock fix was), not rushed inside a sweep. The interim
mitigations already applied are noted.

**The validation path now exists.** The blocker for the #4 / #16 cluster was
never the code, it was that nothing could prove a cross-node determinism change
correct. That gap is closed:
- `scripts/test-lan-multi-validator.mjs` now submits a real transfer between
  validators, confirms every node credits the recipient identically, and
  asserts all nodes agree on the recorded state root (not just the block hash,
  which never covered account state - the blind spot that hid these findings).
- `tests/tx-replay-determinism.test.ts` pins the same property fast and in CI:
  two independent node databases replaying one transaction reach identical
  state roots.
So the way to build the cluster safely is: extend the LAN harness to trigger a
percentHuman change (a vouch, then a panel) across nodes and require the roots
to still converge; make the change fail that assertion first (node-local write),
then chain-order the operation until it passes. That is a red-green loop now,
not a leap of faith.

1. **percentHuman and value are not chain state (#4, critical) and neither are
   tags (#16) — the "state must come only from the chain" cluster.**

   **Progress: vouch operations are now chain-ordered (commit d11ea11 + 9ad4b74).**
   A vouch moved the voucher's locked balance (and, on withdrawal, the vouched
   account's percentHuman) node-locally, forking the ledger. Vouch create and
   withdraw now ride a block as signed operations - deterministic id, block
   timestamp, folded into the block hash, applied at commit on every node -
   mirroring account-registration/validator-change. The wallet and miner sign
   the op client-side. Proven by tests/vouch-operation-determinism.test.ts and
   the 3-validator LAN test (which now submits a vouch and requires the locked
   balance + state root identical on all three nodes). Use
   verification/vouch-operation.ts as the template for the rest.

   **Progress: miner registration is now chain-ordered too (commit 9779063).**
   Register/deregister ride a block as signed operations (deterministic id +
   timestamp), gossiped for fast inclusion, applied at commit - so the active
   miner set (fee split, lottery, panel assignment) is identical on every node.
   The 3-validator LAN test now converges after a transfer, a vouch, AND a miner
   registration. See mining/miner-operation.ts.

   **Progress: verification panels are now chain-ordered too (this session).**
   Panel completion (median of the miner scores -> percentHuman) was the LAST
   node-local writer of percentHuman. A panel_create op (signed by the applicant)
   and panel_score ops (signed by each scoring miner) now ride a block as signed
   operations - deterministic panel id / review id, block timestamp, folded into
   the block hash, applied at commit on every node. Completion is deterministic:
   at creation each panel snapshots a fixed `target_reviews` = min(panel_size,
   active miner count) from chain state (the miner set is chain-state now), and
   the panel completes at the block where the applied score count first meets that
   target, writing the same median -> percentHuman on every node. See
   verification/panel-operation.ts (schema v19). Proven by
   tests/panel-operation-determinism.test.ts (two nodes reach identical
   percentHuman) and the 3-validator LAN test, which now creates a panel, has the
   registered miner score it, and requires percentHuman to converge to the same
   value on all three nodes. Design notes: FIFO juror assignment and
   conflict-of-interest are no longer a consensus step - any active miner may
   score any open panel (except their own); the miner "assignments" endpoint now
   returns open panels. Deterministic FIFO assignment + a deadline-driven
   completion sweep (so a short-staffed panel finishes with whoever showed up -
   the `deadline` column is written now for it) are the two documented follow-ups.
   The legacy node-local `createPanel`/`submitPanelScore` in verification/panel.ts
   are kept ONLY for their semantic tests and are marked do-not-wire.

   **With panels done, percentHuman is now a pure function of the chain** (the
   three writers - vouch withdraw, panel completion, and unwired decay - are all
   chain-driven or dormant). That was the sole blocker for the #4 value fix: the
   next step is to re-derive transaction value locally in replayTransaction /
   acceptPendingTransaction and reject a wire mismatch.

   **Remaining in the cluster:** tags (#16), then re-derive transaction value to
   close #4 (now unblocked). This is one
   architectural change, not several. `replayTransaction` /
   `acceptPendingTransaction` take `fee` / `netAmount` off the wire and apply
   them verbatim; only `processTransaction` on the origin node re-derives them
   from the sender's `percentHuman`. So a crafted transaction can claim full
   value for a 0% sybil and every other node applies the inflated number. The
   truly-unlimited case (crediting MORE than the sender spends) is already
   blocked: accept/replay enforce `netAmount + fee <= amount`. What remains is
   discount evasion - an unverified account's daily allocation, which should
   burn entirely at 0%, delivered as real value instead. Bounded by daily-mint x
   sybil-count, so serious at scale, not literally infinite. The reason the code
   trusts the wire is that `percentHuman`
   itself is node-local (written by `verification/panel.ts` from a REST call),
   so re-deriving locally would make honest nodes disagree and FORK. Both halves
   only become safe once `percentHuman`, miner status, and tag submissions are
   chain-ordered, replicated operations — the same pattern `AccountRegistration`
   already uses (schema v13): a signed op, a pending queue drained by the
   proposer, a hash folded into `computeBlockHash`, applied deterministically at
   commit on both the live and sync paths. Do that, then re-derive value locally
   and reject wire mismatches. Interim already in place: the daily mint no longer
   reads node-local miner state, miner iteration is ordered, and the fee pool is
   in the state root so this class of drift is at least visible. Do NOT ship the
   "re-derive and reject" half before percentHuman is replicated — it trades the
   mint exploit for a chain halt.

2. **State root stays diagnostic (blocker 1 above).** Same root cause as the
   cluster above and blocked on the same work: fold a state-root hash into the
   block hash only AFTER account state (registrations, percentHuman, tags) is a
   pure function of the chain, or the deadlock moves into hash verification.

3. **Full domain separation of the signing scheme (#3).** The interim guard
   rejects a transaction-shaped payload at the auth layer and signatures are no
   longer published, which closes the demonstrated exploit. The complete fix
   binds a per-purpose domain tag (and ideally accountId + method + path) into
   the signed bytes, in the node AND both apps in lockstep. It is ~30 signing
   call sites across ae-app/ae-miner that must move together; safe to do, but it
   needs the apps built and exercised, so it belongs in a session that can run
   them, not a node-only sweep.

4. **Validate-before-relay for gossip (#9).** Bans now expire, so one bad block
   no longer permanently partitions the network. The remaining half: relay a
   block only after it passes `validateIncomingBlock`, and attribute a bad block
   to its signed producer identity rather than the relay hop, so a relayer is
   never punished for forwarding. Touches the block:received emit contract.

Lower-priority, not blocking: `computeStateRoot` is O(accounts) and now runs each
commit (#26) — fine below ~50k accounts, wants an incremental accumulator or a
cache-per-height before then; the share-history endpoint still needs its per-day
snapshot table for the distinct-id flood case (#12).

### Real multi-node check

`node scripts/test-lan-multi-validator.mjs` was run after all of the above and
passes: three real ae-node processes, peered over WebSocket, ran BFT to height
20 and converged on byte-identical block hashes
(`16ce6c9e56a805dc…` on all three). That exercises the fail-stop, the pre-vote
dry run, the state-root check and the on-chain registration path together, in
separate processes, rather than in-process fixtures. Worth re-running after any
further consensus change — it is ~80 seconds and it is the only check that
covers the seams between nodes.

**Run it several times, not once.** Even with the teardown fixed it is ~4/5, so
a single pass proves little and a single failure proves less. Compare a run of
5 against a run of 5 with the change reverted; that is the only way today to
tell a real regression from the residual flake. Any result recorded before the
teardown fix (September 2) should be treated as noise.

**Operator lessons from real multi-machine bring-up**, none of which were code
bugs but all of which cost hours:

- Windows marks a new network **Public**, and a firewall rule scoped to Private
  silently does not apply. The node looks healthy and peers simply never
  connect.
- A machine's LAN IP changes between networks, and `AE_SEED_NODES` is a
  hardcoded address. Nothing logs "the address you were told to dial no longer
  exists." Set DHCP reservations.
- Mismatched code between machines fails block validation and earns a ban. Both
  nodes must be on the same commit — check with `git log --oneline -1` before
  debugging anything else.
- `genesis.json` and the database are a matched pair. Regenerate one and the
  other must be deleted; the node refuses to start otherwise and says so
  clearly.

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

### Decided: discount-down is canonical, the white paper needs updating

**Matt's call (this session): discount-down is correct. The code is right; the
paper is what needs to change.** No code change — `core/transaction.ts` already
implements it. What follows records the divergence so the paper can be fixed.

**White paper §7** grosses the payment UP and the seller is made whole:

> "If a loaf of bread costs 20 points and the buyer is 90% human, they must pay
> approximately 22.2 points (20 / 0.9) to deliver 20 points of value to the
> seller."

So: sender pays `amount / percentHuman`, recipient receives `amount`.

**The code** discounts DOWN and the seller absorbs it
(`core/transaction.ts`, `effectiveAmount = amount * percentHuman / 100`,
remainder burned as `burn_unverified`): sender pays `amount`, recipient
receives `amount * percentHuman`.

Both implement "verification gates purchasing power," but they put the loss on
opposite sides of the trade, and the UX differs sharply. Under the paper, a
seller always gets their sticker price and low-percent buyers simply find
everything more expensive. Under the code, a seller quoting 20 points silently
receives 18 from a 90% buyer, which is likely to read as the system shorting
them.

**Action: edit the white paper**, replacing the bread example with the
discount-down form. Something like: a seller who wants 20 points of value
should quote 22.2 to a 90%-human buyer, because the buyer's 22.2 delivers 20
and the remaining 2.2 burns. The paper's current numbers are right; it is the
direction of the adjustment that is backwards.

One sub-question the paper does not address and the code decides on its own:
the discount applies **only to daily-point spends** (active/supportive/ambient).
Earned points transfer at full value, and non-individual accounts are never
discounted (`isDailyPointType && isIndividual` in `processTransaction`). That
looks deliberate — earned points have already been through the discount once
when they were first spent into existence, so discounting them again would tax
the same value twice. Worth stating explicitly in the paper either way.

Note the code is right about the other half of §7: an account at 0% receives
its full daily allocation but cannot move value.

### Open: state is not yet purely a function of the chain

A state-mutation audit (this session) mapped every writer of `active_balance`,
`supportive_balance`, `ambient_balance`, `earned_balance`, `locked_balance`,
`percent_human` and the fee pool, and classified each as chain-ordered or not.
Transactions are now commit-time ordered. **These are not, and each one can
fork the state root between honest nodes:**

- **Vouching.** `createVouch` runs synchronously inside `POST /miners/vouches`
  and moves earned → locked on whichever node received the HTTP request. No
  vouch transaction type exists; `Block` has no field for it. One vouch
  permanently diverges that node's state root from its peers.
- **Court.** Challenger stakes, juror stakes, guilty-verdict burns, bounty
  payouts and appeal clawbacks all mutate balances from API routes.
- **Verification panels.** `submitPanelScore` writes `percent_human` directly,
  and `percent_human` is inside the state root.

Making these chain-ordered is the same shape of change transactions just went
through: a signed operation type, mempool admission, deterministic apply at
commit. Two determinism hazards recur at every site and must be fixed in the
same change: `uuid()` for row ids (every node would store a different primary
key) and `Date.now()` for timestamps (use the block timestamp).

Until that lands, `computeStateRoot` stays diagnostic — carried in the block
payload, logged on mismatch, and (as of schema v16) recorded in
`blocks.state_root` — but **not** folded into `computeBlockHash` and not
enforced, because honest nodes can legitimately differ.

Persisting it is what snapshot sync rests on, and it is worth being precise
about how much that buys: a joiner can now check a snapshot against a height,
but only as far as it trusts the peers it asked, since nothing in the chain
commits to the value. Enforcement waits on this section's list being cleared.
Folding the root into the block hash before then just relocates the deadlock
into hash verification.

**Not verified:** the audit's verification stage was cut short by a session
usage limit, so 26 of 33 checks never ran. The vouching findings below were
confirmed by hand. The court and panel findings above are from the mapping
pass only and should be re-checked before anyone acts on them.

### Open: MIN_VALIDATOR_STAKE is four orders of magnitude too low

`MIN_VALIDATOR_STAKE = 100_00n` assumes 2-decimal fixed point; `PRECISION` is
`10^8`. Callers convert display units with `PRECISION` and compare against the
constant, so the real floor is **0.0001 points, not the 100 the comment claimed**.
Anyone holding a fraction of a point clears the bar that is supposed to make the
validator set expensive to flood.

Comments in `registration.ts` and `genesis-init.ts` now state the true number.
The constant itself is unchanged on purpose: raising it to `100n * PRECISION` is
a consensus parameter change touching every genesis spec, every registered
validator and about a dozen tests, so it needs a coordinated restart rather than
a quiet edit. **Matt's call**, and cheaper the sooner it happens.

### Done (Fixed)

- ~~**`rebalanceVouchLocks` silently released other subsystems' stake.**~~
  `locked_balance` is shared by four subsystems (vouching, court challenger and
  juror stakes, validator registration, slashing), but the daily rebalance
  computed a vouch-only total and wrote it over the *whole column*
  (`updateBalance(db, voucherId, 'locked_balance', newTotalLocked)`). A
  validator who also vouched kept their `validators` row stake while the points
  backing it quietly returned to spendable `earned_balance`, once per day cycle;
  `deregisterValidator` would then underflow unlocking stake that was no longer
  there. Now applies a delta scoped to the vouch rows
  (`newTotalLocked - sum(vouch.stakeAmount)`) against the existing column value,
  so other subsystems' stake is untouched. Also skips rather than clamps when
  the delta would push `earned_balance` negative. `vouch-locked-balance.test.ts`
  covers stake preservation, conservation across the rebalance, and convergence
  on repeat runs (the absolute write oscillated).
- **Vouch burns are true burns, and that is deliberate — do not "fix" it.**
  `burnVouch` decrements `locked_balance` and does not call `addToFeePool`. A
  state-mutation audit flagged this as a supply leak and I changed it; that was
  wrong and is reverted. WP v2 made every court burn a true burn, and
  `phase64.test.ts` pins it ("fee pool unchanged", "supply decreases from
  defendant + vouch burns"). The legacy folder's CLAUDE.md describes Phase 62
  routing voucher stakes into the pool — Phase 64 superseded that, so the
  legacy note is stale. Backing a fraudulent account has to cost the voucher
  something the network does not hand straight back. Now pinned from the
  vouching side too, in `vouch-locked-balance.test.ts`, so the two cannot drift.
- **Known gap, not fixed:** `withdrawVouch` has no production caller. A
  repo-wide grep finds only its definition and `phase3.test.ts`; `minerRoutes`
  exposes no withdraw or DELETE endpoint. Locking points into a vouch is
  currently a one-way ratchet whose only exit is a guilty verdict burning them.

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
