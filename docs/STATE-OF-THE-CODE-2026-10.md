# State of the code, October 12, 2026

A fresh read of the whole codebase, written for two readers: Matt, and the
professional team this gets handed to. Three independent reviewers read the
backend (one on everything except the court, two on the court: implementation
and mechanism design). Their findings were then checked against the code before
anything was acted on.

How to read the labels:

- **FIXED** means changed in this pass, with tests, and pushed.
- **CONFIRMED** means I read the code path myself and it is as described.
- **REPORTED** means a reviewer traced it and I have not re-verified it. Treat
  it as probably true and write a failing test before relying on it.

Nothing below was found by running an attack against a live network. Where a
fix landed, there is a test that fails on the old code and passes on the new.

---

## The short version

The core is real. The consensus engine, the money math, the "signed operation
rides a block" pattern and the day-cycle arithmetic are well built and well
tested. A three-validator network runs, agrees on state, and survives the
changes in this pass.

Around that core, four things were wrong that tests and docs both missed:

1. **The default way to run a node did not work.** Plain `npm run dev` and the
   desktop app's "Solo" mode accept payments and never settle them, and accept
   miner signups, vouches, panels and tags and never apply them.
2. **A one-validator network could not produce a block at all**, and a slow
   validator on a small network could stall everyone. FIXED.
3. **A peer could steal, mint, and replay payments** through the
   node-to-node path, which skipped checks the HTTP path enforced. FIXED.
4. **The court could be turned on any honest account** in several different
   ways. The plain defects are FIXED. The design problems are not, and the
   court should not carry real value until it is rebuilt on-chain.

The docs claim that every piece of consensus state is "a pure function of the
applied chain". That is not true yet. The list is in section 3.

---

## 1. What is solid

- **Money math.** All bigint on every commit path. One spend formula
  (`deriveSpendValue`) shared by the origin and every replaying node.
- **Rebase.** Conserves supply exactly, with a deterministic dust pass.
- **Block apply.** One SQL transaction per block, fail-stop on error. No
  half-applied blocks.
- **Pre-vote rehearsal.** Validators dry-run a block's transactions and roll
  back before voting. The proposer filters conflicting spends.
- **The operation-lane pattern.** Signed op, id derived from the signature,
  block timestamp, hash folded into the block hash, applied at commit on every
  node. Vouch, miner, panel and tag lanes all follow it.
- **Commit certificates.** Membership, key binding, duplicates and quorum are
  all checked, and each cert is sealed into the next block.
- **P2P hardening.** Signed envelopes and handshakes, expiring bans, handshake
  deadlines, frame caps, and a catch-all so a malformed message cannot kill the
  process.
- **Startup guards.** Atomic schema init, refusal to guess on a versionless
  database, loud genesis-mismatch error.
- **A real multi-node test.** `scripts/test-lan-multi-validator.mjs` boots
  three nodes and requires matching state roots. It passes.

Test counts after this pass: 861 backend unit tests, 59 wallet, 36 miner, all
green. Lint passes in all three (it was failing on `main` in two of them).

---

## 2. What was fixed in this pass

| What | Why it mattered |
|---|---|
| Validator acts on a quorum its own vote completes | A solo chain never committed. On small networks the slowest validator stalled the round. 9 tests. |
| Driver no longer recurses when a round finishes inside its own start | Needed once a solo validator commits instantly. |
| Peer-supplied transfers obey HTTP's rules: amount > 0, no self-transfer, id derived from signature | Theft (negative amount), minting (self-transfer), replay (fresh id). 8 tests, 7 fail on old code. |
| BFT validators no longer also run the day cycle off their wall clock | Two drivers, different order, possible skipped day on one node. |
| Day-cycle failures are logged instead of discarded | A node could silently stop minting. |
| Court: 9 defects (section 4) | 15 tests. |
| `npm run dev:solo` | One command for a local chain where every button works. |
| Miner and wallet UX pass | Matt's Oct 12 review notes. |
| Lint errors on `main`; two stale end-to-end tests | CI lint was red; two multi-runner canaries had been failing since an API change. |

---

## 3. What is still wrong: backend cleanup list

Ordered by what I would do first. Sizes: S (hours), M (a day or two), L (a
week or more).

### Must be done before real users

