// Dev-only helper: bump every individual account's percentHuman to 100 and
// seed a spendable earned balance, so the wallet and miner UIs can be
// exercised end-to-end without running a full genesis ceremony. Reads the
// same SQLite DB the running node uses (WAL mode, so concurrent reads are
// safe).
//
// Run: node scripts/dev-bump-ph.mjs [path/to/ae-node.db] [--check]
// Default path: ./data/ae-node.db  (relative to CWD — run this from ae-node/)
//
// WARNING — this writes account state directly to one node's SQLite file,
// outside consensus. Nothing replicates it. On a multi-validator network that
// is a way to fork state, in two different ways:
//
//   - Run it on one node only and that node's balances stop matching its
//     peers. The first block touching a divergent account cannot be applied by
//     somebody, and consensus fail-stops (deliberately — halting beats
//     diverging silently; see BftDriverConfig.onApplyFailed).
//   - Run it on every node but at different moments and you can STILL diverge,
//     because it only touches accounts that exist locally at that instant. If
//     one node has not yet learned about an account the other has, the two end
//     up with different sets bumped.
//
// Safe procedure on a multi-node network:
//   1. Stop every node.
//   2. Run this on every node.
//   3. Compare the STATE ROOT each run prints. Identical means the nodes agree
//      and it is safe to restart. Different means DO NOT start the chain.
//   4. Restart every node.
//
// `--check` prints the state root without changing anything — the quickest way
// to answer "do these two machines actually agree right now?"

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argv, exit } from 'node:process';

const SEED_EARNED = '500000000000'; // 5,000.00 points at 8 decimals

const args = argv.slice(2);
const checkOnly = args.includes('--check');
const dbPath = resolve(args.find((a) => !a.startsWith('--')) ?? './data/ae-node.db');

// Import the node's own state-root implementation rather than re-deriving it
// here. A second copy that drifted would make two disagreeing nodes print
// matching roots, which is worse than having no check at all.
const stateRootPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'core', 'state-root.js');
if (!existsSync(stateRootPath)) {
  console.error(`Cannot find ${stateRootPath}`);
  console.error('');
  console.error('Run "npm run build" in ae-node first. This script reuses the node\'s');
  console.error('own state-root code so the comparison between machines is meaningful.');
  exit(1);
}
const { computeStateRoot } = await import(pathToFileURL(stateRootPath).href);

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

if (checkOnly) {
  console.log(`Database:    ${dbPath}`);
  console.log(`Individuals: ${before.length}`);
  console.log(`STATE ROOT:  ${computeStateRoot(db)}`);
  console.log('');
  console.log('Compare that value across every node. Identical means they agree.');
  db.close();
  exit(0);
}

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

const root = computeStateRoot(db);
db.close();

console.log('');
console.log(`STATE ROOT: ${root}`);
console.log('');
console.log('Multi-node network? Run this on EVERY node while they are all stopped,');
console.log('confirm they all print the SAME state root above, and only then restart.');
console.log('A mismatch means the account sets differ — starting the chain in that');
console.log('state fail-stops on the first block touching a divergent account.');
console.log('');
console.log('Done. The miner dashboard picks this up within 30s (it polls).');
console.log('The wallet has no poll and emits no balance:updated event for a raw');
console.log('SQL write — switch tabs or reload the page to see the new numbers.');
