#!/usr/bin/env node
/**
 * Seed script for 2-person testing.
 * Creates 2 verified accounts, lowers minimums, runs one day cycle.
 *
 * Usage: npx tsx src/scripts/seed-test.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { initializeSchema } from '../db/schema.js';
import { seedParams, setParam } from '../config/params.js';
import { createAccount, getAccount } from '../core/account.js';
import { createGenesisBlock, getLatestBlock } from '../core/block.js';
import { runDayCycle, getCycleState } from '../core/day-cycle.js';
import { registerMiner } from '../mining/registration.js';

const DB_PATH = './data/ae-node.db';

// Ensure data directory exists
const dir = './data';
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

// Check if DB already has data
const isNew = !existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
initializeSchema(db);
seedParams(db);

if (!isNew) {
  const latest = getLatestBlock(db);
  if (latest && latest.number > 0) {
    console.log('');
    console.log('Database already has data. To start fresh, delete ./data/ae-node.db and run again.');
    console.log('');
    db.close();
    process.exit(0);
  }
}

console.log('');
console.log('=== AE Test Seed ===');
console.log('');

// 1. Lower minimums for small-network testing
setParam(db, 'court.jury_size', 1);
setParam(db, 'mining.panel_size', 1);
setParam(db, 'mining.min_miners_for_jury', 1);
setParam(db, 'mining.tier1_uptime_threshold', 0);
setParam(db, 'mining.rolling_window_days', 1);
console.log('Lowered court/mining minimums for 2-person testing.');

// 2. Create genesis block
createGenesisBlock(db);
console.log('Created genesis block.');

// 3. Create two verified accounts
const matt = createAccount(db, 'individual', 1, 100);
const wife = createAccount(db, 'individual', 1, 100);

// 4. Register both as miners so they can verify each other
const mattMiner = registerMiner(db, matt.account.id);
const wifeMiner = registerMiner(db, wife.account.id);

// 5. Run one day cycle so they have starting balances
runDayCycle(db);
const state = getCycleState(db);

// 6. Get updated balances
const mattAcct = getAccount(db, matt.account.id)!;
const wifeAcct = getAccount(db, wife.account.id)!;

// 7. Save keys to a file for easy reference
const keyFile = {
  warning: 'KEEP THIS FILE SAFE. These are real private keys for your test accounts.',
  created: new Date().toISOString(),
  accounts: [
    {
      name: 'Account 1 (Matt)',
      accountId: matt.account.id,
      publicKey: matt.publicKey,
      privateKey: matt.privateKey,
      minerId: mattMiner.id,
    },
    {
      name: 'Account 2 (Wife)',
      accountId: wife.account.id,
      publicKey: wife.publicKey,
      privateKey: wife.privateKey,
      minerId: wifeMiner.id,
    },
  ],
};

writeFileSync('./data/test-keys.json', JSON.stringify(keyFile, null, 2));

console.log('');
console.log('--- ACCOUNT 1 (Matt) ---');
console.log(`  Account ID:  ${matt.account.id}`);
console.log(`  Public Key:  ${matt.publicKey}`);
console.log(`  Private Key: ${matt.privateKey}`);
console.log(`  Miner ID:    ${mattMiner.id}`);
console.log(`  Active Pts:  1,440.00`);
console.log(`  Human Score: 100%`);
console.log('');
console.log('--- ACCOUNT 2 (Wife) ---');
console.log(`  Account ID:  ${wife.account.id}`);
console.log(`  Public Key:  ${wife.publicKey}`);
console.log(`  Private Key: ${wife.privateKey}`);
console.log(`  Miner ID:    ${wifeMiner.id}`);
console.log(`  Active Pts:  1,440.00`);
console.log(`  Human Score: 100%`);
console.log('');
console.log(`Current Day: ${state.currentDay}`);
console.log('');
console.log('Keys saved to: ./data/test-keys.json');
console.log('');
console.log('Start the node:  npm run dev');
console.log('Then open:       http://localhost:5173 (wallet)');
console.log('                 http://localhost:5174 (miner dashboard)');
console.log('');

db.close();
