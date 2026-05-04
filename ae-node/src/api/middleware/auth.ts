import { Request, Response, NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { verifyPayload } from '../../core/crypto.js';
import { getAccount } from '../../core/account.js';
import { getMinerByAccount } from '../../mining/registration.js';

declare global {
  namespace Express {
    interface Request {
      accountId?: string;
      minerId?: string;
    }
  }
}

export function authMiddleware(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { accountId, timestamp, signature, payload } = req.body;

    if (!accountId || !timestamp || !signature) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_MISSING', message: 'Missing accountId, timestamp, or signature' },
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

    const valid = verifyPayload(payload || {}, timestamp, signature, account.publicKey);
    if (!valid) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_INVALID', message: 'Invalid signature' },
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
