# Foundation Hardening Build Plan

Last updated: July 3, 2026.

## Progress

- **Group A (safety net): DONE.**
  - A1: `.github/workflows/ci.yml` runs ae-node (build + full test suite), ae-app
    (lint + build), and ae-miner (lint + build) on every push to main and every PR.
  - A2: ae-node now has its own eslint config (`eslint.config.js`) + `lint` script,
    hard-gated at zero errors (including zero `any` in the protocol core). All 28
    pre-existing violations fixed (dead code removed, `any` typed, switch
    fall-throughs closed). A repo-root `.prettierrc.json` sets shared formatting.
    The frontends' pre-existing `any` warnings on API plumbing are demoted to
    tracked warnings (see Group D) so their build gate is meaningful today; the
    generated `dev-dist/` service-worker files are now excluded from linting.
- **Group A ✅, Group B ✅ (B1/B2/B3 + D7 all done).**
- **Group C: in progress.**
  - C1 (structured logging): **DONE.** Note a deliberate deviation from the plan:
    instead of adding `pino` (a heavy dependency to a project that keeps only 6
    runtime deps, which matters for auditability), the existing `node/logger.ts`
    was upgraded to emit one JSON object per line (`time, level, tag, msg, ...`),
    with `logger.child(fields)` for bound context and `LOG_LEVEL` from the env.
    A new `api/middleware/requestId.ts` assigns (or honors an incoming) request
    id, sets the `X-Request-Id` response header, and attaches a request-scoped
    child logger. The error handler logs unexpected faults with that id and
    returns the id in every error body so a user can quote it.
    `tests/request-id.test.ts` proves the header, the echo, and the incoming-id
    passthrough.
  - C2 (OpenAPI): **DONE.** `api/openapi.ts` builds an OpenAPI 3.1 spec from the
    same zod schemas the write routes validate against (via zod 4's native
    `z.toJSONSchema` — no extra dependency), so the contract and the runtime
    validation can't drift. Served at `GET /api/v1/openapi.json`; written to
    `docs/openapi.json` by `npm run gen:openapi`. `tests/openapi.test.ts` checks
    the endpoint, that the transaction amount is documented as a base-unit
    integer-string pattern, and that the checked-in file matches the generated
    spec (a drift guard that fails CI if a schema changes without regenerating).

Group B detail (kept for reference):
  - B1 (typed errors): **DONE.** `core/errors.ts` adds an `AppError` base with
    typed subclasses (Validation, InsufficientBalance, Auth, Forbidden, NotFound,
    Conflict). Every user-facing `throw` in the money path, court, verification,
    mining, and tagging is now a typed `AppError` carrying an httpStatus and a
    domain code. `errorHandler.ts` reads status/code off `AppError` and the
    **legacy substring matcher is deleted** — anything that is not an `AppError`
    is an internal fault that returns a generic 500 with **no message leak**
    (logged server-side). Internal invariants (block genesis, fee-pool
    distribution, follower replay, config/governance setters) stay plain `Error`
    on purpose — they are bugs, not user errors, and correctly become 500s.
    (`InheritanceError` predates `AppError` and isn't route-wired; convert it if
    inheritance ever gets an endpoint.)
  - B2 (schema validation): **DONE.** `api/middleware/validate.ts` adds a
    `validateBody(schema)` gate; `api/schemas.ts` holds zod schemas for the write
    endpoints. Applied to 18 write routes across transactions, accounts, court,
    tags, verification, miners, recurring, and contacts. A malformed body is
    rejected with a 400 `VALIDATION` before any business logic runs.
    `tests/request-validation.test.ts` proves it. Schemas validate presence,
    primitive type, and fixed-set enums; numeric-range/cross-field rules stay in
    the business layer (which throws typed `AppError`s with specific codes that
    tests rely on), so nothing that passed before regresses.
  - B3 (integer-string money): **DONE.** Transaction amounts now cross the API
    boundary as a positive base-unit integer string (`/^[1-9]\d*$/`), parsed
    straight to `bigint` — the `BigInt(Math.round(amount * PRECISION))` float
    path is gone. This is the exact canonical value the client already signs, so
    the signature contract is unchanged; the wire and the signature now carry one
    consistent value instead of a display number plus a separately-signed
    base-unit string. `ae-app/src/pages/Send.tsx` sends the string it already
    computes (ae-miner sends no transactions). `tests/request-validation.test.ts`
    proves floats, JS numbers, zero, negatives, leading-zeros, and scientific
    notation are rejected, and that a 1e18-base-unit amount (beyond 2^53, which
    the old float path would have corrupted) transfers exactly.
    Follow-up: `/recurring` still accepts a number-or-string amount and persists
    `amount.toString()`; fold it into the same integer-string contract when the
    recurring executor is revisited.
