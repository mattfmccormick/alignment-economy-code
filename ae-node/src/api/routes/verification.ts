import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { authMiddleware, minerAuthMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as schemas from '../schemas.js';
import { getPanelReviews, verificationStore } from '../../verification/panel.js';
import { getEvidenceForAccount, submitEvidence } from '../../verification/evidence.js';
import { calculateScore } from '../../verification/scoring.js';
import { getMinerByAccount } from '../../mining/registration.js';
import { getAccount } from '../../core/account.js';
import {
  verifyPanelOperation,
  validatePanelOperationApplicable,
  enqueuePanelOperation,
  derivePanelId,
  deriveReviewId,
  type PanelOperation,
} from '../../verification/panel-operation.js';

export function verificationRoutes(
  db: DatabaseSync,
  panelOpBroadcaster?: (op: unknown) => void,
): Router {
  const router = Router();

  // ── PARTICIPANT-FACING ────────────────────────────────────────

  // POST /verification/panels - participant requests a verification panel for
  // their own account. The request carries a signed panel_create operation
  // (payload.op); the panel rides the chain and is created deterministically at
  // commit on every node, because panel completion writes percentHuman and that
  // must be consensus state, not a node-local write. Returns the derived panel
  // id so the client can poll for it once the block commits.
  router.post('/panels', authMiddleware(db), (req, res, next) => {
    try {
      const accountId = req.accountId!;
      const acct = getAccount(db, accountId);
      if (!acct) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Account not found' } });
        return;
      }

      const op = (req.body.payload?.op ?? req.body.op) as PanelOperation | undefined;
      if (!op || op.type !== 'panel_create') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_OP', message: 'payload.op must be a signed panel_create operation' },
        });
        return;
      }
      if (op.accountId !== accountId) {
        res.status(403).json({
          success: false,
          error: { code: 'ACCOUNT_MISMATCH', message: 'op.accountId does not match the authenticated account' },
        });
        return;
      }
      if (!verifyPanelOperation(op, acct.publicKey)) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_OP_SIGNATURE', message: 'panel operation signature does not verify' },
        });
        return;
      }
      const problem = validatePanelOperationApplicable(db, op);
      if (problem) {
        res.status(400).json({ success: false, error: { code: 'OP_NOT_APPLICABLE', message: problem } });
        return;
      }
      enqueuePanelOperation(db, op);
      panelOpBroadcaster?.(op);
      res.json({
        success: true,
        data: { status: 'pending', panelId: derivePanelId(op) },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /verification/evidence - participant submits a piece of evidence
  // for their own account. Auth-protected. The evidence is stored against
  // the participant's account and any open panel can use it for review.
  // (This already exists at /miners/evidence with no auth — this version
  // adds proper auth and ties to the request signer.)
  router.post('/evidence', authMiddleware(db), validateBody(schemas.submitEvidence), (req, res, next) => {
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

  // GET /verification/miners/:accountId/assignments - panels a miner can act on.
  // Public, same rationale as before. Now that panel completion is chain-ordered,
  // FIFO assignment rows are no longer a consensus step: any active miner may
  // score any OPEN panel (except their own), and completion fires deterministically
  // when enough scores are in. So this returns every open panel not yet scored by
  // this miner (the pending queue) plus the panels this miner already scored (their
  // history). Deterministic FIFO assignment + conflict-of-interest as an enforced
  // on-chain check is a documented follow-up; the panel-op path keeps the same
  // PanelAssignment shape so the miner UI is unchanged.
  router.get('/miners/:accountId/assignments', (req, res, next) => {
    try {
      const accountId = req.params.accountId as string;
      const miner = getMinerByAccount(db, accountId);
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
        `SELECT p.id as panel_id, p.account_id, p.status, p.created_at, p.completed_at,
                p.median_score, p.deadline,
                EXISTS(SELECT 1 FROM panel_reviews r WHERE r.panel_id = p.id AND r.miner_id = ?) AS reviewed
         FROM verification_panels p
         WHERE p.account_id != ?
           AND (p.status != 'complete'
                OR EXISTS(SELECT 1 FROM panel_reviews r2 WHERE r2.panel_id = p.id AND r2.miner_id = ?))
         ORDER BY p.created_at DESC`
      ).all(minerId, accountId, minerId) as Array<Record<string, unknown>>;

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
            assignedAt: r.created_at,
            deadline: r.deadline,
            myReviewSubmitted: (r.reviewed as number) === 1,
            missed: false,
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

  // POST /verification/panels/:id/score - miner submits their %Human score for
  // an open panel. The request carries a signed panel_score operation
  // (payload.op); the score rides the chain and applies deterministically at
  // commit on every node. When the applied scores reach the panel's snapshotted
  // target, completion computes the median and writes percentHuman inside the
  // same commit — identically on every node. So this route verifies + queues +
  // gossips the op and returns pending; the completion WS events fire from the
  // commit path, not here.
  router.post('/panels/:id/score', authMiddleware(db), minerAuthMiddleware(db), (req, res, next) => {
    try {
      const accountId = req.accountId!;
      const panelId = req.params.id as string;
      const acct = getAccount(db, accountId);
      if (!acct) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Account not found' } });
        return;
      }

      const op = (req.body.payload?.op ?? req.body.op) as PanelOperation | undefined;
      if (!op || op.type !== 'panel_score') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_OP', message: 'payload.op must be a signed panel_score operation' },
        });
        return;
      }
      if (op.accountId !== accountId) {
        res.status(403).json({
          success: false,
          error: { code: 'ACCOUNT_MISMATCH', message: 'op.accountId does not match the authenticated account' },
        });
        return;
      }
      if (op.panelId !== panelId) {
        res.status(400).json({
          success: false,
          error: { code: 'PANEL_MISMATCH', message: 'op.panelId does not match the URL' },
        });
        return;
      }
      if (!verifyPanelOperation(op, acct.publicKey)) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_OP_SIGNATURE', message: 'panel operation signature does not verify' },
        });
        return;
      }
      const problem = validatePanelOperationApplicable(db, op);
      if (problem) {
        res.status(400).json({ success: false, error: { code: 'OP_NOT_APPLICABLE', message: problem } });
        return;
      }
      enqueuePanelOperation(db, op);
      panelOpBroadcaster?.(op);
      res.json({
        success: true,
        data: { status: 'pending', reviewId: deriveReviewId(op) },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  return router;
}
