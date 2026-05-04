// Phase 65: WebSocket subscribe authentication.
//
// Locks in the signed-handshake property: an account's live event stream
// (balance updates, court filings, verification events) is gated behind a
// signature that proves the connecting client holds the account's private
// key. Without this gate, anyone who learns an account ID could
// passively read someone else's economic activity in real time.
//
// The handshake (server side: ../src/api/websocket.ts):
//   - Client sends { type:'subscribe', accountId, role, timestamp, signature }
//   - Server rebuilds the signed bytes ({action:'subscribe', accountId, role}
//     + timestamp), looks up the account's publicKey, and verifies the sig.
//   - Timestamp must be within a 5-minute window (replay defense).
//   - Failure → server sends { type:'subscribe:error', reason }.
//   - Success → server sends { type:'subscribed', accountId, role } AND
//     starts routing account-specific events to that socket.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { signPayload } from '../src/core/crypto.js';
import { setupWebSocket, eventBus } from '../src/api/websocket.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function startServer(db: DatabaseSync): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    setupWebSocket(server, db);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 1500): Promise<{ type: string; reason?: string; accountId?: string; role?: string; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

describe('Phase 65: WebSocket subscribe authentication', () => {

  it('rejects subscribe with no signature', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { account } = createAccount(db, 'individual', 1, 100);
    const ws = await openWs(port);

    ws.send(JSON.stringify({ type: 'subscribe', accountId: account.id }));
    const msg = await nextMessage(ws);

    assert.equal(msg.type, 'subscribe:error');
    assert.match(msg.reason ?? '', /missing|signature|timestamp/i);

    await closeWs(ws);
    await stopServer(server);
    db.close();
  });

  it('rejects subscribe with an invalid signature (signed by a different key)', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { account: target } = createAccount(db, 'individual', 1, 100);
    const { privateKey: attackerKey } = createAccount(db, 'individual', 1, 100);
    const ws = await openWs(port);

    // Attacker tries to subscribe to target's stream using their OWN key.
    const ts = Math.floor(Date.now() / 1000);
    const role = 'participant';
    const sig = signPayload({ action: 'subscribe', accountId: target.id, role }, ts, attackerKey);
    ws.send(JSON.stringify({ type: 'subscribe', accountId: target.id, role, timestamp: ts, signature: sig }));
    const msg = await nextMessage(ws);

    assert.equal(msg.type, 'subscribe:error');
    assert.match(msg.reason ?? '', /signature|invalid/i);

    await closeWs(ws);
    await stopServer(server);
    db.close();
  });

  it('rejects subscribe with a stale timestamp (>5 min old)', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { account, privateKey } = createAccount(db, 'individual', 1, 100);
    const ws = await openWs(port);

    // Sign a payload from 10 minutes ago. Even with a valid signature this
    // is replay territory and the server must reject.
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const role = 'participant';
    const sig = signPayload({ action: 'subscribe', accountId: account.id, role }, staleTs, privateKey);
    ws.send(JSON.stringify({ type: 'subscribe', accountId: account.id, role, timestamp: staleTs, signature: sig }));
    const msg = await nextMessage(ws);

    assert.equal(msg.type, 'subscribe:error');
    assert.match(msg.reason ?? '', /timestamp|window/i);

    await closeWs(ws);
    await stopServer(server);
    db.close();
  });

  it('accepts subscribe with a valid signature and routes account events', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { account, privateKey } = createAccount(db, 'individual', 1, 100);
    const ws = await openWs(port);

    const ts = Math.floor(Date.now() / 1000);
    const role = 'participant';
    const sig = signPayload({ action: 'subscribe', accountId: account.id, role }, ts, privateKey);
    ws.send(JSON.stringify({ type: 'subscribe', accountId: account.id, role, timestamp: ts, signature: sig }));

    const ack = await nextMessage(ws);
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.accountId, account.id);

    // Now emit a balance update for this account and confirm it arrives.
    const eventPromise = nextMessage(ws);
    eventBus.emit('balance:updated', { accountId: account.id, balance: 1000 });
    const evt = await eventPromise;
    assert.equal(evt.type, 'balance:updated');

    await closeWs(ws);
    await stopServer(server);
    db.close();
  });

  it('does not leak account events to unauthenticated clients', async () => {
    const db = freshDb();
    const { server, port } = await startServer(db);
    const { account } = createAccount(db, 'individual', 1, 100);
    const ws = await openWs(port);

    // Client opens but never sends a valid subscribe. The server must NOT
    // route account-specific events here because client.accountId stays null.
    let received: unknown = null;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'balance:updated') received = msg;
    });

    eventBus.emit('balance:updated', { accountId: account.id, balance: 1000 });
    // Give the event loop a chance to deliver any (incorrect) message.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received, null, 'unauthenticated client must not receive account events');

    await closeWs(ws);
    await stopServer(server);
    db.close();
  });
});