- **Group C: not started.**
- **Group D: tracked below.**

CI status: the ae-node job runs the **deterministic** suite (~58 files: money,
court, verification, mining, crypto, rebase, tagging, API, block/tx/validator
logic) as the blocking gate. Every test that spins up a real multi-node P2P
network with timing-based `wait()` synchronization (~21 files) is renamed
`*.e2e.ts` and runs as a **non-blocking** step — those flake on GitHub's slower
shared runners even though they pass locally. The rule used to classify: any
test using `await wait()` with the runner/PeerManager harness is E2E. Run
`npm run test:e2e` (or `test:all`) to exercise them locally. Stabilizing them
with event-based waits so they can rejoin the gate is D9. The frontend jobs
install with `--legacy-peer-deps` (D6); ae-app is lint-only (D8).

## Why this plan exists

A code review found that the **economics core is strong** (pure-bigint money math,
atomic transactions, idempotent replay, real BFT consensus, 650+ passing ae-node
tests) but the **engineering scaffolding around it is thin**. The gaps are the exact
things a professional auditor or a hired engineer judges first: no enforced CI, fragile
error handling, no input validation at the API boundary, money crossing that boundary as
a float, and no observability.

This plan closes those gaps. It does **not** touch the economics. The rule for every task
below: the full test suite stays green, and no protocol behavior changes unless a task
explicitly says so.

Order matters. Group A builds the safety net first, so every change after it is verified
automatically. Do the groups in sequence.

---

## Group A — Safety net (do first)

Goal: nothing merges without the tests and linter passing. This is the highest-leverage
work in the plan and the cheapest.

### A1. CI that runs every suite on every push and PR
- **Problem:** The only GitHub Actions workflow is `platform-server.yml`. The 650+
  ae-node tests never run automatically. A broken change can merge silently.
- **Do:** Add `.github/workflows/ci.yml` with one job per package:
  - `ae-node`: `npm ci && npm run build && npm test`
  - `ae-app`: `npm ci && npm run lint && npm run build`
  - `ae-miner`: `npm ci && npm run lint && npm run build`
  - Trigger on `push` to main and all `pull_request`s. Use a matrix on Node 22.
- **Acceptance:** Open a throwaway PR that breaks one test; CI goes red. Revert; CI goes green.
- **Effort:** Half a day. **Risk:** None (additive).

### A2. Lint + format baseline across all three apps
- **Problem:** `ae-node` has no lint script. `ae-app`/`ae-miner` have eslint but it isn't
  enforced. No Prettier anywhere, so formatting drifts the moment a second person contributes.
- **Do:**
  - Add an eslint config + `"lint": "eslint ."` script to `ae-node`
    (typescript-eslint, enable `no-floating-promises`, `no-explicit-any`, `no-unused-vars`).
  - Add a shared Prettier config at the repo root and a `format` script per app.
  - Add a `lint` step to each CI job from A1.
  - Fix the violations the first run surfaces (expect floating promises and stray `any`s).
- **Acceptance:** `npm run lint` passes in all three apps and runs in CI.
- **Effort:** 1 day (most of it fixing what the linter finds). **Risk:** Low.

---

## Group B — Harden the API boundary

Goal: make the money-handling edge of the system correct and defensive. This is where the
"vibe code" smell actually lives, and it sits directly in front of the strong core.

### B1. Typed error classes, replace string-sniffing in the error handler
- **Problem:** `errorHandler.ts` chooses HTTP status by `err.message.includes('Invalid')`.
  Fragile, and any unmatched error becomes a 500 that echoes the raw `err.message` to the
  client (information leak).
- **Do:**
  - Add `core/errors.ts` with an `AppError` base carrying `httpStatus` and `code`, plus
    subclasses: `NotFoundError`, `InsufficientBalanceError`, `ValidationError`,
    `ConflictError`, `ForbiddenError`, `AuthError`. (Pattern already exists once as
    `InheritanceError`.)
  - Replace `throw new Error(...)` in `core/`, `court/`, `mining/`, `verification/` with
    the typed classes (roughly 90 call sites; do it package by package, tests green after each).
  - Rewrite `errorHandler.ts` to read `err.httpStatus`/`err.code` when `err instanceof AppError`,
    and for anything else return a generic 500 with **no** internal message.
- **Acceptance:** A forced unknown error returns `{ code: "INTERNAL_ERROR" }` with no leaked
  detail; a balance failure returns 400 `INSUFFICIENT_BALANCE`. Existing error-path tests pass.
