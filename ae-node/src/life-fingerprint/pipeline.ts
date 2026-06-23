import {
  Transaction,
  LifeScore,
  AccountMeta,
  Thresholds,
  DEFAULT_THRESHOLDS,
} from './types.js';
import { runTier1 } from './tier1.js';
import { runTier2, buildGlobalEdgeSet } from './tier2.js';
import { runTier3 } from './tier3.js';
import { assembleLifeScore } from './scorer.js';

const DAY_MS = 86_400_000;

export interface PipelineInput {
  accounts: AccountMeta[];
  transactions: Transaction[];
  now: number;
  thresholds?: Thresholds;
}

export interface PipelineOutput {
  scores: LifeScore[];
  flagged: string[];
}

function buildTxIndex(txs: Transaction[]): Map<string, Transaction[]> {
  const idx = new Map<string, Transaction[]>();
  for (const tx of txs) {
    let senderList = idx.get(tx.sender);
    if (!senderList) { senderList = []; idx.set(tx.sender, senderList); }
    senderList.push(tx);

    let receiverList = idx.get(tx.receiver);
    if (!receiverList) { receiverList = []; idx.set(tx.receiver, receiverList); }
    receiverList.push(tx);
  }
  return idx;
}

function networkAvgDiversity90d(
  accounts: AccountMeta[],
  txIndex: Map<string, Transaction[]>,
  now: number
): number {
  if (accounts.length === 0) return 0;
  const cutoff = now - 90 * DAY_MS;
  let totalDiv = 0;
  for (const acct of accounts) {
    const peers = new Set<string>();
    const myTxs = txIndex.get(acct.accountId) ?? [];
    for (const tx of myTxs) {
      if (tx.timestamp < cutoff) continue;
      if (tx.sender === acct.accountId) peers.add(tx.receiver);
      else peers.add(tx.sender);
    }
    totalDiv += peers.size;
  }
  return totalDiv / accounts.length;
}

export function runPipeline(input: PipelineInput): PipelineOutput {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const { accounts, transactions, now } = input;

  const txIndex = buildTxIndex(transactions);

  const avgDiv = networkAvgDiversity90d(accounts, txIndex, now);

  const tier1Results = new Map<string, ReturnType<typeof runTier1>>();
  const tier1Flagged: string[] = [];

  for (const acct of accounts) {
    const ageDays = Math.max(1, Math.floor((now - acct.createdAt) / DAY_MS));
    const acctTxs = txIndex.get(acct.accountId) ?? [];
    const result = runTier1(acct.accountId, acctTxs, ageDays, avgDiv, now, t);
    tier1Results.set(acct.accountId, result);
    if (result.flags.length > 0) tier1Flagged.push(acct.accountId);
  }

  const tier2Results = new Map<string, ReturnType<typeof runTier2>>();
  const tier2Flagged: string[] = [];
  const histCache = new Map<string, number[]>();
  const clusterCache = new Map<string, import('./tier2.js').Cluster[]>();
  const globalEdges = tier1Flagged.length > 0 ? buildGlobalEdgeSet(transactions) : new Set<string>();

  for (const accountId of tier1Flagged) {
    const acctTxs = txIndex.get(accountId) ?? [];
    const result = runTier2(accountId, acctTxs, tier1Flagged, transactions, now, t, txIndex, histCache, clusterCache, globalEdges);
    tier2Results.set(accountId, result);
    if (result.flags.length > 0) tier2Flagged.push(accountId);
  }

  const tier3Results = new Map<string, ReturnType<typeof runTier3>>();

  for (const accountId of tier2Flagged) {
    const acctTxs = txIndex.get(accountId) ?? [];
    const result = runTier3(accountId, acctTxs, transactions, t);
    tier3Results.set(accountId, result);
  }

  const scores: LifeScore[] = [];
  for (const acct of accounts) {
    const ageDays = Math.max(1, Math.floor((now - acct.createdAt) / DAY_MS));
    const t1 = tier1Results.get(acct.accountId)!;
    const t2 = tier2Results.get(acct.accountId) ?? null;
    const t3 = tier3Results.get(acct.accountId) ?? null;
    scores.push(assembleLifeScore(acct.accountId, t1, t2, t3, ageDays, t));
  }

  const flagged = scores
    .filter((s) => s.composite < t.compositeFlag)
    .map((s) => s.accountId);

  return { scores, flagged };
}
