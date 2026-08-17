import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './src/db/schema.js';
import { createAccount, getAccount, updateBalance, updatePercentHuman } from './src/core/account.js';
import { createPanel, submitPanelScore } from './src/verification/panel.js';
import { createVouch, withdrawVouch } from './src/verification/vouching.js';
import { runDecayForAll } from './src/verification/decay.js';

function fresh() {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  return db;
}

// ---- PROBE 1: fractional median score ----
{
  const db = fresh();
  const a = createAccount(db, 'individual', 1, 0);
  const panel = createPanel(db, a.account.id);
  submitPanelScore(db, panel.id, 'm1', 62.5);
  submitPanelScore(db, panel.id, 'm2', 62.5);
  const r = submitPanelScore(db, panel.id, 'm3', 62.5);
  const acct = getAccount(db, a.account.id)!;
  console.log('P1 medianScore:', r.medianScore, 'stored percentHuman:', acct.percentHuman);
  const raw = db.prepare('SELECT percent_human, typeof(percent_human) as t FROM accounts WHERE id = ?').get(a.account.id);
  console.log('P1 raw row:', raw);
  try {
    const eff = (1000n * BigInt(acct.percentHuman)) / 100n;
    console.log('P1 spend math ok:', eff);
  } catch (e) {
    console.log('P1 spend math THREW:', String(e));
  }
  db.close();
}

// ---- PROBE 2: late miner overrides a completed panel ----
{
  const db = fresh();
  const a = createAccount(db, 'individual', 1, 0);
  const panel = createPanel(db, a.account.id);
  submitPanelScore(db, panel.id, 'm1', 50);
  submitPanelScore(db, panel.id, 'm2', 90);
  const r3 = submitPanelScore(db, panel.id, 'm3', 95);
  console.log('P2 after 3:', r3.panelComplete, r3.medianScore, getAccount(db, a.account.id)!.percentHuman);
  const r4 = submitPanelScore(db, panel.id, 'm4', 0);
  console.log('P2 after 4:', r4.panelComplete, r4.medianScore, getAccount(db, a.account.id)!.percentHuman);
  const r5 = submitPanelScore(db, panel.id, 'm5', 0);
  console.log('P2 after 5:', r5.panelComplete, r5.medianScore, getAccount(db, a.account.id)!.percentHuman);
  const p = db.prepare('SELECT status, completed_at, median_score FROM verification_panels WHERE id = ?').get(panel.id);
  console.log('P2 panel row:', p);
  db.close();
}

// ---- PROBE 3: vouch / withdraw ratchet by an unrelated account ----
{
  const db = fresh();
  const victim = createAccount(db, 'individual', 1, 0);
  const attacker = createAccount(db, 'individual', 1, 0);
  updatePercentHuman(db, victim.account.id, 100);
  updateBalance(db, attacker.account.id, 'earned_balance', 10_000n);

  for (let i = 0; i < 5; i++) {
    const v = createVouch(db, attacker.account.id, victim.account.id, 25);
    withdrawVouch(db, v.id);
    const vict = getAccount(db, victim.account.id)!;
    const att = getAccount(db, attacker.account.id)!;
    console.log(`P3 cycle ${i + 1}: victim percentHuman=${vict.percentHuman} attacker earned=${att.earnedBalance} locked=${att.lockedBalance}`);
  }
  db.close();
}

// ---- PROBE 4: runDecayForAll compounding off joinedDay ----
{
  const db = fresh();
  const a = createAccount(db, 'individual', 1, 100);
  // simulate the account having been around a while
  for (const day of [31, 32, 33, 90, 91]) {
    runDecayForAll(db, day);
    console.log(`P4 currentDay=${day} percentHuman=${getAccount(db, a.account.id)!.percentHuman}`);
  }
  db.close();
}