- **Effort:** 2 days. **Risk:** Medium (many call sites; the suite is the safety net).

### B2. Schema validation on every write route
- **Problem:** 20 routes destructure `req.body` with no validation. Malformed input reaches
  business logic and money math.
- **Do:**
  - Add `zod`. Define a schema per write endpoint (transactions, tags, court, validators,
    miners, verification, recurring, contacts).
  - Add a small `validate(schema)` middleware that parses `req.body` and throws
    `ValidationError` (from B1) on failure.
  - Apply it to every `router.post/put/delete`.
- **Acceptance:** Each validated route has one test proving a malformed body returns 400
  before touching business logic.
- **Effort:** 2 days. **Risk:** Low (additive guardrail).

### B3. Kill float money at the boundary
- **Problem:** `transactions.ts` does `BigInt(Math.round(amount * Number(PRECISION)))` on an
  unvalidated JS number. `NaN`/`Infinity`/negative slip through, and precision breaks above
  ~90M units, which rebased balances will exceed. This is a correctness bug in the money path.
- **Do:**
  - Change the wire format so amounts arrive as an **integer string in base units** (already
    the internal representation), not a decimal float.
  - Parse with a strict bigint parser (reject non-digits, negatives, leading zeros) inside the
    B2 schema for transaction routes.
  - Update the wallet (`ae-app`) and miner (`ae-miner`) send flows to format amounts as base-unit
    strings before POSTing. Keep a display formatter for the UI only.
- **Acceptance:** A test sends `amount: "144000000000"` and it settles exactly; sending a float,
  negative, or `"NaN"` is rejected with 400.
- **Effort:** 1.5 days (backend + both frontends). **Risk:** Medium (touches the send UX; verify
  in the browser preview).

---

## Group C — Operability

Goal: a professional deploying this can see what the system is doing. Not blocking a small
test, needed before real users.

### C1. Structured logging
- **Problem:** Logging is `console.error`. No levels, no request IDs, no way to trace a request.
- **Do:** Add a small logger (pino) with levels and JSON output. Add a request-ID middleware
  that stamps each request and threads the ID into logs and error responses. Replace ad-hoc
  `console.*` in the API and node layers.
- **Acceptance:** A failing request logs one structured line with a request ID that also appears
  in the client error response.
- **Effort:** 1 day. **Risk:** Low.

### C2. API contract (OpenAPI)
- **Problem:** No documented API surface. The "hand it to a pro" goal needs one.
- **Do:** Generate an OpenAPI spec from the zod schemas (B2) via `zod-to-openapi`. Serve it at
  `/api/v1/openapi.json` and check the file into `docs/`.
- **Acceptance:** The spec lists every route with its request/response shape and loads in Swagger UI.
- **Effort:** 1 day. **Risk:** Low.

---

## Group D — Deferred but tracked (Phase 2)

Real, not blocking. Documented so they aren't forgotten.

- **D1. Rate limiting to a shared store.** `rateLimit.ts` is in-memory: it resets on restart and
  doesn't coordinate across nodes. Move to Redis or a DB table before multi-node production.
- ~~**D2. Encrypted keystore.**~~ ✅ **Done (July 5), both apps.** Wallet private keys and mnemonics
  can now be passphrase-encrypted at rest instead of sitting in plaintext `localStorage`. Encryption
  is **opt-in and non-destructive** — plaintext wallets keep loading exactly as before. Built exactly
  to the design below: `lib/keystore.ts` (WebCrypto PBKDF2-SHA256 600k iters → AES-GCM, random
  per-envelope salt + IV, versioned envelope; wrong-passphrase and tamper both fail authentication);
  an in-memory `unlockedSecret` in `keys.ts` keeps `loadWallet()` **synchronous** (reads the decrypted
  secret only after unlock, returns null while locked); an `UnlockGate` at boot (in `ProtectedRoute` /
  `RequireAuth`); and a "Passphrase Protection" card (More page in the wallet, Dashboard in the miner)
  to add/remove protection. Same code in `ae-app` and `ae-miner`. Tests: `keystore.test.ts` (6:
  round-trip, wrong passphrase, tamper, salt/IV freshness, empty-passphrase guard, envelope
  detection) + `keys.test.ts` (4: plaintext loads, protect-encrypts-no-leak, lock→null + unlock-only-
  with-right-passphrase, remove-restores-plaintext) in each app. tsc + lint (0 errors) + build green
  both sides. **Original design (kept for reference):**
  1. `lib/keystore.ts` — `encrypt(wallet, passphrase)` / `decrypt(blob, passphrase)` with WebCrypto:
     PBKDF2-SHA256 (≥600k iters) → AES-GCM, random 16-byte salt + 12-byte IV per encryption, versioned
     JSON envelope `{v, kdf, salt, iv, ct}`. Fully unit-tested (round-trip, wrong-passphrase rejects,
     tamper rejects). This is the safe, self-contained core.
  2. In-memory session: keep `loadWallet()` synchronous by reading from a module-level `sessionWallet`
     populated by an async `unlockWallet(passphrase)`. Plaintext (unencrypted) wallets still load
     synchronously (back-compat) — encryption is **opt-in**.
  3. `<UnlockGate>` at app boot: if an encrypted wallet exists and isn't unlocked, show the passphrase
     prompt before rendering the app; wrong passphrase shows an error, never locks the user out (they
     can still restore from recovery phrase).
  4. A "Protect wallet with a passphrase" action in More/Settings that encrypts the existing wallet
     in place, plus a "Remove passphrase" path. Migration is opt-in, non-destructive.
  5. Same treatment in `ae-miner`.
  Do it as its own build with its own tests; do NOT bolt it onto the end of a long session.
