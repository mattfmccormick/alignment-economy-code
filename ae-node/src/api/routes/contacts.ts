import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount } from '../../core/account.js';

export function contactRoutes(db: DatabaseSync) {
  const router = Router();

  // GET /contacts/:ownerId - list contacts for an account
  router.get('/:ownerId', (req, res) => {
    const contacts = db.prepare(
      `SELECT c.*, a.public_key, a.percent_human, a.type as account_type
       FROM contacts c
       JOIN accounts a ON a.id = c.contact_account_id
       WHERE c.owner_id = ?
       ORDER BY c.is_favorite DESC, c.nickname ASC`
    ).all(req.params.ownerId) as Array<Record<string, unknown>>;
    res.json({ contacts });
  });

  // POST /contacts - add a contact
  router.post('/', (req, res) => {
    const { ownerId, contactAccountId, nickname } = req.body;
    if (!ownerId || !contactAccountId) {
      return res.status(400).json({ error: 'ownerId and contactAccountId required' });
    }

    const contact = getAccount(db, contactAccountId);
    if (!contact) return res.status(404).json({ error: 'Contact account not found' });

    const id = uuid();
    const now = Math.floor(Date.now() / 1000);

    try {
      db.prepare(
        `INSERT INTO contacts (id, owner_id, contact_account_id, nickname, is_favorite, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      ).run(id, ownerId, contactAccountId, nickname || '', now);

      res.json({ id, ownerId, contactAccountId, nickname: nickname || '' });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Contact already exists' });
      }
      throw err;
    }
  });

  // PUT /contacts/:id/favorite - toggle favorite
  router.put('/:id/favorite', (req, res) => {
    const { isFavorite } = req.body;
    db.prepare('UPDATE contacts SET is_favorite = ? WHERE id = ?').run(isFavorite ? 1 : 0, req.params.id);
    res.json({ success: true });
  });

  // PUT /contacts/:id - update nickname
  router.put('/:id', (req, res) => {
    const { nickname } = req.body;
    db.prepare('UPDATE contacts SET nickname = ? WHERE id = ?').run(nickname || '', req.params.id);
    res.json({ success: true });
  });

  // DELETE /contacts/:id
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // GET /contacts/search?q=... - search accounts by ID prefix
  router.get('/search/accounts', (req, res) => {
    const q = (req.query.q as string) || '';
    if (q.length < 3) return res.json({ accounts: [] });

    const accounts = db.prepare(
      `SELECT id, public_key, type, percent_human, earned_balance, is_active
       FROM accounts WHERE id LIKE ? AND is_active = 1 LIMIT 10`
    ).all(`${q}%`) as Array<Record<string, unknown>>;

    res.json({ accounts });
  });

  return router;
}
