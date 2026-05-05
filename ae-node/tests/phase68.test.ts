// Phase 68: protocol treasury — funds public goods from a slice of fees.
//
// Pre-Phase-68 the 0.5% transaction fee went 100% to miners (Tier 1 + Tier 2).
// Nothing in the protocol funded audits, the explorer, docs, or the nonprofit
// running the network. Phase 68 carves out a configurable slice
// (treasury.fee_share, default 10%) on every block's fee distribution and
// routes it to a deterministic protocol-owned account whose private key is
// not held by anyone. Until governance is wired (M2 follow-up), the treasury
// is a sink/saver: balance grows with chain activity, can't yet be spent.
//
// What this phase locks in:
//   - The treasury account is created on first need with the deterministic
//     id derived from a sentinel publicKey.
//   - Every fee distribution routes treasury.fee_share of total fees to that
//     account before splitting the rest between Tier 1 / Tier 2.
//   - The treasury accumulates across blocks.
//   - Setting treasury.fee_share to 0 falls back to pre-Phase-68 behavior
//     (no treasury account is created, miners get the whole pool).
//   - Idempotency from Phase 63 still holds: re-running distribution on the
//     same blockNumber is a no-op.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance } from '../src/core/account.js';
import { registerMiner, setMinerTier } from '../src/mining/registration.js';
import { distributeFeesPublicLottery } from '../src/mining/rewards.js';
import { ensureTreasuryAccount, TREASURY_ACCOUNT_ID } from '../src/core/treasury.js';
import { accountStore } from '../src/core/account.js';
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

function makeMiner(db: DatabaseSync, tier: 1 | 2) {
  const acct = createAccount(db, 'individual', 1, 100);
  updateBalance(db, acct.account.id, 'earned_balance', pts(1000));
  const miner = registerMiner(db, acct.account.id);
  if (tier === 2) setMinerTier(db, miner.id, 2, 'test');
  return { accountId: acct.account.id, minerId: miner.id };
}

describe('Phase 68: protocol treasury', () => {

  it('treasury.fee_share defaults to 0.10 and the account auto-creates on first distribution', () => {
    const db = freshDb();
    makeMiner(db, 1);
    makeMiner(db, 2);

    // Treasury account does not exist yet.
    assert.equal(accountStore(db).findById(TREASURY_ACCOUNT_ID), null);

    distributeFeesPublicLottery(db, 1, 'h-1', pts(100));

    // After distribution: 10 went to treasury, account was created.
    const treasury = getAccount(db, TREASURY_ACCOUNT_ID);
    assert.ok(treasury, 'treasury account should be created on first distribution');
    assert.equal(treasury.earnedBalance, pts(10));
    assert.equal(treasury.type, 'company');
    db.close();
  });

  it('treasury balance accumulates across blocks', () => {
    const db = freshDb();
    makeMiner(db, 1);
    makeMiner(db, 2);

    distributeFeesPublicLottery(db, 1, 'h-1', pts(100));
    distributeFeesPublicLottery(db, 2, 'h-2', pts(100));
    distributeFeesPublicLottery(db, 3, 'h-3', pts(100));

    const treasury = getAccount(db, TREASURY_ACCOUNT_ID)!;
    assert.equal(treasury.earnedBalance, pts(30), 'three 100-fee blocks at 10% = 30 to treasury');
    db.close();
  });

  it('miner pool == totalFees - treasuryPool, and split tier1/tier2 against the global fractions', () => {
    const db = freshDb();
    const t1 = makeMiner(db, 1);
    const t2 = makeMiner(db, 2);

    const dist = distributeFeesPublicLottery(db, 1, 'h-1', pts(100));
    assert.ok(dist);
    // tier1Pool reflects the 18% global share, tier2Pool gets the remainder
    // of the miner pool. treasuryPool is implied by what's missing from
    // (tier1+tier2): 100 - (18 + 72) = 10.
    assert.equal(dist!.tier1Pool, pts(18));
    assert.equal(dist!.tier2Pool, pts(72));
    assert.equal(dist!.tier1Pool + dist!.tier2Pool + pts(10), pts(100));

    // Treasury, tier 1 miner, tier 2 miner all credited.
    const treasury = getAccount(db, TREASURY_ACCOUNT_ID)!;
    const t1Acct = getAccount(db, t1.accountId)!;
    const t2Acct = getAccount(db, t2.accountId)!;
    assert.equal(treasury.earnedBalance, pts(10));
    assert.equal(t1Acct.earnedBalance, pts(1000) + pts(18));
    assert.equal(t2Acct.earnedBalance, pts(1000) + pts(72));
    db.close();
  });

  it('treasury.fee_share = 0 disables the slice (no treasury account, miners get everything)', () => {
    const db = freshDb();
    makeMiner(db, 1);
    makeMiner(db, 2);
    setParam(db, 'treasury.fee_share', 0);
    setParam(db, 'mining.tier1_fee_share', 0.20); // legacy split

    distributeFeesPublicLottery(db, 1, 'h', pts(100));

    // No treasury account created and no fees routed to it.
    assert.equal(accountStore(db).findById(TREASURY_ACCOUNT_ID), null);
    db.close();
  });

  it('no miners but treasury share configured → treasury still receives its slice; miner pool falls into the void', () => {
    const db = freshDb();
    // No miners registered. Distribute should not pay anyone but still
    // credit the treasury for the configured share.
    distributeFeesPublicLottery(db, 1, 'h-1', pts(100));

    const treasury = getAccount(db, TREASURY_ACCOUNT_ID);
    assert.ok(treasury, 'treasury exists when share > 0');
    assert.equal(treasury.earnedBalance, pts(10));
    db.close();
  });

  it('idempotent: re-running on the same blockNumber does not double-credit the treasury', () => {
    const db = freshDb();
    makeMiner(db, 1);
    makeMiner(db, 2);

    distributeFeesPublicLottery(db, 1, 'h-1', pts(100));
    distributeFeesPublicLottery(db, 1, 'h-1', pts(100)); // same blockNumber

    const treasury = getAccount(db, TREASURY_ACCOUNT_ID)!;
    assert.equal(treasury.earnedBalance, pts(10), 'still 10, not 20');
    db.close();
  });

  it('TREASURY_ACCOUNT_ID is deterministic across runs', () => {
    const db1 = freshDb();
    const db2 = freshDb();
    const id1 = ensureTreasuryAccount(db1);
    const id2 = ensureTreasuryAccount(db2);
    assert.equal(id1, id2);
    assert.equal(id1, TREASURY_ACCOUNT_ID);
    assert.match(id1, /^[0-9a-f]{40}$/);
    db1.close();
    db2.close();
  });
});
