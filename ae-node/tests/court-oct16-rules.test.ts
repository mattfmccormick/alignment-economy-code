// The court rules Matt set on October 16, 2026, in his answers to the court
// rebuild plan. One describe block per answer, each with the rule working and
// the way it fails.
//
//   1  A jury seat belongs to a verified human (90%+), not to a node or a tier.
//   2  The jury grows with the network: 3, then 7, then 11.
//   3  Filing costs the chosen percentage, never less than 1,440 points.
//   4  Withdrawing pays the floor to the defendant and blocks refiling for 30 days.
//   5  A case moves to court on its own at day 7; only the defendant may hurry it.
//   8  No-shows forfeit their stake and sit out 30 days.
//   10 The freeze stays on through the appeal window (and nothing settles before).
//   11 Staked points are earned points: a guilty verdict takes both.
//
// Plus the guard that keeps the node-local court off multi-validator chains,
// the validator-stake escape, and the vouch rebase fix the verdicts depend on.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams, setParam } from '../src/config/params.js';
import { createAccount, getAccount, updateBalance, setEscrowed, deactivateAccount } from '../src/core/account.js';
import { registerMiner } from '../src/mining/registration.js';
import {
  fileChallenge, escalateToFull, selectJury, submitVote, getCase, expireCourtDeadlines,
  resolveCase, withdrawChallenge, demandTrial, jurySizeFor, courtStore, fileAppeal,
} from '../src/court/court.js';
import { createVouch, burnVouch, withdrawVouch, rebalanceVouchLocks } from '../src/verification/vouching.js';
import {
  applyVouchOperation, validateVouchOperationApplicable, type VouchOperation,
} from '../src/verification/vouch-operation.js';
import { rebase } from '../src/core/day-cycle.js';
import { createApp } from '../src/api/server.js';
import { signPayload, generateKeyPair } from '../src/core/crypto.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import { PRECISION } from '../src/core/constants.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const pts = (n: number) => BigInt(Math.round(n * Number(PRECISION)));
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

interface MinerHandle { accountId: string; minerId: string }

function miner(db: DatabaseSync, earned = 5_000, percentHuman = 100): MinerHandle {
  const r = createAccount(db, 'individual', 1, percentHuman);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  const m = registerMiner(db, r.account.id);
  return { accountId: r.account.id, minerId: m.id };
}

function minerPool(db: DatabaseSync, n: number): MinerHandle[] {
  const pool: MinerHandle[] = [];
  for (let i = 0; i < n; i++) pool.push(miner(db));
  return pool;
}

function person(db: DatabaseSync, earned = 10_000): string {
  const r = createAccount(db, 'individual', 1, 80);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  return r.account.id;
}

function addValidator(db: DatabaseSync, accountId: string): void {
  db.prepare(
    `INSERT INTO validators (account_id, node_public_key, vrf_public_key, stake, is_active, registered_at)
     VALUES (?, ?, ?, '1', 1, ?)`,
  ).run(accountId, randomUUID(), randomUUID(), NOW);
}

describe('the court only runs where it cannot fork the chain', () => {
  it('files on a network with one validator', () => {
    const db = freshDb();
    const challenger = miner(db, 10_000);
    addValidator(db, challenger.accountId);
    assert.ok(fileChallenge(db, challenger.accountId, person(db), 'not_human', 10));
  });

  it('refuses to file on a network with more than one validator', () => {
    const db = freshDb();
    const challenger = miner(db, 10_000);
    const defendant = person(db);
    addValidator(db, challenger.accountId);
    addValidator(db, person(db));

    assert.throws(
      () => fileChallenge(db, challenger.accountId, defendant, 'not_human', 10),
      /not on the blockchain yet/,
    );
    assert.equal(getAccount(db, defendant)!.isEscrowed, false);
    assert.equal(getAccount(db, challenger.accountId)!.lockedBalance, 0n);
  });
});

describe('answer 3: filing costs the chosen percentage, never less than 1,440 points', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('a small percentage of a small balance stakes the floor', () => {
    const challenger = miner(db, 10_000);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 5);
    assert.equal(c.challengerStake, pts(1_440), '5% of 10,000 is 500, under the floor');
  });

  it('a higher percentage stakes more, as a signal of confidence', () => {
    const challenger = miner(db, 40_000);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    assert.equal(c.challengerStake, pts(4_000));
    assert.equal(c.challengerStakePercent, 10);
  });

  it('a challenger who cannot cover the floor cannot file', () => {
    const challenger = miner(db, 1_000);
    const defendant = person(db);
    assert.throws(
      () => fileChallenge(db, challenger.accountId, defendant, 'not_human', 100),
      /at least 1440 points/,
    );
    assert.equal(getAccount(db, defendant)!.isEscrowed, false, 'nobody frozen for free');
  });
});

