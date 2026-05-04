import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { setupWebSocket, eventBus } from '../src/api/websocket.js';
import { createAccount, getAccount, updateBalance, countActiveParticipants, getTotalEarnedPool } from '../src/core/account.js';
import { PRECISION, DAILY_ACTIVE_POINTS } from '../src/core/constants.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import WebSocket from 'ws';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    // Use a temporary server for each request
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const req = http.request(url, {
        method,
        headers: bodyStr ? { 'Content-Type': 'application/json' } : {},
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, data });
          }
        });
      });

      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

describe('Phase 7: API Layer', () => {

  // Test 1: Create account via API, verify privateKey in response
  it('creates account via API with privateKey, GET omits privateKey', async () => {
    const db = freshDb();
    const app = createApp(db);

    const { status, data } = await request(app, 'POST', '/api/v1/accounts', { type: 'individual' });
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.ok(data.data.publicKey, 'Should include publicKey');
    assert.ok(data.data.privateKey, 'Should include privateKey on creation');
    assert.ok(data.data.account.id, 'Should include account ID');

    const accountId = data.data.account.id;

    // GET should NOT include privateKey
    const { data: getData } = await request(app, 'GET', `/api/v1/accounts/${accountId}`);
    assert.equal(getData.success, true);
    assert.equal(getData.data.privateKey, undefined, 'GET should not return privateKey');
    assert.ok(getData.data.id, 'Should have account ID');

    db.close();
  });

  // Test 2: Signed transaction auth passes, wrong sig rejected
  it('accepts valid signed transaction, rejects invalid signature', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();

    const sender = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', DAILY_ACTIVE_POINTS);
    const receiver = createAccount(db, 'individual', 1, 100);

    // processTransaction verifies signature against internal format:
    // { from, to, amount: bigintString, pointType, isInPerson, memo }
    const storageAmount = pts(100); // 100 display = 10_000_000_000n
    const internalPayload = {
      from: sender.account.id,
      to: receiver.account.id,
      amount: storageAmount.toString(),
      pointType: 'active',
      isInPerson: false,
      memo: '',
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(internalPayload, timestamp, sender.privateKey);

    // The API payload uses display amount, but we pass the signature that matches internal format
    const apiPayload = {
      to: receiver.account.id,
      amount: 100,
      pointType: 'active',
      isInPerson: false,
      memo: '',
    };

    // Valid signature
    const { status, data } = await request(app, 'POST', '/api/v1/transactions', {
      accountId: sender.account.id,
      timestamp,
      signature,
      payload: apiPayload,
    });
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.success, true);

    // Wrong signature
    const { status: badStatus, data: badData } = await request(app, 'POST', '/api/v1/transactions', {
      accountId: sender.account.id,
      timestamp,
      signature: 'deadbeef'.repeat(16),
      payload: apiPayload,
    });
    assert.ok(badStatus >= 400, `Should reject with error status, got ${badStatus}`);
    assert.equal(badData.success, false);

    db.close();
  });

  // Test 3: Replay protection (timestamp > 5 min old)
  // Test this on a route that uses authMiddleware (e.g. a dummy authenticated route)
  it('rejects requests with expired timestamp via auth middleware', async () => {
    const db = freshDb();
    resetRateLimits();

    // Add a test route that uses auth middleware
    const app = createApp(db);
    const { Router } = await import('express');
    const { authMiddleware } = await import('../src/api/middleware/auth.js');
    const testRouter = Router();
    testRouter.post('/test-auth', authMiddleware(db), (_req, res) => {
      res.json({ success: true, data: { authenticated: true } });
    });
    app.use('/api/v1', testRouter);

    const acct = createAccount(db, 'individual', 1, 100);
    const payload = { test: true };
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const signature = signPayload(payload, oldTimestamp, acct.privateKey);

    const { status, data } = await request(app, 'POST', '/api/v1/test-auth', {
      accountId: acct.account.id,
      timestamp: oldTimestamp,
      signature,
      payload,
    });
    assert.equal(status, 401);
    assert.equal(data.error.code, 'AUTH_EXPIRED');

    db.close();
  });

  // Test 4: Rate limiting
  it('returns 429 when rate limit exceeded', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();

    const sender = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', pts(1000000));
    const receiver = createAccount(db, 'individual', 1, 100);

    let hitLimit = false;
    for (let i = 0; i < 25; i++) {
      const storageAmt = pts(1);
      const internalPayload = {
        from: sender.account.id,
        to: receiver.account.id,
        amount: storageAmt.toString(),
        pointType: 'active',
        isInPerson: false,
        memo: '',
      };
      const timestamp = Math.floor(Date.now() / 1000) + i;
      const signature = signPayload(internalPayload, timestamp, sender.privateKey);

      const { status, data } = await request(app, 'POST', '/api/v1/transactions', {
        accountId: sender.account.id,
        timestamp,
        signature,
        payload: { to: receiver.account.id, amount: 1, pointType: 'active', isInPerson: false, memo: '' },
      });

      if (status === 429) {
        hitLimit = true;
        assert.ok(data.error.code === 'RATE_LIMITED');
        break;
      }
    }

    assert.ok(hitLimit, 'Should have hit rate limit within 25 requests');

    db.close();
  });

  // Test 5: WebSocket events
  it('pushes transaction:received event via WebSocket', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();
    const server = http.createServer(app);
    const wss = setupWebSocket(server, db);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };

    const receiver = createAccount(db, 'individual', 1, 100);

    // Connect WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    const receivedEvents: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        const ts = Math.floor(Date.now() / 1000);
        const sig = signPayload({ action: 'subscribe', accountId: receiver.account.id, role: 'participant' }, ts, receiver.privateKey);
        ws.send(JSON.stringify({ type: 'subscribe', accountId: receiver.account.id, role: 'participant', timestamp: ts, signature: sig }));
        setTimeout(resolve, 100);
      });
    });

    ws.on('message', (data) => {
      receivedEvents.push(JSON.parse(data.toString()));
    });

    // Emit a test event
    eventBus.emit('transaction:received', { accountId: receiver.account.id, amount: '1000' });

    // Wait a bit for event delivery
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have received: subscribed + transaction:received
    const txEvent = receivedEvents.find((e) => e.type === 'transaction:received');
    assert.ok(txEvent, 'Should receive transaction:received event');
    assert.equal(txEvent.data.accountId, receiver.account.id);

    ws.close();
    wss.close();
    server.close();

    db.close();
  });

  // Test 6: (Simplified) WebSocket miner event
  it('pushes miner events to subscribed miner', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();
    const server = http.createServer(app);
    const wss = setupWebSocket(server, db);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };

    const minerAcct = createAccount(db, 'individual', 1, 100);
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    const events: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        const ts = Math.floor(Date.now() / 1000);
        const sig = signPayload({ action: 'subscribe', accountId: minerAcct.account.id, role: 'miner' }, ts, minerAcct.privateKey);
        ws.send(JSON.stringify({ type: 'subscribe', accountId: minerAcct.account.id, role: 'miner', timestamp: ts, signature: sig }));
        setTimeout(resolve, 100);
      });
    });

    ws.on('message', (data) => events.push(JSON.parse(data.toString())));

    eventBus.emit('verification:assigned', { accountId: minerAcct.account.id, panelId: 'panel-1' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const assignEvent = events.find((e) => e.type === 'verification:assigned');
    assert.ok(assignEvent, 'Miner should receive verification:assigned event');

    ws.close();
    wss.close();
    server.close();
    db.close();
  });

  // Test 7: Pagination
  it('paginates transaction list correctly', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();

    const sender = createAccount(db, 'individual', 1, 100);
    updateBalance(db, sender.account.id, 'active_balance', pts(100000));
    const receiver = createAccount(db, 'individual', 1, 100);

    // Create 50 transactions directly in DB (avoids rate limiting)
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 50; i++) {
      db.prepare(
        `INSERT INTO transactions (id, "from", "to", amount, fee, net_amount, point_type, is_in_person, memo, signature, timestamp, block_number)
         VALUES (?, ?, ?, ?, '0', ?, 'active', 0, ?, 'sig', ?, NULL)`
      ).run(`tx-${i}`, sender.account.id, receiver.account.id, pts(1).toString(), pts(1).toString(), `tx-${i}`, now + i);
    }

    // Query page 2 with limit 20
    const { status, data } = await request(app, 'GET', `/api/v1/accounts/${sender.account.id}/transactions?page=2&limit=20`);
    assert.equal(status, 200);
    assert.equal(data.data.transactions.length, 20, 'Should return 20 transactions');
    assert.equal(data.data.total, 50, 'Total should be 50');
    assert.equal(data.data.page, 2);

    db.close();
  });

  // Test 8: Network status
  it('returns correct network status', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();

    // Create some accounts
    for (let i = 0; i < 5; i++) {
      const a = createAccount(db, 'individual', 1, 100);
      updateBalance(db, a.account.id, 'earned_balance', pts(1000));
    }

    const { status, data } = await request(app, 'GET', '/api/v1/network/status');
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.data.participantCount, 5);
    assert.equal(data.data.currentDay, 1);

    // Verify total earned pool matches direct query
    const directTotal = getTotalEarnedPool(db);
    assert.equal(data.data.totalEarnedPool, directTotal.toString());

    db.close();
  });

  // Test 9: Error format for invalid request
  it('returns structured error for invalid transaction', async () => {
    const db = freshDb();
    const app = createApp(db);
    resetRateLimits();

    const sender = createAccount(db, 'individual', 1, 100);
    const payload = { to: 'nonexistent', amount: -100, pointType: 'active', isInPerson: false, memo: '' };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(payload, timestamp, sender.privateKey);

    const { status, data } = await request(app, 'POST', '/api/v1/transactions', {
      accountId: sender.account.id, timestamp, signature, payload,
    });

    assert.equal(data.success, false);
    assert.ok(data.error.code, 'Error should have a code');
    assert.ok(data.error.message, 'Error should have a message');

    db.close();
  });
});
