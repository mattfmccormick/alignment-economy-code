# Platform Track build plan (custodial signup)

The AE wallet currently only supports self-custody (write down 12 words, lose them and your account is gone). This plan adds a second on-ramp where users sign up with email and password, the platform holds an encrypted vault for them, and password reset works the way Gmail's does. Most people will pick this path. Power users keep the self-custody flow.

This document is the source of truth for the work. Update it as phases land.

## Decisions locked in (do not relitigate)

| Decision | Choice |
|---|---|
| Architecture | Soft Flavor 2: server holds an encrypted recovery blob it can decrypt only through a verified recovery flow. Normal operation is zero-knowledge. |
| Onboarding | Two tiles before account creation. Self-custody on the left, platform on the right. Each tile says you can switch sides anytime. |
| Self-custody copy | "For people who have used a crypto wallet before. You hold the 12 words. Lose them, lose the account." |
| Platform copy | "First time? Use the platform. Sign in with email and password, we keep the account safe. You can switch to self-custody whenever you want." |
| Recovery | Gmail-style password reset works. Server uses its long-term private key to decrypt the recovery blob, only after the user passes a verification flow (email click plus cooldown plus optional 2FA). |
| 2FA | Recommended at signup, not required. TOTP or passkey. |
| AE balance | Both tracks share the same protocol. A platform user's points live on chain at their AE address, same daily mint, same rules. The platform is just the key store. |
| Session model | Sign in once, password decrypts the vault, private key cached in memory for the session, password re-prompt on timeout. |
| Costs | Yes to spending on servers. Cheapest VPS for v0. |
| Where it lives | New service `platform-server/` at the repo root. Separate from `ae-node`. Wallet hits it over HTTPS. |
| No em dashes | Style preference. Use commas, parentheses, or sentences. |

## How the cryptography works

At signup, the wallet generates a fresh AE keypair locally. It then produces two encrypted copies of the AE private key:

1. **Vault blob.** Encrypted with a key derived from the user's password (Argon2id then AES-GCM, or chacha20-poly1305). Only the user's password unlocks it. Server stores this but cannot read it.
2. **Recovery blob.** Encrypted using an ECIES envelope: client generates a one-time x25519 keypair, computes the shared secret with the server's long-term x25519 public key, encrypts the same plaintext with chacha20-poly1305. Server stores this. Server CAN decrypt it using its long-term private key plus the ephemeral public key from the envelope, but only chooses to during a verified recovery.

Both blobs hold the same plaintext (the AE private key, plus any other secret material the client wants to bundle, like the mnemonic).

Daily sign-in: user types password, vault blob unlocks, AE private key lives in memory until session ends. Server never sees the plaintext.

Forgot password: user clicks "forgot password," gets an email link, waits out the cooldown (24h default), then completes recovery. The server decrypts the recovery blob server-side, returns the plaintext to the client over TLS, the client re-encrypts with the new password to make a new vault blob, uploads it. Server rotates its recovery keypair after the recovery completes so the old recovery blob is permanently invalidated.

## Phases

### Phase 1: Scaffold (DONE)

Committed as `0489191`. 6/6 tests pass.

- [x] `platform-server/` directory at repo root
- [x] `package.json`, `tsconfig.json`, dependencies (Express, argon2, @noble/curves, @noble/ciphers)
- [x] SQLite schema v1: `users`, `sessions`, `email_verifications`, `recovery_tokens`
- [x] Crypto module: Argon2id, x25519 ECIES recovery envelope, HMAC session tokens
- [x] Config loader with dev secret fallback (writes to `data/` so restarts are stable)
- [x] Express boot, `/api/v1/health`
- [x] `phase1.test.ts` covers boot, schema, password hash round-trip, ECIES round-trip, ECIES wrong-key rejection, session token tamper / expiry

### Phase 2: Auth endpoints (DONE)

Committed as `40b1fd7`. 10/10 tests pass.

- [x] `POST /api/v1/signup`
  - Body: `{ email, passwordHash (Argon2 of password on the client), vaultBlob, recoveryBlob, accountId, ephemeralPubKeyHex (already inside recoveryBlob, but accepted for forward compat) }`
  - Server: stores user row, mints session token, returns `{ sessionToken, recoveryPublicKey }`
  - Rejects duplicate email with 409
- [x] `POST /api/v1/signin`
  - Body: `{ email, passwordProof }` where passwordProof is a separate Argon2 derivation the client can prove without sending the raw password
  - Server: verifies password, mints session token, returns `{ sessionToken, vaultBlob, accountId }`
  - Rejects unknown email or bad password with 401 after constant-time check