describe('answer 4: withdrawing pays the floor to the defendant', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('the floor goes to the defendant, the rest comes back, the freeze lifts', () => {
    const challenger = miner(db, 40_000);
    const defendant = person(db, 10_000);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10); // stakes 4,000

    const after = withdrawChallenge(db, c.id, challenger.accountId);

    assert.equal(after.status, 'withdrawn');
    const ch = getAccount(db, challenger.accountId)!;
    assert.equal(ch.lockedBalance, 0n);
    assert.equal(ch.earnedBalance, pts(40_000 - 1_440));
    const d = getAccount(db, defendant)!;
    assert.equal(d.earnedBalance, pts(10_000 + 1_440));
    assert.equal(d.isEscrowed, false);
  });

  it('the same challenger cannot refile against the same defendant for 30 days', () => {
    const challenger = miner(db, 40_000);
    const other = miner(db, 40_000);
    const defendant = person(db);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    withdrawChallenge(db, c.id, challenger.accountId);

    assert.throws(() => fileChallenge(db, challenger.accountId, defendant, 'not_human', 10), /refile after 30 days/);

    // Someone else may still bring a case.
    const second = fileChallenge(db, other.accountId, defendant, 'not_human', 10);
    withdrawChallenge(db, second.id, other.accountId);

    // 31 days on, the first challenger may refile.
    db.prepare('UPDATE court_cases SET resolved_at = ? WHERE id = ?').run(NOW - 31 * DAY, c.id);
    assert.ok(fileChallenge(db, challenger.accountId, defendant, 'not_human', 10));
  });

  it('only the challenger can withdraw, and only during arbitration', () => {
    const challenger = miner(db, 40_000);
    const defendant = person(db);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);

    assert.throws(() => withdrawChallenge(db, c.id, defendant), /Only the challenger/);

    escalateToFull(db, c.id);
    assert.throws(() => withdrawChallenge(db, c.id, challenger.accountId), /still in arbitration/);
  });
});

describe('answer 5: a case moves to court on its own at day 7', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('the sweep escalates and draws a jury once the window closes, not before', () => {
    const challenger = miner(db, 10_000);
    minerPool(db, 3);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);

    const early = expireCourtDeadlines(db, NOW + 6 * DAY);
    assert.deepEqual(early.escalated, [], 'the defendant still has time to respond');
    assert.equal(getCase(db, c.id)!.status, 'arbitration_open');

    const due = expireCourtDeadlines(db, NOW + 8 * DAY);
    assert.deepEqual(due.escalated, [c.id]);
    assert.deepEqual(due.seated, [c.id]);
    assert.equal(getCase(db, c.id)!.status, 'court_voting');
    assert.equal(courtStore(db).findJurorsByCase(c.id).length, 3);
  });

  it('the defendant may demand a trial early, but the jury is still drawn at the sweep', () => {
    const challenger = miner(db, 10_000);
    minerPool(db, 3);
    const defendant = person(db);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);

    const moved = demandTrial(db, c.id, defendant);
    assert.equal(moved.status, 'court_open');
    assert.equal(courtStore(db).findJurorsByCase(c.id).length, 0, 'asking does not let the defendant pick the block');

    assert.deepEqual(expireCourtDeadlines(db, NOW + 60).seated, [c.id]);
  });

  it('the challenger cannot hurry a case to court', () => {
    const challenger = miner(db, 10_000);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    assert.throws(() => demandTrial(db, c.id, challenger.accountId), /Only the defendant/);
  });
});

describe('answer 1: a jury seat belongs to a verified human', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('seats tier-1 miners at 90%+, and skips low scores, frozen and closed accounts', () => {
    const challenger = miner(db, 10_000);
    const good = minerPool(db, 3); // registered at tier 1, never promoted
    const lowScore = miner(db, 5_000, 80);
    const frozen = miner(db);
    setEscrowed(db, frozen.accountId, true);
    const closed = miner(db);
    deactivateAccount(db, closed.accountId);

    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    escalateToFull(db, c.id);
    const seated = selectJury(db, c.id, 'seats');

    assert.deepEqual(seated.sort(), good.map((m) => m.minerId).sort());
    for (const m of [lowScore, frozen, closed]) assert.equal(seated.includes(m.minerId), false);
  });

  it('with too few verified humans there is no trial yet', () => {
    const challenger = miner(db, 10_000);
    minerPool(db, 2);
    miner(db, 5_000, 89);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    escalateToFull(db, c.id);
    assert.deepEqual(selectJury(db, c.id, 'short'), []);
    assert.equal(getCase(db, c.id)!.status, 'court_waiting_jury');
  });
});

