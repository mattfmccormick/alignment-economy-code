import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { registerMiner, getMinerByAccount } from '../../mining/registration.js';
import { getAccount } from '../../core/account.js';
import { submitEvidence } from '../../verification/evidence.js';
import { calculateScore } from '../../verification/scoring.js';
import { createVouch, getActiveVouchesForAccount } from '../../verification/vouching.js';
import { verificationStore } from '../../verification/panel.js';
import { authMiddleware } from '../middleware/auth.js';
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
  router.post('/evidence', authMiddleware(db), (req, res) => {
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

  // POST /vouches - create a vouch (stake points on someone's humanity).
  // Auth-required: the voucher IS the authenticated account. Pre-auth
  // versions of this route accepted `voucherId` from the request body
  // verbatim, which let any third party drain a victim's earned balance
  // into vouches the victim didn't authorize. authMiddleware now verifies
  // that the caller signed `{ vouchedId, stakeAmount }` with their own
  // private key before we do anything with their balance.
  router.post('/vouches', authMiddleware(db), (req, res) => {
    const voucherId = req.accountId!;
    const { vouchedId, stakeAmount } = req.body.payload || req.body;
    // Backwards-compat shim: older clients still POST a top-level voucherId
    // alongside the envelope. If present it MUST match the signed account
    // — otherwise the caller is trying to stake someone else's balance.
    const claimedVoucherId =
      (req.body.payload && req.body.payload.voucherId) ?? req.body.voucherId;
    if (claimedVoucherId && claimedVoucherId !== voucherId) {
      return res.status(403).json({
        success: false,
        error: { code: 'VOUCHER_MISMATCH', message: 'voucherId does not match the authenticated account' },
      });
    }
    if (!vouchedId || !stakeAmount) {
      return res.status(400).json({ error: 'vouchedId and stakeAmount required' });
    }

    try {
      const vouch = createVouch(db, voucherId, vouchedId, BigInt(stakeAmount));
      res.json({ vouch: { ...vouch, stakeAmount: vouch.stakeAmount.toString() } });
    } catch (err) {
      res.status(400).json({ error: String(err) });
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
  router.post('/vouch-requests', authMiddleware(db), (req, res) => {
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
  router.put('/vouch-requests/:id', authMiddleware(db), (req, res) => {
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
