import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount } from '../../core/account.js';

export function recurringRoutes(db: DatabaseSync) {
  const router = Router();

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

  // POST /recurring - create a recurring transfer
  router.post('/', (req, res) => {
    const { fromId, toId, amount, pointType, schedule } = req.body;
    if (!fromId || !toId || !amount) {
      return res.status(400).json({ error: 'fromId, toId, and amount required' });
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

  // PUT /recurring/:id - update a recurring transfer
  router.put('/:id', (req, res) => {
    const { amount, pointType, schedule, isActive } = req.body;
    const existing = db.prepare('SELECT * FROM recurring_transfers WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Recurring transfer not found' });

    if (amount !== undefined) {
      db.prepare('UPDATE recurring_transfers SET amount = ? WHERE id = ?').run(amount.toString(), req.params.id);
    }
    if (pointType !== undefined) {
      db.prepare('UPDATE recurring_transfers SET point_type = ? WHERE id = ?').run(pointType, req.params.id);
    }
    if (schedule !== undefined) {
      db.prepare('UPDATE recurring_transfers SET schedule = ? WHERE id = ?').run(schedule, req.params.id);
    }
    if (isActive !== undefined) {
      db.prepare('UPDATE recurring_transfers SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, req.params.id);
    }

    res.json({ success: true });
  });

  // DELETE /recurring/:id - delete a recurring transfer
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM recurring_transfers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
}
