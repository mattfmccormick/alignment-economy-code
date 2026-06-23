import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTier1, diversityThreshold } from '../src/life-fingerprint/tier1.js';
import { runTier2, cosineSimilarity, dbscan } from '../src/life-fingerprint/tier2.js';
import { runTier3, detectCircularFlows } from '../src/life-fingerprint/tier3.js';
import { computeComposite, assembleLifeScore } from '../src/life-fingerprint/scorer.js';
import { DEFAULT_THRESHOLDS, Transaction } from '../src/life-fingerprint/types.js';

const DAY = 86_400_000;
const NOW = Date.now();

function makeTx(sender: string, receiver: string, daysAgo: number, amount = 100, location?: Transaction['location']): Transaction {
  return { sender, receiver, amount, timestamp: NOW - daysAgo * DAY, location };
}

describe('Tier 1 - Graph diversity', () => {
  it('counts unique counterparties in 30/90/180 day windows', () => {
    const txs = [
      makeTx('alice', 'bob', 5),
      makeTx('alice', 'carol', 10),
      makeTx('alice', 'dave', 50),
      makeTx('alice', 'eve', 100),
      makeTx('alice', 'frank', 200),
    ];
    const r = runTier1('alice', txs, 200, 20, NOW);
    assert.equal(r.diversity30d, 2);
    assert.equal(r.diversity90d, 3);
    assert.equal(r.diversity180d, 4);
  });

  it('calculates top-5 concentration', () => {
    const txs = [
      makeTx('alice', 'bob', 5, 900),
      makeTx('alice', 'carol', 5, 50),
      makeTx('alice', 'dave', 5, 50),
    ];
    const r = runTier1('alice', txs, 60, 20, NOW);
    assert.ok(r.concentration > 0.85);
  });

  it('flags low diversity for account age', () => {
    const txs = [makeTx('alice', 'bob', 5)];
    const r = runTier1('alice', txs, 100, 20, NOW);
    assert.ok(r.flags.includes('low_diversity'));
  });

  it('flags high concentration', () => {
    const txs = [
      makeTx('alice', 'bob', 5, 950),
      makeTx('alice', 'carol', 5, 50),
    ];
    const r = runTier1('alice', txs, 10, 2, NOW);
    assert.ok(r.flags.includes('high_concentration'));
  });

  it('flags high velocity', () => {
    const txs = [makeTx('alice', 'bob', 1, 300000)];
    const r = runTier1('alice', txs, 60, 20, NOW);
    assert.ok(r.flags.includes('high_velocity'));
  });

  it('flags low age richness', () => {
    const txs = [makeTx('alice', 'bob', 5)];
    const r = runTier1('alice', txs, 100, 50, NOW);
    assert.ok(r.flags.includes('low_age_richness'));
  });

  it('does not flag a healthy account', () => {
    const peers = Array.from({ length: 50 }, (_, i) => `peer${i}`);
    const txs = peers.map((p, i) => makeTx('alice', p, i % 30, 100));
    const r = runTier1('alice', txs, 200, 40, NOW);
    assert.equal(r.flags.length, 0);
  });
});

describe('Tier 1 - diversityThreshold', () => {
  it('returns correct thresholds by age', () => {
    assert.equal(diversityThreshold(15, DEFAULT_THRESHOLDS), 3);
    assert.equal(diversityThreshold(60, DEFAULT_THRESHOLDS), 10);
    assert.equal(diversityThreshold(120, DEFAULT_THRESHOLDS), 25);
    assert.equal(diversityThreshold(365, DEFAULT_THRESHOLDS), 40);
  });
});

