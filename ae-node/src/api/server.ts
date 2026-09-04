import express from 'express';
import { createServer } from 'http';
import { DatabaseSync } from 'node:sqlite';
import { accountRoutes, type AccountBroadcaster } from './routes/accounts.js';
import { transactionRoutes, type TxBroadcaster } from './routes/transactions.js';
import { networkRoutes } from './routes/network.js';
import { healthRoutes, type NodeIdentitySummary } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { contactRoutes } from './routes/contacts.js';
import { minerRoutes } from './routes/miners.js';
import { recurringRoutes } from './routes/recurring.js';
import { verificationRoutes } from './routes/verification.js';
import { courtRoutes } from './routes/court.js';
import { validatorRoutes } from './routes/validators.js';
import { tagRoutes } from './routes/tags.js';
import { founderRoutes } from './routes/founder.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { setupWebSocket } from './websocket.js';
import { buildOpenApiSpec } from './openapi.js';
import { logger } from '../node/logger.js';

export interface CreateAppOptions {
  /**
   * Optional callback fired after a successful tx submission. Runner
   * provides this in BFT mode to gossip the tx; in Authority mode it's
   * omitted (the authority's own block production picks up local txs
   * from the DB).
   */
  txBroadcaster?: TxBroadcaster;
  /**
   * Optional callback fired after an account is created. Runner provides this
   * in BFT mode so the new account reaches every peer; without it the account
   * exists only on this node and blocks carrying its transactions fail to
   * replay elsewhere. Omitted in single-node/Authority mode.
   */
  accountBroadcaster?: AccountBroadcaster;
  /**
   * When a submitted transaction's balance effect happens. See ExecutionMode
   * in node/config.ts.
   *
   * Defaults to 'receipt' here, NOT to the node's 'commit' default, because
   * createApp is used directly by a large body of tests that submit a
   * transaction and immediately assert on settled balances. The runner passes
   * the real configured mode, so production behaviour comes from config; this
   * default only governs callers that construct the app by hand.
   */
  executionMode?: 'receipt' | 'commit';
  /**
   * Who this node is, surfaced on GET /api/v1/status.
   *
   * Answers a question an operator otherwise cannot answer from outside the
   * process: which validator is this, and is it currently in the active set?
   * That matters because a validator-change request only reaches the chain if
   * the node receiving it is a proposer — it queues locally and is drained when
   * that node next proposes. POST a registration at a non-validator and it sits
   * in a queue forever, with no error anywhere. scripts checking this before
   * submitting is the difference between a clear message and an afternoon.
   */
  nodeIdentity?: NodeIdentitySummary;
  /**
   * How many P2P peers this node currently has, surfaced on GET /status and
   * /metrics. Deferred (a getter) because the P2P node is constructed after the
   * API server. Omitted for single-node/Authority setups.
   */
  getPeerCount?: () => number;
  /**
   * Gossip a signed vouch operation to peers so every node queues it for the
   * next block (audit #4/#16). Runner provides it in BFT mode; omitted otherwise.
   */
  vouchOpBroadcaster?: (op: unknown) => void;
  /** Gossip a signed miner operation to peers (audit #5/#6/#7). */
  minerOpBroadcaster?: (op: unknown) => void;
}

export function createApp(db: DatabaseSync, opts: CreateAppOptions = {}) {
  const app = express();

  // Middleware. requestId runs first so every later step (and the error
  // handler) can log and return a stable request id.
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(rateLimitMiddleware());

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Routes
  app.use('/api/v1/accounts', accountRoutes(db, opts.accountBroadcaster));
  app.use(
    '/api/v1/transactions',
    transactionRoutes(db, opts.txBroadcaster, opts.executionMode ?? 'receipt'),
  );
  app.use('/api/v1/network', networkRoutes(db));
  app.use('/api/v1', healthRoutes(db, opts.nodeIdentity, opts.getPeerCount));
  app.use('/api/v1/admin', adminRoutes(db));
  app.use('/api/v1/contacts', contactRoutes(db));
  app.use('/api/v1/miners', minerRoutes(db, opts.vouchOpBroadcaster, opts.minerOpBroadcaster));
  app.use('/api/v1/recurring', recurringRoutes(db));
  app.use('/api/v1/verification', verificationRoutes(db));
  app.use('/api/v1/court', courtRoutes(db));
  app.use('/api/v1/validators', validatorRoutes(db));
  app.use('/api/v1/tags', tagRoutes(db));
  app.use('/api/v1/founder', founderRoutes());

  // Machine-readable API contract, generated from the same zod schemas the
  // write routes validate against.
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.json(buildOpenApiSpec());
  });

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}

export function startServer(
  db: DatabaseSync,
  port: number = 3000,
  opts: CreateAppOptions = {},
) {
  const app = createApp(db, opts);
  const server = createServer(app);
  const wss = setupWebSocket(server, db);

  server.listen(port, () => {
    logger.info('api', 'AE Node API listening', { port });
  });

  return { app, server, wss };
}
