import express from 'express';
import { createServer } from 'http';
import { DatabaseSync } from 'node:sqlite';
import { accountRoutes } from './routes/accounts.js';
import { transactionRoutes, type TxBroadcaster } from './routes/transactions.js';
import { networkRoutes } from './routes/network.js';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { contactRoutes } from './routes/contacts.js';
import { minerRoutes } from './routes/miners.js';
import { recurringRoutes } from './routes/recurring.js';
import { verificationRoutes } from './routes/verification.js';
import { courtRoutes } from './routes/court.js';
import { validatorRoutes } from './routes/validators.js';
import { tagRoutes } from './routes/tags.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { setupWebSocket } from './websocket.js';

export interface CreateAppOptions {
  /**
   * Optional callback fired after a successful tx submission. Runner
   * provides this in BFT mode to gossip the tx; in Authority mode it's
   * omitted (the authority's own block production picks up local txs
   * from the DB).
   */
  txBroadcaster?: TxBroadcaster;
}

export function createApp(db: DatabaseSync, opts: CreateAppOptions = {}) {
  const app = express();

  // Middleware
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
  app.use('/api/v1/accounts', accountRoutes(db));
  app.use('/api/v1/transactions', transactionRoutes(db, opts.txBroadcaster));
  app.use('/api/v1/network', networkRoutes(db));
  app.use('/api/v1', healthRoutes(db));
  app.use('/api/v1/admin', adminRoutes(db));
  app.use('/api/v1/contacts', contactRoutes(db));
  app.use('/api/v1/miners', minerRoutes(db));
  app.use('/api/v1/recurring', recurringRoutes(db));
  app.use('/api/v1/verification', verificationRoutes(db));
  app.use('/api/v1/court', courtRoutes(db));
  app.use('/api/v1/validators', validatorRoutes(db));
  app.use('/api/v1/tags', tagRoutes(db));

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
    console.log(`AE Node API running on port ${port}`);
  });

  return { app, server, wss };
}
