// Phase 53: Validator-set churn end-to-end.
//
// Sessions 41-46 built the genesis-time AND runtime paths for managing
// validators. This test proves they compose: a 3-validator genesis where
// only 2 validators run a node, the network is stalled (quorum=3, only
// 2 voters), then a signed deregister via the API drops the absent
// validator, quorum falls to 2, and the network commits again.
//
// What this verifies:
//   1. Genesis with 3 validators boots correctly across 2 runners.
//   2. With N=3 active and only 2 voters, BFT cannot form quorum — the
//      chain stays at block 0 even after several seconds.
//   3. A signed POST /validators/deregister succeeds on a live BFT
//      runner's API mid-flight.
//   4. Applying the same deregister to BOTH runners' DBs synchronizes
//      the validator-set view (the manual cross-DB-sync stopgap until
//      Session-47-or-later does on-chain validator changes).
//   5. With N=2 active, quorum drops to 2 and the next round commits.
//   6. Both runners agree on the post-churn block hash.
//
// Cross-DB-sync limitation (documented in code): the API endpoint
// updates only the DB it was called on. Real production wants
// validator changes propagated through a tx or block payload so any
// node receives the change automatically. Tracked as next session.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'http';

import { AENodeRunner } from '../src/node/runner.js';
import { buildGenesisSet, writeGenesisSet } from '../src/node/genesis-init.js';
import { signPayload } from '../src/core/crypto.js';
import { getLatestBlock } from '../src/core/block.js';
import { SqliteValidatorSet } from '../src/core/consensus/SqliteValidatorSet.js';
import { resetRateLimits } from '../src/api/middleware/rateLimit.js';
import { PRECISION } from '../src/core/constants.js';
import type { AENodeConfig } from '../src/node/config.js';

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function baseConfig(
  dbPath: string,
  nodeKeyPath: string,
  nodeId: string,
  genesisConfigPath: string,
  bftLocalAccountId: string,
): AENodeConfig {
  return {
    nodeId,
    authorityNodeId: '',
    apiPort: 0,
    p2pPort: 0,
    apiHost: '127.0.0.1',
    p2pHost: '127.0.0.1',
    dbPath,
    nodeKeyPath,
    genesisConfigPath,
    consensusMode: 'bft',
    bftLocalAccountId,
    seedNodes: [],
    maxPeers: 5,
    dayCycleIntervalMs: 86_400_000,
    blockIntervalMs: 10_000,
    logLevel: 'error',
  };
}

