import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { registerMiner, getMinerByAccount } from '../../mining/registration.js';
import { getAccount } from '../../core/account.js';
import { submitEvidence } from '../../verification/evidence.js';
import { calculateScore } from '../../verification/scoring.js';
import { createVouch, getActiveVouchesForAccount, withdrawVouch } from '../../verification/vouching.js';
import { verificationStore } from '../../verification/panel.js';
import { authMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as schemas from '../schemas.js';
import { v4 as uuid } from 'uuid';

export function minerRoutes(db: DatabaseSync) {
  const router = Router();

  // POST /miners/register - register as a miner. Auth-required: only the
  // account owner can claim themselves as a miner. The signed accountId
  // is taken to be the registrant; a top-level body accountId is back-compat
  // and rejected if it disagrees with the signature.
  router.post('/register', authMiddleware(db), (req, res) => {
    const accountId = req.accountId!;
    const claimedAccountId = (req.body.payload && req.body.payload.accountId) ?? req.body.accountId;
    if (claimedAccountId && claimedAccountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'accountId does not match the authenticated account' },
      });
    }

    const account = getAccount(db, accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const existing = getMinerByAccount(db, accountId);
    if (existing) return res.status(409).json({ error: 'Already registered as miner', miner: existing });

    try {
      const miner = registerMiner(db, accountId);
      res.json({ miner });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // GET /miners/status/:accountId - get miner status
  router.get('/status/:accountId', (req, res) => {
    const miner = getMinerByAccount(db, req.params.accountId);
    if (!miner) return res.json({ isMiner: false });
    res.json({ isMiner: true, miner });
  });

  // POST /evidence - submit verification evidence. Auth-required: only the
  // account being verified can submit evidence about themselves. Without
  // this, a third party could spam fake evidence in someone else's name
  // (sybil farming via free percent-human bumps once a reviewer signs off).
  router.post('/evidence', authMiddleware(db), validateBody(schemas.submitEvidence), (req, res) => {
    const accountId = req.accountId!;
    const { evidenceTypeId, evidenceHash } = req.body.payload || req.body;
    const claimedAccountId = (req.body.payload && req.body.payload.accountId) ?? req.body.accountId;
    if (claimedAccountId && claimedAccountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'accountId does not match the authenticated account' },
      });
    }
    if (!evidenceTypeId || !evidenceHash) {
      return res.status(400).json({ error: 'evidenceTypeId and evidenceHash required' });
    }

    try {
      const evidence = submitEvidence(db, accountId, evidenceTypeId, evidenceHash);
      const score = calculateScore(db, accountId);
      res.json({ evidence, score });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // GET /evidence/score/:accountId - get current verification score
  router.get('/evidence/score/:accountId', (req, res) => {
    try {
      const score = calculateScore(db, req.params.accountId);
      const vouches = getActiveVouchesForAccount(db, req.params.accountId);
      res.json({ score, vouchCount: vouches.length });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // POST /vouches - create a vouch (WP v2: stake a percentage of holdings).
  router.post('/vouches', authMiddleware(db), validateBody(schemas.createVouch), (req, res) => {
    const voucherId = req.accountId!;
    const { vouchedId, stakePercent } = req.body.payload || req.body;
    const claimedVoucherId =
      (req.body.payload && req.body.payload.voucherId) ?? req.body.voucherId;
    if (claimedVoucherId && claimedVoucherId !== voucherId) {
      return res.status(403).json({
        success: false,
        error: { code: 'VOUCHER_MISMATCH', message: 'voucherId does not match the authenticated account' },
      });
    }
    if (!vouchedId || stakePercent == null) {
      return res.status(400).json({ error: 'vouchedId and stakePercent required' });
    }

    try {
      const vouch = createVouch(db, voucherId, vouchedId, Number(stakePercent));
      res.json({ vouch: { ...vouch, stakeAmount: vouch.stakeAmount.toString() } });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // POST /vouches/:id/withdraw - withdraw a vouch you gave.
  //
  // WP §7.2 says vouchers may withdraw at any time. Until this route existed
  // there was no production caller for withdrawVouch at all, so locking points
  // into a vouch was a one-way ratchet whose only exit was a guilty verdict
  // burning them. Withdrawing returns the stake and drops the vouched
  // account's percentHuman by this vouch's contribution to its score.
  //
  // POST rather than DELETE deliberately. The auth envelope has to travel in a
  // signed body, and a body on DELETE is poorly supported: express.json()
  // leaves req.body undefined for it here, and intermediaries are entitled to
  // strip it. Every other auth-gated route in this API is a signed POST/PUT,
  // so this matches them.
  router.post('/vouches/:id/withdraw', authMiddleware(db), (req, res) => {
    const accountId = req.accountId!;
    const vouchId = req.params.id as string;

    const vouch = verificationStore(db).findActiveVouchById(vouchId);
    if (!vouch) {
      return res.status(404).json({
        success: false,
        error: { code: 'VOUCH_NOT_FOUND', message: `Active vouch not found: ${vouchId}` },
      });
    }
    // Only the person who staked may unstake. Without this, anyone could
    // withdraw someone else's vouch and knock down a third party's score.
    if (vouch.voucherId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_VOUCHER', message: 'Only the voucher can withdraw this vouch' },
      });
    }

    try {
      withdrawVouch(db, vouchId);
      return res.json({
        success: true,
        data: {
          withdrawn: vouchId,
          vouchedId: vouch.vouchedId,
          returnedStake: vouch.stakeAmount.toString(),
          percentHumanReduction: Math.round(vouch.stakedPercentage),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: { code: 'WITHDRAW_FAILED', message: String(err) },
      });
    }
  });

  // GET /vouches/:accountId - get vouches for/from an account
  router.get('/vouches/:accountId', (req, res) => {
    const verif = verificationStore(db);
    const received = verif.findActiveVouchesForAccount(req.params.accountId as string);
    const given = verif.findActiveVouchesGivenBy(req.params.accountId as string);
    res.json({
      received: received.map((v) => ({ ...v, stakeAmount: v.stakeAmount.toString() })),
      given: given.map((v) => ({ ...v, stakeAmount: v.stakeAmount.toString() })),
    });
  });

  // POST /vouch-requests - request someone to vouch for you. Auth-required:
  // the requestor (fromId) is the authenticated account. Without this, a
  // third party could spam vouch requests in someone else's name, polluting
  // miner inboxes and creating social-engineering opportunities.
  router.post('/vouch-requests', authMiddleware(db), validateBody(schemas.createVouchRequest), (req, res) => {
    const fromId = req.accountId!;
    const { toId, message } = req.body.payload || req.body;
    const claimedFromId = (req.body.payload && req.body.payload.fromId) ?? req.body.fromId;
    if (claimedFromId && claimedFromId !== fromId) {
      return res.status(403).json({
        success: false,
        error: { code: 'FROM_MISMATCH', message: 'fromId does not match the authenticated account' },
      });
    }
    if (!toId) return res.status(400).json({ error: 'toId required' });

    const id = uuid();
    const now = Math.floor(Date.now() / 1000);
    verificationStore(db).insertVouchRequest({
      id, fromId, toId, message: message || '', createdAt: now,
    });

    res.json({ id, fromId, toId, status: 'pending' });
  });

  // GET /vouch-requests/:accountId - get pending requests
  router.get('/vouch-requests/:accountId', (req, res) => {
    const verif = verificationStore(db);
    const accountId = req.params.accountId as string;
    res.json({
      incoming: verif.findPendingIncomingRequests(accountId),
      outgoing: verif.findPendingOutgoingRequests(accountId),
    });
  });

  // PUT /vouch-requests/:id - respond to a vouch request. Auth-required
  // AND ownership-checked: only the request's recipient (toId) can accept
  // or decline. Without this, any third party could mark someone else's
  // pending requests as 'accepted' or 'declined' and either bypass a real
  // accept-flow stake (the now-fixed /miners/vouches gap) or hide a
  // genuine request from the intended responder.
  router.put('/vouch-requests/:id', authMiddleware(db), validateBody(schemas.respondVouchRequest), (req, res) => {
    const responderId = req.accountId!;
    const { status } = req.body.payload || req.body;
    if (status !== 'accepted' && status !== 'declined') {
      return res.status(400).json({ error: "status must be 'accepted' or 'declined'" });
    }
    const verif = verificationStore(db);
    const requestRow = verif.findVouchRequestById(req.params.id as string);
    if (!requestRow) return res.status(404).json({ error: 'Vouch request not found' });
    if (requestRow.toId !== responderId) {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_REQUEST_RECIPIENT', message: 'Only the request recipient can respond to it' },
      });
    }
    const now = Math.floor(Date.now() / 1000);
    verif.setVouchRequestStatus(req.params.id as string, status, now);
    res.json({ success: true });
  });

  return router;
}