- [x] `POST /api/v1/signout`
  - Header: `Authorization: Bearer <sessionToken>`
  - Server: marks session revoked
- [x] `GET /api/v1/me`
  - Header: `Authorization: Bearer <sessionToken>`
  - Returns `{ userId, email, accountId, emailVerified, twoFactorEnabled }`
- [x] `phase2.test.ts`: signup happy path, duplicate email rejection, signin happy path, wrong password rejection, signout revokes session, /me returns the right user, /me 401 without a token (10/10 pass, all the cases listed plus duplicate accountId rejection)

### Phase 3: Recovery flow (DONE)

Phase 3 ships in the same commit cycle. 8/8 tests pass.

- [x] `POST /api/v1/recover/start`
  - Body: `{ email }`
  - Server: if email exists, creates a recovery token, schedules an email (Phase 4 wires the actual sender), sets `eligible_at = now + cooldown`
  - Always returns 200 (do not leak which emails are registered)
- [x] `POST /api/v1/recover/verify`
  - Body: `{ token }`
  - Marks token verified (email link clicked)
- [x] `POST /api/v1/recover/complete`
  - Body: `{ token, newPasswordHash, newVaultBlob, newRecoveryBlob }`
  - Server: checks token is verified, cooldown elapsed, not expired, not already completed; decrypts the OLD recovery blob with its current long-term private key (sanity check the plaintext); updates user with new password hash plus new vault + recovery blobs; rotates the server long-term recovery keypair if policy says so; marks token completed
- [x] `phase3.test.ts`: full happy path including cooldown shortcut for tests; rejects unverified token; rejects too-soon-after-start; rejects expired; rejects already completed; full revoke-all-sessions + sign-in-with-new-password assertion. (8/8 pass.)

### Phase 4: Email sending (DONE)

- [x] Dev mode: log verification and recovery links to stdout so the wallet can drive flows locally without SMTP
- [x] Prod mode: SMTP via env-configurable provider (Resend, SendGrid, Postmark) using nodemailer
- [x] Templates: signup verification (template exists, wiring optional), recovery start (wired into /recover/start)
- [x] `phase4.test.ts` (6/6 pass): template renders the token + cooldown, /recover/start invokes the injected mailer with the right shape, unknown email skips the mailer entirely, mailer failure does not poison the user-facing response, SmtpMailer throws helpfully when its env vars are missing

### Phase 5: SDK additions to `@alignmenteconomy/sdk` (DONE)

`PlatformClient` class shipped in `sdk/src/platform.ts`. 6/6 integration tests against a real spawned platform-server. Full SDK suite is now 20/20.

- [x] `client.signup({ email, password, existingKeypair? })`: client generates (or reuses) an AE keypair, derives a per-user PBKDF2-SHA256 vault key (600k iterations, email-anchored salt), encrypts the AE private key with AES-256-GCM, also encrypts to the server's recovery x25519 public key via chacha20-poly1305 envelope, posts /signup, returns `{sessionToken, expiresAt, accountId, privateKey, publicKey}`
- [x] `client.signin({ email, password })`: posts /signin, decrypts the vault locally, returns same session shape
- [x] `client.signout(sessionToken)`
- [x] `client.me(sessionToken)`
- [x] `client.getRecoveryPublicKey()` (new GET /recovery-pubkey endpoint added to platform-server)
- [x] `client.recoverStart({ email })`
- [x] `client.recoverVerify({ token })`
- [x] `client.recoverComplete({ email, token, newPassword })`: drives the full server-side decrypt → client re-encrypt → server commit dance through new `POST /recover/peek` endpoint (also added to platform-server). Returns a fresh signed-in session under the new password.
- [x] Vault helpers (PBKDF2 vault key derivation, AES-GCM encrypt/decrypt, x25519 + chacha20-poly1305 ECIES envelope) inlined in `sdk/src/platform.ts`
- [x] `sdk/tests/platform.test.ts` spawns a real platform-server and exercises the full happy paths plus wrong-password 401 plus signout-revokes-session plus full recovery flow plus signup-with-existing-keypair (import) (6/6 pass)

### Phase 6: Wallet UI (DONE)

Verified end to end in a real browser. Welcome → Create Account → track picker → Use the platform → email+password form → dashboard with daily mint, share-of-economy, verify CTA. Same flow works for the self-custody side. Sign In has tabs for both tracks plus a Forgot password link.

