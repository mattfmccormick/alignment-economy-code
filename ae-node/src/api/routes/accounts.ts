import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createAccount, getAccount, getTotalEarnedPool } from '../../core/account.js';
import { transactionStore } from '../../core/transaction.js';
import { getCycleState } from '../../core/day-cycle.js';
import { validateBody } from '../middleware/validate.js';
import * as schemas from '../schemas.js';
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
  router.post('/', validateBody(schemas.createAccount), (req, res, next) => {
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

  // GET /accounts/:id/ledger — the transaction_log audit trail: every balance
  // change for this account (receives, fees, daily mint, fee-pool / mining
  // distributions, court bounties, burns, vouch locks/unlocks). Newest first.
  // Powers the miner Income and Audit pages. Route-level pagination is fine at
  // Phase 1 scale; a paginated store query is the Phase 2 optimization.
  router.get('/:id/ledger', (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = (page - 1) * limit;
      const accountId = req.params.id as string;

      const txStore = transactionStore(db);
      const all = txStore.findLogsByAccount(accountId).reverse(); // newest first
      const entries = all.slice(offset, offset + limit);

      res.json({
        success: true,
        data: { entries, total: all.length, page, limit },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /accounts/:id/share-history — the account's share of the total economy
  // (same ratio shown on the wallet home screen) reconstructed day-by-day for
  // the life of the account. Returns one point per protocol day from the day
  // the account joined up to today, oldest first.
  //
  // How it's derived: there is no per-day snapshot table (Phase 1). Instead we
  // start from every account's CURRENT earned+locked balance and walk the
  // transaction_log backwards, undoing each logged change day by day. That
  // makes today's point exactly match the live figure, and each earlier day is
  // the balances as they stood at that day's close. The daily rebase scales
  // everyone equally, so it cancels in the ratio and needs no special handling.
  // A snapshot table can replace this behind the same endpoint at Phase 2.
  router.get('/:id/share-history', (req, res, next) => {
    try {
      const accountId = req.params.id as string;
      const account = getAccount(db, accountId);
      if (!account) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Account not found: ${accountId}` },
        });
        return;
      }

      // Protocol day boundary is 08:59 UTC (32340s past midnight). A timestamp
      // belongs to the day that opened at the most recent 09:00 UTC mint.
      const ANCHOR = 8 * 3600 + 59 * 60;
      const dayKey = (tsSec: number) => Math.floor((tsSec - ANCHOR) / 86400);
      const nowSec = Math.floor(Date.now() / 1000);
      const today = dayKey(nowSec);

      // Live balances + join day for every account. `state` is mutated backwards.
      const accts = db.prepare(
        'SELECT id, earned_balance, locked_balance, created_at FROM accounts'
      ).all() as Array<{ id: string; earned_balance: string; locked_balance: string; created_at: number }>;
      const state = new Map<string, { e: bigint; l: bigint }>();
      const joinDay = new Map<string, number>();
      for (const a of accts) {
        state.set(a.id, { e: BigInt(a.earned_balance), l: BigInt(a.locked_balance) });
        joinDay.set(a.id, dayKey(a.created_at));
      }

      // Every earned/locked balance change, grouped by the day it landed on.
      const rows = db.prepare(
        `SELECT account_id, point_type, balance_before, timestamp
           FROM transaction_log
          WHERE point_type IN ('earned','locked')
          ORDER BY timestamp ASC`
      ).all() as Array<{ account_id: string; point_type: string; balance_before: string; timestamp: number }>;
      const byDay = new Map<number, typeof rows>();
      for (const r of rows) {
        const d = dayKey(r.timestamp);
        const list = byDay.get(d);
        if (list) list.push(r); else byDay.set(d, [r]);
      }

      // Share of the economy as of the end of day k: this account's
      // earned+locked over the sum across every account that had joined by k.
      const shareAt = (k: number): number => {
        let mine = 0n, total = 0n;
        for (const [id, b] of state) {
          if ((joinDay.get(id) ?? 0) > k) continue; // didn't exist yet
          const v = b.e + b.l;
          total += v;
          if (id === accountId) mine += v;
        }
        return total > 0n ? Number((mine * 10000n) / total) / 100 : 0;
      };

      const startDay = Math.max(dayKey(account.createdAt), today - 364); // cap at ~1yr
      const dateFor = (k: number) =>
        new Date((ANCHOR + k * 86400 + 43200) * 1000).toISOString().slice(0, 10);

      const points: Array<{ day: number; date: string; percentOfEconomy: number }> = [
        { day: today, date: dateFor(today), percentOfEconomy: shareAt(today) },
      ];
      // Undo one day at a time: endState(k) = endState(k+1) minus day (k+1)'s rows.
      for (let k = today - 1; k >= startDay; k--) {
        const undo = (byDay.get(k + 1) ?? []).slice().sort((a, b) => b.timestamp - a.timestamp);
        for (const r of undo) {
          const b = state.get(r.account_id);
          if (!b) continue;
          if (r.point_type === 'earned') b.e = BigInt(r.balance_before);
          else b.l = BigInt(r.balance_before);
        }
        points.push({ day: k, date: dateFor(k), percentOfEconomy: shareAt(k) });
      }
      points.reverse(); // oldest first

      res.json({
        success: true,
        data: { points, currentDay: today, joinedDay: account.joinedDay },
        meta: { timestamp: nowSec },
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
    isEscrowed: acct.isEscrowed,
    protectionWindowEnd: acct.protectionWindowEnd,
    createdAt: acct.createdAt,
  };
}

