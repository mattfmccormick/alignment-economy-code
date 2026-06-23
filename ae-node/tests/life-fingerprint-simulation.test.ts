import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/life-fingerprint/pipeline.js';
import { formatFlaggedList } from '../src/life-fingerprint/dashboard.js';
import { Transaction, AccountMeta } from '../src/life-fingerprint/types.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

// Seeded PRNG for deterministic tests (xorshift32)
function makeRng(seed: number) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296);
  };
}

interface SimConfig {
  honestCount: number;
  puppetCount: number;
  daysOfHistory: number;
  smartPuppetFraction: number;
}

function generateSimulation(cfg: SimConfig) {
  const rng = makeRng(42);
  const accounts: AccountMeta[] = [];
  const txs: Transaction[] = [];

  const honestIds: string[] = [];
  const puppetIds: string[] = [];

  // Locations: 4 city clusters
  const cities = [
    { lat: 40.7128, lng: -74.006 },  // NYC
    { lat: 34.0522, lng: -118.244 }, // LA
    { lat: 41.8781, lng: -87.6298 }, // Chicago
    { lat: 29.7604, lng: -95.3698 }, // Houston
  ];

  // Create honest accounts
  for (let i = 0; i < cfg.honestCount; i++) {
    const id = `honest_${i}`;
    honestIds.push(id);
    const ageDays = 90 + Math.floor(rng() * 200);
    accounts.push({ accountId: id, createdAt: NOW - ageDays * DAY });
  }

  // Create puppet accounts
  for (let i = 0; i < cfg.puppetCount; i++) {
    const id = `puppet_${i}`;
    puppetIds.push(id);
    const ageDays = 60 + Math.floor(rng() * 120);
    accounts.push({ accountId: id, createdAt: NOW - ageDays * DAY });
  }

  const numSmartPuppets = Math.floor(cfg.puppetCount * cfg.smartPuppetFraction);

  // Generate honest transactions: diverse, outward, multiple locations, varied times
  for (const id of honestIds) {
    const homeCity = cities[Math.floor(rng() * cities.length)];
    const workCity = cities[Math.floor(rng() * cities.length)];

    // Each honest account transacts with 15-40 unique peers over 90 days
    const peerCount = 15 + Math.floor(rng() * 26);
    const peerPool = honestIds.filter((h) => h !== id);
    const myPeers: string[] = [];
    for (let p = 0; p < peerCount && p < peerPool.length; p++) {
      const idx = Math.floor(rng() * peerPool.length);
      const peer = peerPool.splice(idx, 1)[0];
      myPeers.push(peer);
    }

    for (let d = 0; d < Math.min(cfg.daysOfHistory, 90); d++) {
      // 1-4 transactions per day
      const txCount = 1 + Math.floor(rng() * 4);
      for (let t = 0; t < txCount; t++) {
        const peer = myPeers[Math.floor(rng() * myPeers.length)];
        const amount = 20 + Math.floor(rng() * 200);
        // Varied hours: each person has their own activity window
        const personalOffset = Math.floor(rng() * 12);
        const hour = (8 + personalOffset + Math.floor(rng() * 6)) % 24;
        const ts = NOW - d * DAY + hour * HOUR + Math.floor(rng() * HOUR);

        const useLocation = rng() > 0.6;
        const loc = useLocation ? {
          lat: (rng() > 0.5 ? homeCity : workCity).lat + (rng() - 0.5) * 0.01,
          lng: (rng() > 0.5 ? homeCity : workCity).lng + (rng() - 0.5) * 0.01,
          terminalId: `term_${Math.floor(rng() * 100)}`,
        } : undefined;

        txs.push({ sender: id, receiver: peer, amount, timestamp: ts, location: loc });
      }
    }
  }

  // Generate puppet transactions
  const puppetOperatorCity = cities[0]; // All puppets share one location

  for (let i = 0; i < cfg.puppetCount; i++) {
    const id = puppetIds[i];
    const isSmart = i < numSmartPuppets;

    for (let d = 0; d < Math.min(cfg.daysOfHistory, 90); d++) {
      // Puppets mostly trade with other puppets
      const inRingTxCount = isSmart ? 2 : 4;
      for (let t = 0; t < inRingTxCount; t++) {
        const otherIdx = (i + 1 + Math.floor(rng() * (cfg.puppetCount - 1))) % cfg.puppetCount;
        const peer = puppetIds[otherIdx];
        const amount = 400 + Math.floor(rng() * 200);
        // Same operator = same time pattern (9-11 AM UTC concentrated)
        const hour = 9 + Math.floor(rng() * 2);
        const ts = NOW - d * DAY + hour * HOUR + Math.floor(rng() * HOUR * 0.5);

        const loc = {
          lat: puppetOperatorCity.lat + (rng() - 0.5) * 0.005,
          lng: puppetOperatorCity.lng + (rng() - 0.5) * 0.005,
          terminalId: `term_puppet_${Math.floor(rng() * 3)}`,
        };

        txs.push({ sender: id, receiver: peer, amount, timestamp: ts, location: loc });
      }

      // Smart puppets add some noise: 1-2 txs with random honest accounts
      if (isSmart && rng() > 0.5) {
        const honest = honestIds[Math.floor(rng() * honestIds.length)];
        const amount = 10 + Math.floor(rng() * 50);
        const hour = Math.floor(rng() * 24);
        const ts = NOW - d * DAY + hour * HOUR;
        txs.push({ sender: id, receiver: honest, amount, timestamp: ts });
      }
    }
  }

  return { accounts, txs, honestIds, puppetIds, numSmartPuppets };
}

