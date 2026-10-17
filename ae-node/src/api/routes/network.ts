import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { countActiveParticipants, getTotalEarnedPool } from '../../core/account.js';
import { getFeePool } from '../../core/fee-pool.js';
import { cycleStateStore } from '../../core/stores/SqliteCycleStateStore.js';
import { TARGET_EARNED_PER_PERSON } from '../../core/constants.js';
import { computeStateRoot } from '../../core/state-root.js';
import { transactionStore } from '../../core/transaction.js';
import { publicTx } from '../public-tx.js';

export function networkRoutes(db: DatabaseSync): Router {
  const router = Router();

  // GET /network/status
  router.get('/status', (_req, res, next) => {
    try {
      const currentDay = cycleStateStore(db).getCurrentDay();
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
          currentDay,
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

  // GET /network/blocks/:number — a single block by height. Lets the explorer
  // (and any client) look up an arbitrary block, not just the latest page.
  router.get('/blocks/:number', (req, res, next) => {
    try {
      const number = parseInt(req.params.number as string, 10);
      if (!Number.isInteger(number) || number < 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'block number must be a non-negative integer' },
        });
      }
      const row = db.prepare('SELECT * FROM blocks WHERE number = ?').get(number);
      if (!row) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `No block #${number}` },
        });
      }
      res.json({
        success: true,
        data: row,
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /network/blocks/:number/contents — everything a block carried, in a
  // form a person can read: the transfers (signatures stripped, see
  // public-tx.ts) and every other operation (new accounts, vouches, miner
  // actions, verification reviews, tags, validator changes) reduced to what
  // it was and which account signed it. Backs the wallet's block view, where a
  // participant taps from the network stats into a block and down to a single
  // transaction. Public like the rest of /network: the chain is public.
  router.get('/blocks/:number/contents', (req, res, next) => {
    try {
      const number = parseInt(req.params.number as string, 10);
      if (!Number.isInteger(number) || number < 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'block number must be a non-negative integer' },
        });
      }
      const row = db.prepare('SELECT * FROM blocks WHERE number = ?').get(number) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `No block #${number}` },
        });
      }
      const transactions = transactionStore(db).findTransactionsByBlock(number).map(publicTx);
      const operations = [
        ...blockOps(row.account_registrations, 'account'),
        ...blockOps(row.vouch_operations, 'vouch'),
        ...blockOps(row.miner_operations, 'miner'),
        ...blockOps(row.panel_operations, 'verification'),
        ...blockOps(row.tagging_operations, 'tag'),
        ...blockOps(row.validator_changes, 'validator'),
      ];
      res.json({
        success: true,
        data: {
          number: row.number,
          day: row.day,
          timestamp: row.timestamp,
          hash: row.hash,
          previousHash: row.previous_hash,
          stateRoot: row.state_root ?? null,
          transactionCount: row.transaction_count,
          transactions,
          operations,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /network/state-root
  // GET /network/state-root?height=N
  //
  // The account-state fingerprint this node holds. Two uses:
  //
  //   1. Operators comparing machines. Ask every node for the same height and
  //      they should return the same 64 hex chars. A mismatch that persists
  //      across heights means real drift — usually a direct SQL write applied
  //      to some nodes and not others.
  //   2. A joiner checking a state snapshot before trusting it. The snapshot
  //      carries its own root, but a donor could fabricate both; asking several
  //      independent nodes for the root at that height is what makes the check
  //      mean something. See scripts/snapshot.mjs.
  //
  // Public deliberately: it reveals no balances, only whether two nodes agree.
  router.get('/state-root', (req, res, next) => {
    try {
      const headRow = db.prepare('SELECT MAX(number) as height FROM blocks').get() as {
        height: number | null;
      };
      const head = headRow.height ?? 0;

      // Live root: recomputed now, describing state as it stands this instant.
      // Only comparable across nodes when they are at the same height and idle,
      // which is why the recorded-per-height value below is the one to use for
      // anything careful.
      if (req.query.height === undefined) {
        return res.json({
          success: true,
          data: { height: head, stateRoot: computeStateRoot(db), source: 'live' },
          meta: { timestamp: Math.floor(Date.now() / 1000) },
        });
      }

      const height = Number.parseInt(String(req.query.height), 10);
      if (!Number.isInteger(height) || height < 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_HEIGHT', message: 'height must be a non-negative integer' },
        });
      }

      const row = db.prepare('SELECT state_root FROM blocks WHERE number = ?').get(height) as
        | { state_root: string | null }
        | undefined;

      if (!row) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `No block #${height} (head is ${head})` },
        });
      }
      if (!row.state_root) {
        // Recorded roots start at schema v16. Older blocks have none and it
        // cannot be backfilled without replaying the chain, so say so plainly
        // rather than returning null and letting a caller read it as "agrees".
        return res.status(409).json({
          success: false,
          error: {
            code: 'ROOT_NOT_RECORDED',
            message:
              `Block #${height} predates state-root recording on this node. ` +
              `Pick a height committed after the upgrade.`,
          },
        });
      }

      return res.json({
        success: true,
        data: { height, stateRoot: row.state_root, source: 'recorded' },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      return next(e);
    }
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

/** One non-transfer operation a block carried, as the block view shows it. */
interface BlockOperationSummary {
  kind: 'account' | 'vouch' | 'miner' | 'verification' | 'tag' | 'validator';
  /** The op's own type (vouch_create, register, product_register...). */
  type: string;
  /** The account that signed it, when the op names one. */
  accountId: string | null;
}

// Each op lane is stored on the block row as a JSON array (or NULL when the
// block carried none). Read defensively: a malformed column shows as nothing
// rather than failing the whole block view.
function blockOps(json: unknown, kind: BlockOperationSummary['kind']): BlockOperationSummary[] {
  if (typeof json !== 'string' || json === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((raw) => {
    const op = (raw ?? {}) as Record<string, unknown>;
    // Vouch ops are signed by the voucher; every other lane uses accountId.
    const signer = op.accountId ?? op.voucherId;
    return {
      kind,
      type: typeof op.type === 'string' ? op.type : kind === 'account' ? 'account_register' : kind,
      accountId: typeof signer === 'string' ? signer : null,
    };
  });
}
