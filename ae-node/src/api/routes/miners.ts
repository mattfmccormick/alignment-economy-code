import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { registerMiner, getMinerByAccount } from '../../mining/registration.js';
import { submitEvidence } from '../../verification/evidence.js';
import { calculateScore } from '../../verification/scoring.js';
import { getActiveVouchesForAccount } from '../../verification/vouching.js';
import {
  enqueueVouchOperation,
  verifyVouchOperation,
  validateVouchOperationApplicable,
  deriveVouchId,
  type VouchOperation,
} from '../../verification/vouch-operation.js';
import { getAccount } from '../../core/account.js';
import {
  enqueueMinerOperation,
  verifyMinerOperation,
  validateMinerOperationApplicable,
  deriveMinerId,
  type MinerOperation,
} from '../../mining/miner-operation.js';
import { verificationStore } from '../../verification/panel.js';
import { recordHeartbeat } from '../../mining/heartbeat.js';
import { getLatestBlock } from '../../core/block.js';
import { authMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as schemas from '../schemas.js';
import { v4 as uuid } from 'uuid';

export function minerRoutes(
  db: DatabaseSync,
  vouchOpBroadcaster?: (op: unknown) => void,
  minerOpBroadcaster?: (op: unknown) => void,
) {
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

    // Miner registration rides the chain now (audit #5/#6/#7): who is a miner is
    // consensus state (fee split, lottery, panel assignment), so applying it
    // node-locally forked the set. The client signs a MinerOperation; this route
    // verifies + queues + gossips it, and it applies at commit on every node.
    const op = (req.body.payload?.op ?? req.body.op) as MinerOperation | undefined;
    if (!op || op.type !== 'miner_register') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OP', message: 'payload.op must be a signed miner_register operation' },
      });
    }
    if (op.accountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'op.accountId does not match the authenticated account' },
      });
    }
    if (!verifyMinerOperation(op, account.publicKey)) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_OP_SIGNATURE', message: 'miner operation signature does not verify' },
      });
    }
    const problem = validateMinerOperationApplicable(db, op);
    if (problem) {
      return res.status(400).json({ success: false, error: { code: 'OP_NOT_APPLICABLE', message: problem } });
    }
    enqueueMinerOperation(db, op);
    minerOpBroadcaster?.(op);
    return res.json({
      success: true,
      data: { status: 'pending', minerId: deriveMinerId(op) },
      meta: { timestamp: Math.floor(Date.now() / 1000) },
    });
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
  // Create a vouch. The vouch now rides the chain (audit #4/#16): it moves the
  // voucher's balance (earned -> locked) and, on later withdrawal, the vouched
  // account's percentHuman - both consensus state - so applying it node-locally
  // forked the ledger. The client signs a VouchOperation and sends it here; this
  // route verifies and QUEUES it for the next block. It applies deterministically
  // on every node at commit, not synchronously here.
  //
  // Body: { accountId, timestamp, signature, payload: { op: <signed VouchOpCreate> } }
  router.post('/vouches', authMiddleware(db), (req, res) => {
    const voucherId = req.accountId!;
    const op = (req.body.payload?.op ?? req.body.op) as VouchOperation | undefined;
    if (!op || op.type !== 'vouch_create') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OP', message: 'payload.op must be a signed vouch_create operation' },
      });
    }
    if (op.voucherId !== voucherId) {
      return res.status(403).json({
        success: false,
        error: { code: 'VOUCHER_MISMATCH', message: 'op.voucherId does not match the authenticated account' },
      });
    }
    const voucher = getAccount(db, voucherId);
    if (!voucher) {
      return res.status(404).json({ success: false, error: { code: 'ACCOUNT_NOT_FOUND', message: 'voucher not found' } });
    }
    if (!verifyVouchOperation(op, voucher.publicKey)) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_OP_SIGNATURE', message: 'vouch operation signature does not verify' },
      });
    }
    const problem = validateVouchOperationApplicable(db, op);
    if (problem) {
      return res.status(400).json({ success: false, error: { code: 'OP_NOT_APPLICABLE', message: problem } });
    }
    enqueueVouchOperation(db, op);
    vouchOpBroadcaster?.(op);
    return res.json({
      success: true,
      data: { status: 'pending', vouchId: deriveVouchId(op) },
      meta: { timestamp: Math.floor(Date.now() / 1000) },
    });
  });

  // POST /miners/heartbeat - "I am online and available for assignments."
  //
  // recordHeartbeat existed with a comment saying the protocol records one
  // every block, and nothing called it. So countHeartbeatsSince always
  // returned 0, calculateUptime always returned 0%, and the tier1 uptime
  // threshold (90%) could never be met by anyone. Uptime was not a low number;
  // it was an unmeasured one.
  //
  // A miner here is an API client, not necessarily a validator, so the honest
  // signal is the client saying so on its poll rather than anything derived
  // from block production. mining.heartbeat_interval_seconds (60) is the
  // cadence calculateUptime expects.
  router.post('/heartbeat', authMiddleware(db), (req, res) => {
    const miner = getMinerByAccount(db, req.accountId!);
    if (!miner || !miner.isActive) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_A_MINER', message: 'No active miner for this account' },
      });
    }
    const height = getLatestBlock(db)?.number ?? 0;
    recordHeartbeat(db, miner.id, height);
    return res.json({
      success: true,
      data: { minerId: miner.id, blockHeight: height },
      meta: { timestamp: Math.floor(Date.now() / 1000) },
    });
  });

  // POST /vouches/:id/withdraw - withdraw a vouch you gave.
  //
  // WP Â§7.2 says vouchers may withdraw at any time. Until this route existed
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

    // Same chain-ordered path as create: the client signs a vouch_withdraw op,
    // this route verifies + queues it, and it applies at commit on every node.
    const op = (req.body.payload?.op ?? req.body.op) as VouchOperation | undefined;
    if (!op || op.type !== 'vouch_withdraw' || op.vouchId !== vouchId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OP', message: 'payload.op must be a signed vouch_withdraw for this vouch' },
      });
    }
    if (op.voucherId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_VOUCHER', message: 'op.voucherId does not match the authenticated account' },
      });
    }
    const voucherAcct = getAccount(db, accountId);
    if (!voucherAcct || !verifyVouchOperation(op, voucherAcct.publicKey)) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_OP_SIGNATURE', message: 'vouch operation signature does not verify' },
      });
    }
    try {
      enqueueVouchOperation(db, op);
      vouchOpBroadcaster?.(op);
      return res.json({
        success: true,
        data: {
          status: 'pending',
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