describe('Life Fingerprint Simulation', () => {
  it('100 honest + 20 puppet accounts: catches puppets, clears honest', () => {
    const sim = generateSimulation({
      honestCount: 100,
      puppetCount: 20,
      daysOfHistory: 90,
      smartPuppetFraction: 0.3,
    });

    const result = runPipeline({
      accounts: sim.accounts,
      transactions: sim.txs,
      now: NOW,
    });

    // Check honest accounts: none should be flagged
    const honestFlagged = result.flagged.filter((id) => id.startsWith('honest_'));
    const honestScores = result.scores.filter((s) => s.accountId.startsWith('honest_'));
    const honestComposites = honestScores.map((s) => s.composite);
    const avgHonest = honestComposites.reduce((a, b) => a + b, 0) / honestComposites.length;

    console.log(`\n=== SIMULATION RESULTS ===`);
    console.log(`Honest accounts: ${sim.honestIds.length}`);
    console.log(`Puppet accounts: ${sim.puppetIds.length} (${sim.numSmartPuppets} smart)`);
    console.log(`Total transactions: ${sim.txs.length}`);
    console.log(`\nHonest avg composite: ${avgHonest.toFixed(3)}`);
    console.log(`Honest false positives: ${honestFlagged.length} / ${sim.honestIds.length}`);

    // Check puppet accounts
    const puppetFlagged = result.flagged.filter((id) => id.startsWith('puppet_'));
    const puppetScores = result.scores.filter((s) => s.accountId.startsWith('puppet_'));
    const puppetComposites = puppetScores.map((s) => s.composite);
    const avgPuppet = puppetComposites.reduce((a, b) => a + b, 0) / puppetComposites.length;

    console.log(`\nPuppet avg composite: ${avgPuppet.toFixed(3)}`);
    console.log(`Puppets caught: ${puppetFlagged.length} / ${sim.puppetIds.length}`);

    // Dumb puppets should all be caught
    const dumbPuppetCount = sim.puppetIds.length - sim.numSmartPuppets;
    const dumbPuppetsCaught = puppetFlagged.filter((id) => {
      const idx = parseInt(id.split('_')[1]);
      return idx >= sim.numSmartPuppets;
    }).length;
    console.log(`Dumb puppets caught: ${dumbPuppetsCaught} / ${dumbPuppetCount}`);

    // Print some example scores
    console.log(`\n--- Sample honest scores ---`);
    for (const s of honestScores.slice(0, 3)) {
      console.log(`  ${s.accountId}: ${s.composite.toFixed(3)} (tier ${s.tier}, flags: [${s.flags.join(', ')}])`);
    }
    console.log(`\n--- Sample puppet scores ---`);
    for (const s of puppetScores.slice(0, 5)) {
      console.log(`  ${s.accountId}: ${s.composite.toFixed(3)} (tier ${s.tier}, flags: [${s.flags.join(', ')}])`);
    }

    // Show dashboard for worst puppet
    const ageDays = new Map<string, number>();
    for (const a of sim.accounts) {
      ageDays.set(a.accountId, Math.floor((NOW - a.createdAt) / DAY));
    }
    const flaggedOutput = formatFlaggedList(
      result.scores.filter((s) => s.accountId.startsWith('puppet_')),
      ageDays
    );
    console.log(`\n${flaggedOutput.slice(0, 1500)}`);

    // Assertions
    assert.ok(honestFlagged.length <= 5, `Too many honest false positives: ${honestFlagged.length}`);
    assert.ok(avgHonest > 0.5, `Honest avg score ${avgHonest} should be > 0.5`);
    assert.ok(puppetFlagged.length >= Math.floor(sim.puppetIds.length * 0.6),
      `Should catch at least 60% of puppets: caught ${puppetFlagged.length}/${sim.puppetIds.length}`);
    assert.ok(dumbPuppetsCaught >= dumbPuppetCount * 0.8,
      `Should catch at least 80% of dumb puppets: caught ${dumbPuppetsCaught}/${dumbPuppetCount}`);
    assert.ok(avgPuppet < avgHonest, `Puppet avg ${avgPuppet} should be < honest avg ${avgHonest}`);
  });

  it('deterministic: same input produces same scores', () => {
    const sim = generateSimulation({
      honestCount: 10,
      puppetCount: 5,
      daysOfHistory: 30,
      smartPuppetFraction: 0.2,
    });

    const r1 = runPipeline({ accounts: sim.accounts, transactions: sim.txs, now: NOW });
    const r2 = runPipeline({ accounts: sim.accounts, transactions: sim.txs, now: NOW });

    for (let i = 0; i < r1.scores.length; i++) {
      assert.equal(r1.scores[i].composite, r2.scores[i].composite,
        `Score mismatch for ${r1.scores[i].accountId}`);
      assert.deepStrictEqual(r1.scores[i].flags, r2.scores[i].flags);
    }
  });

  it('smart puppets are harder to catch than dumb ones', () => {
    const sim = generateSimulation({
      honestCount: 50,
      puppetCount: 20,
      daysOfHistory: 60,
      smartPuppetFraction: 0.5,
    });

    const result = runPipeline({ accounts: sim.accounts, transactions: sim.txs, now: NOW });

    const smartScores = result.scores
      .filter((s) => {
        if (!s.accountId.startsWith('puppet_')) return false;
        return parseInt(s.accountId.split('_')[1]) < 10;
      })
      .map((s) => s.composite);

    const dumbScores = result.scores
      .filter((s) => {
        if (!s.accountId.startsWith('puppet_')) return false;
        return parseInt(s.accountId.split('_')[1]) >= 10;
      })
      .map((s) => s.composite);

    const avgSmart = smartScores.reduce((a, b) => a + b, 0) / smartScores.length;
    const avgDumb = dumbScores.reduce((a, b) => a + b, 0) / dumbScores.length;

    console.log(`\nSmart puppet avg: ${avgSmart.toFixed(3)}, Dumb puppet avg: ${avgDumb.toFixed(3)}`);
    assert.ok(avgSmart >= avgDumb,
      `Smart puppets (${avgSmart.toFixed(3)}) should score >= dumb puppets (${avgDumb.toFixed(3)})`);
  });
});