describe('Phase 53: Validator-set churn end-to-end', () => {
  const tempDirs: string[] = [];
  let runners: AENodeRunner[] = [];

  afterEach(async () => {
    for (const r of runners) {
      try { r.stop(); } catch {}
    }
    runners = [];
    await wait(50);
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tempDirs.length = 0;
  });

  it('quorum stalls at N=3 with 2 runners; deregister of absent validator unstalls', async () => {
    resetRateLimits();

    // ── 1. Genesis: 3 validators (A + B + absent), all funded ───────
    const set = buildGenesisSet({ networkId: 'ae-test',
      validatorCount: 3,
      names: ['validator-1', 'validator-2', 'validator-absent'],
      initialEarnedDisplay: 5000,
      stakeDisplay: 200,
    });

    const genesisDir = mkdtempSync(join(tmpdir(), 'phase53-genesis-'));
    tempDirs.push(genesisDir);
    const { specPath } = writeGenesisSet(genesisDir, set);

    const ksA = set.keystores[0];
    const ksB = set.keystores[1];
    const ksAbsent = set.keystores[2]; // present in genesis, but no runner

    // ── 2. Per-runner data dirs + node-key files (A + B) ────────────
    const aDir = mkdtempSync(join(tmpdir(), 'phase53-A-'));
    const bDir = mkdtempSync(join(tmpdir(), 'phase53-B-'));
    tempDirs.push(aDir, bDir);

    const aDb = join(aDir, 'node.db');
    const aKey = join(aDir, 'node-key.json');
    const bDb = join(bDir, 'node.db');
    const bKey = join(bDir, 'node-key.json');

    writeFileSync(aKey, JSON.stringify(ksA), { mode: 0o600 });
    writeFileSync(bKey, JSON.stringify(ksB), { mode: 0o600 });

    // ── 3. Start runner A ───────────────────────────────────────────
    const runnerA = new AENodeRunner(
      baseConfig(aDb, aKey, ksA.accountId, specPath, ksA.accountId),
    );
    runners.push(runnerA);
    runnerA.start();
    await runnerA.waitForReady();
    const aP2P = runnerA.getP2PPort();
    const aApi = runnerA.getApiPort();

    // ── 4. Start runner B with seed pointing at A ───────────────────
    const runnerB = new AENodeRunner({
      ...baseConfig(bDb, bKey, ksB.accountId, specPath, ksB.accountId),
      seedNodes: [{ host: '127.0.0.1', port: aP2P }],
    });
    runners.push(runnerB);
    runnerB.start();
    await runnerB.waitForReady();
    const bApi = runnerB.getApiPort();

    // Wait for peer mesh
    const meshDeadline = Date.now() + 5_000;
    while (
      Date.now() < meshDeadline &&
      runnerA.getP2PNode().peerManager.getPeerCount() < 1
    ) {
      await wait(50);
    }
    assert.equal(
      runnerA.getP2PNode().peerManager.getPeerCount(),
      1,
      'A must see B as peer',
    );

    // ── 5. Confirm both runners see 3 active validators (genesis) ──
    const aSetEarly = new SqliteValidatorSet(runnerA.getDb()).listActive();
    const bSetEarly = new SqliteValidatorSet(runnerB.getDb()).listActive();
    assert.equal(aSetEarly.length, 3, 'A sees 3 active validators initially');
    assert.equal(bSetEarly.length, 3, 'B sees 3 active validators initially');

    // ── 6. Network is stalled — quorum=3 needs all three voters ────
    // BFT rounds will fire and NIL-time-out. No block 1 should land
    // for several seconds.
    await wait(4_000);
    const aLatestStalled = getLatestBlock(runnerA.getDb());
    const bLatestStalled = getLatestBlock(runnerB.getDb());
    assert.equal(aLatestStalled?.number, 0, 'A stays at genesis (quorum unreachable)');
    assert.equal(bLatestStalled?.number, 0, 'B stays at genesis (quorum unreachable)');

    // ── 7. Submit deregister for the absent validator to BOTH APIs ──
    // The test holds the absent validator's privateKey because
    // buildGenesisSet returned it in the keystore. In real life, the
    // absent validator would sign + post the request themselves; we
    // simulate it by signing on their behalf.
    const deregPayload = {};
    const deregTs = Math.floor(Date.now() / 1000);
    const deregSig = signPayload(deregPayload, deregTs, ksAbsent.account.privateKey);
    const deregBody = {
      accountId: ksAbsent.accountId,
      timestamp: deregTs,
      signature: deregSig,
      payload: deregPayload,
    };

    const deregA = await postJson(aApi, '/api/v1/validators/deregister', deregBody);
    assert.equal(deregA.status, 200, `A's deregister: ${JSON.stringify(deregA.data)}`);
    assert.equal(deregA.data.success, true);

    const deregB = await postJson(bApi, '/api/v1/validators/deregister', deregBody);
    assert.equal(deregB.status, 200, `B's deregister: ${JSON.stringify(deregB.data)}`);
    assert.equal(deregB.data.success, true);

    // ── 8. Both runners now show 2 active validators ────────────────
    const aSetAfter = new SqliteValidatorSet(runnerA.getDb()).listActive();
    const bSetAfter = new SqliteValidatorSet(runnerB.getDb()).listActive();
    assert.equal(aSetAfter.length, 2, 'A sees 2 active after deregister');
    assert.equal(bSetAfter.length, 2, 'B sees 2 active after deregister');
    const aIds = aSetAfter.map((v) => v.accountId).sort();
    const bIds = bSetAfter.map((v) => v.accountId).sort();
    assert.deepEqual(aIds, bIds, 'both runners see the same active set');
    assert.ok(
      !aIds.includes(ksAbsent.accountId),
      'absent validator is no longer in the active set',
    );

    // ── 9. With N=2, quorum=2. Network unstalls. Wait for commit ────
    // Same multi-runner timing flake as phase 35/49: the success case
    // commits in ~1s after deregister, but under load the test can
    // spin through several NIL rounds. 90s gives plenty of margin
    // even on a CI box under parallel test pressure.
    const commitDeadline = Date.now() + 90_000;
    while (Date.now() < commitDeadline) {
      const aLatest = getLatestBlock(runnerA.getDb());
      const bLatest = getLatestBlock(runnerB.getDb());
      if ((aLatest?.number ?? 0) >= 1 && (bLatest?.number ?? 0) >= 1) break;
      await wait(100);
    }
    const aLatest = getLatestBlock(runnerA.getDb());
    const bLatest = getLatestBlock(runnerB.getDb());
    assert.ok(
      (aLatest?.number ?? 0) >= 1,
      'A commits a block after deregister (quorum reachable)',
    );
    assert.ok(
      (bLatest?.number ?? 0) >= 1,
      'B commits a block after deregister (quorum reachable)',
    );
    // After Session 54 (startup-delay fix), commits are fast enough that
    // one runner can be a block or two ahead of the other when this
    // check runs. Compare hashes at a height BOTH have reached.
    const commonHeight = Math.min(aLatest!.number, bLatest!.number);
    const aBlockAtCommon = runnerA.getDb()
      .prepare('SELECT hash FROM blocks WHERE number = ?')
      .get(commonHeight) as { hash: string };
    const bBlockAtCommon = runnerB.getDb()
      .prepare('SELECT hash FROM blocks WHERE number = ?')
      .get(commonHeight) as { hash: string };
    assert.equal(
      aBlockAtCommon.hash,
      bBlockAtCommon.hash,
      `block ${commonHeight} hash must match across runners`,
    );

    // ── 10. Confirm absent is now stored as inactive on both DBs ────
    const aAbsent = new SqliteValidatorSet(runnerA.getDb()).findByAccountId(
      ksAbsent.accountId,
    );
    const bAbsent = new SqliteValidatorSet(runnerB.getDb()).findByAccountId(
      ksAbsent.accountId,
    );
    assert.ok(aAbsent && !aAbsent.isActive, 'A has absent row marked inactive');
    assert.ok(bAbsent && !bAbsent.isActive, 'B has absent row marked inactive');

    // ── 11. Stake unlocked back to absent's earned balance ──────────
    // Both DBs should show the same post-deregister account state.
    const aAbsentAcct = runnerA.getDb()
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(ksAbsent.accountId) as { earned_balance: string; locked_balance: string };
    const bAbsentAcct = runnerB.getDb()
      .prepare('SELECT earned_balance, locked_balance FROM accounts WHERE id = ?')
      .get(ksAbsent.accountId) as { earned_balance: string; locked_balance: string };
    assert.equal(aAbsentAcct.earned_balance, pts(5000).toString());
    assert.equal(aAbsentAcct.locked_balance, '0');
    assert.deepEqual(aAbsentAcct, bAbsentAcct, 'absent account state agrees');
  });
});
