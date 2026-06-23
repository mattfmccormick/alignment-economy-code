import { Transaction, Thresholds, DEFAULT_THRESHOLDS } from './types.js';

const DAY_MS = 86_400_000;
const EARTH_RADIUS_KM = 6371;

export interface Tier2Result {
  clustering: number;
  temporalCorrelation: { accountId: string; score: number } | null;
  geoClusters: number;
  geoOverlap: { accountId: string; sharedClusters: number } | null;
  flags: string[];
}

export interface Point {
  lat: number;
  lng: number;
}

export interface Cluster {
  centroid: Point;
  points: Point[];
}

function clusteringCoefficient(
  accountId: string,
  acctTxs: Transaction[],
  globalEdgeSet: Set<string>
): number {
  const peers = new Set<string>();
  for (const tx of acctTxs) {
    if (tx.sender === accountId) peers.add(tx.receiver);
    else if (tx.receiver === accountId) peers.add(tx.sender);
  }
  const peerList = [...peers];
  const n = peerList.length;
  if (n < 2) return 0;

  let edges = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = peerList[i] < peerList[j] ? peerList[i] : peerList[j];
      const b = peerList[i] < peerList[j] ? peerList[j] : peerList[i];
      if (globalEdgeSet.has(`${a}\0${b}`)) edges++;
    }
  }
  const possible = (n * (n - 1)) / 2;
  return edges / possible;
}

export function buildGlobalEdgeSet(txs: Transaction[]): Set<string> {
  const s = new Set<string>();
  for (const tx of txs) {
    const a = tx.sender < tx.receiver ? tx.sender : tx.receiver;
    const b = tx.sender < tx.receiver ? tx.receiver : tx.sender;
    s.add(`${a}\0${b}`);
  }
  return s;
}

function buildHourHistogram(
  accountId: string,
  txs: Transaction[],
  windowDays: number,
  now: number
): number[] {
  const cutoff = now - windowDays * DAY_MS;
  const bins = new Array(24).fill(0);
  let total = 0;
  for (const tx of txs) {
    if (tx.timestamp < cutoff) continue;
    if (tx.sender !== accountId && tx.receiver !== accountId) continue;
    const hour = new Date(tx.timestamp).getUTCHours();
    bins[hour]++;
    total++;
  }
  if (total === 0) return bins;
  for (let i = 0; i < 24; i++) bins[i] /= total;
  return bins;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function haversineKm(a: Point, b: Point): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function dbscan(
  points: Point[],
  radiusKm: number,
  minPoints: number
): Cluster[] {
  const labels = new Array(points.length).fill(-1); // -1 = unvisited
  let clusterId = 0;

  function regionQuery(idx: number): number[] {
    const neighbors: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (haversineKm(points[idx], points[i]) <= radiusKm) {
        neighbors.push(i);
      }
    }
    return neighbors;
  }

  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -1) continue;
    const neighbors = regionQuery(i);
    if (neighbors.length < minPoints) {
      labels[i] = -2; // noise
      continue;
    }
    labels[i] = clusterId;
    const queue = [...neighbors.filter((n) => n !== i)];
    while (queue.length > 0) {
      const j = queue.shift()!;
      if (labels[j] === -2) labels[j] = clusterId;
      if (labels[j] !== -1) continue;
      labels[j] = clusterId;
      const jNeighbors = regionQuery(j);
      if (jNeighbors.length >= minPoints) {
        for (const n of jNeighbors) {
          if (labels[n] === -1 || labels[n] === -2) queue.push(n);
        }
      }
    }
    clusterId++;
  }

  const clusters: Cluster[] = [];
  for (let c = 0; c < clusterId; c++) {
    const members = points.filter((_, i) => labels[i] === c);
    if (members.length === 0) continue;
    const centroid: Point = {
      lat: members.reduce((s, p) => s + p.lat, 0) / members.length,
      lng: members.reduce((s, p) => s + p.lng, 0) / members.length,
    };
    clusters.push({ centroid, points: members });
  }
  return clusters;
}

