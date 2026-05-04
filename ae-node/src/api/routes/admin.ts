import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { runDayCycle, getCycleState } from '../../core/day-cycle.js';
import { countActiveParticipants } from '../../core/account.js';
import { getLatestBlock } from '../../core/block.js';
import { eventBus } from '../websocket.js';

// Admin endpoints are gated by a shared secret set at startup. The secret is
// only set when AE_ADMIN_SECRET is provided in the environment, otherwise the
// admin routes are not exposed at all. This keeps the production binary safe
// from accidentally-exposed test endpoints (the previous implementation had
// no auth and would let any client jump the network forward arbitrary days).
const ADMIN_SECRET = process.env.AE_ADMIN_SECRET ?? '';

function checkAdminAuth(req: { headers: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (!ADMIN_SECRET) {
    res.status(403).json({
      success: false,
      error: { code: 'ADMIN_DISABLED', message: 'Admin endpoints are disabled. Start the node with AE_ADMIN_SECRET set to enable.' },
    });
    return false;
  }
  const provided = (req.headers['x-admin-secret'] || '') as string;
  // Constant-time comparison via length + character-by-character XOR.
  if (provided.length !== ADMIN_SECRET.length) {
    res.status(401).json({ success: false, error: { code: 'ADMIN_AUTH_FAILED', message: 'Invalid admin secret' } });
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ADMIN_SECRET.length; i++) {
    diff |= provided.charCodeAt(i) ^ ADMIN_SECRET.charCodeAt(i);
  }
  if (diff !== 0) {
    res.status(401).json({ success: false, error: { code: 'ADMIN_AUTH_FAILED', message: 'Invalid admin secret' } });
    return false;
  }
  return true;
}

export function adminRoutes(db: DatabaseSync) {
  const router = Router();

  // POST /admin/advance-day - manually trigger a day cycle (testing only).
  // Requires the X-Admin-Secret header to match AE_ADMIN_SECRET. Without the
  // env var set, the endpoint is closed.
  router.post('/advance-day', (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const before = getCycleState(db);
      const rebaseEvent = runDayCycle(db);
      const after = getCycleState(db);
      const participants = countActiveParticipants(db);
      const latest = getLatestBlock(db);

      // Notify WebSocket clients
      if (rebaseEvent) {
        eventBus.emit('rebase:complete', rebaseEvent);
      }
      eventBus.emit('network:day-change', { day: after.currentDay });

      res.json({
        success: true,
        previousDay: before.currentDay,
        currentDay: after.currentDay,
        participants,
        blockHeight: latest?.number ?? 0,
        rebase: rebaseEvent
          ? {
              multiplier: rebaseEvent.rebaseMultiplier,
              participantCount: rebaseEvent.participantCount,
            }
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /admin/state - read-only view of the cycle clock and chain head.
  // Public: same data is observable by any node that follows blocks.
  router.get('/state', (_req, res) => {
    const state = getCycleState(db);
    const participants = countActiveParticipants(db);
    const latest = getLatestBlock(db);
    res.json({
      currentDay: state.currentDay,
      cyclePhase: state.cyclePhase,
      participants,
      blockHeight: latest?.number ?? 0,
    });
  });

  return router;
}