describe('Tier 2 - Clustering coefficient', () => {
  it('returns high clustering for a tightly connected group', () => {
    const txs = [
      makeTx('alice', 'bob', 5),
      makeTx('alice', 'carol', 5),
      makeTx('alice', 'dave', 5),
      makeTx('bob', 'carol', 5),
      makeTx('bob', 'dave', 5),
      makeTx('carol', 'dave', 5),
    ];
    const r = runTier2('alice', txs, [], txs, NOW);
    assert.ok(r.clustering > 0.9, `clustering ${r.clustering} should be > 0.9`);
  });

  it('returns low clustering for unrelated counterparties', () => {
    const txs = [
      makeTx('alice', 'bob', 5),
      makeTx('alice', 'carol', 5),
      makeTx('alice', 'dave', 5),
    ];
    const r = runTier2('alice', txs, [], txs, NOW);
    assert.equal(r.clustering, 0);
  });

  it('flags high clustering', () => {
    const txs = [
      makeTx('alice', 'bob', 5),
      makeTx('alice', 'carol', 5),
      makeTx('bob', 'carol', 5),
    ];
    const r = runTier2('alice', txs, [], txs, NOW);
    assert.ok(r.flags.includes('high_clustering'));
  });
});

describe('Tier 2 - Temporal fingerprint', () => {
  it('cosine similarity of identical histograms is 1', () => {
    const a = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 0.001);
  });

  it('cosine similarity of orthogonal histograms is 0', () => {
    const a = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('detects temporal correlation between flagged accounts', () => {
    const hour10 = new Date(NOW);
    hour10.setUTCHours(10, 0, 0, 0);
    const base = hour10.getTime();

    const txs: Transaction[] = [];
    for (let d = 0; d < 20; d++) {
      const ts = base - d * DAY;
      txs.push({ sender: 'alice', receiver: 'x', amount: 10, timestamp: ts });
      txs.push({ sender: 'bob', receiver: 'y', amount: 10, timestamp: ts + 60000 });
    }

    const r = runTier2('alice', txs, ['bob'], txs, NOW);
    assert.ok(r.temporalCorrelation !== null);
    assert.ok(r.temporalCorrelation!.score > 0.85);
    assert.ok(r.flags.includes('temporal_correlation'));
  });
});

describe('Tier 2 - DBSCAN', () => {
  it('finds clusters of nearby points', () => {
    const points = [
      { lat: 40.7128, lng: -74.006 },
      { lat: 40.7130, lng: -74.005 },
      { lat: 40.7129, lng: -74.007 },
      { lat: 34.0522, lng: -118.2437 },
      { lat: 34.0524, lng: -118.2435 },
      { lat: 34.0520, lng: -118.2440 },
    ];
    const clusters = dbscan(points, 2, 3);
    assert.equal(clusters.length, 2);
  });

  it('treats isolated points as noise', () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 45, lng: 90 },
    ];
    const clusters = dbscan(points, 2, 3);
    assert.equal(clusters.length, 0);
  });
});

describe('Tier 2 - Geographic overlap', () => {
  it('detects overlap between flagged accounts sharing locations', () => {
    const loc = { lat: 40.7128, lng: -74.006, terminalId: 't1' };
    const txs: Transaction[] = [];
    for (let d = 0; d < 10; d++) {
      txs.push(makeTx('alice', 'x', d, 10, loc));
      txs.push(makeTx('bob', 'y', d, 10, loc));
    }
    const r = runTier2('alice', txs, ['bob'], txs, NOW);
    assert.ok(r.geoOverlap !== null);
    assert.ok(r.flags.includes('geo_overlap'));
  });
});

