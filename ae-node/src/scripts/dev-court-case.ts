#!/usr/bin/env node
/**
 * Dev-only: court data on the local solo chain, so the court screens can be
 * reviewed without other people filing, answering and voting.
 *
 * Usage (from ae-node/, with or without the node running):
 *   npm run dev:court-case                          every unverified wallet on the solo chain goes to court
 *   npm run dev:court-case -- <accountId> ...       only these accounts
 *   npm run dev:court-case -- --demo-miner <id>     the miner app's view for this miner account:
 *                                                  a case it filed (with a reply from the
 *                                                  defendant) and a seated jury it sits on
 *   npm run dev:court-case -- --db ./data/x.db      a different database
 *
 * It goes through the real court functions (fileChallenge, submitArgument,
 * escalateToFull, selectJury, submitVote), so stakes lock, freezes apply and
 * the screens show exactly what a real case would. --demo-miner also writes
 * accounts and miners straight into this node's database (the miner gets
 * 100% human and 5,000 earned; two juror accounts and one defendant are
 * created), which is only safe on a one-validator dev chain.
 *
 * The court is still node-local (see assertCourtRunsOnThisNetwork), so this
 * refuses to run against a database with more than one active validator.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb, closeDb } from '../db/connection.js';
import {
  fileChallenge, courtStore, submitArgument, getArgumentsForCase, escalateToFull, selectJury, submitVote,
} from '../court/court.js';
import { createAccount, getAccount, updateBalance } from '../core/account.js';
import { getLatestBlock } from '../core/block.js';
import { PRECISION } from '../core/constants.js';
import { getMinerByAccount, registerMiner } from '../mining/registration.js';
import { cycleStateStore } from '../core/stores/SqliteCycleStateStore.js';

const OPENING_ARGUMENT =
  "I don't think a real person is behind this account. It was opened within minutes of two other " +
  'accounts, it has no vouches from verified people, and it sends points at the same minute every day. ' +
  "I'm asking the court to look at it.";

// The challenger's evidence post, so the defendant's "Evidence against you"
// has files in it. Fingerprints are hashes of the names: there is no file.
const EVIDENCE_TEXT =
  'Here is what I found. The selfie on this account comes up in a reverse image search as a stock photo. ' +
  'The sign-up log shows three accounts opened from the same device within four minutes. And every day at ' +
  '9:02 am it sends its points to the same account.';
const fileRef = (name: string) => ({ name, hash: createHash('sha256').update(`dev-court-case:${name}`).digest('hex') });
const EVIDENCE_FILES = ['selfie-reverse-image-search.png', 'signup-log-same-device.csv', 'daily-transfers-9-02am.csv'].map(fileRef);

const DEFENDANT_REPLY =
  "That's my real face. I don't use social media, so a reverse image search shouldn't find anything of me. " +
  'The other accounts are my two kids, we signed up together on my laptop. Happy to do a call with anyone on the jury.';

const STAKE_PERCENT = 5;
const SEED_EARNED = 5_000n * PRECISION;

const args = process.argv.slice(2);
let dbPath = './data/solo-dev.db';
let demoMiner: string | null = null;
const named: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') dbPath = args[++i];
  else if (args[i] === '--demo-miner') demoMiner = args[++i];
  else named.push(args[i]);
}

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Start the solo chain first with "npm run dev:solo".`);
  process.exit(1);
}

const db = getDb(dbPath);
const store = courtStore(db);

if (demoMiner) {
  setUpMinerDemo(demoMiner);
} else {
  putWalletsInCourt();
}
closeDb();

/** Every unverified wallet (or the named ones) in court, with evidence. */
function putWalletsInCourt(): void {
  const challenger = db
    .prepare(
      `SELECT a.id FROM accounts a JOIN miners m ON m.account_id = a.id
        WHERE m.is_active = 1 AND a.is_active = 1 AND a.is_escrowed = 0 AND a.percent_human >= 100
        ORDER BY CAST(a.earned_balance AS INTEGER) DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!challenger) {
    console.error('No funded, 100% human miner on this chain to act as the challenger.');
    process.exit(1);
  }

  const defendants =
    named.length > 0
      ? named
      : (
          db
            .prepare(
              `SELECT id FROM accounts
                WHERE type = 'individual' AND is_active = 1 AND percent_human < 100 AND id != ?
                ORDER BY created_at`,
            )
            .all(challenger.id) as Array<{ id: string }>
        ).map((r) => r.id);

  if (defendants.length === 0) {
    console.log('No unverified wallet accounts to put in court.');
    return;
  }

  console.log(`Challenger (miner): ${challenger.id}`);
  for (const defendantId of defendants) {
    let c = store.findActiveCaseAgainst(defendantId);
    if (c) {
      console.log(`  ${defendantId}  already in court (case ${c.id})`);
    } else {
      try {
        c = fileChallenge(db, challenger.id, defendantId, 'not_human', STAKE_PERCENT, OPENING_ARGUMENT);
        console.log(`  ${defendantId}  case ${c.id} filed`);
      } catch (e) {
        console.log(`  ${defendantId}  skipped: ${(e as Error).message}`);
        continue;
      }
    }
    // Add the challenger's evidence once (also upgrades cases filed before it existed).
    const hasEvidence = getArgumentsForCase(db, c.id).some((a) => a.role === 'challenger' && a.attachments.length > 0);
    if (!hasEvidence) {
      try {
        submitArgument(db, c.id, c.challengerId, EVIDENCE_TEXT, { attachments: EVIDENCE_FILES });
        console.log('    evidence added');
      } catch (e) {
        console.log(`    evidence skipped: ${(e as Error).message}`);
      }
    }
  }
}

/** A fresh, funded, fully verified individual account. */
function newAccount(percentHuman: number): string {
  const day = cycleStateStore(db).getCurrentDay();
  const id = createAccount(db, 'individual', day, percentHuman).account.id;
  if (percentHuman > 0) updateBalance(db, id, 'earned_balance', SEED_EARNED);
  return id;
}

/** The miner app's two court seats for one miner: a case it filed, and jury duty. */
function setUpMinerDemo(minerAccountId: string): void {
  const acct = getAccount(db, minerAccountId);
  if (!acct || !getMinerByAccount(db, minerAccountId)) {
    console.error(`${minerAccountId} is not a miner on this chain.`);
    process.exit(1);
  }

  // Filing needs funds and juror seats need 90%+ human.
  db.prepare('UPDATE accounts SET percent_human = 100 WHERE id = ?').run(minerAccountId);
  if (acct.earnedBalance < SEED_EARNED) updateBalance(db, minerAccountId, 'earned_balance', SEED_EARNED);
  console.log(`Demo miner: ${minerAccountId} (100% human, ${SEED_EARNED / PRECISION}+ earned)`);

  // 1. A case this miner filed, with evidence files and a reply from the defendant.
  const filed = store.findCasesByAccount(minerAccountId).find((c) => c.challengerId === minerAccountId && c.verdict === null);
  if (filed) {
    console.log(`  Already filed case ${filed.id}`);
  } else {
    const defendant = newAccount(0);
    const c = fileChallenge(db, minerAccountId, defendant, 'not_human', STAKE_PERCENT, EVIDENCE_TEXT, undefined, EVIDENCE_FILES);
    submitArgument(db, c.id, defendant, DEFENDANT_REPLY, {
      attachments: [fileRef('passport-photo-page.jpg'), fileRef('family-signup-photo.jpg')],
      offers: ['call', 'in_person'],
    });
    console.log(`  Filed case ${c.id} against ${defendant}, defendant replied`);
  }

  // 2. Jury duty: seat a real jury, drawn by the court, on a case this miner
  //    has no part in, with one other juror already voted (sealed).
  const seatedOn = (db.prepare('SELECT case_id FROM court_jury WHERE juror_account_id = ? LIMIT 1').get(minerAccountId) as
    | { case_id: string }
    | undefined)?.case_id;
  if (seatedOn) {
    console.log(`  Already on the jury for case ${seatedOn}`);
    return;
  }
  const target = db
    .prepare(
      `SELECT id FROM court_cases
        WHERE status = 'arbitration_open' AND challenger_id != ? AND defendant_id != ?
        ORDER BY created_at LIMIT 1`,
    )
    .get(minerAccountId, minerAccountId) as { id: string } | undefined;
  if (!target) {
    console.log('  No open case to seat a jury on. Run "npm run dev:court-case" first.');
    return;
  }

  // A jury needs 3 eligible people. Add verified juror accounts until there are.
  for (let i = 0; i < 2; i++) registerMiner(db, newAccount(100));

  escalateToFull(db, target.id);
  const head = getLatestBlock(db);
  const seated = selectJury(db, target.id, head?.hash ?? 'dev-court-case');
  const me = getMinerByAccount(db, minerAccountId)!;
  if (!seated.includes(me.id)) {
    console.log(`  Jury seated on case ${target.id}, but the demo miner was not drawn (${seated.length} seated).`);
    return;
  }
  const other = seated.find((m) => m !== me.id);
  if (other) submitVote(db, target.id, other, 'not_human');
  console.log(`  Seated on the jury for case ${target.id} (${seated.length} jurors, 1 already voted)`);
}
