// Adding a validator must go through the CHAIN, not through one node's database.
//
// There are two routes whose names differ by one word and whose behaviour
// differs completely:
//
//   POST /validators/register          calls registerValidator() directly.
//                                      Three purely LOCAL writes: debit earned,
//                                      credit locked, INSERT into validators.
//                                      Never enqueued, never gossiped, never in
//                                      a block.
//   POST /validators/propose-register  enqueues a signed ValidatorChange that a
//                                      proposer drains into
//                                      block.validatorChanges, so every node
//                                      applies it from the chain.
//
// `npm run validator:register` shipped pointing at the first one, and the
// operator docs told you to aim it at an ACTIVE VALIDATOR, which is the worst
// possible target. That node's validator set grows by one while its peers' does
// not, so its quorumCount (floor(2n/3)+1) rises, it demands more prevotes than
// can exist, and it precommits NIL forever. The chain halts with no error
// anywhere: the state root that would notice the divergence is diagnostic only
// and is not folded into the block hash.
//
// These tests pin the distinction from both sides. If someone repoints the CLI
// at the convenient-looking route again, the second test fails.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { createAccount } from '../src/core/account.js';
import { createApp } from '../src/api/server.js';
import { signValidatorChangeRegister } from '../src/core/consensus/validator-change.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { PRECISION } from '../src/core/constants.js';

const STAKE_DISPLAY = 500;
const STAKE_FIXED = BigInt(STAKE_DISPLAY) * PRECISION;

interface Ctx {
  db: DatabaseSync;
  server: Server;
  base: string;
  accountId: string;
  privateKey: string;
}

async function boot(): Promise<Ctx> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  createGenesisBlock(db);

  const a = createAccount(db, 'individual', 1, 100);
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    (STAKE_FIXED * 10n).toString(),
    a.account.id,
  );

  const server = createServer(createApp(db));
  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return {
    db,
    server,
    base: `http://127.0.0.1:${port}/api/v1`,
    accountId: a.account.id,
    privateKey: a.privateKey,
  };
}

function pendingChangeCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM pending_validator_changes').get() as { c: number };
  return r.c;
}

function validatorRowCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM validators').get() as { c: number };
  return r.c;
}

describe('adding a validator goes on-chain', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });

  it('the signed change the CLI builds is accepted and QUEUED, not applied locally', async () => {
    // Exactly what src/scripts/register-validator.ts constructs and sends.
    const change = signValidatorChangeRegister({
      accountId: ctx.accountId,
      nodePublicKey: 'a'.repeat(64),
      vrfPublicKey: 'b'.repeat(64),
      stake: STAKE_FIXED.toString(),
      timestamp: Math.floor(Date.now() / 1000),
      accountPrivateKey: ctx.privateKey,
    });

    assert.equal(pendingChangeCount(ctx.db), 0, 'precondition: queue empty');
    assert.equal(validatorRowCount(ctx.db), 0, 'precondition: no validators');

    const res = await fetch(`${ctx.base}/validators/propose-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change }),
    });
    const body = (await res.json()) as any;

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'pending');

    // Queued for a block...
    assert.equal(pendingChangeCount(ctx.db), 1, 'change must be queued for a proposer to drain');
    // ...and NOT applied to this node's state. That is the whole point: the
    // validator set may only change when a block carrying the change commits,
    // so every node arrives at the same set.
    assert.equal(validatorRowCount(ctx.db), 0, 'must not touch the local validator set');
    const acct = ctx.db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(ctx.accountId) as { earned_balance: string; locked_balance: string };
    assert.equal(acct.locked_balance, '0', 'must not lock stake before the change is on-chain');

    ctx.server.close();
    ctx.db.close();
  });

  it('the local-only route really does diverge this node, which is why the CLI must not use it', async () => {
    // Not a bug report against /register — it is the in-process path genesis
    // and tests use. This pins the behavioural difference so the two routes
    // cannot be confused again, and documents the exact damage.
    const set = new SqliteValidatorSet(ctx.db);
    assert.equal(set.listActive().length, 0);

    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      stake: STAKE_DISPLAY,
      nodePublicKey: 'c'.repeat(64),
      vrfPublicKey: 'd'.repeat(64),
    };
    const { signPayload } = await import('../src/core/crypto.js');
    const res = await fetch(`${ctx.base}/validators/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: ctx.accountId,
        timestamp,
        signature: signPayload(payload, timestamp, ctx.privateKey),
        payload,
      }),
    });
    assert.equal(res.status, 200);

    // It applied immediately and locally. Nothing was queued, so no block will
    // ever carry it and no peer will ever learn about it.
    assert.equal(validatorRowCount(ctx.db), 1, '/register mutates local state directly');
    assert.equal(pendingChangeCount(ctx.db), 0, '/register queues nothing for the chain');

    // And this is the harm: quorum is derived from the local set size, so this
    // node now needs more prevotes than its peers believe exist.
    assert.equal(set.listActive().length, 1);

    ctx.server.close();
    ctx.db.close();
  });

  it('rejects a change signed by a different account', async () => {
    const other = createAccount(ctx.db, 'individual', 1, 100);
    const change = signValidatorChangeRegister({
      accountId: ctx.accountId, // claims to be ctx
      nodePublicKey: 'a'.repeat(64),
      vrfPublicKey: 'b'.repeat(64),
      stake: STAKE_FIXED.toString(),
      timestamp: Math.floor(Date.now() / 1000),
      accountPrivateKey: other.privateKey, // but signed by someone else
    });

    const res = await fetch(`${ctx.base}/validators/propose-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change }),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'INVALID_SIGNATURE');
    assert.equal(pendingChangeCount(ctx.db), 0);

    ctx.server.close();
    ctx.db.close();
  });

  it('rejects display units, which would be wrong by a factor of 10^8', async () => {
    // The route parses change.stake with BigInt() and compares it against
    // MIN_VALIDATOR_STAKE in base units. Sending "500" (display) instead of
    // "50000000000" (fixed) must not quietly register a validator staking
    // five millionths of a point.
    const change = signValidatorChangeRegister({
      accountId: ctx.accountId,
      nodePublicKey: 'a'.repeat(64),
      vrfPublicKey: 'b'.repeat(64),
      stake: '1', // 1 base unit, far below the floor
      timestamp: Math.floor(Date.now() / 1000),
      accountPrivateKey: ctx.privateKey,
    });

    const res = await fetch(`${ctx.base}/validators/propose-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change }),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'STAKE_TOO_SMALL');

    ctx.server.close();
    ctx.db.close();
  });
});