describe('answer 2: the jury grows with the network', () => {
  it('3, then 7, then 11, never more than a third of the pool', () => {
    assert.equal(jurySizeFor(2, 11), 0, 'no trial under three jurors');
    assert.equal(jurySizeFor(3, 11), 3);
    assert.equal(jurySizeFor(20, 11), 3);
    assert.equal(jurySizeFor(21, 11), 7);
    assert.equal(jurySizeFor(32, 11), 7);
    assert.equal(jurySizeFor(33, 11), 11);
    assert.equal(jurySizeFor(500, 11), 11, 'court.jury_size is the ceiling');
    assert.equal(jurySizeFor(500, 7), 7);
    assert.equal(jurySizeFor(27, 9), 9, 'a governed size off the ladder is still reachable');
    assert.equal(jurySizeFor(500, 10), 9, 'an even ceiling rounds down to odd');
  });
});

describe('answer 8: no-shows forfeit and sit out', () => {
  it('a juror who never voted is not drawn again for 30 days', () => {
    const db = freshDb();
    const challenger = miner(db, 40_000);
    const pool = minerPool(db, 4);

    const first = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    escalateToFull(db, first.id);
    const [a, b, noShow] = selectJury(db, first.id, 'first');
    submitVote(db, first.id, a, 'human');
    submitVote(db, first.id, b, 'human');
    expireCourtDeadlines(db, NOW + 30 * DAY); // two of three decide; one never voted

    const second = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    escalateToFull(db, second.id);
    const seated = selectJury(db, second.id, 'second', NOW + 31 * DAY);
    assert.equal(seated.length, 3, 'three of four are still eligible');
    assert.equal(seated.includes(noShow), false, 'the no-show sits this one out');
    assert.equal(pool.length, 4);
  });
});

describe('answers 10 and 11: settle once, and take everything a guilty account holds', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('stakes the defendant posted for others are part of the bounty and the burn', () => {
    const challenger = miner(db, 10_000);
    const pool = minerPool(db, 3);
    const defendant = person(db, 10_000);
    const friend = person(db, 0);
    // Parked before the case: 10% of 10,000 locked as a vouch.
    const parked = createVouch(db, defendant, friend, 10);
    assert.equal(getAccount(db, defendant)!.lockedBalance, pts(1_000));

    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'guilty')) submitVote(db, c.id, j, 'not_human');
    resolveCase(db, c.id);
    expireCourtDeadlines(db, NOW + 8 * DAY);

    const d = getAccount(db, defendant)!;
    assert.equal(d.isActive, false);
    assert.equal(d.earnedBalance, 0n);
    assert.equal(d.lockedBalance, 0n, 'the parked stake did not escape');
    const vouchRow = db.prepare('SELECT is_active FROM vouches WHERE id = ?').get(parked.id) as { is_active: number };
    assert.equal(vouchRow.is_active, 0);
    assert.equal(
      getAccount(db, challenger.accountId)!.earnedBalance,
      pts(10_000) + pts(2_000),
      'stake back plus 20% of all 10,000, not of the 9,000 left in earned',
    );
    for (const m of pool) assert.equal(getAccount(db, m.accountId)!.lockedBalance, 0n);
  });

  it('with appeals governed off, a verdict settles at once', () => {
    setParam(db, 'court.max_appeals', 0);
    const challenger = miner(db, 10_000);
    minerPool(db, 3);
    const defendant = person(db);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'final')) submitVote(db, c.id, j, 'human');

    assert.equal(resolveCase(db, c.id), 'innocent');
    assert.equal(getCase(db, c.id)!.status, 'court_verdict');
    assert.equal(getAccount(db, defendant)!.isEscrowed, false);
  });
});

describe('the daily rebase keeps vouch stakes and locked balances in step', () => {
  it('a vouch can be burned or withdrawn after a rebase that shrinks balances', () => {
    const db = freshDb();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(createAccount(db, 'individual', 1, 100).account.id);
    // Everyone above target, so the multiplier is below 1 (the steady state).
    for (const id of ids) updateBalance(db, id, 'earned_balance', pts(600_000));
    const [voucher, vouchedA, vouchedB] = ids;
    const v1 = createVouch(db, voucher, vouchedA, 10);
    const v2 = createVouch(db, voucher, vouchedB, 5);

    const event = rebase(db);
    assert.ok(event && event.rebaseMultiplier < 1);
    rebalanceVouchLocks(db);

    const stakes = db.prepare('SELECT stake_amount FROM vouches WHERE voucher_id = ? AND is_active = 1').all(voucher) as Array<{ stake_amount: string }>;
    const recorded = stakes.reduce((sum, r) => sum + BigInt(r.stake_amount), 0n);
    assert.equal(getAccount(db, voucher)!.lockedBalance, recorded, 'the record matches what is locked');

    burnVouch(db, v1.id);
    withdrawVouch(db, v2.id);
    assert.equal(getAccount(db, voucher)!.lockedBalance, 0n);
  });
});

