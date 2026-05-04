import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createAccount, getAccount, getTotalEarnedPool } from '../../core/account.js';
import { transactionStore } from '../../core/transaction.js';
import { getCycleState } from '../../core/day-cycle.js';
import type { AccountType } from '../../core/types.js';

export function accountRoutes(db: DatabaseSync): Router {
  const router = Router();

  // POST /accounts - create new account (no auth).
  //
  // Two modes:
  //   1. Client custody (preferred for real users): client generates a BIP39
  //      mnemonic, derives the ML-DSA keypair, and sends ONLY the publicKey.
  //      The server stores it; the private key never crosses the network.
  //      Field: { type, publicKey }.
  //   2. Server-generated keypair (legacy, useful for tests): omit publicKey.
  //      The server creates the keypair and returns the privateKey ONCE.
  //
  // New accounts always start at percentHuman: 0. Score is earned through
  // miner verification panels, vouches, and evidence — never granted by a
  // server flag. This is the protocol's single source of identity truth.
  router.post('/', (req, res, next) => {
    try {
      const body = req.body?.payload || req.body || {};
      const { type, publicKey } = body;
      const validTypes: AccountType[] = ['individual', 'company', 'government', 'ai_bot'];
      if (!validTypes.includes(type)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_TYPE', message: `Invalid account type. Must be one of: ${validTypes.join(', ')}` },
        });
        return;
      }

      // Validate provided public key shape (hex, ML-DSA-65 = 1952 bytes = 3904 hex chars)
      if (publicKey !== undefined && publicKey !== null) {
        if (typeof publicKey !== 'string' || publicKey.length !== 3904 || !/^[0-9a-fA-F]+$/.test(publicKey)) {
          res.status(400).json({
            success: false,
            error: { code: 'INVALID_PUBLIC_KEY', message: 'publicKey must be a 1952-byte hex string (ML-DSA-65)' },
          });
          return;
        }
      }

      const currentDay = getCycleState(db).currentDay;
      const result = createAccount(db, type, currentDay, 0, publicKey || undefined);
      // In client-custody mode, privateKey is empty — the client already holds it.
      // In legacy mode, the server-generated privateKey is returned ONCE.
      res.json({
        success: true,
        data: {
          account: serializeAccount(result.account),
          publicKey: result.publicKey,
          privateKey: result.privateKey || undefined,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /accounts/:id
  router.get('/:id', (req, res, next) => {
    try {
      const account = getAccount(db, req.params.id);
      if (!account) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Account not found: ${req.params.id}` },
        });
        return;
      }

      const totalEarned = getTotalEarnedPool(db);
      const percentOfEconomy = totalEarned > 0n
        ? Number((account.earnedBalance + account.lockedBalance) * 10000n / totalEarned) / 100
        : 0;

      res.json({
        success: true,
        data: {
          ...serializeAccount(account),
          percentOfEconomy,
          dailyAllocationEligible: account.type === 'individual' && account.isActive,
          spendMultiplier: account.percentHuman / 100,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /accounts/:id/transactions
  router.get('/:id/transactions', (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = (page - 1) * limit;

      const txStore = transactionStore(db);
      const accountId = req.params.id as string;
      const total = txStore.countTransactionsByAccount(accountId);
      const txs = txStore.findTransactionsByAccount(accountId, { limit, offset });

      res.json({
        success: true,
        data: {
          transactions: txs,
          total,
          page,
          limit,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  return router;
}

function serializeAccount(acct: NonNullable<ReturnType<typeof getAccount>>) {
  return {
    id: acct.id,
    type: acct.type,
    publicKey: acct.publicKey,
    earnedBalance: acct.earnedBalance.toString(),
    activeBalance: acct.activeBalance.toString(),
    supportiveBalance: acct.supportiveBalance.toString(),
    ambientBalance: acct.ambientBalance.toString(),
    lockedBalance: acct.lockedBalance.toString(),
    percentHuman: acct.percentHuman,
    joinedDay: acct.joinedDay,
    isActive: acct.isActive,
    protectionWindowEnd: acct.protectionWindowEnd,
    createdAt: acct.createdAt,
  };
}

