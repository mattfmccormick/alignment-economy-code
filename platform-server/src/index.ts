// Platform server entry point. Boots the SQLite db, configures middleware,
// mounts the routers, listens on the configured port.
//
// Stays minimal on purpose. Routes live in src/routes/*; this file just
// wires them together so an integration test can call createApp() without
// listening on a real port.

import express, { type Application } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig, type PlatformConfig } from './config.js';
import { initializeSchema } from './schema.js';
import { authRoutes } from './routes/auth.js';
import { recoveryRoutes } from './routes/recovery.js';
import { createMailer, type Mailer } from './mailer.js';

export function createApp(db: DatabaseSync, config?: PlatformConfig, mailer?: Mailer): Application {
  const app = express();
  app.use(express.json({ limit: '128kb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) });
  });

  // Tests pass explicit config + mailer so they can use deterministic
  // parameters and inspect what would have been emailed. The runtime
  // entry below loads the real config + chooses the SMTP/console mailer
  // based on env.
  const cfg = config ?? loadConfig();
  const m = mailer ?? createMailer(cfg);
  app.use('/api/v1', authRoutes(db, cfg));
  app.use('/api/v1', recoveryRoutes(db, cfg, m));

  return app;
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  initializeSchema(db);
  return db;
}

// Bootstrap when the file is run directly (`tsx watch src/index.ts`).
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
               process.argv[1]?.endsWith('src/index.ts') ||
               process.argv[1]?.endsWith('dist/index.js');

if (isMain) {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const app = createApp(db);
  app.listen(config.port, () => {
    console.log(`[platform-server] listening on http://localhost:${config.port}`);
    console.log(`[platform-server] db: ${config.dbPath}`);
    console.log(`[platform-server] recovery public key: ${config.recoveryPublicKey}`);
    console.log(`[platform-server] email mode: ${config.emailMode}`);
  });
}
