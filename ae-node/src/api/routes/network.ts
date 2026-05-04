import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { countActiveParticipants, getTotalEarnedPool } from '../../core/account.js';
import { getFeePool } from '../../core/fee-pool.js';
import { TARGET_EARNED_PER_PERSON } from '../../core/constants.js';

export function networkRoutes(db: DatabaseSync): Router {
  const router = Router();

  // GET /network/status
  router.get('/status', (_req, res, next) => {
    try {
      const state = db.prepare('SELECT * FROM day_cycle_state WHERE id = 1').get() as Record<string, unknown>;
      const participantCount = countActiveParticipants(db);
      const totalEarned = getTotalEarnedPool(db);
      const feePool = getFeePool(db);
      const targetTotal = TARGET_EARNED_PER_PERSON * BigInt(participantCount);

      const blockRow = db.prepare('SELECT MAX(number) as height FROM blocks').get() as { height: number | null };
      const minerCount = db.prepare('SELECT COUNT(*) as cnt FROM miners WHERE is_active = 1').get() as { cnt: number };

      const txToday = db.prepare(
        'SELECT COUNT(*) as cnt FROM transactions WHERE timestamp >= ?'
      ).get(Math.floor(Date.now() / 1000) - 86400) as { cnt: number };

      res.json({
        success: true,
        data: {
          currentDay: state.current_day,
          blockHeight: blockRow.height ?? 0,
          participantCount,
          minerCount: minerCount.cnt,
          totalEarnedPool: totalEarned.toString(),
          targetTotal: targetTotal.toString(),
          transactionsToday: txToday.cnt,
          feePoolBalance: feePool.currentBalance.toString(),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /network/blocks
  router.get('/blocks', (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = (page - 1) * limit;

      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM blocks').get() as { cnt: number };
      const rows = db.prepare('SELECT * FROM blocks ORDER BY number DESC LIMIT ? OFFSET ?').all(limit, offset);

      res.json({
        success: true,
        data: { blocks: rows, total: countRow.cnt, page, limit },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /network/fee-pool
  router.get('/fee-pool', (_req, res, next) => {
    try {
      const pool = getFeePool(db);
      res.json({
        success: true,
        data: {
          accumulated: pool.totalAccumulated.toString(),
          distributed: pool.totalDistributed.toString(),
          current: pool.currentBalance.toString(),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  return router;
}
