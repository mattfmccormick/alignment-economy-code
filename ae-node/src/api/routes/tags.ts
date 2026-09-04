// Tag routes: products, spaces, supportive tagging, ambient tagging.
//
// These are the consumer-facing endpoints behind the wallet's "Tag your world"
// page. The user names the durable goods they own (products) and the places
// they spend time (spaces), then submits per-day minute allocations against
// each. The supportive/ambient daily mints get distributed by those minute
// shares, then finalized at end-of-day to flow value to manufacturers and
// space entities.
//
// Endpoints:
//   POST /products              register a product the caller owns
//   GET  /products              list all active products (public catalog)
//   GET  /products/mine/:owner  list products created by an account
//   POST /spaces                register a space
//   GET  /spaces                list all active spaces
//   POST /supportive            replace today's supportive tag set for an account (auth-required)
//   GET  /supportive/:owner/:day  list supportive tags for an account+day
//   POST /ambient               replace today's ambient tag set for an account (auth-required)
//   GET  /ambient/:owner/:day   list ambient tags for an account+day
//
// /supportive and /ambient are signature-gated: the caller signs the tag
// payload with their own private key, ae-node verifies via authMiddleware,
// and the route reads accountId from req.accountId. Without this gate, any
// third party can redirect a victim's daily 144 supportive + 14.4 ambient
// point flows toward a product or space that benefits the attacker. (The
// header used to claim "tag forgery has no economic gain"; that was wrong.
// Tagging redirects the victim's flow at the victim's percentHuman, so a
// fully-verified victim is the most valuable target.)

import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { getAccount } from '../../core/account.js';
import { getCycleState } from '../../core/day-cycle.js';
import { getSupportiveTags } from '../../tagging/supportive.js';
import { getAmbientTags } from '../../tagging/ambient.js';
import {
  enqueueTaggingOperation,
  verifyTaggingOperation,
  validateTaggingOperationApplicable,
  deriveProductId,
  deriveSpaceId,
  type TaggingOperation,
} from '../../tagging/tagging-operation.js';
import { authMiddleware } from '../middleware/auth.js';