describe('Tier 3 - Circular flow detection', () => {
  it('detects a simple A->B->C->A loop', () => {
    const txs: Transaction[] = [
      { sender: 'a', receiver: 'b', amount: 100, timestamp: 1000 },
      { sender: 'b', receiver: 'c', amount: 100, timestamp: 2000 },
      { sender: 'c', receiver: 'a', amount: 100, timestamp: 3000 },
    ];
    const acctTxs = txs.filter((t) => t.sender === 'a' || t.receiver === 'a');
    const ratio = detectCircularFlows('a', acctTxs, txs, 4);
    assert.ok(ratio > 0.9, `ratio ${ratio} should be > 0.9`);
  });

  it('returns 0 for outward-only flows', () => {
    const txs: Transaction[] = [
      { sender: 'a', receiver: 'b', amount: 100, timestamp: 1000 },
      { sender: 'a', receiver: 'c', amount: 100, timestamp: 2000 },
      { sender: 'b', receiver: 'd', amount: 100, timestamp: 3000 },
    ];
    const acctTxs = txs.filter((t) => t.sender === 'a' || t.receiver === 'a');
    const ratio = detectCircularFlows('a', acctTxs, txs, 4);
    assert.equal(ratio, 0);
  });

  it('respects hop limit', () => {
    const txs: Transaction[] = [
      { sender: 'a', receiver: 'b', amount: 100, timestamp: 1000 },
      { sender: 'b', receiver: 'c', amount: 100, timestamp: 2000 },
      { sender: 'c', receiver: 'd', amount: 100, timestamp: 3000 },
      { sender: 'd', receiver: 'e', amount: 100, timestamp: 4000 },
      { sender: 'e', receiver: 'a', amount: 100, timestamp: 5000 },
    ];
    const acctTxs = txs.filter((t) => t.sender === 'a' || t.receiver === 'a');
    const within4 = detectCircularFlows('a', acctTxs, txs, 4);
    assert.equal(within4, 0);
    const within5 = detectCircularFlows('a', acctTxs, txs, 5);
    assert.ok(within5 > 0);
  });

  it('flags circular flow above threshold', () => {
    const txs: Transaction[] = [
      { sender: 'a', receiver: 'b', amount: 100, timestamp: 1000 },
      { sender: 'b', receiver: 'a', amount: 100, timestamp: 2000 },
    ];
    const acctTxs = txs.filter((t) => t.sender === 'a' || t.receiver === 'a');
    const r = runTier3('a', acctTxs, txs);
    assert.ok(r.flags.includes('circular_flow'));
  });
});

describe('Composite scoring', () => {
  it('healthy account scores near 1', () => {
    const t1 = {
      diversity30d: 20, diversity90d: 50, diversity180d: 80,
      concentration: 0.2, reciprocity: 0.15, dailyVelocityAvg: 500, ageRichnessRatio: 1.2, flags: [],
    };
    const score = computeComposite(t1, null, null, 200);
    assert.ok(score > 0.55, `score ${score} should be > 0.55`);
  });

  it('puppet account scores near 0', () => {
    const t1 = {
      diversity30d: 2, diversity90d: 3, diversity180d: 4,
      concentration: 0.95, reciprocity: 0.95, dailyVelocityAvg: 10000, ageRichnessRatio: 0.05,
      flags: ['low_diversity', 'high_concentration', 'high_reciprocity', 'high_velocity', 'low_age_richness'],
    };
    const t2 = {
      clustering: 0.85, temporalCorrelation: { accountId: 'x', score: 0.95 },
      geoClusters: 1, geoOverlap: { accountId: 'x', sharedClusters: 1 }, flags: ['high_clustering', 'temporal_correlation', 'geo_overlap'],
    };
    const t3 = { circularRatio: 0.7, flags: ['circular_flow'] };
    const score = computeComposite(t1, t2, t3, 200);
    assert.ok(score < 0.2, `score ${score} should be < 0.2`);
  });

  it('assembleLifeScore merges all tier flags', () => {
    const t1 = {
      diversity30d: 5, diversity90d: 5, diversity180d: 5,
      concentration: 0.8, reciprocity: 0.5, dailyVelocityAvg: 100, ageRichnessRatio: 0.5,
      flags: ['high_concentration'],
    };
    const t2 = {
      clustering: 0.5, temporalCorrelation: null, geoClusters: 2, geoOverlap: null,
      flags: ['high_clustering'],
    };
    const ls = assembleLifeScore('test', t1, t2, null, 90);
    assert.ok(ls.flags.includes('high_concentration'));
    assert.ok(ls.flags.includes('high_clustering'));
    assert.equal(ls.tier, 2);
  });
});
