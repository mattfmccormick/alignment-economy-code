// Validator API surface.
//
// Endpoints for the validator lifecycle:
//   POST /api/v1/validators/register    — stake earned points + register keys
//   POST /api/v1/validators/deregister  — unlock stake + mark inactive
//   GET  /api/v1/validators             — list active validators
//   GET  /api/v1/validators/:accountId  — fetch one validator
//
// Auth model: register/deregister both use the standard signed-payload
// auth middleware. The validator candidate signs the request with their
// account's ML-DSA key, so no admin secret is required and no other
// account can register on someone else's behalf. List/get are public —
// the validator set is observable on-chain anyway.
//
// Conversion: API takes `stake` in DISPLAY units (e.g., 200 = 200.00
// points). The protocol layer wants fixed-precision bigint (200 *
// PRECISION). Same convention as the transactions API.

import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { authMiddleware } from '../middleware/auth.js';
import {
  registerValidator,
  deregisterValidator,
  MIN_VALIDATOR_STAKE,
} from '../../core/consensus/registration.js';
import { SqliteValidatorSet } from '../../core/consensus/SqliteValidatorSet.js';
import type { ValidatorInfo } from '../../core/consensus/IValidatorSet.js';
import {
  enqueueValidatorChange,
  verifyValidatorChange,
  type ValidatorChange,
  type ValidatorChangeRegister,
  type ValidatorChangeDeregister,
} from '../../core/consensus/validator-change.js';
import { getAccount } from '../../core/account.js';
import { PRECISION } from '../../core/constants.js';

function serialize(v: ValidatorInfo): Record<string, unknown> {
  return {
    accountId: v.accountId,
    nodePublicKey: v.nodePublicKey,
    vrfPublicKey: v.vrfPublicKey,
    stake: v.stake.toString(),
    isActive: v.isActive,
    registeredAt: v.registeredAt,
    deregisteredAt: v.deregisteredAt,
  };
}

