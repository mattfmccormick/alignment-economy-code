// Phase 34: API tx broadcast (BFT mode).
//
// When the API's POST /transactions handler succeeds in BFT mode, it
// fires the configured txBroadcaster with the wire form of the new tx.
// In production the runner wires this to peerManager.broadcast so every
// validator's findUnblockedTransactions sees it. The unit-level test
// captures the broadcast via a mock callback.
//
// Verified:
//   1. txBroadcaster fires on successful submission with the right shape
//   2. txBroadcaster does NOT fire when no broadcaster is configured
//      (back-compat: existing Authority-mode call sites pass `createApp(db)`)
//   3. txBroadcaster does NOT fire when the submission fails (bad sig)
//   4. A throwing broadcaster does NOT poison the API response — gossip
//      is best-effort

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount, updateBalance } from '../src/core/account.js';
import { PRECISION, DAILY_ACTIVE_POINTS } from '../src/core/constants.js';
import { signPayload } from '../src/core/crypto.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import type { WireTransaction } from '../src/network/block-validator.js';

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
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        url,
        { method, headers: bodyStr ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, data: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode!, data });
            }
          });
        },
      );
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

interface TxSubmission {
  apiBody: unknown;
  storageAmount: bigint;
  receiverId: string;
  senderId: string;
  signedTimestamp: number;
}

/** Set up a sender + receiver and craft a valid signed API submission. */
function buildSignedTx(db: DatabaseSync): TxSubmission {
  const sender = createAccount(db, 'individual', 1, 100);
  updateBalance(db, sender.account.id, 'active_balance', DAILY_ACTIVE_POINTS);
  const receiver = createAccount(db, 'individual', 1, 100);

  const storageAmount = pts(50);
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

  return {
    apiBody: {
      accountId: sender.account.id,
      timestamp,
      signature,
      payload: {
        to: receiver.account.id,
        amount: 50,
        pointType: 'active',
        isInPerson: false,
        memo: '',
      },
    },
    storageAmount,
    receiverId: receiver.account.id,
    senderId: sender.account.id,
    signedTimestamp: timestamp,
  };
}

describe('Phase 34: API tx broadcast (BFT mode)', () => {
  it('fires txBroadcaster with the wire-form tx after successful submission', async () => {
    const db = freshDb();
    resetRateLimits();

    const broadcasts: WireTransaction[] = [];
    const app = createApp(db, {
      txBroadcaster: (tx) => {
        broadcasts.push(tx);
      },
    });

    const tx = buildSignedTx(db);
    const { status, data } = await request(app, 'POST', '/api/v1/transactions', tx.apiBody);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);

    assert.equal(broadcasts.length, 1, 'broadcaster should have fired exactly once');
    const wire = broadcasts[0];
    assert.equal(wire.id, data.data.transaction.id);
    assert.equal(wire.from, tx.senderId);
    assert.equal(wire.to, tx.receiverId);
    assert.equal(wire.amount, tx.storageAmount.toString());
    assert.equal(wire.pointType, 'active');
    assert.equal(wire.isInPerson, false);
    assert.equal(wire.memo, '');
    assert.equal(typeof wire.signature, 'string');
    assert.equal(wire.signature.length > 0, true);
    assert.equal(wire.timestamp, tx.signedTimestamp);

    db.close();
  });

  it('does NOT fire when no broadcaster is configured (Authority back-compat)', async () => {
    const db = freshDb();
    resetRateLimits();

    // No opts → no broadcaster → existing call sites unchanged.
    const app = createApp(db);

    const tx = buildSignedTx(db);
    const { status, data } = await request(app, 'POST', '/api/v1/transactions', tx.apiBody);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);

    // The default-no-broadcaster case is verified just by completing
    // without throwing — there's no broadcaster array to check against.
    db.close();
  });

  it('does NOT fire when the submission fails (bad signature)', async () => {
    const db = freshDb();
    resetRateLimits();

    const broadcasts: WireTransaction[] = [];
    const app = createApp(db, {
      txBroadcaster: (tx) => {
        broadcasts.push(tx);
      },
    });

    const tx = buildSignedTx(db);
    const badBody = {
      ...(tx.apiBody as object),
      signature: 'deadbeef'.repeat(16), // invalid
    };
    const { status, data } = await request(app, 'POST', '/api/v1/transactions', badBody);
    assert.ok(status >= 400, `Expected error status, got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.success, false);

    assert.equal(broadcasts.length, 0, 'broadcaster must not fire on rejected submissions');

    db.close();
  });

  it('a throwing broadcaster does not break the API response', async () => {
    const db = freshDb();
    resetRateLimits();

    const app = createApp(db, {
      txBroadcaster: () => {
        throw new Error('simulated peer manager failure');
      },
    });

    const tx = buildSignedTx(db);
    const { status, data } = await request(app, 'POST', '/api/v1/transactions', tx.apiBody);
    // Tx still committed locally, API still responded 200 — broadcast is
    // best-effort and a network failure shouldn't fail the user.
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.success, true);
    assert.ok(data.data.transaction.id);

    db.close();
  });
});
