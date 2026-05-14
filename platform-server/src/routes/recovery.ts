// Recovery routes: forgot-password flow for the platform track.
//
// Three-step flow (Soft Flavor 2):
//
//   1. POST /api/v1/recover/start { email }
//      Server creates a recovery_tokens row with eligible_at = now +
//      cooldown (24h default), expires_at = now + 7 days. Emails the
//      user a link containing the token (Phase 4 wires the actual
//      email). Always returns 200 with the same shape regardless of
//      whether the email is registered (so a probe can't enumerate).
//      In dev mode, the token is included in the response for testing.
//
//   2. POST /api/v1/recover/verify { token }
//      Marks the token verified (proves the user has access to the
//      inbox). Doesn't yet allow recovery to complete; the cooldown
//      still has to elapse.
//
//   3. POST /api/v1/recover/complete { token, newPassword,
//                                      newVaultBlob, newRecoveryBlob }
//      Server checks: token exists, not expired, not already completed,
//      verified, and cooldown elapsed. Decrypts the OLD recovery_blob
//      with its long-term recovery private key as a sanity check that
//      the recovery infrastructure is healthy. Updates the user with
//      the new password hash, new vault blob, new recovery blob. Revokes
//      all existing sessions for that user (forces signin with the new
//      password). Marks the token completed.
//
// Why this shape: the cooldown is the security spine. Even if an
// attacker phishes the user's email and clicks the link, they have to
// wait 24 hours before they can reset. During that window, the real
// user can notice and cancel. Combined with optional 2FA (Phase 6+),
// this matches the recovery story of every reasonable web2 platform
// without giving up the no-central-authority story for users on the
// self-custody track.
//
// "Recovery shortcut" for tests: pass `now: number` to /complete to
// override the wall clock check, ONLY when AE_PLATFORM_ALLOW_TEST_NOW
// is set. Real deployments leave it unset.

import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { hashPassword, randomToken, decryptRecoveryBlob } from '../crypto.js';
import { type PlatformConfig } from '../config.js';

interface StartBody { email?: unknown }
interface VerifyBody { token?: unknown }
interface CompleteBody {
  token?: unknown;
  newPassword?: unknown;
  newVaultBlob?: unknown;
  newRecoveryBlob?: unknown;
  /** Test-only: override now() so the cooldown can be skipped. Ignored
   *  unless AE_PLATFORM_ALLOW_TEST_NOW=1. */
  now?: unknown;
}

const RECOVERY_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

function isString(v: unknown, minLen = 1, maxLen = 16384): v is string {
  return typeof v === 'string' && v.length >= minLen && v.length <= maxLen;
}

