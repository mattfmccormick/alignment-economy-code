import { Transaction, Thresholds, DEFAULT_THRESHOLDS } from './types.js';

export interface Tier3Result {
  circularRatio: number;
  flags: string[];
}

const MAX_TRACE_CALLS = 50_000;

export function detectCircularFlows(
  accountId: string,
  txs: Transaction[],
  allTxs: Transaction[],
  maxHops: number
): number {
  const outgoing = txs.filter((tx) => tx.sender === accountId);
  if (outgoing.length === 0) return 0;

  const txIndex = new Map<string, Transaction[]>();
  for (const tx of allTxs) {
    let list = txIndex.get(tx.sender);
    if (!list) {
      list = [];
      txIndex.set(tx.sender, list);
    }
    list.push(tx);
  }

  let circularVolume = 0;
  let totalVolume = 0;
  let budget = MAX_TRACE_CALLS;

  for (const tx of outgoing) {
    totalVolume += tx.amount;
    if (budget <= 0) {
      circularVolume += tx.amount;
      continue;
    }
    const result = traceReturns(accountId, tx.receiver, tx.timestamp, maxHops - 1, txIndex, new Set([accountId]), budget);
    budget = result.remaining;
    if (result.found) {
      circularVolume += tx.amount;
    }
  }

  return totalVolume === 0 ? 0 : circularVolume / totalVolume;
}

function traceReturns(
  origin: string,
  current: string,
  afterTimestamp: number,
  hopsLeft: number,
  txIndex: Map<string, Transaction[]>,
  visited: Set<string>,
  budget: number
): { found: boolean; remaining: number } {
  if (current === origin) return { found: true, remaining: budget };
  if (hopsLeft <= 0 || budget <= 0) return { found: false, remaining: budget };
  budget--;

  const forwards = txIndex.get(current);
  if (!forwards) return { found: false, remaining: budget };

  for (const tx of forwards) {
    if (tx.timestamp <= afterTimestamp) continue;
    if (visited.has(tx.receiver) && tx.receiver !== origin) continue;
    visited.add(tx.receiver);
    const result = traceReturns(origin, tx.receiver, tx.timestamp, hopsLeft - 1, txIndex, visited, budget);
    budget = result.remaining;
    if (result.found) {
      visited.delete(tx.receiver);
      return { found: true, remaining: budget };
    }
    visited.delete(tx.receiver);
    if (budget <= 0) return { found: false, remaining: 0 };
  }
  return { found: false, remaining: budget };
}

export function runTier3(
  accountId: string,
  txs: Transaction[],
  allTxs: Transaction[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): Tier3Result {
  const flags: string[] = [];
  const ratio = detectCircularFlows(
    accountId,
    txs,
    allTxs,
    thresholds.circularMaxHops
  );
  if (ratio > thresholds.circularRatio) flags.push('circular_flow');
  return { circularRatio: ratio, flags };
}
