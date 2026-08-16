// Dev-only helper: bump every individual account's percentHuman to 100 and
// seed a spendable earned balance, so the wallet and miner UIs can be
// exercised end-to-end without running a full genesis ceremony. Reads the
// same SQLite DB the running node uses (WAL mode, so concurrent reads are
// safe).
//
// Run: node scripts/dev-bump-ph.mjs [path/to/ae-node.db]
// Default path: ./data/ae-node.db  (relative to CWD — run this from ae-node/)
//
// WARNING — single-node use only. This writes account state directly to one
// node's SQLite file, outside consensus. Blocks carry no state root, so a
// multi-validator network cannot detect the resulting divergence: percentHuman
// drift is silent forever, and balance drift surfaces only as a
// `Replay: insufficient <type> balance` throw on the un-bumped node the first
// time a seeded account spends. Run it on EVERY node of a network or none.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

const SEED_EARNED = '500000000000'; // 5,000.00 points at 8 decimals

const dbPath = resolve(argv[2] ?? './data/ae-node.db');

// Guard before opening: DatabaseSync happily creates a missing file, so
// without this a wrong CWD produces a stray empty DB and a confusing
// "no such table: accounts" stack trace instead of a usable message.
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  console.error('');
  console.error('Run this from the ae-node directory:');
  console.error('  cd ae-node && node scripts/dev-bump-ph.mjs');
  console.error('Or pass an explicit path:');
  console.error('  node scripts/dev-bump-ph.mjs path/to/ae-node.db');
  exit(1);
}

const db = new DatabaseSync(dbPath);

const before = db.prepare(
  "SELECT id, percent_human, earned_balance FROM accounts WHERE type = 'individual'",
).all();

if (before.length === 0) {
  console.log(`No individual accounts in ${dbPath}.`);
  console.log('Create an account in the wallet first, then run this again.');
  db.close();
  exit(0);
}

console.log(`Found ${before.length} individual account(s) in ${dbPath}.`);

// No `percent_human < 100` filter. With one, the script was a one-shot: an
// account already at 100 was skipped even when its earned balance had been
// spent down to nothing, so a second run printed the same success output
// having changed zero rows. Setting both columns unconditionally makes the
// script idempotent and re-runnable as a top-up.
const result = db.prepare(
  `UPDATE accounts
      SET percent_human = 100, earned_balance = ?
    WHERE type = 'individual'`,
).run(SEED_EARNED);

const changed = Number(result.changes ?? 0);
console.log(`Set percentHuman=100 and earned=${SEED_EARNED} on ${changed} row(s).`);

const after = db.prepare(
  "SELECT id, percent_human, earned_balance FROM accounts WHERE type = 'individual'",
).all();
for (const row of after) {
  console.log(`  ${row.id.slice(0, 12)}…  pH=${row.percent_human}  earned=${row.earned_balance}`);
}

db.close();
console.log('');
console.log('Done. The miner dashboard picks this up within 30s (it polls).');
console.log('The wallet has no poll and emits no balance:updated event for a raw');
console.log('SQL write — switch tabs or reload the page to see the new numbers.');
