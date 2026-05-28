// Shared presentation helpers for transaction_log entries (the audit trail).
// Used by the Income page (filtered to earnings) and the Audit page (full
// activity history). Keeping the change-type metadata in one place so the
// two pages can't drift apart.
import type { LedgerEntry } from './api';

export interface ChangeMeta {
  label: string;
  // 'in' = balance increase (income / returned stake), 'out' = decrease,
  // 'neutral' = a rebase-style adjustment with no clear direction.
  direction: 'in' | 'out' | 'neutral';
  // Tailwind text-color class for the amount.
  color: string;
}

const CHANGE_META: Record<string, ChangeMeta> = {
  tx_receive: { label: 'Payment received', direction: 'in', color: 'text-teal' },
  fee_distribution: { label: 'Fee pool / mining reward', direction: 'in', color: 'text-gold' },
  bounty: { label: 'Court bounty', direction: 'in', color: 'text-gold' },
  vouch_unlock: { label: 'Vouch stake returned', direction: 'in', color: 'text-teal' },
  mint: { label: 'Daily allocation', direction: 'in', color: 'text-muted' },
  tx_send: { label: 'Payment sent', direction: 'out', color: 'text-muted' },
  fee: { label: 'Transaction fee', direction: 'out', color: 'text-muted' },
  vouch_lock: { label: 'Vouch stake locked', direction: 'out', color: 'text-muted' },
  vouch_burn: { label: 'Vouch stake slashed', direction: 'out', color: 'text-red' },
  court_burn: { label: 'Court penalty', direction: 'out', color: 'text-red' },
  burn_unverified: { label: 'Burned (unverified spend)', direction: 'out', color: 'text-red' },
  burn_expire: { label: 'Expired (unspent daily)', direction: 'out', color: 'text-muted' },
  rebase: { label: 'Rebase adjustment', direction: 'neutral', color: 'text-muted' },
};

export function changeMeta(changeType: string): ChangeMeta {
  return CHANGE_META[changeType] ?? { label: changeType, direction: 'neutral', color: 'text-muted' };
}

// The signed prefix shown on an amount, given its direction.
export function amountSign(direction: ChangeMeta['direction']): string {
  if (direction === 'in') return '+';
  if (direction === 'out') return '-';
  return '';
}

// Earned income the miner actually accrues: direct payments, court bounties,
// and fee-pool / mining distributions. (Daily mint and returned vouch stakes
// are balance increases but not "income" in the earnings sense, so they stay
// out of the Income view and live only in the full Audit log.)
export const INCOME_TYPES = ['tx_receive', 'bounty', 'fee_distribution'] as const;

export function isIncome(changeType: string): boolean {
  return (INCOME_TYPES as readonly string[]).includes(changeType);
}

export function filterIncome(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.filter((e) => isIncome(e.change_type));
}

// Sum income entries by change_type, for the "Income Sources" breakdown.
// Returns base-unit totals (caller formats with displayPoints).
export function incomeBySource(entries: LedgerEntry[]): Array<{ changeType: string; total: number }> {
  const totals = new Map<string, number>();
  for (const e of filterIncome(entries)) {
    totals.set(e.change_type, (totals.get(e.change_type) ?? 0) + Number(e.amount));
  }
  return Array.from(totals.entries())
    .map(([changeType, total]) => ({ changeType, total }))
    .sort((a, b) => b.total - a.total);
}
