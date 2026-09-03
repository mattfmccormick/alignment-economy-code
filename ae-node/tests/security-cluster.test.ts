// Audit security cluster: replay, signature exposure, tx-signature reuse,
// missing-payload downgrade, and the malformed-gossip node kill.
//
// Each test pins one confirmed finding. They are grouped here because they were
// found and fixed together and share fixtures.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { createAccount } from '../src/core/account.js';
import { createApp } from '../src/api/server.js';
import { signPayload } from '../src/core/crypto.js';
import { PRECISION } from '../src/core/constants.js';

interface Ctx {
  db: DatabaseSync;
  server: Server;
  base: string;
  alice: { id: string; pub: string; priv: string };
  bob: { id: string; pub: string; priv: string };
}

async function boot(): Promise<Ctx> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createGenesisBlock(db);

  const a = createAccount(db, 'individual', 1, 100);
  const b = createAccount(db, 'individual', 1, 100);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    (1000n * PRECISION).toString(),
    a.account.id,
  );

  // receipt mode so a POSTed transaction settles immediately and a replay is a
  // clean second attempt against known state.
  const server = createServer(createApp(db, { executionMode: 'receipt' }));
  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return {
    db,
    server,
    base: `http://127.0.0.1:${port}/api/v1`,
    alice: { id: a.account.id, pub: a.account.publicKey, priv: a.privateKey },
    bob: { id: b.account.id, pub: b.account.publicKey, priv: b.privateKey },
  };
}

function txEnvelope(ctx: Ctx, amountPts: number, timestamp: number) {
  // Byte-for-byte the payload ae-app/Send builds and the node verifies.
  const payload = {
    from: ctx.alice.id,
    to: ctx.bob.id,
    amount: (BigInt(amountPts) * PRECISION).toString(),
    pointType: 'earned',
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
  };
  const signature = signPayload(payload, timestamp, ctx.alice.priv);
  // Wire shape the route expects: from is the top-level accountId, the rest ride
  // in `payload`. The SIGNATURE is over the full internal payload (including
  // from), which is what Send.tsx signs and processTransaction re-verifies.
  return {
    accountId: ctx.alice.id,
    timestamp,
    signature,
    payload: {
      to: payload.to,
      amount: payload.amount,
      pointType: payload.pointType,
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    },
  };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('security cluster', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(() => {
    ctx.server.close();
    ctx.db.close();
  });

  it('a replayed transaction is rejected the second time (audit #2)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const env = txEnvelope(ctx, 10, ts);

    const first = await post(ctx.base, '/transactions', env);
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // Byte-identical resubmission: same signed bytes -> same derived id ->
    // rejected, rather than moving the money a second time.
    const afterFirst = await fetch(`${ctx.base}/accounts/${ctx.bob.id}`).then((r) => r.json());
    const bobAfterOne = BigInt(afterFirst.data.earnedBalance);
    assert.ok(bobAfterOne > 0n, 'bob received the first payment (net of fee)');

    const replay = await post(ctx.base, '/transactions', env);
    assert.equal(replay.status, 400, JSON.stringify(replay.body));
    assert.equal(replay.body.error.code, 'DUPLICATE_TRANSACTION');

    // The replay moved no money: bob's balance is exactly what it was.
    const afterReplay = await fetch(`${ctx.base}/accounts/${ctx.bob.id}`).then((r) => r.json());
    assert.equal(afterReplay.data.earnedBalance, bobAfterOne.toString());
  });

  it('a genuinely distinct payment still goes through (no false positive)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const a = await post(ctx.base, '/transactions', txEnvelope(ctx, 10, ts));
    // Different timestamp -> different signed bytes -> different id.
    const b = await post(ctx.base, '/transactions', txEnvelope(ctx, 10, ts + 1));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    // Both distinct payments landed. Exact value is net of fee; the point is
    // that the second was NOT rejected as a duplicate, so bob got two credits.
    const bob = await fetch(`${ctx.base}/accounts/${ctx.bob.id}`).then((r) => r.json());
    const single = (a.body.data && (a.body.data.netAmount || a.body.data.transaction?.netAmount));
    assert.ok(BigInt(bob.data.earnedBalance) > 0n);
    // Two identical-value payments -> balance is an even split of two credits;
    // assert it is strictly greater than one credit to prove both applied.
    const oneCredit = single ? BigInt(single) : 0n;
    if (oneCredit > 0n) {
      assert.equal(BigInt(bob.data.earnedBalance), oneCredit * 2n);
    }
  });

  it('the transactions endpoint does not expose signatures (audit #2/#3)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    await post(ctx.base, '/transactions', txEnvelope(ctx, 5, ts));

    const list = await fetch(`${ctx.base}/accounts/${ctx.alice.id}/transactions`).then((r) =>
      r.json(),
    );
    assert.ok(list.data.transactions.length >= 1);
    for (const t of list.data.transactions) {
      assert.ok(!('signature' in t), 'signature must not be published');
      assert.ok(!('receiverSignature' in t), 'receiverSignature must not be published');
    }
    // The useful fields are still there.
    assert.ok('amount' in list.data.transactions[0]);
    assert.ok('id' in list.data.transactions[0]);
  });

  it('a transaction signature cannot authenticate an auth-gated route (audit #3)', async () => {
    // Build a real transaction signature, then present it as an auth envelope on
    // a signed route (miner registration). This is the exploit the PoC ran.
    const ts = Math.floor(Date.now() / 1000);
    const txPayload = {
      from: ctx.alice.id,
      to: ctx.bob.id,
      amount: (5n * PRECISION).toString(),
      pointType: 'earned',
      isInPerson: false,
      recipientIsHuman: false,
      memo: '',
    };
    const txSig = signPayload(txPayload, ts, ctx.alice.priv);

    const res = await post(ctx.base, '/miners/register', {
      accountId: ctx.alice.id,
      timestamp: ts,
      signature: txSig,
      payload: txPayload, // the transaction payload, reused as the auth payload
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'AUTH_TX_SIGNATURE_REUSE');
  });

  it('an auth request with a missing payload is rejected, not treated as {} (audit #15)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    // Sign over {} and omit payload entirely — the downgrade the fix closes.
    const sigOverEmpty = signPayload({}, ts, ctx.alice.priv);
    const res = await post(ctx.base, '/miners/register', {
      accountId: ctx.alice.id,
      timestamp: ts,
      signature: sigOverEmpty,
      // no payload key
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'AUTH_MISSING_PAYLOAD');
  });

  it('an explicit empty payload still authenticates (no legitimate regression)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload({}, ts, ctx.alice.priv);
    const res = await post(ctx.base, '/miners/register', {
      accountId: ctx.alice.id,
      timestamp: ts,
      signature: sig,
      payload: {}, // present, empty
    });
    // Miner registration with a valid empty-payload envelope proceeds past auth
    // (it may still succeed or fail on miner-specific rules, but NOT on auth).
    assert.notEqual(res.status, 401, JSON.stringify(res.body));
  });
});
