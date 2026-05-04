import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { processTransaction, TransactionInput, transactionStore } from '../../core/transaction.js';
import { PRECISION } from '../../core/constants.js';
import { getAccount } from '../../core/account.js';
import { authMiddleware } from '../middleware/auth.js';
import { eventBus } from '../websocket.js';
import type { PointType } from '../../core/types.js';
import type { WireTransaction } from '../../network/block-validator.js';

/**
 * Optional callback fired AFTER a tx has been successfully committed to the
 * local DB via processTransaction. Runner provides this in BFT mode so
 * tx-gossip kicks in: every validator's findUnblockedTransactions sees the
 * tx, so whichever validator is elected proposer can include it. In
 * Authority mode this is omitted — the authority's own block-production
 * loop scoops up unblocked txs from its DB, no gossip needed.
 */
export type TxBroadcaster = (tx: WireTransaction) => void;

export function transactionRoutes(
  db: DatabaseSync,
  txBroadcaster?: TxBroadcaster,
): Router {
  const router = Router();

  // POST /transactions (processTransaction does its own sig verification)
  router.post('/', (req, res, next) => {
    try {
      const { payload, accountId, timestamp, signature } = req.body;
      const { to, amount, pointType, isInPerson, memo } = payload;

      if (!to || amount == null || !pointType) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'Missing required fields: to, amount, pointType' },
        });
        return;
      }

      if (amount <= 0) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_AMOUNT', message: 'Amount must be positive', details: { amount } },
        });
        return;
      }

      // Convert display units to storage (bigint at 10^8 precision)
      const storageAmount = BigInt(Math.round(amount * Number(PRECISION)));

      // Re-sign with storage-level payload format (processTransaction verifies this)
      // The API auth middleware already verified the user's identity.
      // processTransaction does its own verification using the internal payload format.
      // We pass the original signature; the caller must sign the internal format.
      const input: TransactionInput = {
        from: accountId,
        to,
        amount: storageAmount,
        pointType: pointType as PointType,
        isInPerson: isInPerson ?? false,
        memo: memo ?? '',
        timestamp,
        signature,
      };

      const result = processTransaction(db, input);
      const sender = getAccount(db, accountId)!;

      // Gossip the tx so every peer's findUnblockedTransactions sees it.
      // Fire-and-forget — don't block the API response on gossip latency.
      // Errors swallowed (a bad PeerManager broadcast shouldn't fail the
      // user's submission, which has already committed locally).
      if (txBroadcaster) {
        try {
          txBroadcaster({
            id: result.transaction.id,
            from: result.transaction.from,
            to: result.transaction.to,
            amount: result.transaction.amount.toString(),
            fee: result.fee.toString(),
            netAmount: result.netAmount.toString(),
            pointType: result.transaction.pointType,
            isInPerson: result.transaction.isInPerson,
            memo: result.transaction.memo,
            signature: result.transaction.signature,
            timestamp: result.transaction.timestamp,
          });
        } catch {
          // intentionally silent — broadcast is best-effort
        }
      }

      // Notify both parties over WebSocket so their balances refresh live
      eventBus.emit('balance:updated', {
        accountId: input.from,
        reason: 'transaction:sent',
        transactionId: result.transaction.id,
      });
      eventBus.emit('balance:updated', {
        accountId: input.to,
        reason: 'transaction:received',
        transactionId: result.transaction.id,
      });
      eventBus.emit('transaction:sent', {
        accountId: input.from,
        to: input.to,
        amount: result.transaction.amount.toString(),
        pointType: result.transaction.pointType,
        transactionId: result.transaction.id,
      });
      eventBus.emit('transaction:received', {
        accountId: input.to,
        from: input.from,
        amount: result.netAmount.toString(),
        pointType: result.transaction.pointType,
        transactionId: result.transaction.id,
      });

      res.json({
        success: true,
        data: {
          transaction: {
            id: result.transaction.id,
            from: result.transaction.from,
            to: result.transaction.to,
            amount: result.transaction.amount.toString(),
            fee: result.fee.toString(),
            netAmount: result.netAmount.toString(),
            pointType: result.transaction.pointType,
          },
          newBalance: sender.earnedBalance.toString(),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /transactions/:id
  router.get('/:id', (req, res, next) => {
    try {
      const tx = transactionStore(db).findTransactionById(req.params.id as string);
      if (!tx) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found' } });
        return;
      }
      res.json({ success: true, data: tx, meta: { timestamp: Math.floor(Date.now() / 1000) } });
    } catch (e) { next(e); }
  });

  return router;
}
