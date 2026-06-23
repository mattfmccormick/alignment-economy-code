import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/life-fingerprint/pipeline.js';
import { formatDashboard, formatFlaggedList } from '../src/life-fingerprint/dashboard.js';
import { Transaction, AccountMeta } from '../src/life-fingerprint/types.js';

const DAY = 86_400_000;
const NOW = Date.now();

function makeTx(sender: string, receiver: string, daysAgo: number, amount = 100): Transaction {
  return { sender, receiver, amount, timestamp: NOW - daysAgo * DAY };
}

describe('Pipeline - end to end', () => {
  it('runs all tiers on a small network', () => {
    const accounts: AccountMeta[] = [
      { accountId: 'honest1', createdAt: NOW - 200 * DAY },
      { accountId: 'honest2', createdAt: NOW - 200 * DAY },
      { accountId: 'puppet1', createdAt: NOW - 100 * DAY },
      { accountId: 'puppet2', createdAt: NOW - 100 * DAY },
    ];

    const txs: Transaction[] = [];
    const peers = Array.from({ length: 50 }, (_, i) => `peer${i}`);
    for (const p of peers) {
      txs.push(makeTx('honest1', p, Math.floor(Math.random() * 30), 100));
      txs.push(makeTx('honest2', p, Math.floor(Math.random() * 30), 100));
    }

    for (let d = 0; d < 30; d++) {
      txs.push(makeTx('puppet1', 'puppet2', d, 500));
      txs.push(makeTx('puppet2', 'puppet1', d, 500));
    }

    const result = runPipeline({ accounts, transactions: txs, now: NOW });

    const honestScores = result.scores.filter((s) => s.accountId.startsWith('honest'));
    const puppetScores = result.scores.filter((s) => s.accountId.startsWith('puppet'));

    for (const s of honestScores) {
      assert.ok(s.composite > 0.5, `honest ${s.accountId} score ${s.composite} should be > 0.5`);
    }

    for (const s of puppetScores) {
      assert.ok(s.composite < 0.5, `puppet ${s.accountId} score ${s.composite} should be < 0.5`);
    }

    assert.ok(result.flagged.includes('puppet1'));
    assert.ok(result.flagged.includes('puppet2'));
    assert.ok(!result.flagged.includes('honest1'));
    assert.ok(!result.flagged.includes('honest2'));
  });

  it('handles empty network', () => {
    const result = runPipeline({ accounts: [], transactions: [], now: NOW });
    assert.equal(result.scores.length, 0);
    assert.equal(result.flagged.length, 0);
  });

  it('handles accounts with no transactions', () => {
    const accounts: AccountMeta[] = [
      { accountId: 'new', createdAt: NOW - 5 * DAY },
    ];
    const result = runPipeline({ accounts, transactions: [], now: NOW });
    assert.equal(result.scores.length, 1);
    assert.equal(result.scores[0].diversity30d, 0);
  });
});

describe('Dashboard formatter', () => {
  it('produces readable output for a flagged account', () => {
    const accounts: AccountMeta[] = [
      { accountId: 'puppet_abc123', createdAt: NOW - 120 * DAY },
    ];
    const txs: Transaction[] = [];
    for (let d = 0; d < 30; d++) {
      txs.push(makeTx('puppet_abc123', 'puppet_abc123_peer', d, 500));
    }
    const result = runPipeline({ accounts, transactions: txs, now: NOW });
    const score = result.scores[0];
    const dash = formatDashboard(score, 120);
    assert.ok(dash.includes('Account #'));
    assert.ok(dash.includes('Life Score'));
    assert.ok(dash.includes('Counterparties'));
  });

  it('formats flagged list', () => {
    const accounts: AccountMeta[] = [
      { accountId: 'p1', createdAt: NOW - 120 * DAY },
      { accountId: 'p2', createdAt: NOW - 120 * DAY },
    ];
    const txs: Transaction[] = [];
    for (let d = 0; d < 30; d++) {
      txs.push(makeTx('p1', 'p2', d, 500));
      txs.push(makeTx('p2', 'p1', d, 500));
    }
    const result = runPipeline({ accounts, transactions: txs, now: NOW });
    const ageDays = new Map([['p1', 120], ['p2', 120]]);
    const output = formatFlaggedList(result.scores, ageDays);
    assert.ok(output.includes('FLAGGED ACCOUNTS'));
  });

  it('returns no-flag message for clean network', () => {
    const accounts: AccountMeta[] = [
      { accountId: 'good', createdAt: NOW - 200 * DAY },
    ];
    const peers = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const txs = peers.map((p, i) => makeTx('good', p, i % 30, 100));
    const result = runPipeline({ accounts, transactions: txs, now: NOW });
    const ageDays = new Map([['good', 200]]);
    const output = formatFlaggedList(result.scores, ageDays);
    assert.equal(output, 'No flagged accounts.');
  });
});
