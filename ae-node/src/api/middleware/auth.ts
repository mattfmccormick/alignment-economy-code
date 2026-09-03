import { Request, Response, NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { verifyPayload } from '../../core/crypto.js';
import { getAccount } from '../../core/account.js';
import { getMinerByAccount } from '../../mining/registration.js';

declare global {
  // Module augmentation of Express's Request is the standard pattern here;
  // it genuinely requires `namespace`, so the rule is disabled for this block.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: string;
      minerId?: string;
    }
  }
}

export function authMiddleware(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Default to {} rather than destructuring req.body directly.
    //
    // express.json() leaves req.body undefined when there is no parseable JSON
    // body — no Content-Type, an empty body, or a method it does not treat as
    // carrying one. Destructuring that threw a TypeError, which the error
    // handler turned into a 500. So the single most likely malformed request,
    // "auth-gated route called with no body at all", reported itself as a
    // server fault instead of the 401 it is, on every auth-gated route.
    const { accountId, timestamp, signature, payload } = req.body ?? {};

    if (!accountId || !timestamp || !signature) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_MISSING', message: 'Missing accountId, timestamp, or signature' },
      });
      return;
    }

    // The payload must be PRESENT and an object, even when empty (audit #15).
    //
    // Before this, an absent payload was silently treated as a signature over
    // {} (`verifyPayload(payload || {}, ...)`). A caller could sign {}, omit
    // the payload entirely, and pass — while route handlers that read a
    // parameter out of req.body rather than out of the signed payload then
    // acted on UNSIGNED data. Requiring a present object closes that: an empty
    // payload is still fine (some routes legitimately sign {}), but it must be
    // sent explicitly as `payload: {}`, so what the route sees is what was
    // signed. Every first-party client already sends the payload object.
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_MISSING_PAYLOAD',
          message: 'Request must include a signed `payload` object (send {} if there are no parameters)',
        },
      });
      return;
    }

    // Replay protection: reject timestamps > 5 minutes old
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_EXPIRED', message: 'Request timestamp expired (>5 minutes)' },
      });
      return;
    }

    const account = getAccount(db, accountId);
    if (!account) {
      res.status(401).json({
        success: false,
        error: { code: 'ACCOUNT_NOT_FOUND', message: `Account not found: ${accountId}` },
      });
      return;
    }

    const valid = verifyPayload(payload, timestamp, signature, account.publicKey);
    if (!valid) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_INVALID', message: 'Invalid signature' },
      });
      return;
    }

    // Reject a transaction signature reused as an auth envelope (audit #3).
    //
    // signPayload/verifyPayload sign JSON.stringify(payload)+timestamp with no
    // domain tag, and transactions sign the same way, so a signature that
    // authorises a PAYMENT also verifies here as a login for any auth-gated
    // route within the 5-minute window. A transaction payload is uniquely
    // shaped — from + to + amount + pointType together — and no legitimate auth
    // payload carries that shape, so refusing it blocks the crossover without
    // touching the transaction path or any client. (Publishing signatures was
    // the other half and is fixed separately; full domain separation, which
    // binds a per-purpose tag into the signed bytes across the node and both
    // apps, is the complete fix and is tracked in CLAUDE.md.)
    const pl = (payload ?? {}) as Record<string, unknown>;
    if ('from' in pl && 'to' in pl && 'amount' in pl && 'pointType' in pl) {
      res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TX_SIGNATURE_REUSE',
          message: 'A transaction signature cannot be used to authenticate a request',
        },
      });
      return;
    }

    req.accountId = accountId;
    next();
  };
}

export function minerAuthMiddleware(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.accountId) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    const miner = getMinerByAccount(db, req.accountId);
    if (!miner) {
      res.status(403).json({
        success: false,
        error: { code: 'NOT_A_MINER', message: 'Account is not an active miner' },
      });
      return;
    }

    req.minerId = miner.id;
    next();
  };
}