export function tagRoutes(
  db: DatabaseSync,
  // Gossip a signed tagging op so any proposer includes it (audit #16). Absent
  // outside BFT mode; the op still queues locally and rides this node's blocks.
  taggingOpBroadcaster?: (op: unknown) => void,
): Router {
  const router = Router();

  // Shared handler for the four op-bearing POST routes. Verifies the signed op,
  // confirms it belongs to the authenticated account, checks it applies against
  // committed chain state, then queues + gossips it. The row appears (products/
  // spaces/tags) only once the carrying block commits — same pending model as
  // miner registration and vouches.
  function submitOp(
    req: import('express').Request,
    res: import('express').Response,
    expectedType: TaggingOperation['type'],
    dataFor: (op: TaggingOperation) => Record<string, unknown>,
  ) {
    const accountId = req.accountId!;
    // Back-compat identity guard (mirrors miners.ts): a flat-body accountId that
    // disagrees with the signed caller is a 403 before anything else, so the
    // auth-hardening regression contract holds regardless of the op envelope.
    const claimedAccountId = (req.body.payload && req.body.payload.accountId) ?? req.body.accountId;
    if (claimedAccountId && claimedAccountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'accountId does not match the authenticated account' },
      });
    }
    const account = getAccount(db, accountId);
    if (!account) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'account not found' } });
    }
    const op = (req.body.payload?.op ?? req.body.op) as TaggingOperation | undefined;
    if (!op || op.type !== expectedType) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OP', message: `payload.op must be a signed ${expectedType} operation` },
      });
    }
    if (op.accountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'op.accountId does not match the authenticated account' },
      });
    }
    if (!verifyTaggingOperation(op, account.publicKey)) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_OP_SIGNATURE', message: 'tagging operation signature does not verify' },
      });
    }
    const problem = validateTaggingOperationApplicable(db, op);
    if (problem) {
      return res.status(400).json({ success: false, error: { code: 'OP_NOT_APPLICABLE', message: problem } });
    }
    enqueueTaggingOperation(db, op);
    taggingOpBroadcaster?.(op);
    return res.json({
      success: true,
      data: { status: 'pending', ...dataFor(op) },
      meta: { timestamp: Math.floor(Date.now() / 1000) },
    });
  }

  // ----- Products -----

  // POST /tags/products — auth-required. Registration now rides the chain
  // (audit #16): the client sends a signed product_register op; this route
  // verifies + queues + gossips it, and it applies at commit on every node. The
  // product row appears via GET only once the carrying block commits.
  router.post('/products', authMiddleware(db), (req, res) =>
    submitOp(req, res, 'product_register', (op) => ({
      productId: deriveProductId(op as Extract<TaggingOperation, { type: 'product_register' }>),
    })),
  );

  router.get('/products', (_req, res) => {
    const rows = db.prepare(
      `SELECT id, name, category, manufacturer_id, created_by, is_active, created_at
       FROM products WHERE is_active = 1 ORDER BY created_at DESC`,
    ).all() as Array<Record<string, unknown>>;
    res.json({
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        manufacturerId: r.manufacturer_id,
        createdBy: r.created_by,
        isActive: (r.is_active as number) === 1,
        createdAt: r.created_at,
      })),
    });
  });

  router.get('/products/mine/:owner', (req, res) => {
    const rows = db.prepare(
      `SELECT id, name, category, manufacturer_id, created_by, is_active, created_at
       FROM products WHERE created_by = ? AND is_active = 1 ORDER BY created_at DESC`,
    ).all(req.params.owner) as Array<Record<string, unknown>>;
    res.json({
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        manufacturerId: r.manufacturer_id,
        createdBy: r.created_by,
        isActive: (r.is_active as number) === 1,
        createdAt: r.created_at,
      })),
    });
  });

  // ----- Spaces -----

  // POST /tags/spaces — auth-required. Chain-ordered like /products: a signed
  // space_register op is verified, queued, and gossiped; the row appears at
  // commit. Validity (type, collectionRate, parent/entity existence) is checked
  // by validateTaggingOperationApplicable against committed chain state.
  router.post('/spaces', authMiddleware(db), (req, res) =>
    submitOp(req, res, 'space_register', (op) => ({
      spaceId: deriveSpaceId(op as Extract<TaggingOperation, { type: 'space_register' }>),
    })),
  );

  router.get('/spaces', (_req, res) => {
    const rows = db.prepare(
      `SELECT id, name, type, parent_id, entity_id, collection_rate, is_active, created_at
       FROM spaces WHERE is_active = 1 ORDER BY created_at DESC`,
    ).all() as Array<Record<string, unknown>>;
    res.json({
      spaces: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        parentId: r.parent_id,
        entityId: r.entity_id,
        collectionRate: r.collection_rate,
        isActive: (r.is_active as number) === 1,
        createdAt: r.created_at,
      })),
    });
  });

  // ----- Supportive tags -----

  // POST /tags/supportive — auth-required. Chain-ordered (audit #16): a signed
  // supportive_tag_submit op is verified, queued, and gossiped. The tag rows and
  // their pointsAllocated appear (via GET) once the block commits; the client
  // shows a live local preview until then.
  router.post('/supportive', authMiddleware(db), (req, res) =>
    submitOp(req, res, 'supportive_tag_submit', () => ({})),
  );

  router.get('/supportive/:owner/:day', (req, res) => {
    const day = Number(req.params.day);
    const tags = getSupportiveTags(db, req.params.owner, day);
    res.json({
      tags: tags.map((t) => ({
        id: t.id,
        accountId: t.accountId,
        day: t.day,
        productId: t.productId,
        minutesUsed: t.minutesUsed,
        pointsAllocated: t.pointsAllocated.toString(),
        status: t.status,
      })),
    });
  });

  // ----- Ambient tags -----

  // POST /tags/ambient — auth-required. Mirrors /supportive: a signed
  // ambient_tag_submit op is verified, queued, and gossiped; rows appear at commit.
  router.post('/ambient', authMiddleware(db), (req, res) =>
    submitOp(req, res, 'ambient_tag_submit', () => ({})),
  );

  router.get('/ambient/:owner/:day', (req, res) => {
    const day = Number(req.params.day);
    const tags = getAmbientTags(db, req.params.owner, day);
    res.json({
      tags: tags.map((t) => ({
        id: t.id,
        accountId: t.accountId,
        day: t.day,
        spaceId: t.spaceId,
        minutesOccupied: t.minutesOccupied,
        pointsAllocated: t.pointsAllocated.toString(),
        status: t.status,
      })),
    });
  });

  // Convenience: today's day index, so the wallet doesn't have to
  // compute it from the cycle state itself.
  router.get('/today', (_req, res) => {
    const state = getCycleState(db);
    res.json({ day: state.currentDay, cyclePhase: state.cyclePhase });
  });

  return router;
}
