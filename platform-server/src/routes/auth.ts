// Auth routes: signup, signin, signout, me.
//
// Wire shape:
//   POST /api/v1/signup  { email, password, vaultBlob, recoveryBlob, accountId }
//     -> 201 { sessionToken, expiresAt, recoveryPublicKey, userId, accountId }
//     -> 409 EMAIL_TAKEN if email already registered
//     -> 400 INVALID_INPUT on shape failure
//
//   POST /api/v1/signin  { email, password }
//     -> 200 { sessionToken, expiresAt, vaultBlob, accountId, userId }
//     -> 401 AUTH_INVALID on unknown email or wrong password (same code
//        both ways so a probe can't enumerate registered emails)
//
//   POST /api/v1/signout
//     header: Authorization: Bearer <sessionToken>
//     -> 200 { revoked: true }
//     -> 401 if no/invalid session
//
//   GET /api/v1/me
//     header: Authorization: Bearer <sessionToken>
//     -> 200 { userId, email, accountId, emailVerified, twoFactorEnabled }
//
// Password handling: client sends the raw password over TLS. Server
// Argon2id-hashes it for storage; we never persist plaintext. The vault
// blob is encrypted client-side with a key derived from the SAME password
// using a different salt (e.g. SHA-256("vault:" + email)), so even if the
// server's password_hash leaks, the vault stays encrypted (attacker would
// still need to brute-force back to the raw password to derive the vault
// key). This is the Soft Flavor 2 trade-off documented in
// docs/platform-track-plan.md.

import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { hashPassword, verifyPassword, mintSessionToken, randomToken } from '../crypto.js';
import { type PlatformConfig } from '../config.js';
import { bearerAuth } from '../middleware/auth.js';
import { checkSigninTotp } from './twofa.js';

interface SignupBody {
  email?: unknown;
  password?: unknown;
  vaultBlob?: unknown;
  recoveryBlob?: unknown;
  accountId?: unknown;
}

interface SigninBody {
  email?: unknown;
  password?: unknown;
}

// Minimal email shape check. Server-side, we mostly care that the field
// is a non-empty string with one @ and a dot somewhere after; we don't
// need RFC-5322 perfection. Real validity is proved by the verification
// link landing in the inbox.
function looksLikeEmail(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length > 254) return false;
  const at = v.indexOf('@');
  if (at < 1 || at === v.length - 1) return false;
  return v.includes('.', at);
}

function isString(v: unknown, minLen = 1, maxLen = 100000): v is string {
  return typeof v === 'string' && v.length >= minLen && v.length <= maxLen;
}

