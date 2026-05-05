import { Router, Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount } from '../../core/account.js';
import { authMiddleware } from '../middleware/auth.js';

export function recurringRoutes(db: DatabaseSync) {
  const router = Router();

  // Ownership check for the row referenced by :id. Only the account who
  // created the recurring transfer (`from_id`) can modify or delete it.
  // Used by both PUT and DELETE on /:id. Returns true if the caller owns
  // the row (and the route may proceed); otherwise responds 404 or 403
  // and returns false.
  function ownsRecurring(id: string, callerAccountId: string, res: Response): boolean {
    const row = db
      .prepare('SELECT from_id FROM recurring_transfers WHERE id = ?')
      .get(id) as { from_id?: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Recurring transfer not found' });
      return false;
    }
    if (row.from_id !== callerAccountId) {
      res.status(403).json({
        success: false,
        error: { code: 'NOT_TRANSFER_OWNER', message: 'Only the recurring-transfer creator can modify this row' },
      });
      return false;
    }
    return true;
  }

  // GET /recurring/:accountId - list recurring transfers for an account
  router.get('/:accountId', (req, res) => {
    const transfers = db.prepare(
      `SELECT r.*, a.public_key as to_public_key
       FROM recurring_transfers r
       LEFT JOIN accounts a ON a.id = r.to_id
       WHERE r.from_id = ?
       ORDER BY r.created_at DESC`
    ).all(req.params.accountId) as Array<Record<string, unknown>>;
    res.json({ transfers });
  });

  // POST /recurring - create a recurring transfer.
  //
  // Auth-required: the signed account becomes `fromId`. Pre-auth versions
  // accepted `fromId` from the body verbatim — once an executor lands that
  // would be straight-up theft (anyone could schedule "send 10 active
  // points/day from Alice to Mallory" against a victim's balance). Even
  // before the executor exists, gating now means the moment that wiring
  // lands, the auth path is already in place.
  router.post('/', authMiddleware(db), (req, res) => {
    const fromId = req.accountId!;
    const { toId, amount, pointType, schedule } = req.body.payload || req.body;
    const claimedFromId = (req.body.payload && req.body.payload.fromId) ?? req.body.fromId;
    if (claimedFromId && claimedFromId !== fromId) {
      return res.status(403).json({
        success: false,
        error: { code: 'FROM_MISMATCH', message: 'fromId does not match the authenticated account' },
      });
    }
    if (!toId || !amount) {
      return res.status(400).json({ error: 'toId and amount required' });
    }

    const sender = getAccount(db, fromId);
    if (!sender) return res.status(404).json({ error: 'Sender account not found' });

    const recipient = getAccount(db, toId);
    if (!recipient) return res.status(404).json({ error: 'Recipient account not found' });

    if (fromId === toId) return res.status(400).json({ error: 'Cannot create recurring transfer to self' });

    const id = uuid();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(
      `INSERT INTO recurring_transfers (id, from_id, to_id, amount, point_type, schedule, is_active, last_executed_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)`
    ).run(id, fromId, toId, amount.toString(), pointType || 'active', schedule || 'daily', now);

    res.json({ id, fromId, toId, amount: amount.toString(), pointType: pointType || 'active', schedule: schedule || 'daily', isActive: true });
  });

  // PUT /recurring/:id - update a recurring transfer. Auth + ownership.
  router.put('/:id', authMiddleware(db), (req, res) => {
    const id = req.params.id as string;
    if (!ownsRecurring(id, req.accountId!, res)) return;
    const { amount, pointType, schedule, isActive } = req.body.payload || req.body;

    if (amount !== undefined) {
      db.prepare('UPDATE recurring_transfers SET amount = ? WHERE id = ?').run(amount.toString(), id);
    }
    if (pointType !== undefined) {
      db.prepare('UPDATE recurring_transfers SET point_type = ? WHERE id = ?').run(pointType, id);
    }
    if (schedule !== undefined) {
      db.prepare('UPDATE recurring_transfers SET schedule = ? WHERE id = ?').run(schedule, id);
    }
    if (isActive !== undefined) {
      db.prepare('UPDATE recurring_transfers SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
    }

    res.json({ success: true });
  });

  // DELETE /recurring/:id - delete a recurring transfer. Auth + ownership.
  router.delete('/:id', authMiddleware(db), (req, res) => {
    const id = req.params.id as string;
    if (!ownsRecurring(id, req.accountId!, res)) return;
    db.prepare('DELETE FROM recurring_transfers WHERE id = ?').run(id);
    res.json({ success: true });
  });

  return router;
}
