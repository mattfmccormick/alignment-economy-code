// Dev-only helper: bump every individual account's percentHuman to 100 so the
// miner UI can be exercised end-to-end without genesis bootstrap. Reads the
// same SQLite DB the running node uses (WAL mode, so concurrent reads are
// safe).
//
// Run: node scripts/dev-bump-ph.mjs [path/to/ae-node.db]
// Default path: ./data/ae-node.db

import { DatabaseSync } from 'node:sqlite';
import { argv } from 'node:process';

const dbPath = argv[2] ?? './data/ae-node.db';
const db = new DatabaseSync(dbPath);

const before = db.prepare(
  "SELECT id, percent_human, earned_balance FROM accounts WHERE type = 'individual'",
).all();
console.log(`Found ${before.length} individual accounts. Bumping percentHuman to 100…`);

db.prepare(
  "UPDATE accounts SET percent_human = 100, earned_balance = '500000000000' WHERE type = 'individual' AND percent_human < 100",
).run();

const after = db.prepare(
  "SELECT id, percent_human, earned_balance FROM accounts WHERE type = 'individual'",
).all();
for (const row of after) {
  console.log(`  ${row.id.slice(0, 12)}…  pH=${row.percent_human}  earned=${row.earned_balance}`);
}

db.close();
console.log('Done.');