export function recoveryRoutes(db: DatabaseSync, config: PlatformConfig): Router {
  const router = Router();

  // ── start ───────────────────────────────────────────────────────────
  router.post('/recover/start', (req, res, next) => {
    try {
      const body = (req.body ?? {}) as StartBody;
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      // Always answer the same shape so a probe can't enumerate users.
      const okResponse = { success: true, data: { sent: true } as { sent: boolean; devToken?: string } };

      if (!email || !email.includes('@')) {
        res.json(okResponse);
        return;
      }
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
      if (!user) {
        res.json(okResponse);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const token = randomToken(32);
      db.prepare(
        `INSERT INTO recovery_tokens (token, user_id, created_at, eligible_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        token,
        user.id,
        now,
        now + config.recoveryCooldownSeconds,
        now + RECOVERY_TOKEN_TTL_SECONDS,
      );

      // In dev / test mode, include the token in the response so the
      // wallet can drive the flow without an email server. Phase 4 wires
      // a real email transport.
      if (config.emailMode === 'dev') {
        okResponse.data.devToken = token;
        console.log(`[recover/start] dev mode: token for ${email}: ${token}`);
      }
      res.json(okResponse);
    } catch (e) { next(e); }
  });

  // ── verify ──────────────────────────────────────────────────────────
  router.post('/recover/verify', (req, res, next) => {
    try {
      const body = (req.body ?? {}) as VerifyBody;
      if (!isString(body.token, 1, 256)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'token required' } });
        return;
      }
      const row = db
        .prepare(
          'SELECT token, user_id, expires_at, verified_at, completed_at FROM recovery_tokens WHERE token = ?',
        )
        .get(body.token) as
        | { token: string; user_id: string; expires_at: number; verified_at: number | null; completed_at: number | null }
        | undefined;

      const now = Math.floor(Date.now() / 1000);
      if (!row || row.expires_at < now || row.completed_at !== null) {
        res.status(404).json({ success: false, error: { code: 'TOKEN_INVALID', message: 'Recovery link not valid' } });
        return;
      }

      if (row.verified_at === null) {
        db.prepare('UPDATE recovery_tokens SET verified_at = ? WHERE token = ?').run(now, row.token);
      }
      res.json({ success: true, data: { verified: true } });
    } catch (e) { next(e); }
  });

  // ── complete ────────────────────────────────────────────────────────
  router.post('/recover/complete', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as CompleteBody;
      if (!isString(body.token, 1, 256)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'token required' } });
        return;
      }
      if (!isString(body.newPassword, 8, 1024)) {
        res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be 8 to 1024 chars' } });
        return;
      }
      if (!isString(body.newVaultBlob, 1, 16384) || !isString(body.newRecoveryBlob, 1, 16384)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_BLOB', message: 'newVaultBlob and newRecoveryBlob required' } });
        return;
      }

      const row = db
        .prepare(
          `SELECT token, user_id, eligible_at, expires_at, verified_at, completed_at
           FROM recovery_tokens WHERE token = ?`,
        )
        .get(body.token) as
        | { token: string; user_id: string; eligible_at: number; expires_at: number; verified_at: number | null; completed_at: number | null }
        | undefined;

      const allowTestNow = process.env.AE_PLATFORM_ALLOW_TEST_NOW === '1';
      const now = allowTestNow && typeof body.now === 'number' ? Math.floor(body.now) : Math.floor(Date.now() / 1000);

      if (!row || row.expires_at < now || row.completed_at !== null) {
        res.status(404).json({ success: false, error: { code: 'TOKEN_INVALID', message: 'Recovery link not valid' } });
        return;
      }
      if (row.verified_at === null) {
        res.status(403).json({
          success: false,
          error: { code: 'NOT_VERIFIED', message: 'Click the link in your email before completing recovery' },
        });
        return;
      }
      if (row.eligible_at > now) {
        res.status(403).json({
          success: false,
          error: {
            code: 'COOLDOWN_ACTIVE',
            message: `Recovery cooldown still active. Try again after ${row.eligible_at}`,
            details: { eligibleAt: row.eligible_at, now },
          },
        });
        return;
      }

      // Sanity check: server can still decrypt the OLD recovery_blob. If
      // this throws, the recovery key has rotated and we should not
      // trust the upcoming completion. (This won't happen on a healthy
      // server. It's a guardrail against accidental key loss.)
      const oldUser = db
        .prepare('SELECT recovery_blob FROM users WHERE id = ?')
        .get(row.user_id) as { recovery_blob: string } | undefined;
      if (oldUser?.recovery_blob) {
        try {
          decryptRecoveryBlob(oldUser.recovery_blob, config.recoveryPrivateKey);
        } catch {
          res.status(500).json({
            success: false,
            error: { code: 'RECOVERY_KEY_LOST', message: 'Server-side recovery key cannot decrypt the user vault. Contact support.' },
          });
          return;
        }
      }

      const newHash = await hashPassword(body.newPassword as string);

      db.exec('BEGIN');
      try {
        db.prepare(
          `UPDATE users
             SET password_hash = ?, vault_blob = ?, recovery_blob = ?
           WHERE id = ?`,
        ).run(newHash, body.newVaultBlob as string, body.newRecoveryBlob as string, row.user_id);

        db.prepare('UPDATE recovery_tokens SET completed_at = ? WHERE token = ?').run(now, row.token);

        // Revoke every existing session for that user. The recovering
        // user gets a fresh session below; anyone else who happened to
        // be logged in gets kicked.
        db.prepare(
          `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
        ).run(now, row.user_id);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      res.json({ success: true, data: { recovered: true, userId: row.user_id } });
    } catch (e) { next(e); }
  });

  return router;
}
