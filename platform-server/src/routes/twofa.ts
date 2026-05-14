// Two-factor auth routes (TOTP).
//
// Enrollment is a two-step dance so the server doesn't commit a secret
// the user can't actually generate codes for:
//
//   1. POST /api/v1/2fa/enroll   { sessionToken: header }
//      Returns a fresh base32 secret plus an otpauth:// URI. Server
//      does NOT persist anything. The client renders the URI as a QR
//      code; the user adds it to Google Authenticator / 1Password /
//      Authy.
//
//   2. POST /api/v1/2fa/confirm  { secret, code }   (session required)
//      Verifies the code against the secret. If valid, persists
//      `totp_secret` on the user row. From now on /signin requires
//      a `code` field too.
//
// Disable: POST /api/v1/2fa/disable { code }. Server verifies the code
// against the stored secret, then clears the row. Needs both a valid
// session AND a fresh TOTP, so a phisher who only has the password
// can't quietly drop 2FA before the real owner notices.
//
// /signin already exists in routes/auth.ts. It's modified there (not
// here) to honor the totp_secret column when present.

import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { authenticator } from 'otplib';
import { type PlatformConfig } from '../config.js';
import { bearerAuth } from '../middleware/auth.js';

// Allow ±1 window (30s before/after) on every check. Compensates for
// modest clock drift between the user's phone and the server.
authenticator.options = { window: 1 };

// otpauth:// URI uses this as the displayed account name and the
// issuer label in the authenticator app.
const TOTP_ISSUER = 'Alignment Economy';

function isString(v: unknown, min = 1, max = 200): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

export function twofaRoutes(db: DatabaseSync, config: PlatformConfig): Router {
  const router = Router();

  // ── enroll ──────────────────────────────────────────────────────────
  router.post('/2fa/enroll', bearerAuth(db, config), (req, res, next) => {
    try {
      const userId = req.userId!;
      const user = db
        .prepare('SELECT email, totp_secret FROM users WHERE id = ?')
        .get(userId) as { email: string; totp_secret: string | null } | undefined;
      if (!user) {
        res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
        return;
      }
      if (user.totp_secret) {
        // Already enrolled. The flow to swap to a fresh secret is
        // disable-then-enroll; we don't silently overwrite.
        res.status(409).json({
          success: false,
          error: { code: 'TOTP_ALREADY_ENABLED', message: 'Two-factor auth is already on. Disable it first to re-enroll.' },
        });
        return;
      }

      const secret = authenticator.generateSecret();
      const otpauthUri = authenticator.keyuri(user.email, TOTP_ISSUER, secret);
      res.json({ success: true, data: { secret, otpauthUri } });
    } catch (e) { next(e); }
  });

  // ── confirm ─────────────────────────────────────────────────────────
  router.post('/2fa/confirm', bearerAuth(db, config), (req, res, next) => {
    try {
      const userId = req.userId!;
      const body = req.body as { secret?: unknown; code?: unknown };
      if (!isString(body.secret, 16, 256) || !isString(body.code, 6, 8)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'secret and code required' } });
        return;
      }
      const ok = authenticator.check(body.code as string, body.secret as string);
      if (!ok) {
        res.status(401).json({ success: false, error: { code: 'TOTP_INVALID', message: 'Code did not match. Check your authenticator app and try again.' } });
        return;
      }

      // Race guard: if a parallel enroll/confirm already committed a
      // secret, refuse to overwrite. Disable-then-re-enroll is the
      // supported path.
      const existing = db
        .prepare('SELECT totp_secret FROM users WHERE id = ?')
        .get(userId) as { totp_secret: string | null } | undefined;
      if (existing?.totp_secret) {
        res.status(409).json({
          success: false,
          error: { code: 'TOTP_ALREADY_ENABLED', message: 'Two-factor auth is already on.' },
        });
        return;
      }

      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(body.secret, userId);
      res.json({ success: true, data: { enabled: true } });
    } catch (e) { next(e); }
  });

  // ── disable ─────────────────────────────────────────────────────────
  router.post('/2fa/disable', bearerAuth(db, config), (req, res, next) => {
    try {
      const userId = req.userId!;
      const body = req.body as { code?: unknown };
      if (!isString(body.code, 6, 8)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'code required' } });
        return;
      }
      const user = db
        .prepare('SELECT totp_secret FROM users WHERE id = ?')
        .get(userId) as { totp_secret: string | null } | undefined;
      if (!user?.totp_secret) {
        res.status(400).json({ success: false, error: { code: 'TOTP_NOT_ENABLED', message: 'Two-factor auth is not on.' } });
        return;
      }
      const ok = authenticator.check(body.code as string, user.totp_secret);
      if (!ok) {
        res.status(401).json({ success: false, error: { code: 'TOTP_INVALID', message: 'Code did not match.' } });
        return;
      }
      db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(userId);
      res.json({ success: true, data: { disabled: true } });
    } catch (e) { next(e); }
  });

  return router;
}

/**
 * Helper exported for use in routes/auth.ts inside /signin. Given the
 * user's stored secret and the optional code on the request, return
 * `{ ok: true }` if 2FA is either not enabled or the code matches.
 * Otherwise `{ ok: false, code: ... }` with a stable error code.
 */
export function checkSigninTotp(
  storedSecret: string | null,
  providedCode: unknown,
): { ok: true } | { ok: false; code: 'TOTP_REQUIRED' | 'TOTP_INVALID' } {
  if (!storedSecret) return { ok: true };
  if (typeof providedCode !== 'string' || providedCode.length < 6) {
    return { ok: false, code: 'TOTP_REQUIRED' };
  }
  return authenticator.check(providedCode, storedSecret)
    ? { ok: true }
    : { ok: false, code: 'TOTP_INVALID' };
}
