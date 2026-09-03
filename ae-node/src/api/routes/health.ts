import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { getLatestBlock } from '../../core/block.js';
import { countActiveParticipants } from '../../core/account.js';
import { getCycleState } from '../../core/day-cycle.js';
import { getConnectedClients } from '../websocket.js';

export interface NodeIdentitySummary {
  /** The account this node validates as, or null in Authority/observer mode. */
  accountId: string | null;
  /** 'bft' or 'authority'. */
  consensusMode: string;
  /** Target seconds between blocks, so peers can be checked for agreement. */
  blockIntervalMs: number;
}

export function healthRoutes(db: DatabaseSync, identity?: NodeIdentitySummary) {
  const router = Router();

  // Basic health check (for load balancers, Docker HEALTHCHECK)
  router.get('/health', (_req, res) => {
    try {
      // Quick DB check
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) });
    } catch {
      res.status(503).json({ status: 'unhealthy', timestamp: Math.floor(Date.now() / 1000) });
    }
  });

  // Detailed status (for monitoring dashboards)
  router.get('/status', (_req, res) => {
    try {
      const latest = getLatestBlock(db);
      const cycleState = getCycleState(db);
      const participants = countActiveParticipants(db);
      const wsClients = getConnectedClients();
      const uptime = process.uptime();
      const mem = process.memoryUsage();

      res.json({
        status: 'ok',
        node: {
          version: '0.1.0',
          uptime: Math.floor(uptime),
          pid: process.pid,
          accountId: identity?.accountId ?? null,
          consensusMode: identity?.consensusMode ?? null,
          blockIntervalMs: identity?.blockIntervalMs ?? null,
          // Whether this node can currently propose. A validator-change request
          // sent to a node where this is false queues locally and never reaches
          // a block, because the queue is drained only by the proposer.
          isActiveValidator: identity?.accountId
            ? Boolean(
                (
                  db
                    .prepare(
                      'SELECT 1 AS ok FROM validators WHERE account_id = ? AND is_active = 1',
                    )
                    .get(identity.accountId) as { ok: number } | undefined
                )?.ok,
              )
            : false,
        },
        chain: {
          blockHeight: latest?.number ?? 0,
          latestBlockHash: latest?.hash ?? null,
          latestBlockTime: latest?.timestamp ?? null,
        },
        cycle: {
          currentDay: cycleState.currentDay,
          phase: cycleState.cyclePhase,
        },
        network: {
          participants,
          wsClients,
        },
        memory: {
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
          rssMb: Math.round(mem.rss / 1024 / 1024),
        },
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: String(err) });
    }
  });

  // Prometheus-style metrics (text/plain)
  router.get('/metrics', (_req, res) => {
    try {
      const latest = getLatestBlock(db);
      const cycleState = getCycleState(db);
      const participants = countActiveParticipants(db);
      const wsClients = getConnectedClients();
      const mem = process.memoryUsage();

      const lines = [
        '# HELP ae_block_height Current block height',
        '# TYPE ae_block_height gauge',
        `ae_block_height ${latest?.number ?? 0}`,
        '# HELP ae_current_day Current day in the cycle',
        '# TYPE ae_current_day gauge',
        `ae_current_day ${cycleState.currentDay}`,
        '# HELP ae_participants_total Total active participants',
        '# TYPE ae_participants_total gauge',
        `ae_participants_total ${participants}`,
        '# HELP ae_ws_clients Connected WebSocket clients',
        '# TYPE ae_ws_clients gauge',
        `ae_ws_clients ${wsClients}`,
        '# HELP ae_uptime_seconds Node uptime in seconds',
        '# TYPE ae_uptime_seconds gauge',
        `ae_uptime_seconds ${Math.floor(process.uptime())}`,
        '# HELP ae_memory_heap_bytes Heap memory used',
        '# TYPE ae_memory_heap_bytes gauge',
        `ae_memory_heap_bytes ${mem.heapUsed}`,
        '',
      ];

      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.send(lines.join('\n'));
    } catch {
      res.status(500).send('# error collecting metrics\n');
    }
  });

  return router;
}
