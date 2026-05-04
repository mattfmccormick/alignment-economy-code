// Phase 18: Validator set foundation (Tier 2 / Phase-3 BFT prep).
//
// First step of Tier 2. We're laying the data model and registration
// flow that BFTConsensus will sit on top of in later sessions. Nothing
// that ships in this session changes runtime consensus behavior — the
// authority chain still uses AuthorityConsensus. What changes:
//
//   - A `validators` table tracks who has staked what and which keys
//     they've registered.
//   - registerValidator atomically locks earnedBalance into
//     lockedBalance and inserts the row; deregisterValidator reverses.
//   - SqliteValidatorSet exposes the queries BFTConsensus will need:
//     listActive, totalActiveStake, quorumCount, lookups by account id
//     and node publicKey.
//
// This suite verifies:
//   1. register flow: balance moves, row inserted, audit log written
//   2. duplicate-key rejection (same accountId, same nodePublicKey)
//   3. minimum-stake enforcement
//   4. invalid-key shape rejection
//   5. inactive / missing account rejection
//   6. lookups (byAccountId, byNodePublicKey)
//   7. listActive / listAll ordering + filtering
//   8. totalActiveStake sums correctly across many validators
//   9. quorumCount: 1→1, 4→3, 7→5, 10→7 (Tendermint 2/3+1)
//  10. deregister: balance reverses, row marked inactive, listActive shrinks

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount } from '../src/core/account.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import {
  registerValidator,
  deregisterValidator,
  MIN_VALIDATOR_STAKE,
} from '../src/core/consensus/registration.js';
import { transactionStore } from '../src/core/transaction.js';
import { PRECISION } from '../src/core/constants.js';

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

function fundAccount(db: DatabaseSync, accountId: string, amount: bigint): void {
  db.prepare('UPDATE accounts SET earned_balance = ? WHERE id = ?').run(
    amount.toString(),
    accountId,
  );
}

function makeValidatorKeys() {
  return {
    nodeKey: generateNodeIdentity(),
    vrfKey: Ed25519VrfProvider.generateKeyPair(),
  };
}

