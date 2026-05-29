// GET /network/blocks/:number — single-block lookup by height. Added so the
// explorer (and any client) can resolve an arbitrary block, not just the
// latest page. Happy path + the two failure modes (not found, bad input).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { createApp } from '../src/api/server.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createGenesisBlock(db);
  return db;
}

async function startApp(db: DatabaseSync): Promise<{ port: number; server: Server }> {
  const server = createServer(createApp(db));
  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { port, server };
}

describe('GET /network/blocks/:number', () => {
  it('returns the genesis block at height 0', async () => {
    const db = freshDb();
    const { port, server } = await startApp(db);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/network/blocks/0`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.success, true);
      assert.equal(body.data.number, 0);
      assert.ok(typeof body.data.hash === 'string' && body.data.hash.length > 0);
    } finally {
      server.close();
    }
  });

  it('404s for a height that does not exist', async () => {
    const db = freshDb();
    const { port, server } = await startApp(db);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/network/blocks/99999`);
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error?.code, 'NOT_FOUND');
    } finally {
      server.close();
    }
  });

  it('400s for a non-numeric height', async () => {
    const db = freshDb();
    const { port, server } = await startApp(db);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/network/blocks/abc`);
      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.error?.code, 'BAD_REQUEST');
    } finally {
      server.close();
    }
  });
});