// ── Review fixes (adversarial pass on the October 16 rewrite) ─────────────

describe('a court case cannot be turned into a chain halt or a dodge', () => {
  it('a vouch from a frozen defendant is refused, and skipped at apply instead of throwing', () => {
    const db = freshDb();
    const challenger = miner(db, 10_000);
    const defendant = person(db);
    const friend = person(db);
    fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);

    const op: VouchOperation = {
      type: 'vouch_create', voucherId: defendant, vouchedId: friend, stakePercent: 10,
      timestamp: NOW, signature: 'aa'.repeat(32),
    };
    assert.match(validateVouchOperationApplicable(db, op) ?? '', /frozen by a court case/);
    // At commit this used to throw inside the block transaction and halt consensus.
    assert.doesNotThrow(() => applyVouchOperation(db, op, NOW));
    assert.equal(getAccount(db, defendant)!.lockedBalance, 0n, 'nothing moved into a stake');
  });

  it('vouchers can pull out before a verdict, but not once a jury has found the account not human', () => {
    const db = freshDb();
    const challenger = miner(db, 10_000);
    minerPool(db, 3);
    const defendant = person(db);
    const early = person(db, 10_000);
    const late = person(db, 10_000);
    const earlyVouch = createVouch(db, early, defendant, 10);
    const lateVouch = createVouch(db, late, defendant, 10);
    const withdrawOp = (voucherId: string, vouchId: string): VouchOperation => ({
      type: 'vouch_withdraw', voucherId, vouchId, timestamp: NOW, signature: 'bb'.repeat(32),
    });

    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    // During arbitration a voucher may still change their mind (answer 6).
    assert.equal(validateVouchOperationApplicable(db, withdrawOp(early, earlyVouch.id)), null);
    applyVouchOperation(db, withdrawOp(early, earlyVouch.id), NOW);
    assert.equal(getAccount(db, early)!.earnedBalance, pts(10_000), 'pulled out before any verdict, stake returned');

    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'held')) submitVote(db, c.id, j, 'not_human');
    resolveCase(db, c.id); // guilty, pending the appeal window

    assert.match(validateVouchOperationApplicable(db, withdrawOp(late, lateVouch.id)) ?? '', /held until the case settles/);
    applyVouchOperation(db, withdrawOp(late, lateVouch.id), NOW);
    expireCourtDeadlines(db, NOW + 8 * DAY);
    assert.equal(getAccount(db, late)!.earnedBalance, pts(9_000), 'the stake burned with the verdict');
    assert.equal(getAccount(db, late)!.lockedBalance, 0n);
  });

  it('only one appeal runs at a time, even when governance allows two', () => {
    const db = freshDb();
    setParam(db, 'court.max_appeals', 2);
    const challenger = miner(db, 10_000);
    minerPool(db, 9);
    const defendant = person(db);
    const c = fileChallenge(db, challenger.accountId, defendant, 'not_human', 10);
    escalateToFull(db, c.id);
    for (const j of selectJury(db, c.id, 'two')) submitVote(db, c.id, j, 'not_human');
    resolveCase(db, c.id);

    fileAppeal(db, c.id);
    assert.throws(() => fileAppeal(db, c.id), /already running/);
  });

  it('a fractional juror stake setting still seats a jury', () => {
    const db = freshDb();
    setParam(db, 'court.juror_stake_percent', 2.5);
    const challenger = miner(db, 10_000);
    const pool = minerPool(db, 3);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    escalateToFull(db, c.id);
    assert.equal(selectJury(db, c.id, 'fraction').length, 3);
    assert.equal(getAccount(db, pool[0].accountId)!.lockedBalance, pts(125), '2.5% of 5,000');
  });

  it('running the rebase twice on one day changes nothing the second time', () => {
    const db = freshDb();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(createAccount(db, 'individual', 1, 100).account.id);
    for (const id of ids) updateBalance(db, id, 'earned_balance', pts(600_000));
    // All of the voucher's savings in one vouch: zero earned, so no rebase log
    // row of its own, which is what the old resume path keyed its skip on.
    const v = createVouch(db, ids[0], ids[1], 100);
    assert.equal(getAccount(db, ids[0])!.earnedBalance, 0n);

    rebase(db);
    rebalanceVouchLocks(db);
    const lockedAfterFirst = getAccount(db, ids[0])!.lockedBalance;
    rebase(db); // a re-run on the same day, as after a crash past the commit
    rebalanceVouchLocks(db);

    assert.equal(getAccount(db, ids[0])!.lockedBalance, lockedAfterFirst);
    const stake = db.prepare('SELECT stake_amount FROM vouches WHERE id = ?').get(v.id) as { stake_amount: string };
    assert.equal(BigInt(stake.stake_amount), lockedAfterFirst);
    assert.doesNotThrow(() => burnVouch(db, v.id));
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

function request(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        `http://127.0.0.1:${addr.port}${path}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode!, data }); }
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(bodyStr);
      req.end();
    });
  });
}

function keyed(db: DatabaseSync, earned: number, percentHuman = 100) {
  const kp = generateKeyPair();
  const r = createAccount(db, 'individual', 1, percentHuman, kp.publicKey);
  updateBalance(db, r.account.id, 'earned_balance', pts(earned));
  return { accountId: r.account.id, privateKey: kp.privateKey };
}

function envelope(accountId: string, privateKey: string, payload: Record<string, unknown> = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return { accountId, timestamp, signature: signPayload(payload, timestamp, privateKey), payload };
}

describe('court routes under the October 16 rules', () => {
  beforeEach(() => resetRateLimits());

  it('the challenger can no longer escalate (the route is gone)', async () => {
    const db = freshDb();
    const challenger = keyed(db, 10_000);
    registerMiner(db, challenger.accountId);
    const c = fileChallenge(db, challenger.accountId, person(db), 'not_human', 10);
    const res = await request(createApp(db), `/api/v1/court/cases/${c.id}/escalate`, envelope(challenger.accountId, challenger.privateKey));
    assert.equal(res.status, 404);
    assert.equal(getCase(db, c.id)!.status, 'arbitration_open');
  });

  it('withdraw works for the challenger and is refused to anyone else', async () => {
    const db = freshDb();
    const app = createApp(db);
    const challenger = keyed(db, 10_000);
    registerMiner(db, challenger.accountId);
    const defendant = keyed(db, 10_000, 80);
    const c = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);

    const refused = await request(app, `/api/v1/court/cases/${c.id}/withdraw`, envelope(defendant.accountId, defendant.privateKey));
    assert.equal(refused.status, 403);

    const ok = await request(app, `/api/v1/court/cases/${c.id}/withdraw`, envelope(challenger.accountId, challenger.privateKey));
    assert.equal(ok.status, 200);
    assert.equal(ok.data.data.case.status, 'withdrawn');
  });

  it('demand-trial works for the defendant and is refused to the challenger', async () => {
    const db = freshDb();
    const app = createApp(db);
    const challenger = keyed(db, 10_000);
    registerMiner(db, challenger.accountId);
    const defendant = keyed(db, 10_000, 80);
    const c = fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);

    const refused = await request(app, `/api/v1/court/cases/${c.id}/demand-trial`, envelope(challenger.accountId, challenger.privateKey));
    assert.equal(refused.status, 403);

    const ok = await request(app, `/api/v1/court/cases/${c.id}/demand-trial`, envelope(defendant.accountId, defendant.privateKey));
    assert.equal(ok.status, 200);
    assert.equal(ok.data.data.case.status, 'court_open');
  });

  it('a frozen defendant cannot move savings into a validator stake', async () => {
    const db = freshDb();
    const app = createApp(db);
    const challenger = keyed(db, 10_000);
    registerMiner(db, challenger.accountId);
    const defendant = keyed(db, 10_000, 80);
    const free = keyed(db, 10_000, 80);
    fileChallenge(db, challenger.accountId, defendant.accountId, 'not_human', 10);

    // Deliberately bad keys: an account that is not frozen gets past the
    // freeze check and is refused for the keys instead.
    const payload = { stake: 5_000, nodePublicKey: 1, vrfPublicKey: 2 };
    const frozen = await request(app, '/api/v1/validators/register', envelope(defendant.accountId, defendant.privateKey, payload));
    assert.equal(frozen.status, 403);
    assert.equal(frozen.data.error.code, 'ACCOUNT_ESCROWED');
    assert.equal(getAccount(db, defendant.accountId)!.lockedBalance, 0n);

    const notFrozen = await request(app, '/api/v1/validators/register', envelope(free.accountId, free.privateKey, payload));
    assert.equal(notFrozen.status, 400);
  });
});
