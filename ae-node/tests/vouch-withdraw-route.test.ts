// POST /miners/vouches/:id/withdraw - the route that lets a voucher unstake.
//
// This endpoint is unusual: it moves the caller's own money AND lowers a THIRD
// PARTY's percentHuman. So the auth gate is not just "are you signed in", it is
// "are you the person who staked". Without the ownership check anyone could
// withdraw someone else's vouch and knock down an account they have no
// relationship with, which is a cheap way to strip a rival of their ability to
// spend.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createApp } from '../src/api/server.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { createVouch } from '../src/verification/vouching.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
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
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method, headers: bodyStr ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
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
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

function makeAccount(db: DatabaseSync, percentHuman = 100) {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  return { accountId: r.account.id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

function envelope(accountId: string, privateKey: string, vouchId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { vouchId };
  return { accountId, timestamp, signature: signPayload(payload, timestamp, privateKey), payload };
}

describe('POST /miners/vouches/:id/withdraw', () => {
  beforeEach(() => resetRateLimits());

  it('lets the voucher withdraw, returning the stake and dropping the score', async () => {
    const db = freshDb();
    const voucher = makeAccount(db);
    const vouched = makeAccount(db, 40);
    updateBalance(db, voucher.accountId, 'earned_balance', 10_000n);

    const vouch = createVouch(db, voucher.accountId, vouched.accountId, 10);
    const staked = getAccount(db, voucher.accountId)!.lockedBalance;

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/miners/vouches/${vouch.id}/withdraw`,
      envelope(voucher.accountId, voucher.privateKey, vouch.id),
    );

    assert.equal(res.status, 200);
    assert.equal(res.data.data.percentHumanReduction, 10);
    assert.equal(getAccount(db, voucher.accountId)!.lockedBalance, 0n);
    assert.equal(getAccount(db, vouched.accountId)!.percentHuman, 30);
    assert.ok(getAccount(db, voucher.accountId)!.earnedBalance >= staked);
    db.close();
  });

  it('rejects a stranger with 403, leaving the score untouched', async () => {
    const db = freshDb();
    const voucher = makeAccount(db);
    const vouched = makeAccount(db, 40);
    const stranger = makeAccount(db);
    updateBalance(db, voucher.accountId, 'earned_balance', 10_000n);

    const vouch = createVouch(db, voucher.accountId, vouched.accountId, 10);

    const res = await request(
      createApp(db),
      'POST',
      `/api/v1/miners/vouches/${vouch.id}/withdraw`,
      envelope(stranger.accountId, stranger.privateKey, vouch.id),
    );

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'NOT_VOUCHER');
    // The attack this blocks: stripping a third party's ability to spend.
    assert.equal(getAccount(db, vouched.accountId)!.percentHuman, 40);
    assert.ok(getAccount(db, voucher.accountId)!.lockedBalance > 0n);
    db.close();
  });

  it('rejects an unsigned request with 401', async () => {
    const db = freshDb();
    const voucher = makeAccount(db);
    const vouched = makeAccount(db, 40);
    updateBalance(db, voucher.accountId, 'earned_balance', 10_000n);
    const vouch = createVouch(db, voucher.accountId, vouched.accountId, 10);

    const res = await request(createApp(db), 'POST', `/api/v1/miners/vouches/${vouch.id}/withdraw`, {
      accountId: voucher.accountId,
    });

    assert.equal(res.status, 401);
    assert.equal(getAccount(db, vouched.accountId)!.percentHuman, 40);
    db.close();
  });

  it('404s on an unknown or already-withdrawn vouch', async () => {
    const db = freshDb();
    const voucher = makeAccount(db);
    const res = await request(
      createApp(db),
      'POST',
      '/api/v1/miners/vouches/does-not-exist/withdraw',
      envelope(voucher.accountId, voucher.privateKey, 'does-not-exist'),
    );
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'VOUCH_NOT_FOUND');
    db.close();
  });
});
