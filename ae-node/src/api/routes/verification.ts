import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { authMiddleware, minerAuthMiddleware } from '../middleware/auth.js';
import { eventBus } from '../websocket.js';
import { createPanel, submitPanelScore, getPanelReviews, verificationStore } from '../../verification/panel.js';
import { getEvidenceForAccount, submitEvidence } from '../../verification/evidence.js';
import { calculateScore } from '../../verification/scoring.js';
import { assignMinersToPanel } from '../../mining/fifo-queue.js';
import { getMiner, getMinerByAccount } from '../../mining/registration.js';
import { getAccount } from '../../core/account.js';

export function verificationRoutes(db: DatabaseSync): Router {
  const router = Router();

  // ── PARTICIPANT-FACING ────────────────────────────────────────

  // POST /verification/panels - participant requests a verification panel
  // for their own account. Auth-protected: must sign with the account's key.
  // FIFO-assigns available miners, transitions panel to in_progress.
  router.post('/panels', authMiddleware(db), (req, res, next) => {
    try {
      const accountId = req.accountId!;
      const acct = getAccount(db, accountId);
      if (!acct) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Account not found' } });
        return;
      }

      const panel = createPanel(db, accountId);
      const assignedMinerIds = assignMinersToPanel(db, panel.id, accountId);

      // Notify each assigned miner over WebSocket so their dashboard updates.
      for (const minerId of assignedMinerIds) {
        const miner = getMiner(db, minerId);
        if (miner) {
          eventBus.emit('verification:assigned', {
            accountId: miner.accountId,
            minerId,
            panelId: panel.id,
            applicantAccountId: accountId,
          });
        }
      }

      res.json({
        success: true,
        data: {
          panel,
          assignedMinerCount: assignedMinerIds.length,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /verification/evidence - participant submits a piece of evidence
  // for their own account. Auth-protected. The evidence is stored against
  // the participant's account and any open panel can use it for review.
  // (This already exists at /miners/evidence with no auth — this version
  // adds proper auth and ties to the request signer.)
  router.post('/evidence', authMiddleware(db), (req, res, next) => {
    try {
      const accountId = req.accountId!;
      const { evidenceTypeId, evidenceHash } = req.body.payload || req.body;
      if (!evidenceTypeId || !evidenceHash) {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'evidenceTypeId and evidenceHash required' } });
        return;
      }
      const evidence = submitEvidence(db, accountId, evidenceTypeId, evidenceHash);
      res.json({
        success: true,
        data: { evidence },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /verification/accounts/:id/panels - list all panels for an account.
  // Public: any user can view the verification history of any account, since
  // it's a public ledger. Useful for clients showing "your past verifications"
  // and for challengers looking up someone's record.
  router.get('/accounts/:id/panels', (req, res, next) => {
    try {
      const panels = verificationStore(db).findPanelsByAccount(req.params.id as string);
      res.json({
        success: true,
        data: { panels },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // ── MINER-FACING ──────────────────────────────────────────────

  // GET /verification/miners/:accountId/assignments - panels FIFO-assigned to
  // a miner. Public: the data is derivable from the on-chain assignment records
  // anyway, and making it auth-protected would force a signed-GET pattern that
  // the codebase doesn't support. The actual SCORE submission below is the
  // auth-protected action.
  router.get('/miners/:accountId/assignments', (req, res, next) => {
    try {
      const miner = getMinerByAccount(db, req.params.accountId as string);
      if (!miner) {
        res.json({
          success: true,
          data: { assignments: [], minerRegistered: false },
          meta: { timestamp: Math.floor(Date.now() / 1000) },
        });
        return;
      }
      const minerId = miner.id;
      const rows = db.prepare(
        `SELECT p.id as panel_id, p.account_id, p.status, p.created_at, p.completed_at, p.median_score,
                a.assigned_at, a.deadline, a.completed as assignment_completed, a.missed
         FROM miner_verification_assignments a
         JOIN verification_panels p ON p.id = a.panel_id
         WHERE a.miner_id = ?
         ORDER BY a.assigned_at DESC`
      ).all(minerId) as Array<Record<string, unknown>>;

      res.json({
        success: true,
        data: {
          minerRegistered: true,
          assignments: rows.map((r) => ({
            panelId: r.panel_id,
            applicantAccountId: r.account_id,
            panelStatus: r.status,
            panelCreatedAt: r.created_at,
            panelCompletedAt: r.completed_at,
            medianScore: r.median_score,
            assignedAt: r.assigned_at,
            deadline: r.deadline,
            myReviewSubmitted: (r.assignment_completed as number) === 1,
            missed: (r.missed as number) === 1,
          })),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /verification/panels/:id - public panel detail with the applicant's
  // submitted evidence and any reviews already in. Used by both the miner
  // (to review evidence before scoring) and the applicant (to see progress).
  router.get('/panels/:id', (req, res, next) => {
    try {
      const panel = verificationStore(db).findPanelById(req.params.id as string);
      if (!panel) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Panel not found' } });
        return;
      }

      const accountId = panel.accountId;
      const evidence = getEvidenceForAccount(db, accountId);
      const reviews = getPanelReviews(db, req.params.id as string);
      const liveScore = calculateScore(db, accountId);
      const assignedMiners = db.prepare(
        'SELECT miner_id, assigned_at, deadline, completed, missed FROM miner_verification_assignments WHERE panel_id = ?'
      ).all(req.params.id) as Array<Record<string, unknown>>;

      res.json({
        success: true,
        data: {
          panel,
          evidence,
          reviews,
          assignedMiners,
          // Live (non-binding) auto-scored breakdown for context. Final score
          // is the median of submitted reviews, set when the panel completes.
          liveScore,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /verification/panels/:id/score - miner submits their %Human score
  // for an assigned panel. Auth + miner-required. When the last assigned
  // miner submits, the median is computed and the applicant's percentHuman
  // is updated atomically inside submitPanelScore.
  router.post('/panels/:id/score', authMiddleware(db), minerAuthMiddleware(db), (req, res, next) => {
    try {
      const minerId = req.minerId!;
      const panelId = req.params.id as string;
      const { score } = req.body.payload || req.body;
      if (typeof score !== 'number') {
        res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'score (number) required' } });
        return;
      }

      // Confirm this miner was actually assigned to this panel. Without this
      // check, any miner could score any panel — defeats the FIFO design.
      const assignment = db.prepare(
        'SELECT id, completed FROM miner_verification_assignments WHERE miner_id = ? AND panel_id = ?'
      ).get(minerId, panelId) as { id: string; completed: number } | undefined;

      if (!assignment) {
        res.status(403).json({ success: false, error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this panel' } });
        return;
      }
      if (assignment.completed === 1) {
        res.status(409).json({ success: false, error: { code: 'ALREADY_SCORED', message: 'You already scored this panel' } });
        return;
      }

      const result = submitPanelScore(db, panelId, minerId, score);

      // Mark the assignment as completed so the FIFO queue treats it as done
      // and this miner can't score the same panel twice.
      db.prepare(
        'UPDATE miner_verification_assignments SET completed = 1 WHERE id = ?'
      ).run(assignment.id);

      // Notify the applicant when the panel completes so their wallet refreshes.
      if (result.panelComplete) {
        const panel = verificationStore(db).findPanelById(panelId);
        if (panel) {
          eventBus.emit('verification:complete', {
            accountId: panel.accountId,
            panelId,
            medianScore: result.medianScore,
          });
          eventBus.emit('score:changed', {
            accountId: panel.accountId,
            newScore: result.medianScore,
          });
          eventBus.emit('balance:updated', {
            accountId: panel.accountId,
            reason: 'verification:complete',
          });
        }
      }

      res.json({
        success: true,
        data: result,
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  return router;
}