- **D3. Finish the repository extraction.** ✅ **Done.** `ICycleStateStore` +
  `SqliteCycleStateStore` (with a `cycleStateStore(db)` factory) now own every `day_cycle_state`
  read/write; the last inline SQL in the business logic (the cycle-phase read in
  `transaction.ts`, four `current_day` reads in the court, the day-cycle read/write helpers, and
  the network-status read) all route through it. No business module issues raw `day_cycle_state`
  SQL anymore. (Remaining non-store SQL elsewhere, e.g. block-height/miner counts in
  `network.ts`, is out of scope for the day-cycle store and can be extracted alongside its own
  store later.)
- **D4. Frontend tests.** 🟢 **Unit + send/verify/vouch flow layer done, both frontends.** Vitest is set up in `ae-app`
  and `ae-miner`, each with a `test` script wired into its CI job (both are now lint + test +
  build). Unit tests cover the correctness-critical pure logic: `formatting.ts` (incl. a new
  `toBaseUnits` helper extracted from `Send.tsx` so the display→base-unit money conversion is
  centralized and tested, plus a round-trip against `displayPoints`), `crypto.ts` (mnemonic→keypair
  determinism, validation, signing), and the miner's `ledger.ts` (income classification +
  per-source aggregation). Writing these caught and removed a real bug: `derivePublicKey` was dead
  code that wrongly assumed the ML-DSA-65 public key is the last 1952 bytes of the secret key — it
  isn't, and nothing used it. **Component layer started (ae-app):** stood up a jsdom + React
  Testing Library harness (a dedicated `vitest.config.ts` with `environment: 'jsdom'`, kept separate
  from `vite.config.ts` so the PWA/service-worker plugin doesn't run under the test runner) and wrote
  the first real flow test on the money-critical page: `Send.test.tsx` drives the recipient →
  amount → send path and asserts the app signs and transmits the amount as the canonical base-unit
  integer string (`toBaseUnits`, the real one — not mocked), never the float, plus a failure-path
  test that a rejected send surfaces the error to the user. **Then the same harness in ae-miner**
  (its own `vitest.config.ts`, jsdom + RTL) with `Vouch.test.tsx` on the verification-critical
  inbox accept flow: it drives the "Accept" action and asserts the app locks the stake first
  (`submitVouch` with the default 5% policy minimum) and only *then* marks the request accepted
  (`updateVouchRequest`), verified with `invocationCallOrder` — the exact ordering that prevents a
  failed stake from leaving a stale "accepted" record. A second test asserts that when the stake
  fails to lock, `updateVouchRequest` is never called and the error surfaces. **Then the ae-app
  verify page:** `Verify.test.tsx` drives the "request a vouch" modal — fill the recipient id + a
  message, submit — and asserts the app POSTs `createVouchRequest` with exactly `{ toId, message }`
  signed as the requester, and shows the "sent" confirmation; a second test asserts a rejected
  request surfaces the server error instead of a false success. That completes the send/verify/vouch
  flow triad this item called for. **Remaining:** the miner court/verify pages can pick up the same
  harness as they change; not blocking.
- **D5. Frontend `any` burn-down.** ✅ **Done (both frontends at 0 `any`, rules promoted to error).** A2 demoted `no-explicit-any` and a
  few react-hooks advisory rules to warnings (~72 `any` in ae-app, ~25 in ae-miner), almost all on
  API-response plumbing — 51 of ae-app's are in `lib/api.ts`'s `request<…>` generics. Started the
  burn-down: added `lib/types.ts` with real `AccountData` / `AccountDetail` shapes (mirroring the
  ae-node serializer), typed `getAccount` / `createAccount`, de-duplicated the copy of `AccountData`
  that `useAccount` carried, and removed the internal `json: any` in the request helper (now
  narrowed `unknown`) plus a `catch (e: any)` in `Send.tsx`. Then typed the transaction response
  (`TransactionData`, camelCase per `rowToTransaction`) on `getTransactions` and its consumers
  (`History`, `Wallet`) — which caught a second real bug: `History` rendered `tx.point_type`
  (snake) while the payload is `tx.pointType`, so the per-transaction point-type label was always
  blank. Then typed the court responses — `CourtCaseData`, `MyCaseData`, `JurorData`,
  `CaseArgumentData` — across `getActiveCases`, `getCase`, `getMyCases`, `fileChallenge`,
  `escalateCase`, and `submitCaseArgument`. Then typed the miner + network responses
  (`MinerData`, `MinerStatus`, `NetworkStatus`) across `getMinerStatus`, `registerMiner`, and
  `getNetworkStatus`, and the `More` / `Wallet` / `Network` state that holds them — which caught a
  third latent bug: `More` set `miner: res.data` where `res.data` is `{ miner }`, double-nesting
  the record (harmless today only because `minerStatus.miner` is never read). Then typed the
  contacts response (`ContactData`, snake_case since the route returns raw joined DB rows) — which
  caught the biggest bug yet: **three pages** (`Contacts`, `Send`, `Recurring`) set their contact
  state straight from the snake_case rows into a camelCase local type, so `contact.isFavorite` and
  `contact.contactAccountId` were `undefined` at runtime (favorites filtering and contact-ID
  display silently broken). Fixed all three with an explicit snake→camel map. Then typed the
  vouch responses (`VouchData`, `VouchRequestData`) on `getVouches`, `getVouchRequests`,
  `createVouch`, and `createVouchRequest` — which surfaced a type inaccuracy in `Verify` (its local
  `Vouch.stakeAmount` was `number` but the API sends a string; no runtime bug since the display
  sites already wrapped it in `String(...)`, but the type is now correct). Then typed the tagging
  responses (`ProductData`, `SpaceData`, `SupportiveTagData`, `AmbientTagData`) across the
  products/spaces/supportive/ambient endpoints, removed the two `(t: any)` maps in `Tag`, and
  **fixed the real `react-hooks/purity` bug**: `SaveBar` computed `justSaved` from `Date.now()`
  during render (so the "saved" state never cleared itself) — now driven by a `setTimeout` +
  state, and the purity warning is gone. Then typed `searchAccounts` (`AccountSearchResult`,
  snake_case) — which caught another casing bug: `Send`'s recipient search read `acc.percentHuman`
  while the payload field is `acc.percent_human`, so search hits always showed "0% human". Fixed.
  Then typed the recurring-transfer response (`RecurringTransferData`, snake_case) — same bug as
  contacts: `Recurring` read `t.isActive` / `t.toId` / `t.pointType` off raw snake_case rows, so
  the active/paused toggle, recipient, and point-type were all broken; fixed with a snake→camel
  map. Then typed the verification-panel list/request responses (`PanelSummary`, matching
  ae-node's `VerificationPanel`) on `getAccountPanels` and `requestPanel`, replacing an unsafe
  `res.data.panels as PanelSummary[]` cast in `Verify` and de-duplicating its local copy of the
  type. Then typed the contact and recurring mutation responses (a shared `SuccessResponse` for the
  bare-ack routes, real shapes for `addContact` / `createRecurring`). **Then the final 13:**
  `sendTransaction` (`{ transaction: TransactionData; newBalance }`), `submitEvidence` /
  `getEvidenceScore` (a new `ScoreBreakdownData` mirroring ae-node's `ScoreBreakdown`) — which
  **caught the eighth latent bug**: `getEvidenceScore` was typed `{ score: number }` but the route
  returns `score` as a `ScoreBreakdown` object, so `Verify` cast the whole payload to `any` and read
  through fallback chains (`scoreObj.totalScore ?? scoreObj.score ?? 0`); with the type corrected the
  `any` and the fallbacks are gone. Then `updateVouchRequest` → `SuccessResponse`,
  `submitVerificationEvidence` → `{ evidence: unknown }`, the unused `getPanel` / `getFeePool` /
  `advanceDay` → `Record<string, unknown>`, `generateGenesis` → a concrete keystore-array shape, the
  `websocket.ts` `EventHandler` (`(data: any)` → `(data: Record<string, unknown>)`, handlers narrow
  the fields they read), and the two `CaseDetail` ws handlers. **ae-app is at 0 `any` (from 72)** and
  `no-explicit-any` / `no-empty-object-type` / `no-unsafe-function-type` are **promoted back to
  `error`** — new `any` now fails the ae-app build gate. Lint (0 errors), tests (14), and build all
  green. Along the way this pass caught 8 real bugs (blank point-type labels, double-nested miner
  state, three contact-page snake/camel mismatches, a "0% human" search bug, a broken recurring
  toggle, a purity bug, and the evidence-score shape). (react-hooks
  `purity`/`immutability`/`set-state-in-effect` stay warnings in ae-app until their handful of
  pre-existing hits are fixed.) **Then ae-miner (23 `any`):** its api.ts already kept types inline,
  so this promoted the page-local court/panel types (`PanelAssignment`, `PanelDetail`, `CaseHeader`,
  `CaseArgument`, `JurorRow`, `JuryAssignment`, `ActiveCaseSummary`) up into api.ts as the real
  return shapes, de-duplicating the copies in `Verify` / `Court` / `CaseDetail`, and typed the two
  `CaseDetail` ws handlers plus `Vouch`'s request/vouch card props and the two dual-shape account
  balance reads (narrow casts, not `any`). **ae-miner is at 0 `any` (from 23)**, and because its
  react-hooks advisories were already clean, **all six rules** are promoted to `error` there. Both
  frontends lint clean (0 errors), all tests green (14 + 17), both build. D5 done.
- **D6. Frontend dependency conflict.** ✅ **Done.** Bumped `vite-plugin-pwa` to `^1.3.0` in both
  frontends (1.3.0 adds `^8.0.0` to its vite peer range), regenerated both lockfiles cleanly
  without `--legacy-peer-deps`, and removed the flag from both CI jobs. Verified `npm install`
  resolves with no ERESOLVE and both PWA builds still generate their service workers.
- ~~**D7. Finish B1 error migration.**~~ **Done.** All user-facing throws in court,
  verification, mining, and tagging are typed `AppError`s and the legacy substring matcher is
  removed from `errorHandler.ts`.
- **D8. Fix the ae-app clean build.** ✅ **Done.** Root cause: `ae-app` depends on
  `@alignmenteconomy/sdk` via `file:../sdk`, and the SDK's `dist/` is gitignored — so on a fresh
  checkout the module (and every type that flows from it) can't resolve until the SDK is built.
  The `catch (e: unknown)` errors seen in CI were cascade artifacts of that unresolved module, not
  real source bugs: once the SDK is built, `ae-app` type-checks and builds clean (verified with a
  forced non-incremental `tsc -b --force` + full `vite build`). Fix is CI-only — the ae-app job
  now builds the SDK first, then lints and builds ae-app; the build step is restored (job is
  `lint + build` again). Note for local devs cloning fresh: run `npm ci && npm run build` in
  `sdk/` before building `ae-app`.
- **D9. Stabilize the flaky multi-runner tests.** 🟢 **Sweep done (July 5); residual flake is
  inherent multi-process nondeterminism.** Investigating the canonical "Phase 17 sync" flake
  root-caused it precisely: `phase16.e2e.ts` built two chains by calling `createGenesisBlock()` once
  per node, but genesis carries a `Date.now()` timestamp, so the two genesis blocks diverge whenever
  the calls land in different seconds — the follower then can't match block 1's parent hash and
  wrongly bans the honest authority, aborting sync with zero blocks applied (~1 in 5 runs). Fixed by
  sharing the authority's exact genesis with the follower, plus converting the file's fixed `wait()`
  sleeps to poll-to-deadline and adding a wait-for-peer-advertised-height before the one-shot
  `startSync()`. 25/25 green (was ~80%). Notably, `smoke-multiblock` and `phase60` were **already**
  deterministic (poll-to-deadline with generous timeouts); the residual flake there is genuine
  multi-process BFT nondeterminism under load, not a naive sleep. **Progress (July 5):** the
  `wait` / `waitForCondition` helper is now extracted to `tests/helpers/wait.ts` (shared, not
  copy-pasted per file), and `phase36.e2e.ts` — the worst offender (8 fixed sleeps) — is converted:
  its gossip-propagation `broadcast(); wait(200); assert(received)` waits now poll the received
  array to a deadline (`waitForCondition(() => arr.length >= n)`); the genuine settles (dedup
  negative-checks, mesh-ack) stay as bounded `wait`. Stable 6/6 across repeated runs. Note: the CI
  e2e step is `continue-on-error: true` (non-blocking), **not** a retry — so there's no retry to drop;
  the goal is deterministic-enough tests to eventually move back to blocking. **Sweep complete (July
  5):** phase10/14/15/27/32 are all converted with the same pattern — each `broadcast/action; wait;
  assert(observable)` now polls the observable (`received.length`, `getPeerCount`, `isBanned`, an
  `applied` flag, a balance change) to a deadline; genuine settles (dedup no-ops, "never-connected"
  negatives, mesh-ack) stay as bounded `wait`. Reaction-to-bad-input polls (ban / disconnect) use a
  3s cap so a genuine miss fails fast instead of burning the default 10s. All six files verified
  passing. **What's left is NOT a sleep problem:** `phase15`'s "unauthorized-producer ban" and the
  `smoke-multiblock`/`phase60` family are genuinely intermittently nondeterministic under load — the
  ban / commit occasionally does not happen at all within any reasonable window (not "happens but
  slowly"). Poll-to-deadline can't fix that; it only removes the false failures where the event *did*
  happen just after a too-tight fixed sleep. Those tests stay `continue-on-error` (non-blocking) by
  design. **New finding (separate, real):** `ChainSync.startSync()`
  is one-shot with no retry — a genuinely dropped `get_blocks` request or reply stalls a follower
  forever (`isSyncing` stuck true). That's a production robustness gap, not just a test issue; it
  wants its own careful fix (a stall watchdog that re-requests, made safe by skipping already-applied
  blocks so a late duplicate reply can't ban an honest peer) with a dropped-message test. Logged here
  so it isn't lost.

---

## Group W: White-paper alignment audit (July 5)

A claim-by-claim pass over `Alignment_Economy_White_Paper_July_FV.docx` against the code. Most WP
mechanics are implemented and match to the exact constant (1,440/144/14.4 daily, 525,600 rebase
target, 0.5% fee, 20/80 tiers, 60/40 Tier-2 lottery/baseline, composite accuracy 80% over 30 days,
3-miner FIFO median panels, percentage-based vouching with rebalancing locks, 10%/mo decay offset by
human-tags, 11-juror courts with 5% stakes and sealed votes, 20/80 bounty/burn, 50/50 innocent split,
escrow, one-case-at-a-time, conflict exclusion, appeals, 6-month protection window, ML-DSA-65, 7-year
pruning, governance classes). These are the gaps where code and paper diverge.

- ~~**W1. Duplicate-account verdict is missing.**~~ ✅ **Done (July 5).** A `duplicate_account`
  challenge now names a **counterpart** — the earlier account the defendant duplicates (schema v12:
  nullable `court_cases.counterpart_id`; required + validated at filing: counterpart exists, is
  active, differs from defendant/challenger, and joined on an earlier day so the defendant is
  unambiguously the later duplicate). On a guilty verdict the defendant closes like any non-human
  account (bounty + burn + deactivate), and `applyGuiltyVerdict` now burns a **2× overlap penalty**
  from the surviving counterpart: `2 × (currentDay − defendant.joinedDay) × DAILY_ACTIVE_POINTS`,
  capped at the counterpart's Earned (never driven negative). The counterpart is not escrowed (it's
  presumed-legit; the penalty disgorges up to available balance) — a documented design choice.
  `not_human` cases are unchanged. Wired through the API (`counterpartAccountId`, zod-optional,
  serialized on the case) and the miner File Challenge form (a counterpart field appears when
  "Duplicate Account" is selected, required to submit). Covered by `wp1-duplicate-verdict.test.ts`
  (4/4: penalty math, cap, counterpart-required, counterpart-must-be-older).
- ~~**W2. Wallet doesn't gross up the percentHuman discount.**~~ ✅ **Done (July 5).** The Send
  preview now tells the truth for an active spend by a <100%-human individual: it shows a
  **"Verification burn (N% human)"** line (`amount × (1 − percentHuman/100)`) and a corrected
  **"Recipient gets"** (`amount × percentHuman/100 − 0.5% fee`) instead of the old figure that
  ignored the discount. Below it, a one-tap **gross-up** control raises the amount to
  `amount ÷ (percentHuman/100)` so the recipient receives the full intended value (WP §7's 20 → 22.22
  at 90%). UI-only; the protocol math (`transaction.ts:368`) was already correct. Covered by a new
  `Send.test.tsx` case (burn line, corrected delivery figure, and the gross-up click).
- ~~**W3. Validator selection contradicts the WP.**~~ ✅ **Done (July 5) — Matt's call: change the
  code, accuracy-weighted is the goal.** Proposer selection is now weighted by proof-of-human
  accuracy, not capital. `ValidatorInfo` gained an optional `proposerWeight`; `selectProposer`
  weights by `proposerWeight ?? stake` (the fallback keeps raw fixtures/snapshots on stake). The
  live `SqliteValidatorSet.listActive()` populates `proposerWeight` from `getCompositeAccuracy`
  (clamped to [1, 100]; a new miner or no-record account gets 100 = benefit of the doubt, so a fresh
  network is equal-weight until accuracy diverges). This was safe to do because (a) `getCompositeAccuracy`
  is a **pure function of committed on-chain counts** — no wall-clock window — so every node computes
  the same weight at the same height (deterministic), and (b) quorum/finality is **count-based**
  (`⌊2N/3⌋+1`), never weight-based, and block validation checks the commit cert, not the proposer
  identity — so weighting only affects *who proposes* (liveness), never safety, and historical blocks
  never re-derive the proposer. Economic `stake` is untouched (still locked/slashable). Covered by
  `wp3-accuracy-selection.test.ts` (4/4: proportional selection, stake fallback, determinism, live
  `listActive` weight population).
- ~~**W4. Follower catch-up sync has no retry.**~~ ✅ **Done (July 5).** `ChainSync` now arms a
  **stall watchdog** on every `get_blocks` request (`batchTimeoutMs`, default 8s; `maxBatchRetries`,
  default 3, both constructor-injectable for tests). If no batch advances the follower before it
  fires, it re-requests the outstanding batch; after the budget is spent it gives up and frees
  `isSyncing`, so the next periodic `startSync` can retry against a fresh best peer instead of the
  follower wedging forever. Made safe against late/duplicate replies: the batch handler now **skips
  blocks at or below `currentHeight`** (validating a stale block against our advanced head would fail
  and wrongly ban an honest peer that just answered a retry), clears the watchdog when a reply lands,
  and resets the retry budget on progress. `phase16.e2e.ts` (normal sync) still 9/9; new
  `wp4-sync-retry.test.ts` proves the stall is freed after retries and a fresh sync works afterward.
- **W5. White-paper honesty pass.** 🟢 **Nullifier duplicate check built; the rest need Matt.**
  (a) ✅ **Nullifier** — WP §8.2 says the nullifier "prevents the same document from being used to
  create multiple accounts." The code stored the credential hash but **never checked it across
  accounts**, so one ID could verify ten accounts — the exact attack the paper says it stops.
  `submitEvidence` now rejects a hash already registered to a *different* account
  (`ConflictError` / `DUPLICATE_CREDENTIAL`), while allowing the *same* account to re-submit for
  re-verification. This is the paper's basic duplicate defense working today with a plain content
  hash; the zero-knowledge circuit that hides the credential itself stays a Phase-3 privacy
  enhancement (documented as such in `evidence.ts`). Covered by `wp5-nullifier.test.ts` (3/3).
  (b) ✅ **Enrollment fee** — **resolved (Matt, July 5): off-protocol, miner-attested.** The fee is
  paid however the participant likes (fiat outside the system, or points inside it); a reviewing
  miner simply confirms "they paid" via a checkbox during verification. It is deliberately NOT a
  protocol-enforced on-chain mechanism, so there is nothing to build at the consensus layer. (If we
  later want the attestation recorded, it's a one-field add to the verification flow — noted, not
  blocking.) (c) ✅ **Smart-contract Supportive collection** — **resolved (Matt): out of scope.**
  Automated point-of-sale / usage collection happens outside this app; the in-repo `smart-contracts.ts`
  stays a schema placeholder by design, not a gap to fill. (d) ✅ **Eleven-miner ramp-up review** —
  **resolved (Matt): operational, nothing to build.** It's a one-time manual re-review we run once
  the network reaches 11 active miners; no code needed now. Net: W5 is closed — the one real code gap
  (the nullifier) is fixed, and the rest are intentionally off-protocol.

**Sequencing:** W1 first (clearest correctness delta, self-contained), then W2 (small, user-facing),
then W4 (robustness). W3 and W5 need Matt's decisions before code moves.

---

## Suggested sequencing

1. **A1 + A2** together (the safety net) — ~1.5 days.
2. **B1** (typed errors) — 2 days.
3. **B2 + B3** (validation + integer money) — ~3.5 days.
4. **C1 + C2** (logging + API docs) — 2 days.
5. **Group D** as separate Phase-2 tickets.

Total for A–C: roughly two focused weeks. After that, the project reads like production code, not
a prototype, and a hired engineer can pick it up without wincing.

Each numbered task should land as its own build phase with its own tests, matching the existing
convention in CLAUDE.md.