export function authRoutes(db: DatabaseSync, config: PlatformConfig): Router {
  const router = Router();

  // ── signup ──────────────────────────────────────────────────────────
  router.post('/signup', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as SignupBody;
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!looksLikeEmail(email)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'Email is required' } });
        return;
      }
      if (!isString(body.password, 8, 1024)) {
        res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be 8 to 1024 chars' } });
        return;
      }
      if (!isString(body.vaultBlob, 1, 16384) || !isString(body.recoveryBlob, 1, 16384)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_BLOB', message: 'vaultBlob and recoveryBlob are required' } });
        return;
      }
      if (!isString(body.accountId, 1, 256)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_ACCOUNT_ID', message: 'accountId is required' } });
        return;
      }

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
      if (existing) {
        res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } });
        return;
      }
      const existingAccount = db.prepare('SELECT id FROM users WHERE account_id = ?').get(body.accountId) as { id: string } | undefined;
      if (existingAccount) {
        res.status(409).json({ success: false, error: { code: 'ACCOUNT_TAKEN', message: 'AccountId already linked to another user' } });
        return;
      }

      const passwordHash = await hashPassword(body.password as string);
      const userId = uuid();
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `INSERT INTO users (id, email, password_hash, account_id, vault_blob, recovery_blob, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        email,
        passwordHash,
        body.accountId as string,
        body.vaultBlob as string,
        body.recoveryBlob as string,
        now,
        now,
      );

      // Mint a fresh session straight after signup so the wallet doesn't
      // have to call /signin immediately. Same shape /signin returns.
      const sessionId = randomToken(16);
      const expiresAt = now + config.sessionTtlSeconds;
      db.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      ).run(sessionId, userId, now, expiresAt);
      const sessionToken = mintSessionToken(sessionId, expiresAt, config.sessionSecret);

      res.status(201).json({
        success: true,
        data: {
          userId,
          accountId: body.accountId,
          sessionToken,
          expiresAt,
          recoveryPublicKey: config.recoveryPublicKey,
        },
      });
    } catch (e) { next(e); }
  });

  // ── signin ──────────────────────────────────────────────────────────
  router.post('/signin', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as SigninBody;
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!looksLikeEmail(email) || !isString(body.password, 1, 1024)) {
        // Same 401 the wrong-password path returns. Don't let a malformed
        // request differentiate from a wrong credential.
        res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Invalid email or password' } });
        return;
      }

      const row = db
        .prepare(
          'SELECT id, password_hash, account_id, vault_blob, totp_secret FROM users WHERE email = ?',
        )
        .get(email) as { id: string; password_hash: string; account_id: string; vault_blob: string; totp_secret: string | null } | undefined;

      // Argon2.verify is the expensive bit. If the email doesn't exist we
      // still spend the time so signin response time doesn't leak existence.
      const fakeHash = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const valid = await verifyPassword(row?.password_hash ?? fakeHash, body.password as string);
      if (!row || !valid) {
        res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Invalid email or password' } });
        return;
      }

      // If 2FA is on, the request also needs a valid TOTP code. The wallet
      // submits without a code first and watches for the TOTP_REQUIRED
      // response, then re-submits with the code. The two codes are
      // distinct so the wallet can show the right prompt: TOTP_REQUIRED
      // means "ask for code", TOTP_INVALID means "the code you typed is
      // wrong, try again."
      const codeFromBody = (req.body as { code?: unknown }).code;
      const totpCheck = checkSigninTotp(row.totp_secret, codeFromBody);
      if (!totpCheck.ok) {
        res.status(401).json({
          success: false,
          error: { code: totpCheck.code, message: totpCheck.code === 'TOTP_REQUIRED' ? 'Two-factor code required' : 'Two-factor code invalid' },
        });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const sessionId = randomToken(16);
      const expiresAt = now + config.sessionTtlSeconds;
      db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId, row.id, now, expiresAt);
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
      const sessionToken = mintSessionToken(sessionId, expiresAt, config.sessionSecret);

      res.json({
        success: true,
        data: {
          userId: row.id,
          accountId: row.account_id,
          sessionToken,
          expiresAt,
          vaultBlob: row.vault_blob,
        },
      });
    } catch (e) { next(e); }
  });

  // ── signout ─────────────────────────────────────────────────────────
  router.post('/signout', bearerAuth(db, config), (req, res, next) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, req.sessionId!);
      res.json({ success: true, data: { revoked: true } });
    } catch (e) { next(e); }
  });

  // ── me ──────────────────────────────────────────────────────────────
  router.get('/me', bearerAuth(db, config), (req, res, next) => {
    try {
      const row = db
        .prepare('SELECT id, email, account_id, email_verified_at, totp_secret FROM users WHERE id = ?')
        .get(req.userId!) as { id: string; email: string; account_id: string; email_verified_at: number | null; totp_secret: string | null } | undefined;
      if (!row) {
        // Session was valid but user vanished. Shouldn't happen in practice;
        // return 401 to force re-auth.
        res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'User not found' } });
        return;
      }
      res.json({
        success: true,
        data: {
          userId: row.id,
          email: row.email,
          accountId: row.account_id,
          emailVerified: row.email_verified_at !== null,
          twoFactorEnabled: row.totp_secret !== null,
        },
      });
    } catch (e) { next(e); }
  });

  return router;
}
