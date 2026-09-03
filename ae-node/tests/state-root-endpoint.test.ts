// GET /api/v1/network/state-root and the node-identity fields on GET /status.
//
// These two endpoints are what makes snapshot sync more than a file copy.
// `scripts/snapshot.mjs verify --peer` asks independent nodes for the root they
// recorded at the snapshot's height and refuses to bless the file unless they
// agree, so the exact status codes here are load-bearing: the CLI branches on
// them to tell "this peer disagrees" (do not import) apart from "this peer is
// behind or too old to answer" (inconclusive, ask someone else). Collapsing
// those into one response would make a snapshot that nobody confirmed look the
// same as one everybody confirmed.
//
// /status carries the node's own identity for a related reason: a validator
// change is drained only by the node that proposes, so `validator:register`
// checks `isActiveValidator` before submitting. Without it, registering against
// a non-proposing node succeeds with a 200 and then silently never happens.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock, blockStore } from '../src/core/block.js';
import { createAccount } from '../src/core/account.js';
import { createApp } from '../src/api/server.js';
import { computeStateRoot, recordStateRoot } from '../src/core/state-root.js';
import { registerValidator } from '../src/core/consensus/registration.js';

let db: DatabaseSync;
let server: Server;
let base: string;
let validatorAccountId: string;

function addBlock(d: DatabaseSync, n: number) {
  d.prepare(
    `INSERT INTO blocks (number, day, timestamp, previous_hash, hash, merkle_root, transaction_count)
     VALUES (?, 1, ?, 'p', ?, 'm', 0)`,
  ).run(n, 1_700_000_000 + n, `hash-${n}`);
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('GET /network/state-root', () => {
  before(async () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    initializeSchema(db);
    seedParams(db);
    createGenesisBlock(db);

    const a = createAccount(db, 'individual', 1, 100);
    validatorAccountId = a.account.id;

    // Block 1 gets a recorded root; block 2 deliberately does not, standing in
    // for a height committed before the upgrade.
    addBlock(db, 1);
    recordStateRoot(db, 1);
    addBlock(db, 2);

    server = createServer(
      createApp(db, {
        nodeIdentity: {
          accountId: validatorAccountId,
          consensusMode: 'bft',
          blockIntervalMs: 10_000,
        },
      }),
    );
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    base = `http://127.0.0.1:${port}/api/v1`;
  });

  after(() => {
    server.close();
  });

  it('returns the recorded root for a height that has one', async () => {
    const { status, body } = await get('/network/state-root?height=1');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.height, 1);
    assert.equal(body.data.source, 'recorded');
    assert.equal(body.data.stateRoot, blockStore(db).findStateRoot(1));
    assert.match(body.data.stateRoot, /^[0-9a-f]{64}$/);
  });

  it('returns the live root when no height is given', async () => {
    const { status, body } = await get('/network/state-root');
    assert.equal(status, 200);
    assert.equal(body.data.source, 'live');
    assert.equal(body.data.stateRoot, computeStateRoot(db));
  });

  it('404s for a height the node has not reached', async () => {
    // The CLI reads this as "ask someone else", not "this snapshot is bad".
    const { status, body } = await get('/network/state-root?height=99999');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.match(body.error.message, /head is 2/);
  });

  it('409s, not 200-with-null, for a block whose root was never recorded', async () => {
    // The distinction that matters most here. Returning null with a 200 would
    // let a caller treat "I have no opinion" as "I agree", which is exactly the
    // case where a joiner must go ask another node instead.
    const { status, body } = await get('/network/state-root?height=2');
    assert.equal(status, 409);
    assert.equal(body.error.code, 'ROOT_NOT_RECORDED');
    assert.equal(body.success, false);
  });

  it('400s on a non-integer height', async () => {
    const { status, body } = await get('/network/state-root?height=abc');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'BAD_HEIGHT');
  });

  it('400s on a negative height', async () => {
    const { status } = await get('/network/state-root?height=-1');
    assert.equal(status, 400);
  });

  it('two nodes holding the same accounts report the same root', async () => {
    // The property an operator relies on when comparing machines. Built with a
    // second independent database rather than by reading the same one twice,
    // since the latter would pass even if the root depended on local state.
    const other = new DatabaseSync(':memory:');
    other.exec('PRAGMA foreign_keys = ON');
    initializeSchema(other);
    seedParams(other);
    createGenesisBlock(other);

    const seen = db.prepare('SELECT public_key FROM accounts ORDER BY id').all() as Array<{
      public_key: string;
    }>;
    for (const row of seen) {
      createAccount(other, 'individual', 1, 100, row.public_key);
    }
    addBlock(other, 1);
    recordStateRoot(other, 1);

    const { body } = await get('/network/state-root?height=1');
    assert.equal(body.data.stateRoot, blockStore(other).findStateRoot(1));
    other.close();
  });
});

describe('GET /status — node identity', () => {
  let idb: DatabaseSync;
  let iserver: Server;
  let ibase: string;
  let accountId: string;

  before(async () => {
    idb = new DatabaseSync(':memory:');
    idb.exec('PRAGMA foreign_keys = ON');
    initializeSchema(idb);
    seedParams(idb);
    createGenesisBlock(idb);
    const a = createAccount(idb, 'individual', 1, 100);
    accountId = a.account.id;

    iserver = createServer(
      createApp(idb, {
        nodeIdentity: { accountId, consensusMode: 'bft', blockIntervalMs: 10_000 },
      }),
    );
    const port: number = await new Promise((resolve) => {
      iserver.listen(0, '127.0.0.1', () => resolve((iserver.address() as { port: number }).port));
    });
    ibase = `http://127.0.0.1:${port}/api/v1`;
  });

  after(() => {
    iserver.close();
  });

  it('reports who this node is and how it is configured', async () => {
    const res = await fetch(`${ibase}/status`);
    const body = (await res.json()) as any;
    assert.equal(res.status, 200);
    assert.equal(body.node.accountId, accountId);
    assert.equal(body.node.consensusMode, 'bft');
    assert.equal(body.node.blockIntervalMs, 10_000);
  });

  it('isActiveValidator is false until the account is actually in the set', async () => {
    const before = (await (await fetch(`${ibase}/status`)).json()) as any;
    assert.equal(before.node.isActiveValidator, false);

    // Registering flips it. This is the exact signal validator:register checks
    // before submitting, because a change sent to a node that cannot propose is
    // queued locally and never reaches a block, with no error anywhere.
    idb
      .prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?')
      .run('100000000000', accountId);
    registerValidator(idb, {
      accountId,
      nodePublicKey: 'a'.repeat(64),
      vrfPublicKey: 'b'.repeat(64),
      stake: 1_000_000n,
    });

    const after = (await (await fetch(`${ibase}/status`)).json()) as any;
    assert.equal(after.node.isActiveValidator, true);
  });

  it('reports nulls rather than guessing when no identity was supplied', async () => {
    const bare = new DatabaseSync(':memory:');
    bare.exec('PRAGMA foreign_keys = ON');
    initializeSchema(bare);
    seedParams(bare);
    createGenesisBlock(bare);

    const s = createServer(createApp(bare));
    const port: number = await new Promise((resolve) => {
      s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
    });
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/v1/status`)).json()) as any;
    assert.equal(body.node.accountId, null);
    assert.equal(body.node.consensusMode, null);
    assert.equal(body.node.isActiveValidator, false);
    s.close();
    bare.close();
  });
});
