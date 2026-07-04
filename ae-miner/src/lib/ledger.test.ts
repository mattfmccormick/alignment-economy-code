import { describe, it, expect } from 'vitest';
import {
  changeMeta,
  amountSign,
  isIncome,
  filterIncome,
  incomeBySource,
} from './ledger';
import type { LedgerEntry } from './api';

// Minimal ledger-entry factory — only the fields the ledger helpers read.
function entry(change_type: string, amount: string): LedgerEntry {
  return {
    id: `id-${Math.random()}`,
    account_id: 'acct',
    change_type,
    point_type: 'earned',
    amount,
    balance_before: '0',
    balance_after: amount,
    reference_id: 'ref',
    timestamp: 0,
  } as LedgerEntry;
}

describe('isIncome / filterIncome', () => {
  it('classifies only real earnings as income', () => {
    expect(isIncome('tx_receive')).toBe(true);
    expect(isIncome('bounty')).toBe(true);
    expect(isIncome('fee_distribution')).toBe(true);
    // Balance increases that are not "income" in the earnings sense.
    expect(isIncome('mint')).toBe(false);
    expect(isIncome('vouch_unlock')).toBe(false);
    // Outflows.
    expect(isIncome('tx_send')).toBe(false);
    expect(isIncome('court_burn')).toBe(false);
  });

  it('filters a mixed ledger down to income entries', () => {
    const entries = [
      entry('tx_receive', '100'),
      entry('mint', '1440'),
      entry('bounty', '50'),
      entry('tx_send', '30'),
    ];
    const income = filterIncome(entries);
    expect(income.map((e) => e.change_type)).toEqual(['tx_receive', 'bounty']);
  });
});

describe('incomeBySource', () => {
  it('sums income per change_type and sorts by total descending', () => {
    const entries = [
      entry('tx_receive', '100'),
      entry('fee_distribution', '500'),
      entry('tx_receive', '150'),
      entry('mint', '9999'), // excluded (not income)
      entry('bounty', '200'),
    ];
    expect(incomeBySource(entries)).toEqual([
      { changeType: 'fee_distribution', total: 500 },
      { changeType: 'tx_receive', total: 250 },
      { changeType: 'bounty', total: 200 },
    ]);
  });

  it('returns an empty breakdown when there is no income', () => {
    expect(incomeBySource([entry('tx_send', '10'), entry('mint', '1440')])).toEqual([]);
  });
});

describe('changeMeta / amountSign', () => {
  it('maps known change types and falls back for unknown ones', () => {
    expect(changeMeta('tx_receive').direction).toBe('in');
    expect(changeMeta('court_burn').direction).toBe('out');
    expect(changeMeta('rebase').direction).toBe('neutral');
    const unknown = changeMeta('brand_new_type');
    expect(unknown.direction).toBe('neutral');
    expect(unknown.label).toBe('brand_new_type');
  });

  it('signs amounts by direction', () => {
    expect(amountSign('in')).toBe('+');
    expect(amountSign('out')).toBe('-');
    expect(amountSign('neutral')).toBe('');
  });
});
