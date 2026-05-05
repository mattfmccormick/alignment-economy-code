import { Router, Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { getAccount } from '../../core/account.js';
import { authMiddleware } from '../middleware/auth.js';

export function contactRoutes(db: DatabaseSync) {
  const router = Router();

  // Verify the authenticated caller owns the contact row referenced by :id.
  // Used by every PUT/DELETE on a contact. Returns true and writes nothing
  // if the check passes; otherwise responds with the appropriate error and
  // returns false (caller should bail immediately).
  function ownsContact(contactId: string, callerAccountId: string, res: Response): boolean {
    const row = db
      .prepare('SELECT owner_id FROM contacts WHERE id = ?')
      .get(contactId) as { owner_id?: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Contact not found' });
      return false;
    }
    if (row.owner_id !== callerAccountId) {
      res.status(403).json({
        success: false,
        error: { code: 'NOT_CONTACT_OWNER', message: 'Only the contact owner can modify this row' },
      });
      return false;
    }
    return true;
  }

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

  // POST /contacts - add a contact. Auth-required: the signed account is
  // the owner. Body ownerId is back-compat (rejected with 403 if mismatched).
  router.post('/', authMiddleware(db), (req, res) => {
    const ownerId = req.accountId!;
    const { contactAccountId, nickname } = req.body.payload || req.body;
    const claimedOwnerId = (req.body.payload && req.body.payload.ownerId) ?? req.body.ownerId;
    if (claimedOwnerId && claimedOwnerId !== ownerId) {
      return res.status(403).json({
        success: false,
        error: { code: 'OWNER_MISMATCH', message: 'ownerId does not match the authenticated account' },
      });
    }
    if (!contactAccountId) {
      return res.status(400).json({ error: 'contactAccountId required' });
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

  // PUT /contacts/:id/favorite - toggle favorite. Auth + ownership-checked.
  router.put('/:id/favorite', authMiddleware(db), (req, res) => {
    const id = req.params.id as string;
    if (!ownsContact(id, req.accountId!, res)) return;
    const { isFavorite } = req.body.payload || req.body;
    db.prepare('UPDATE contacts SET is_favorite = ? WHERE id = ?').run(isFavorite ? 1 : 0, id);
    res.json({ success: true });
  });

  // PUT /contacts/:id - update nickname. Auth + ownership-checked.
  router.put('/:id', authMiddleware(db), (req, res) => {
    const id = req.params.id as string;
    if (!ownsContact(id, req.accountId!, res)) return;
    const { nickname } = req.body.payload || req.body;
    db.prepare('UPDATE contacts SET nickname = ? WHERE id = ?').run(nickname || '', id);
    res.json({ success: true });
  });

  // DELETE /contacts/:id - Auth + ownership-checked.
  router.delete('/:id', authMiddleware(db), (req, res) => {
    const id = req.params.id as string;
    if (!ownsContact(id, req.accountId!, res)) return;
    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
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