export function validatorRoutes(db: DatabaseSync): Router {
  const router = Router();
  const auth = authMiddleware(db);

  // ── POST /register ───────────────────────────────────────────────────
  //
  // Body: { accountId, timestamp, signature, payload: { stake, nodePublicKey, vrfPublicKey } }
  //
  // The payload's stake is a display-units number. The protocol layer
  // checks stake >= MIN_VALIDATOR_STAKE; we do a friendly client-facing
  // check too so the error message names DISPLAY units, not the raw
  // 10^8-scaled bigint.
  router.post('/register', auth, (req, res, next) => {
    try {
      const accountId = req.accountId!;
      const { stake, nodePublicKey, vrfPublicKey } = req.body.payload ?? {};

      if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_STAKE', message: 'stake must be a positive number (display units)' },
        });
        return;
      }
      if (typeof nodePublicKey !== 'string' || typeof vrfPublicKey !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_KEYS', message: 'nodePublicKey and vrfPublicKey must be hex strings' },
        });
        return;
      }

      const stakeFixed = BigInt(Math.round(stake * Number(PRECISION)));
      if (stakeFixed < MIN_VALIDATOR_STAKE) {
        // Convert MIN back to display for the error message
        const minDisplay = Number(MIN_VALIDATOR_STAKE) / Number(PRECISION);
        res.status(400).json({
          success: false,
          error: {
            code: 'STAKE_TOO_SMALL',
            message: `stake ${stake} below minimum ${minDisplay}`,
          },
        });
        return;
      }

      let validator: ValidatorInfo;
      try {
        validator = registerValidator(db, {
          accountId,
          nodePublicKey,
          vrfPublicKey,
          stake: stakeFixed,
        });
      } catch (err) {
        // The protocol layer throws on every invariant failure
        // (insufficient balance, key collision, already registered,
        // wrong-shape hex). Surface the message verbatim so clients
        // can react; map to a generic 400 since these are all
        // user-input problems.
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          success: false,
          error: { code: 'REGISTER_FAILED', message },
        });
        return;
      }

      res.json({
        success: true,
        data: serialize(validator),
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /deregister ─────────────────────────────────────────────────
  //
  // Body: { accountId, timestamp, signature, payload: {} }
  //
  // The empty payload is intentional — the auth middleware verifies the
  // signature over (payload, timestamp), which is enough to prove the
  // account holder authorized the deregistration. No additional fields
  // are needed.
  router.post('/deregister', auth, (req, res, next) => {
    try {
      const accountId = req.accountId!;
      try {
        deregisterValidator(db, { accountId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          success: false,
          error: { code: 'DEREGISTER_FAILED', message },
        });
        return;
      }

      // Return the now-inactive validator row so the client can confirm.
      const set = new SqliteValidatorSet(db);
      const v = set.findByAccountId(accountId);
      res.json({
        success: true,
        data: v ? serialize(v) : null,
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /propose-register ────────────────────────────────────────────
  //
  // Body: { change: <fully-signed ValidatorChangeRegister> }
  //
  // The chain-driven path. Unlike /register (which applies to the local
  // DB immediately), this endpoint enqueues the signed change for the
  // BFT proposer to include in the next block. The change applies on
  // every node when that block commits.
  //
  // Auth model: the ValidatorChange itself is signed by the affected
  // account's ML-DSA-65 key (computed inside validator-change.ts's
  // canonical-bytes signer). The signature in the change body IS the
  // authentication — no outer auth-middleware wrapper. We verify it
  // here against the account's stored publicKey.
  //
  // Response: 200 with the enqueued change + a "pending" status
  // indicator. The caller polls GET /validators/:accountId or watches
  // for block commits to confirm the apply landed.
  router.post('/propose-register', (req, res, next) => {
    try {
      const change = req.body?.change;
      if (!change || typeof change !== 'object' || change.type !== 'register') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CHANGE', message: 'body must include `change` with type=register' },
        });
        return;
      }
      const account = getAccount(db, change.accountId);
      if (!account) {
        res.status(404).json({
          success: false,
          error: { code: 'ACCOUNT_NOT_FOUND', message: `Account not found: ${change.accountId}` },
        });
        return;
      }
      if (!verifyValidatorChange(change as ValidatorChange, account.publicKey)) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_SIGNATURE', message: 'change.signature does not verify against account.publicKey' },
        });
        return;
      }
      // Display-units stake floor for friendlier error messages. The
      // protocol-level apply still enforces MIN_VALIDATOR_STAKE; this
      // is just an early reject to avoid queueing changes that would
      // fail at apply time.
      const reg = change as ValidatorChangeRegister;
      let stakeFixed: bigint;
      try {
        stakeFixed = BigInt(reg.stake);
      } catch {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_STAKE', message: 'change.stake must be a base-10 integer string' },
        });
        return;
      }
      if (stakeFixed < MIN_VALIDATOR_STAKE) {
        res.status(400).json({
          success: false,
          error: {
            code: 'STAKE_TOO_SMALL',
            message: `stake ${stakeFixed} below MIN_VALIDATOR_STAKE ${MIN_VALIDATOR_STAKE}`,
          },
        });
        return;
      }
      const id = enqueueValidatorChange(db, change as ValidatorChange);
      res.json({
        success: true,
        data: {
          status: 'pending',
          queueId: id,
          change,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /propose-deregister ──────────────────────────────────────────
  //
  // Body: { change: <fully-signed ValidatorChangeDeregister> }
  //
  // Same model as propose-register. The signed change goes on the
  // queue; applies when the next block commits.
  router.post('/propose-deregister', (req, res, next) => {
    try {
      const change = req.body?.change;
      if (!change || typeof change !== 'object' || change.type !== 'deregister') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CHANGE', message: 'body must include `change` with type=deregister' },
        });
        return;
      }
      const account = getAccount(db, change.accountId);
      if (!account) {
        res.status(404).json({
          success: false,
          error: { code: 'ACCOUNT_NOT_FOUND', message: `Account not found: ${change.accountId}` },
        });
        return;
      }
      if (!verifyValidatorChange(change as ValidatorChange, account.publicKey)) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_SIGNATURE', message: 'change.signature does not verify against account.publicKey' },
        });
        return;
      }
      void (change as ValidatorChangeDeregister); // narrowing for IDE; no extra fields to validate
      const id = enqueueValidatorChange(db, change as ValidatorChange);
      res.json({
        success: true,
        data: {
          status: 'pending',
          queueId: id,
          change,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET / (list active) ──────────────────────────────────────────────
  router.get('/', (_req, res, next) => {
    try {
      const set = new SqliteValidatorSet(db);
      const all = set.listActive();
      res.json({
        success: true,
        data: all.map(serialize),
        meta: { timestamp: Math.floor(Date.now() / 1000), count: all.length },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /:accountId ──────────────────────────────────────────────────
  router.get('/:accountId', (req, res, next) => {
    try {
      const set = new SqliteValidatorSet(db);
      const v = set.findByAccountId(req.params.accountId);
      if (!v) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Validator not found: ${req.params.accountId}` },
        });
        return;
      }
      res.json({
        success: true,
        data: serialize(v),
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