- [x] New screen: two tiles before account creation
  - Left tile: "I'll hold my own keys" (self-custody, today's flow)
  - Right tile: "Use the platform" (custodial, the new flow)
  - Both note that you can switch later
- [x] Platform signup form: email + password + confirm password
- [x] Platform signin form: email + password, with a "Forgot password" link. Lives under a tab on the existing sign-in screen alongside the self-custody recovery-phrase form.
- [x] Forgot password flow: email entry → token entry + new password (dev mode pre-fills the token from the server response; prod will require pasting from email).
- [x] Session persisted in localStorage via `lib/platform.ts`. `loadWallet()` in `lib/keys.ts` was unified across tracks so the rest of the wallet UI is track-agnostic.
- [x] Platform signup also registers the AE account on chain via `api.createAccount(publicKey)` so the daily mint flows immediately.
- [x] CORS opened on platform-server so the wallet at a different origin can talk to it.
- [x] Optional 2FA setup screen (recommended-not-required) — Phase 6.5 shipped. Platform-server has `/2fa/enroll`, `/2fa/confirm`, `/2fa/disable` (6 tests passing). SDK exposes `enroll2FA`, `confirm2FA`, `disable2FA`, and `signin({ code })`. Wallet More page has a "Two-factor auth" card for platform users that scans the otpauth URI as a QR via `qrcode` and confirms with a 6-digit code; the disable flow re-prompts for a current code. Sign-in catches `TOTP_REQUIRED` and routes to a dedicated `platform-totp` screen so the password is only typed once.
- [x] Session expiry prompt: when the wallet detects an expired session, prompt for password to re-decrypt the vault. Phase 6.7 shipped. `lib/platform.ts` exposes `isSessionExpired()`. New `SessionReauthModal` component takes the password (and TOTP if 2FA is on) and calls `/signin` to refresh the token. More page wraps its platform-server calls (`/me`, `/2fa/enroll`, `/2fa/confirm`, `/2fa/disable`) in a `withSession` helper that opens the modal on a local expiry or 401 and replays the original call after a successful re-auth, so the user never has to click the same button twice.
- [x] Wallet "Switch to self-custody" action on the More page for platform users (Phase 6.6 shipped, `4af5f9e`). Verified end to end: platform-track user opens More → sees Switch card → warning → reveal private key → confirm checkboxes → save self-custody copy → page reloads → wallet now operates in self-custody mode with the same AE account on chain. Platform session optionally kept as a backup.

### Phase 7: Deploy (artifacts done, waiting on host choice)

Code-side everything is ready. Pick a host and run the commands in `docs/deploy-platform-server.md`. Three paths shipped:

- [x] **Dockerfile**: multi-stage build, ~200MB runtime image, non-root, /data volume
- [x] **Fly.io config** (`platform-server/fly.toml`): smallest VM, free tier, auto-TLS
- [x] **Render.com blueprint** (`platform-server/render.yaml`): single-blueprint deploy, free tier
- [x] **Self-hosted stack** (`platform-server/docker-compose.yml` + `Caddyfile` + `.env.example`): Hetzner / DigitalOcean / any Docker host
- [x] **GitHub Actions CI** (`.github/workflows/platform-server.yml`): runs the 30-test suite on every push to `platform-server/`, builds and pushes a Docker image to `ghcr.io/mattfmccormick/ae-platform-server` on push to main
- [x] **Deploy guide**: `docs/deploy-platform-server.md`
- [ ] **Pick a host + run the steps.** Manual one-time setup; deploy guide has the exact commands per option.
- [ ] **Smoke test from installed wallet**: build the wallet installer with `VITE_PLATFORM_URL=https://...` baked in, install on a fresh machine, walk through email + password signup, verify daily mint shows up. Same flow that worked in dev.
- [ ] **Wire CI auto-deploy** once a host is picked: append a `flyctl deploy` / Render webhook / SSH step to the workflow. Stub callout in the deploy doc.

## Open questions to answer before each phase

- Phase 2: what's the password proof format on the wire? Argon2 hash of the password with a public salt derived from the email? Same parameters as the server uses for the password_hash column?
- Phase 3: cooldown duration. 24 hours is the default in the config. Should it be configurable per user (e.g. high-value account opts into 72 hours)?
- Phase 4: which email provider? Resend has a generous free tier and the cleanest API.
- Phase 5: where does the AE private key live in the wallet UI's memory? Same `loadWallet()` interface as today, or a new `loadPlatformWallet()` that re-derives from a cached session?
- Phase 6: 2FA UI: where exactly does the QR code show up? After signup or as an opt-in from the More page?
- Phase 7: domain. Do we have `alignmenteconomy.org` provisioned for subdomains?

Resolve each before that phase starts. Or pick the obvious default in the moment and move on.

## How to track progress

After each phase, check off the boxes here and add a one-line entry to CLAUDE.md's "Done" section. When all seven phases land, mark the whole platform track complete in CLAUDE.md's M1 list.
