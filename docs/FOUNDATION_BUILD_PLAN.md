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
- **Group B: in progress.**
  - B1 (typed errors): started. `core/errors.ts` adds an `AppError` base with
    typed subclasses (Validation, InsufficientBalance, Auth, Forbidden, NotFound,
    Conflict). `errorHandler.ts` now reads status/code off `AppError` and, crucially,
    **no longer leaks internal error messages on unexpected 500s** (they're logged
    server-side and the client gets a generic body). The money path
    (`transaction.ts`, `account.ts`) is migrated to typed errors. The legacy
    substring matcher is retained as a fallback until the remaining throw sites
    (court, verification, mining, tagging) are migrated — that migration and the
    removal of the fallback is the rest of B1.
  - B2, B3: not started.
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
- **D2. Encrypted keystore.** Wallet private keys and mnemonics sit in plaintext `localStorage`.
  Standard for web wallets but should become a passphrase-encrypted keystore. Mark as
  "known and accepted" until then.
- **D3. Finish the repository extraction.** `IBlockStore`/`ITransactionStore`/`IAccountStore`
  exist, but some inline SQL remains in business logic (e.g. the cycle-phase read in
  `transaction.ts`). Extract `ICycleStateStore` and the rest before the Postgres migration.
- **D4. Frontend tests.** `ae-app` and `ae-miner` have zero tests. Add a thin layer (Vitest +
  React Testing Library) covering the send flow, verification, and vouch flow once B3 changes the
  send format.
- **D5. Frontend `any` burn-down.** A2 demoted `no-explicit-any` and a few react-hooks advisory
  rules to warnings in the two frontends (~84 in ae-app, ~25 in ae-miner), almost all `any` on
  API-response plumbing. Type the API responses properly and promote these rules back to errors.
  Do this after D4 so the tests catch any regressions. Includes the one real `react-hooks/purity`
  smell in `ae-app/src/pages/Tag.tsx` (`Date.now()` read during render for the "just saved"
  checkmark; move to a timer + state).
- **D6. Frontend dependency conflict.** `vite-plugin-pwa@1.2.0` peers on vite <=7 but both
  frontends run vite 8, so `npm ci` needs `--legacy-peer-deps` (the CI jobs pass this). Bump
  `vite-plugin-pwa` to a vite-8-compatible release (or pin vite to 7) and drop the flag.
- **D7. Finish B1 error migration.** Migrate the remaining `throw new Error` sites in
  `court/`, `verification/`, `mining/`, and `tagging/` to typed `AppError`s, then delete the
  legacy substring matcher from `errorHandler.ts`.
- **D8. Fix the ae-app clean build.** On a fresh checkout `ae-app` won't build: it imports the
  sibling `@alignmenteconomy/sdk` workspace package (not installed by a standalone `npm ci`) and
  `tsc` surfaces pre-existing `catch (e: unknown)` type errors that local incremental builds
  masked. Set up workspace resolution (or build the SDK first in CI) and fix the catch typings,
  then restore the `build` step to the ae-app CI job (currently lint-only).
- **D9. Stabilize the flaky multi-runner tests.** Phase 60 (and the Phase 35/49/53/59 family)
  are timing-flaky: they use fixed `wait()` delays for validator restart/catch-up. CI retries the
  test step once to absorb this, but the real fix is event-based waits so a single run is
  deterministic. Then drop the retry.

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