describe('Phase 18: Validator set + registration', () => {
  // ── Happy-path register ──────────────────────────────────────────────

  it('register locks stake from earned to locked and inserts the row', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(500));

    const { nodeKey, vrfKey } = makeValidatorKeys();
    const stake = pts(200);

    const v = registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: nodeKey.publicKey,
      vrfPublicKey: vrfKey.publicKey,
      stake,
    });

    assert.equal(v.accountId, acct.account.id);
    assert.equal(v.nodePublicKey, nodeKey.publicKey);
    assert.equal(v.vrfPublicKey, vrfKey.publicKey);
    assert.equal(v.stake, stake);
    assert.equal(v.isActive, true);

    // Earned balance went down, locked balance went up
    const post = db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(acct.account.id) as { earned_balance: string; locked_balance: string };
    assert.equal(BigInt(post.earned_balance), pts(500) - stake);
    assert.equal(BigInt(post.locked_balance), stake);

    // Audit-log row exists
    const logs = transactionStore(db).findLogsByAccount(acct.account.id, 'vouch_lock');
    assert.equal(logs.length, 1);
    assert.equal(BigInt(logs[0].amount), stake);
  });

  // ── Validation failures ──────────────────────────────────────────────

  it('rejects re-registration of an already-active validator', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(1000));
    const { nodeKey, vrfKey } = makeValidatorKeys();

    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: nodeKey.publicKey,
      vrfPublicKey: vrfKey.publicKey,
      stake: pts(200),
    });

    assert.throws(
      () =>
        registerValidator(db, {
          accountId: acct.account.id,
          nodePublicKey: makeValidatorKeys().nodeKey.publicKey,
          vrfPublicKey: makeValidatorKeys().vrfKey.publicKey,
          stake: pts(200),
        }),
      /already a registered validator/,
    );
  });

  it('rejects two validators sharing the same nodePublicKey', () => {
    const db = freshDb();
    const a = createAccount(db, 'individual', 1, 100);
    const b = createAccount(db, 'individual', 1, 100);
    fundAccount(db, a.account.id, pts(1000));
    fundAccount(db, b.account.id, pts(1000));
    const sharedNodeKey = generateNodeIdentity();

    registerValidator(db, {
      accountId: a.account.id,
      nodePublicKey: sharedNodeKey.publicKey,
      vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
      stake: pts(200),
    });

    assert.throws(
      () =>
        registerValidator(db, {
          accountId: b.account.id,
          nodePublicKey: sharedNodeKey.publicKey,
          vrfPublicKey: Ed25519VrfProvider.generateKeyPair().publicKey,
          stake: pts(200),
        }),
      /already used by another validator/,
    );
  });

  it('rejects stake below MIN_VALIDATOR_STAKE', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(1000));
    const { nodeKey, vrfKey } = makeValidatorKeys();

    assert.throws(
      () =>
        registerValidator(db, {
          accountId: acct.account.id,
          nodePublicKey: nodeKey.publicKey,
          vrfPublicKey: vrfKey.publicKey,
          stake: MIN_VALIDATOR_STAKE - 1n,
        }),
      /below minimum/,
    );
  });

  it('rejects malformed nodePublicKey or vrfPublicKey', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(1000));
    const { vrfKey } = makeValidatorKeys();

    assert.throws(
      () =>
        registerValidator(db, {
          accountId: acct.account.id,
          nodePublicKey: 'not-hex',
          vrfPublicKey: vrfKey.publicKey,
          stake: pts(200),
        }),
      /nodePublicKey must be 32 bytes/,
    );

    const { nodeKey } = makeValidatorKeys();
    assert.throws(
      () =>
        registerValidator(db, {
          accountId: acct.account.id,
          nodePublicKey: nodeKey.publicKey,
          vrfPublicKey: 'cafe', // too short
          stake: pts(200),
        }),
      /vrfPublicKey must be 32 bytes/,
    );
  });

  it('rejects insufficient earned balance', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(50)); // less than min stake
    const { nodeKey, vrfKey } = makeValidatorKeys();

    assert.throws(
      () =>
        registerValidator(db, {
          accountId: acct.account.id,
          nodePublicKey: nodeKey.publicKey,
          vrfPublicKey: vrfKey.publicKey,
          stake: pts(200),
        }),
      /Insufficient earned balance/,
    );
  });

  it('rejects missing account', () => {
    const db = freshDb();
    const { nodeKey, vrfKey } = makeValidatorKeys();
    assert.throws(
      () =>
        registerValidator(db, {
          accountId: 'no-such-account',
          nodePublicKey: nodeKey.publicKey,
          vrfPublicKey: vrfKey.publicKey,
          stake: pts(200),
        }),
      /Account not found/,
    );
  });

  // ── Lookups ──────────────────────────────────────────────────────────

  it('findByAccountId and findByNodePublicKey both return the same row', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(1000));
    const { nodeKey, vrfKey } = makeValidatorKeys();
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: nodeKey.publicKey,
      vrfPublicKey: vrfKey.publicKey,
      stake: pts(200),
    });

    const set = new SqliteValidatorSet(db);
    const a = set.findByAccountId(acct.account.id);
    const b = set.findByNodePublicKey(nodeKey.publicKey);
    assert.ok(a);
    assert.ok(b);
    assert.deepEqual(a, b);
  });

  it('returns null for unknown lookups', () => {
    const db = freshDb();
    const set = new SqliteValidatorSet(db);
    assert.equal(set.findByAccountId('nope'), null);
    assert.equal(set.findByNodePublicKey('00'.repeat(32)), null);
  });

  // ── listActive / listAll ─────────────────────────────────────────────

  it('listActive returns only active validators sorted by accountId', () => {
    const db = freshDb();
    const set = new SqliteValidatorSet(db);

    const accounts = [];
    for (let i = 0; i < 4; i++) {
      const a = createAccount(db, 'individual', 1, 100);
      fundAccount(db, a.account.id, pts(1000));
      accounts.push(a);
    }
    for (const a of accounts) {
      const { nodeKey, vrfKey } = makeValidatorKeys();
      registerValidator(db, {
        accountId: a.account.id,
        nodePublicKey: nodeKey.publicKey,
        vrfPublicKey: vrfKey.publicKey,
        stake: pts(200),
      });
    }

    // Deregister one
    deregisterValidator(db, { accountId: accounts[1].account.id });

    const active = set.listActive();
    const all = set.listAll();
    assert.equal(active.length, 3);
    assert.equal(all.length, 4);

    // Sorted by accountId ascending
    const sortedIds = [...active.map((v) => v.accountId)].sort();
    assert.deepEqual(active.map((v) => v.accountId), sortedIds);
  });

  // ── Stake aggregation + quorum ───────────────────────────────────────

  it('totalActiveStake sums across active validators only', () => {
    const db = freshDb();
    const stakes = [pts(100), pts(200), pts(300), pts(400)];

    for (const s of stakes) {
      const a = createAccount(db, 'individual', 1, 100);
      fundAccount(db, a.account.id, s + pts(10));
      const { nodeKey, vrfKey } = makeValidatorKeys();
      registerValidator(db, {
        accountId: a.account.id,
        nodePublicKey: nodeKey.publicKey,
        vrfPublicKey: vrfKey.publicKey,
        stake: s,
      });
    }

    const set = new SqliteValidatorSet(db);
    assert.equal(set.totalActiveStake(), pts(100) + pts(200) + pts(300) + pts(400));

    // Deregister the largest; total should drop
    const all = set.listAll();
    const biggest = all.reduce((a, b) => (a.stake > b.stake ? a : b));
    deregisterValidator(db, { accountId: biggest.accountId });
    assert.equal(set.totalActiveStake(), pts(100) + pts(200) + pts(300));
  });

  it('quorumCount follows the Tendermint 2/3+1 formula', () => {
    const db = freshDb();
    const set = new SqliteValidatorSet(db);

    // 0 validators → quorum 0
    assert.equal(set.quorumCount(), 0);

    const cases: Array<{ n: number; expected: number }> = [
      { n: 1, expected: 1 },
      { n: 2, expected: 2 },
      { n: 3, expected: 3 },
      { n: 4, expected: 3 },
      { n: 7, expected: 5 },
      { n: 10, expected: 7 },
    ];

    let inserted = 0;
    for (const c of cases) {
      // Top up so we have c.n active validators
      while (inserted < c.n) {
        const a = createAccount(db, 'individual', 1, 100);
        fundAccount(db, a.account.id, pts(1000));
        const { nodeKey, vrfKey } = makeValidatorKeys();
        registerValidator(db, {
          accountId: a.account.id,
          nodePublicKey: nodeKey.publicKey,
          vrfPublicKey: vrfKey.publicKey,
          stake: pts(200),
        });
        inserted++;
      }
      assert.equal(
        set.quorumCount(),
        c.expected,
        `n=${c.n}, expected quorum=${c.expected}, got ${set.quorumCount()}`,
      );
    }
  });

  // ── Deregister flow ──────────────────────────────────────────────────

  it('deregister unlocks stake back to earned + marks row inactive', () => {
    const db = freshDb();
    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(500));
    const { nodeKey, vrfKey } = makeValidatorKeys();

    const stake = pts(200);
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: nodeKey.publicKey,
      vrfPublicKey: vrfKey.publicKey,
      stake,
    });

    deregisterValidator(db, { accountId: acct.account.id });

    const post = db
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(acct.account.id) as { earned_balance: string; locked_balance: string };
    assert.equal(BigInt(post.earned_balance), pts(500));
    assert.equal(BigInt(post.locked_balance), 0n);

    const set = new SqliteValidatorSet(db);
    const v = set.findByAccountId(acct.account.id);
    assert.ok(v);
    assert.equal(v!.isActive, false);
    assert.notEqual(v!.deregisteredAt, null);

    assert.equal(set.listActive().length, 0);
    assert.equal(set.listAll().length, 1);

    const unlockLogs = transactionStore(db).findLogsByAccount(acct.account.id, 'vouch_unlock');
    assert.equal(unlockLogs.length, 1);
    assert.equal(BigInt(unlockLogs[0].amount), stake);
  });

  it('rejects deregister for a non-existent or already-inactive validator', () => {
    const db = freshDb();
    assert.throws(
      () => deregisterValidator(db, { accountId: 'nope' }),
      /Account is not a validator/,
    );

    const acct = createAccount(db, 'individual', 1, 100);
    fundAccount(db, acct.account.id, pts(1000));
    const { nodeKey, vrfKey } = makeValidatorKeys();
    registerValidator(db, {
      accountId: acct.account.id,
      nodePublicKey: nodeKey.publicKey,
      vrfPublicKey: vrfKey.publicKey,
      stake: pts(200),
    });
    deregisterValidator(db, { accountId: acct.account.id });

    assert.throws(
      () => deregisterValidator(db, { accountId: acct.account.id }),
      /already deregistered/,
    );
  });
});
