import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { registerMiner, getMinerByAccount } from '../../mining/registration.js';
import { getAccount } from '../../core/account.js';
import { submitEvidence } from '../../verification/evidence.js';
import { calculateScore } from '../../verification/scoring.js';
import { createVouch, getActiveVouchesForAccount } from '../../verification/vouching.js';
import { verificationStore } from '../../verification/panel.js';
import { v4 as uuid } from 'uuid';

export function minerRoutes(db: DatabaseSync) {
  const router = Router();

  // POST /miners/register - register as a miner
  router.post('/register', (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

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

  // POST /evidence - submit verification evidence
  router.post('/evidence', (req, res) => {
    const { accountId, evidenceTypeId, evidenceHash } = req.body;
    if (!accountId || !evidenceTypeId || !evidenceHash) {
      return res.status(400).json({ error: 'accountId, evidenceTypeId, and evidenceHash required' });
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

  // POST /vouches - create a vouch (stake points on someone's humanity)
  router.post('/vouches', (req, res) => {
    const { voucherId, vouchedId, stakeAmount } = req.body;
    if (!voucherId || !vouchedId || !stakeAmount) {
      return res.status(400).json({ error: 'voucherId, vouchedId, and stakeAmount required' });
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

  // POST /vouch-requests - request someone to vouch for you
  router.post('/vouch-requests', (req, res) => {
    const { fromId, toId, message } = req.body;
    if (!fromId || !toId) return res.status(400).json({ error: 'fromId and toId required' });

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

  // PUT /vouch-requests/:id - respond to a vouch request
  router.put('/vouch-requests/:id', (req, res) => {
    const { status } = req.body; // 'accepted' or 'declined'
    if (status !== 'accepted' && status !== 'declined') {
      return res.status(400).json({ error: "status must be 'accepted' or 'declined'" });
    }
    const now = Math.floor(Date.now() / 1000);
    verificationStore(db).setVouchRequestStatus(req.params.id as string, status, now);
    res.json({ success: true });
  });

  return router;
}
