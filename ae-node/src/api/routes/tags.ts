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
import { registerProduct, getProduct } from '../../tagging/products.js';
import { registerSpace, getSpace } from '../../tagging/spaces.js';
import {
  submitSupportiveTags,
  getSupportiveTags,
  type TagInput,
} from '../../tagging/supportive.js';
import {
  submitAmbientTags,
  getAmbientTags,
  type AmbientTagInput,
} from '../../tagging/ambient.js';
import { authMiddleware } from '../middleware/auth.js';
import type { SpaceType } from '../../tagging/types.js';

const VALID_SPACE_TYPES: SpaceType[] = [
  'room', 'building', 'park', 'road', 'transit', 'city', 'state', 'nation', 'custom',
];

export function tagRoutes(db: DatabaseSync): Router {
  const router = Router();

  // ----- Products -----

  router.post('/products', (req, res) => {
    const { name, category, createdBy, manufacturerId } = req.body || {};
    if (!name || !category || !createdBy) {
      return res.status(400).json({ error: 'name, category, and createdBy are required' });
    }
    const owner = getAccount(db, createdBy);
    if (!owner) return res.status(404).json({ error: 'createdBy account not found' });
    if (manufacturerId) {
      const mfg = getAccount(db, manufacturerId);
      if (!mfg) return res.status(404).json({ error: 'manufacturer account not found' });
    }

    const product = registerProduct(db, name, category, createdBy, manufacturerId || undefined);
    res.json({ product });
  });

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

  router.post('/spaces', (req, res) => {
    const { name, type, parentId, entityId, collectionRate } = req.body || {};
    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required' });
    }
    if (!VALID_SPACE_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_SPACE_TYPES.join(', ')}` });
    }
    if (parentId && !getSpace(db, parentId)) {
      return res.status(404).json({ error: 'parent space not found' });
    }
    if (entityId && !getAccount(db, entityId)) {
      return res.status(404).json({ error: 'entity account not found' });
    }

    const space = registerSpace(
      db,
      name,
      type,
      parentId || undefined,
      entityId || undefined,
      typeof collectionRate === 'number' ? collectionRate : 0,
    );
    res.json({ space });
  });

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

  // POST /tags/supportive — auth-required. The signed account is taken to
  // be the tag owner; a top-level `accountId` in the body is back-compat
  // only and rejected with 403 if it disagrees with the signed caller.
  router.post('/supportive', authMiddleware(db), (req, res) => {
    const accountId = req.accountId!;
    const { day, tags } = req.body.payload || req.body;
    const claimedAccountId = (req.body.payload && req.body.payload.accountId) ?? req.body.accountId;
    if (claimedAccountId && claimedAccountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'accountId does not match the authenticated account' },
      });
    }
    if (day === undefined || !Array.isArray(tags)) {
      return res.status(400).json({ error: 'day and tags[] are required' });
    }
    const owner = getAccount(db, accountId);
    if (!owner) return res.status(404).json({ error: 'account not found' });

    const inputs: TagInput[] = tags.map((t: any) => ({
      productId: String(t.productId),
      minutesUsed: Number(t.minutesUsed),
    }));

    try {
      const out = submitSupportiveTags(db, accountId, Number(day), inputs);
      res.json({
        tags: out.map((t) => ({
          id: t.id,
          accountId: t.accountId,
          day: t.day,
          productId: t.productId,
          minutesUsed: t.minutesUsed,
          pointsAllocated: t.pointsAllocated.toString(),
          status: t.status,
        })),
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? 'invalid submission' });
    }
  });

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

  // POST /tags/ambient — auth-required. Mirrors /supportive's auth shape.
  router.post('/ambient', authMiddleware(db), (req, res) => {
    const accountId = req.accountId!;
    const { day, tags } = req.body.payload || req.body;
    const claimedAccountId = (req.body.payload && req.body.payload.accountId) ?? req.body.accountId;
    if (claimedAccountId && claimedAccountId !== accountId) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_MISMATCH', message: 'accountId does not match the authenticated account' },
      });
    }
    if (day === undefined || !Array.isArray(tags)) {
      return res.status(400).json({ error: 'day and tags[] are required' });
    }
    const owner = getAccount(db, accountId);
    if (!owner) return res.status(404).json({ error: 'account not found' });

    const inputs: AmbientTagInput[] = tags.map((t: any) => ({
      spaceId: String(t.spaceId),
      minutesOccupied: Number(t.minutesOccupied),
    }));

    try {
      const out = submitAmbientTags(db, accountId, Number(day), inputs);
      res.json({
        tags: out.map((t) => ({
          id: t.id,
          accountId: t.accountId,
          day: t.day,
          spaceId: t.spaceId,
          minutesOccupied: t.minutesOccupied,
          pointsAllocated: t.pointsAllocated.toString(),
          status: t.status,
        })),
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? 'invalid submission' });
    }
  });

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
