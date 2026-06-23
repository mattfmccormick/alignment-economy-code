import { Transaction, Thresholds, DEFAULT_THRESHOLDS } from './types.js';

const DAY_MS = 86_400_000;

export interface Tier1Result {
  diversity30d: number;
  diversity90d: number;
  diversity180d: number;
  concentration: number;
  reciprocity: number;
  dailyVelocityAvg: number;
  ageRichnessRatio: number;
  flags: string[];
}

function uniqueCounterparties(
  accountId: string,
  txs: Transaction[],
  windowMs: number,
  now: number
): number {
  const cutoff = now - windowMs;
  const peers = new Set<string>();
  for (const tx of txs) {
    if (tx.timestamp < cutoff) continue;
    if (tx.sender === accountId) peers.add(tx.receiver);
    else if (tx.receiver === accountId) peers.add(tx.sender);
  }
  return peers.size;
}

function topNConcentration(
  accountId: string,
  txs: Transaction[],
  n: number
): number {
  const volumeByPeer = new Map<string, number>();
  let total = 0;
  for (const tx of txs) {
    const peer = tx.sender === accountId ? tx.receiver : tx.sender;
    if (peer === accountId) continue;
    volumeByPeer.set(peer, (volumeByPeer.get(peer) ?? 0) + tx.amount);
    total += tx.amount;
  }
  if (total === 0) return 0;
  const sorted = [...volumeByPeer.values()].sort((a, b) => b - a);
  const topSum = sorted.slice(0, n).reduce((s, v) => s + v, 0);
  return topSum / total;
}

function bidirectionalRatio(
  accountId: string,
  txs: Transaction[]
): number {
  const sentTo = new Set<string>();
  const receivedFrom = new Set<string>();
  for (const tx of txs) {
    if (tx.sender === accountId) sentTo.add(tx.receiver);
    else if (tx.receiver === accountId) receivedFrom.add(tx.sender);
  }
  const allPeers = new Set([...sentTo, ...receivedFrom]);
  if (allPeers.size === 0) return 0;
  let bidirectional = 0;
  for (const peer of allPeers) {
    if (sentTo.has(peer) && receivedFrom.has(peer)) bidirectional++;
  }
  return bidirectional / allPeers.size;
}

function dailyVelocity(
  accountId: string,
  txs: Transaction[],
  windowDays: number,
  now: number
): number {
  const cutoff = now - windowDays * DAY_MS;
  let total = 0;
  for (const tx of txs) {
    if (tx.timestamp < cutoff) continue;
    if (tx.sender === accountId) total += tx.amount;
  }
  return total / windowDays;
}

export function diversityThreshold(ageDays: number, t: Thresholds): number {
  if (ageDays < 30) return t.diversity.under30d;
  if (ageDays < 90) return t.diversity.under90d;
  if (ageDays < 180) return t.diversity.under180d;
  return t.diversity.over180d;
}

export function runTier1(
  accountId: string,
  txs: Transaction[],
  accountAgeDays: number,
  networkAvgDiversity90d: number,
  now: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): Tier1Result {
  const d30 = uniqueCounterparties(accountId, txs, 30 * DAY_MS, now);
  const d90 = uniqueCounterparties(accountId, txs, 90 * DAY_MS, now);
  const d180 = uniqueCounterparties(accountId, txs, 180 * DAY_MS, now);
  const conc = topNConcentration(accountId, txs, 5);
  const recip = bidirectionalRatio(accountId, txs);
  const vel = dailyVelocity(accountId, txs, 30, now);
  const expected = networkAvgDiversity90d > 0 ? networkAvgDiversity90d : 1;
  const ageRatio = d90 / expected;

  const flags: string[] = [];
  const minDiv = diversityThreshold(accountAgeDays, thresholds);
  if (d90 < minDiv) flags.push('low_diversity');
  if (conc > thresholds.concentration) flags.push('high_concentration');
  if (recip > thresholds.reciprocity) flags.push('high_reciprocity');

  const maxVel = thresholds.velocityMultiplier * thresholds.dailyAllocation;
  if (vel > maxVel) flags.push('high_velocity');

  if (ageRatio < thresholds.ageRichnessRatio) flags.push('low_age_richness');

  return {
    diversity30d: d30,
    diversity90d: d90,
    diversity180d: d180,
    concentration: conc,
    reciprocity: recip,
    dailyVelocityAvg: vel,
    ageRichnessRatio: ageRatio,
    flags,
  };
}