function collectLocations(
  accountId: string,
  txs: Transaction[],
  windowDays: number,
  now: number
): Point[] {
  const cutoff = now - windowDays * DAY_MS;
  const pts: Point[] = [];
  for (const tx of txs) {
    if (tx.timestamp < cutoff) continue;
    if (tx.sender !== accountId && tx.receiver !== accountId) continue;
    if (tx.location) pts.push({ lat: tx.location.lat, lng: tx.location.lng });
  }
  return pts;
}

function clusterOverlap(
  a: Cluster[],
  b: Cluster[],
  radiusKm: number
): number {
  let shared = 0;
  for (const ca of a) {
    for (const cb of b) {
      if (haversineKm(ca.centroid, cb.centroid) <= radiusKm) {
        shared++;
        break;
      }
    }
  }
  return shared;
}

export function runTier2(
  accountId: string,
  txs: Transaction[],
  flaggedAccounts: string[],
  allTxs: Transaction[],
  now: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  txIndex?: Map<string, Transaction[]>,
  histCache?: Map<string, number[]>,
  clusterCache?: Map<string, Cluster[]>,
  globalEdges?: Set<string>
): Tier2Result {
  const flags: string[] = [];

  const edges = globalEdges ?? buildGlobalEdgeSet(allTxs);
  const cc = clusteringCoefficient(accountId, txs, edges);
  if (cc > thresholds.clustering) flags.push('high_clustering');

  const myHist = buildHourHistogram(accountId, txs, 30, now);
  if (histCache) histCache.set(accountId, myHist);

  let bestCorr: { accountId: string; score: number } | null = null;
  for (const other of flaggedAccounts) {
    if (other === accountId) continue;
    let otherHist = histCache?.get(other);
    if (!otherHist) {
      const otherTxs = txIndex?.get(other) ?? allTxs.filter(
        (tx) => tx.sender === other || tx.receiver === other
      );
      otherHist = buildHourHistogram(other, otherTxs, 30, now);
      if (histCache) histCache.set(other, otherHist);
    }
    const sim = cosineSimilarity(myHist, otherHist);
    if (sim > thresholds.temporalSimilarity) {
      if (!bestCorr || sim > bestCorr.score) {
        bestCorr = { accountId: other, score: sim };
      }
    }
  }
  if (bestCorr) flags.push('temporal_correlation');

  const locs = collectLocations(accountId, txs, 90, now);
  const myClusters = dbscan(
    locs,
    thresholds.geoClusterRadiusKm,
    thresholds.geoClusterMinPoints
  );
  if (clusterCache) clusterCache.set(accountId, myClusters);

  let bestGeoOverlap: { accountId: string; sharedClusters: number } | null =
    null;
  if (myClusters.length > 0) {
    for (const other of flaggedAccounts) {
      if (other === accountId) continue;
      let otherClusters = clusterCache?.get(other);
      if (!otherClusters) {
        const otherTxs = txIndex?.get(other) ?? allTxs.filter(
          (tx) => tx.sender === other || tx.receiver === other
        );
        const otherLocs = collectLocations(other, otherTxs, 90, now);
        otherClusters = dbscan(
          otherLocs,
          thresholds.geoClusterRadiusKm,
          thresholds.geoClusterMinPoints
        );
        if (clusterCache) clusterCache.set(other, otherClusters);
      }
      const shared = clusterOverlap(
        myClusters,
        otherClusters,
        thresholds.geoOverlapRadiusKm
      );
      if (shared > 0) {
        if (!bestGeoOverlap || shared > bestGeoOverlap.sharedClusters) {
          bestGeoOverlap = { accountId: other, sharedClusters: shared };
        }
      }
    }
  }
  if (bestGeoOverlap) flags.push('geo_overlap');

  return {
    clustering: cc,
    temporalCorrelation: bestCorr,
    geoClusters: myClusters.length,
    geoOverlap: bestGeoOverlap,
    flags,
  };
}