1. **Retire authority mode.** [M] CONFIRMED. `runner.ts` `startBlockProduction`
   has two paths. The authority timer builds a block only when a payment is
   waiting, does not apply it under the default `executionMode: 'commit'`, and
   never drains the operation queues. Solo mode in the desktop app, plain
   `npm run dev` and `docker-compose.yml` all use it. Now that single-validator
   BFT commits, point all three at it and delete the authority producer. One
   consensus path is the right number for a protocol meant to last.

2. **Make every operation lane impossible to halt.** [M] REPORTED, and it
   matches the pattern the tags review already found. Apply loops have no
   try/catch, the pre-vote dry run covers transactions only, and block
   validation checks operation signatures only. A validly signed operation
   that fails at apply rolls the block back on every node, the operation stays
   queued, and the halt repeats. Reported triggers:
   - `POST /validators/propose-register` needs no login and checks only
     signature and minimum stake. A zero-balance account can submit one.
   - A new user tapping "become a miner" after the bootstrap window with
     under 50% human.
   - Re-registering a deactivated miner or validator.
   - A vouch with zero balance, below the minimum, or from an escrowed account.
   Fix: copy the tags lane. Never throw at apply; turn every non-applicable
   case into a deterministic skip. Add one test per failing precondition, fed
   through a block.

3. **Account creation is free, unauthenticated, and moves everyone's money.**
   [L] CONFIRMED in part. `POST /accounts` and the gossip path insert an
   account row immediately. Mint pays every active individual row and the
   rebase target is a fixed amount times the active individual count. So a
   node that has not yet heard about a new account at the day boundary
   computes a different rebase multiplier, and anyone can move the multiplier
   and bloat the table by creating accounts in a loop. Mint, rebase and tag
   finalization should see only accounts whose registration has committed,
   and registration needs a cost or a rate.

4. **Tag payouts can create points.** [S] REPORTED. Ambient hierarchy pays the
   leaf in full and each ancestor on top (more than 100%), with no depth cap,
   and the tagger's debit is clamped at zero. Supportive tags pay the maker
   without checking the tagger still holds the points. Subtract the cuts, cap
   the depth, cap payouts at the tagger's balance, add a conservation test.

