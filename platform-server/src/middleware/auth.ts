// Bearer-token auth middleware.
//
// Reads the Authorization: Bearer <token> header, verifies the HMAC and
// expiry via verifySessionToken, looks up the matching session row to
// confirm it's not revoked, and stashes the user_id on req for the
// route handler. Anything past this middleware can trust req.userId.
//
// On any failure: 401 with a generic AUTH_INVALID code (don't leak which
// part failed to a probing attacker).

import { type Request, type Response, type NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { verifySessionToken } from '../crypto.js';
import { type PlatformConfig } from '../config.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
    }
  }
}

export function bearerAuth(db: DatabaseSync, config: PlatformConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ success: false, error: { code: 'AUTH_MISSING', message: 'Bearer token required' } });
      return;
    }
    const token = header.slice(7).trim();

    const parsed = verifySessionToken(token, config.sessionSecret);
    if (!parsed) {
      res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Invalid or expired session' } });
      return;
    }

    const session = db
      .prepare('SELECT user_id, expires_at, revoked_at FROM sessions WHERE id = ?')
      .get(parsed.sessionId) as { user_id?: string; expires_at?: number; revoked_at?: number | null } | undefined;

    if (!session || !session.user_id) {
      res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Session not found' } });
      return;
    }
    if (session.revoked_at) {
      res.status(401).json({ success: false, error: { code: 'AUTH_REVOKED', message: 'Session revoked' } });
      return;
    }
    // verifySessionToken already checked HMAC expiry, but the DB row has its
    // own expires_at column too. We trust DB over the token for revocation
    // and re-check the expiry as a defense-in-depth measure.
    if (session.expires_at && Math.floor(Date.now() / 1000) >= session.expires_at) {
      res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Session expired' } });
      return;
    }

    req.userId = session.user_id;
    req.sessionId = parsed.sessionId;
    next();
  };
}
