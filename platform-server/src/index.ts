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

  // Tests pass explicit config + mailer so they can use deterministic
  // parameters and inspect what would have been emailed. The runtime
  // entry below loads the real config + chooses the SMTP/console mailer
  // based on env.
  const cfgPre = config ?? loadConfig();

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) });
  });

  // Public endpoint: the SDK calls this before signup so it can encrypt
  // the recovery blob with the server's long-term recovery public key.
  // The key itself is not a secret; publishing it just lets clients
  // know which key envelope to seal their plaintext under.
  app.get('/api/v1/recovery-pubkey', (_req, res) => {
    res.json({ success: true, data: { recoveryPublicKey: cfgPre.recoveryPublicKey } });
  });

  const cfg = cfgPre;
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

// Bootstrap when the file is run directly (`tsx src/index.ts`, `tsx watch`,
// or `node dist/index.js`). Normalize backslashes to forward slashes so the
// suffix check works on Windows.
const argv1 = (process.argv[1] ?? '').replace(/\\/g, '/');
const isMain =
  argv1.endsWith('platform-server/src/index.ts') ||
  argv1.endsWith('platform-server/dist/index.js') ||
  argv1.endsWith('/src/index.ts') ||
  argv1.endsWith('/dist/index.js');

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
