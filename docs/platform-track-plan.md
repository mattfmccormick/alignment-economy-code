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

### Phase 4: Email sending

- [ ] Dev mode: log verification and recovery links to stdout so the wallet can drive flows locally without SMTP
- [ ] Prod mode: SMTP via env-configurable provider (Resend, SendGrid, Postmark)
- [ ] Templates: signup verification, recovery start
- [ ] `phase4.test.ts`: dev logger captures the expected URLs, smtp wiring exercised with a mock transporter

### Phase 5: SDK additions to `@alignmenteconomy/sdk`

- [ ] `client.signupPlatform({ email, password })`: client generates AE keypair, derives password key, encrypts vault, encrypts recovery, posts signup, stores session token
- [ ] `client.signinPlatform({ email, password })`: posts signin, decrypts vault locally, returns the in-memory private key
- [ ] `client.signoutPlatform()`
- [ ] `client.recoverStart({ email })`
- [ ] `client.recoverComplete({ token, newPassword })`: derives new password key, decrypts the OLD recovery blob locally if the server returned plaintext, re-encrypts to a new vault blob, posts complete
- [ ] Vault helpers: `encryptVault(privateKey, password)`, `decryptVault(blob, password)`, `encryptRecovery(privateKey, serverPubKey)`
- [ ] SDK tests against a spawned platform-server

### Phase 6: Wallet UI

- [ ] New screen: two tiles before account creation
  - Left tile: "I'll hold my keys" (self-custody, today's flow)
  - Right tile: "Use the platform" (custodial, the new flow)
  - Both note that you can switch later
- [ ] Platform signup form: email + password + confirm password, plus an optional 2FA setup screen after
- [ ] Platform signin form: email + password, with a "forgot password" link
- [ ] Forgot password flow: email entry, then a "check your email" confirmation, then the link in the email lands on a reset screen with the new password form
- [ ] Session expiry prompt: when the wallet detects an expired session, prompt for password to re-decrypt the vault
- [ ] Wallet "Switch to self-custody" action on the More page for platform users: exports the mnemonic, instructs the user to write it down, optionally deletes the platform vault

### Phase 7: Deploy

- [ ] Cheapest VPS (Hetzner CX11 around $5/mo, or DigitalOcean droplet)
- [ ] Domain or subdomain (e.g. `platform.alignmenteconomy.org`)
- [ ] HTTPS via Let's Encrypt
- [ ] Reverse proxy (Caddy or nginx)
- [ ] `systemd` unit or PM2 for process management
- [ ] GitHub Actions CI workflow for deploy on push to main
- [ ] Smoke test from the installed wallet hitting the production platform
- [ ] Production env vars for `AE_PLATFORM_RECOVERY_PRIVATE_KEY` and `AE_PLATFORM_SESSION_SECRET` (generate fresh, never commit)

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
