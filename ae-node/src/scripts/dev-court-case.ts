#!/usr/bin/env node
/**
 * Dev-only: put wallet accounts on the local solo chain into court, so the
 * wallet's defendant screens (frozen-funds banner, Court list, case detail)
 * can be reviewed without a second person filing a real challenge.
 *
 * Usage (from ae-node/, with or without the node running):
 *   npm run dev:court-case                      every unverified wallet on the solo chain
 *   npm run dev:court-case -- <accountId> ...   only these accounts
 *   npm run dev:court-case -- --db ./data/x.db  a different database
 *
 * It goes through the real fileChallenge(), so the case looks exactly like
 * one a miner filed from the miner app: the challenger's stake is locked, the
 * defendant's earned balance is frozen, and the opening argument is the first
 * entry on the case timeline. The challenger is the best-funded miner that is
 * 100% human and not itself in court.
 *
 * The court is still node-local (see assertCourtRunsOnThisNetwork), so this
 * refuses to run against a database with more than one active validator.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb, closeDb } from '../db/connection.js';
import { fileChallenge, courtStore, submitArgument, getArgumentsForCase } from '../court/court.js';

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
const EVIDENCE_FILES = ['selfie-reverse-image-search.png', 'signup-log-same-device.csv', 'daily-transfers-9-02am.csv'].map(
  (name) => ({ name, hash: createHash('sha256').update(`dev-court-case:${name}`).digest('hex') }),
);

const STAKE_PERCENT = 5;

const args = process.argv.slice(2);
let dbPath = './data/solo-dev.db';
const named: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') dbPath = args[++i];
  else named.push(args[i]);
}

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Start the solo chain first with "npm run dev:solo".`);
  process.exit(1);
}

const db = getDb(dbPath);

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
  process.exit(0);
}

console.log(`Challenger (miner): ${challenger.id}`);
const store = courtStore(db);
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

closeDb();