5. **Miner tiers do not work, and they decide who sits on juries.** [M]
   CONFIRMED. No client ever calls `POST /miners/heartbeat`, so uptime is 0%
   for everyone and Tier 2 is unreachable honestly. It is reachable
   dishonestly: the heartbeat is self-reported with no once-per-interval rule,
   so a script reaches Tier 2 in hours. Tier decides the fee split and the
   jury pool. Heartbeats are also a node-local table, so tiers would differ
   per node the moment they were used. Either put liveness on-chain (a
   validator's signed votes already prove it) or drop the uptime rule.

6. **Legacy validator routes and unbound signatures.** [M] REPORTED.
   `POST /validators/register` and `/deregister` still write one node's
   validator table directly. Signed requests cover payload plus timestamp
   only: no method, path, account, network id or nonce, with a 5-minute
   window. A captured signature for one action can authorize another. Bind
   them, in the node and both apps together.

7. **Sync trusts whoever answers.** [M] REPORTED. A joining node verifies the
   parent certificate against a validator snapshot the same peer supplies, and
   the tip block of a batch has no certificate check. One dishonest validator
   can feed a joiner an invented chain.

8. **API exposure.** [S] REPORTED. The API listens on every interface (the
   host setting is parsed and ignored), CORS is `*`, and several reads leak
   private data with no login: contact lists, recurring transfers,
   vouch-request messages, and where and how long someone was in a space.
   `POST /accounts` with no public key generates the private key on the
   server and returns it over HTTP.

9. **Pending transactions never expire.** [S] REPORTED. A pending transaction
   that can never apply is re-checked every round and counted against the
   sender's spendable balance forever. Transactions carry no expiry or network
   id, so a testnet signature is valid on mainnet for the same key.

10. **Validator admission.** [S] CONFIRMED in docs. Minimum validator stake is
    0.0001 points, quorum is by count, there is no downtime detection and
    `slashValidator` has no caller. A dead validator cannot be removed without
    its own key.

### Should

11. **Widen the state root, then enforce it.** [M] It covers accounts and the
    fee pool only. Miners, tiers, validators, vouches, panels, tags, cycle
    state and params can drift unseen.
12. **Protocol parameters are node-local rows.** [M] No on-chain change path,
    not in the genesis spec, and `npm run seed:test` rewrites them. Governance
    classes exist with no engine behind them.
13. **Run API tests in commit mode.** [M] `createApp` defaults to the legacy
    receipt mode, so no HTTP-level test exercises the production execution
    model. This is how item 1 went unnoticed.
14. **Put at least one multi-runner test in `npm test`.** [S] The 861 figure
    contains no full-node coverage. Every such test is `*.e2e.ts` and
    non-blocking. Two of 21 were failing on `main` and nobody saw
    (`phase15` ban test and `phase32` still are).
15. **No end-to-end test crosses a day boundary.** [M] Add a two-node test
    across 08:59 UTC with a transaction in the boundary block, and a
    wipe-and-resync test.
16. **The 14-minute test suite.** [S] One simulation file
    (`life-fingerprint-simulation`) is 12 of them, and nothing imports the
    module it tests.
17. **The verification panel has nothing to verify.** [L] Already documented:
    miners score a hash, never the evidence. Proof of human is the product.

### Nice

18. **Delete dead code.** [M] `life-fingerprint/` (about 1,000 lines, no
    importer), `smart-contracts.ts`, `mining/vrf.ts`, legacy `panel.ts`
    create/score, `validateBlock`/`validateChain`, three stale
    `initialize*Schema` duplicates, `Mempool` in BFT mode, unused config
    fields, the i18n scaffolding (12 locale files, zero translated strings).
19. **Decide decay, inheritance and smart contracts.** [M] Wire them or remove
    their params, routes and doc claims. The docs list them as done.
20. **Finish the store extraction.** [L] About 168 raw SQL call sites outside
    `core/stores`, despite the docs saying the stores own all state access.
21. **Crypto agility.** [L] No algorithm or version tag in any signed format,
    and no key-rotation operation. A new key means a new account without the
    balance or score. Consensus keys are Ed25519, so votes are not
    post-quantum while accounts are. Add a scheme byte and a rotation
    operation before mainnet.
22. **Pruning.** [M] Unwired. If run, that node can no longer serve a sync
    from genesis.

### Doc claims the code contradicts

- "Every writer of consensus-relevant state is a pure function of the applied
  chain." Not yet: account rows, the court, miner tiers, the legacy validator
  routes, and (until this pass) the wall-clock day cycle.
- "Slashing: double-sign and downtime detection wired to the validator set."
  `slashValidator` has no caller.
- "Proposer selection ... via the IVrfProvider interface." It is a plain hash
  of height, round and parent hash, weighted by miner accuracy. The VRF
  provider is used for key generation only.
- "The I*Store interfaces now own all state access." See item 20.
- "Milestone 2: Whitepaper completeness 6/6 done." Inheritance and the smart
  contract DSL are unwired.
- "831 tests green" as the health signal. See items 13 and 14.

---

## 4. The court

> **Update, October 16, 2026.** Matt answered the court decisions (miner vs
> person, jury size, filing cost, withdrawal, escalation, no-shows, the freeze
> after a verdict, what a guilty verdict takes, appeals) and the rules are now
> in `src/court/court.ts`. Of the design problems listed below, these are
> addressed in the node-local court: the filer no longer picks the jury (no
> challenger escalate; juries drawn at the day-cycle sweep), punishment no
> longer lands before the appeal (`verdict_pending`, then one settlement), and
> freezing someone now costs a 1,440-point floor that goes to them on
> withdrawal. Juror seats are one per verified human (90%+) instead of Tier 2,
> and no-shows forfeit. Still open: the court is node-local (new cases are now
> refused on multi-validator networks), votes are a plaintext column, and
> juror identities are public. The repo CLAUDE.md has the full list.

### What was wrong, and is now fixed

1. **Jury packing.** Any miner with any transaction to or from a party was
   excluded from the jury, and sending someone points needs no consent. One
   base unit to each honest juror removed them all. Now only what the JUROR
   did counts: paid a party, vouched for one, or scored the defendant's panel.
2. **One vote convicted.** A verdict was a majority of votes cast, with no
   quorum. Now it needs a majority of the jurors seated. Otherwise the case is
   dismissed.
3. **Stranded juror stakes.** Non-voters and dismissed cases left 5% of each
   juror's balance locked for good. Now released.
4. **Zombie cases.** A dismissed case could be escalated, voted on, resolved,
   or seated twice. All refused now.
5. **One bad case froze the node's day.** The deadline sweep had no isolation
   and its errors were discarded, so one settlement that threw stopped expiry,
   rebase and mint on that node every day, silently.
6. **A bystander paid.** A duplicate-account verdict burned the savings of
   whoever the challenger named as the "counterpart", who was never notified
   and could not respond or appeal. **The counterpart penalty is switched off.
   This departs from white paper section 9.3 on purpose.** Restoring it needs
   the counterpart to be a real party. Matt's call.
7. **Wrong defendants.** A company could be convicted of being "not human".
   An account under challenge could file its own challenge to move its balance
   out of reach.
8. **Appeals.** The appeal window was never enforced, an appeal with no jury
   blocked the defendant forever, and reversing an innocent verdict threw.
9. **Jury ordering** used locale-dependent string comparison.

### What is still wrong and needs the rebuild

These are design problems. Patching them into the node-local court would be
wasted work, because the court has to move onto the chain anyway.

- **The court is node-local.** A case filed on one node does not exist on any
  other. On a real network it forks state the moment it is used. Every other
  subsystem has been moved onto the chain; the court has not.
- **The filer picks the jury.** The seed is the latest block hash at the
  moment the challenger chooses to escalate. They can wait for a block that
  seats their friends.
- **Juror seats are free.** Tier 2 can be reached by a heartbeat script (item
  5), and three colluding miners can verify unlimited new accounts.
- **Punishment lands before the appeal.** Guilty burns 80% and pays the
  bounty immediately. Win on appeal and the balance stays zero, the vouchers
  stay burned, and the challenger keeps the bounty.
- **Freezing someone is free and repeatable.** File with a dust stake, never
  escalate, get refunded in full at day 7, file again.
- **Votes are not sealed.** They are a plaintext column behind an API mask,
  juror identities are public from seating, and jurors have only downside, so
  bribery is cheap and herding is rational.
- **The court feeds the scores that pick the court.** One guilty verdict
  drops each of the defendant's verifiers to 0% accuracy and out of Tier 2.
  The same number weights block proposers.

### The rebuild, in five rules

1. **A jury draw the parties cannot touch.** Automatic at filing height plus a
   fixed delay, seeded by that future block. Conflicts limited to what a party
   cannot manufacture (done). Fewer than the minimum eligible means no trial.
2. **Nothing irreversible until the appeal window closes.** Funds stay
   escrowed, then everything settles once against the final verdict. Appeals
   need a bond, a deadline (done) and a larger jury.
3. **Filing costs something real.** An absolute minimum bond on top of the
   percentage. Not escalating counts as losing. The defendant can demand
   trial. Immunity only from a full-jury verdict.
4. **A juror seat costs something real.** An absolute miner bond, slashable
   on final verdicts. Reviewers and jurors drawn on-chain, not first come.
5. **Sealed votes.** Commit, then reveal, as on-chain operations. Juror
   identities hidden until reveal. Jurors who match the final verdict are paid
   from the loser's stake.

The court then becomes a sixth operation lane (file, argue, commit, reveal,
appeal), settled deterministically by the day cycle, using
`verification/panel-operation.ts` as the template.

### What the current design gets right and should keep

Skin in the game for challenger, juror and voucher. Tie goes to the defendant.
True burns, so miner-jurors do not profit from convicting. Escrow freezes
savings only, so an accused person can still live on daily points. One appeal,
loser only, prior jurors excluded. One case at a time plus a protection window.

---

## 5. Decisions for Matt

1. **Is a miner a person or a business?** The code says both. Registration
   requires an individual account at 50% human, the August design note says
   "a miner is a business, not a person", and the daily-mint exclusion for
   miners was removed for a determinism reason that no longer applies, so a
   miner account currently draws a full daily allocation. Recommendation: a
   miner is a business operated by exactly one verified human. The human's
   account sponsors it, the miner account gets no daily mint and cannot vouch,
   one miner per human, and the owner must stay verified. That is what keeps
   one person from running a thousand miners and owning every jury.
2. **The duplicate-account penalty** (court item 6): keep it off until the
   counterpart is a party, or drop it.
3. **Minimum jury size.** The code seats as few as 3. Governance says 7 to 25.
   A 3-person jury deciding an 80% burn is thin. Raising the floor means a
   young network has no court at all for a while, which may be the honest
   answer.
4. **The email and password account option** is now hidden unless a hosted
   service is configured. Ship it later as a real hosted service, or remove it.
5. **Raise the minimum validator stake** (a coordinated restart; cheaper the
   sooner it happens).
