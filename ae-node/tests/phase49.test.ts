// Phase 49: Two-runner integration from a shared genesis spec.
//
// Sessions 41 + 42 made the bootstrap path real:
//   - GenesisSpec format + applyGenesisSpec (Session 41)
//   - buildGenesisSet + writeGenesisSet CLI (Session 42)
//
// This test drives both pieces end-to-end against actual runners. It's
// the closest thing to "two laptops" we can run in CI:
//
//   1. buildGenesisSet → spec + per-validator keystores in memory
//   2. writeGenesisSet → spec.json + keys/<accountId>.json on disk
//   3. For each keystore: write it as the runner's node-key.json
//      (the keystore IS NodeIdentity-shape at the JSON top level so
//      the runner reads it without modification).
//   4. Two AENodeRunners boot pointing at the SAME genesis.json. They
//      apply it on first boot → identical genesis blocks → matching
//      genesisHash on the wire envelope → handshake succeeds.
//   5. Submit a signed earned-points transfer to runner A's API.
//   6. Both DBs see the tx, BFT commits a block, post-block balances
//      match across both runners.
//
// Phase 35 already does multi-runner E2E but seeds DBs imperatively;
// this test proves the SHARED-SPEC path Matt actually uses on real
// machines.

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
import { getAccount } from '../src/core/account.js';
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

describe('Phase 49: Spec-driven two-runner bootstrap', () => {
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

  it('two runners booting from the same genesis spec peer + commit a real tx', async () => {
    resetRateLimits();

    // ── 1. Build the shared genesis: 2 validators, plenty of earned ───
    // The validators ARE the sender + receiver. Each starts with
    // 5000 earned (- 200 stake = 4800 spendable earned). Earned
    // transfers don't depend on the day cycle, so the test exercises
    // the bootstrap + consensus path without needing a mint event.
    const set = buildGenesisSet({ networkId: 'ae-test',
      validatorCount: 2,
      names: ['validator-1', 'validator-2'],
      initialEarnedDisplay: 5000,
      stakeDisplay: 200,
    });

    const genesisDir = mkdtempSync(join(tmpdir(), 'phase49-genesis-'));
    tempDirs.push(genesisDir);
    const { specPath } = writeGenesisSet(genesisDir, set);

    const ksA = set.keystores[0];
    const ksB = set.keystores[1];

    // ── 2. Per-runner data dirs + node-key files ─────────────────────
    // The keystore JSON is NodeIdentity-shape at the top level — the
    // runner's loadOrCreateNodeIdentity reads {publicKey, secretKey}
    // and ignores the rest. We just write the keystore as the node
    // key file.
    const runnerADir = mkdtempSync(join(tmpdir(), 'phase49-A-'));
    const runnerBDir = mkdtempSync(join(tmpdir(), 'phase49-B-'));
    tempDirs.push(runnerADir, runnerBDir);

    const runnerADb = join(runnerADir, 'node.db');
    const runnerANodeKey = join(runnerADir, 'node-key.json');
    const runnerBDb = join(runnerBDir, 'node.db');
    const runnerBNodeKey = join(runnerBDir, 'node-key.json');

    writeFileSync(runnerANodeKey, JSON.stringify(ksA), { mode: 0o600 });
    writeFileSync(runnerBNodeKey, JSON.stringify(ksB), { mode: 0o600 });

    // ── 3. Start runner A ────────────────────────────────────────────
    const runnerA = new AENodeRunner(
      baseConfig(runnerADb, runnerANodeKey, ksA.accountId, specPath, ksA.accountId),
    );
    runners.push(runnerA);
    runnerA.start();
    await runnerA.waitForReady();
    const aP2PPort = runnerA.getP2PPort();
    const aApiPort = runnerA.getApiPort();

    // ── 4. Start runner B with seed pointing at A ────────────────────
    const runnerB = new AENodeRunner({
      ...baseConfig(runnerBDb, runnerBNodeKey, ksB.accountId, specPath, ksB.accountId),
      seedNodes: [{ host: '127.0.0.1', port: aP2PPort }],
    });
    runners.push(runnerB);
    runnerB.start();
    await runnerB.waitForReady();

    // ── 5. Genesis hash agreement (the property handshakes use) ──────
    const aGenesis = getLatestBlock(runnerA.getDb())!;
    const bGenesis = getLatestBlock(runnerB.getDb())!;
    assert.equal(aGenesis.hash, bGenesis.hash, 'genesis hashes must match across runners');

    // ── 6. Wait for peer mesh ────────────────────────────────────────
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
      'A must see B as peer (proves genesis hash agreement, since handshakes verify it)',
    );

    // ── 7. Submit a real signed earned-points transfer (A → B) ──────
    const txAmount = pts(100);
    const txTimestamp = Math.floor(Date.now() / 1000);
    const internalPayload = {
      from: ksA.accountId,
      to: ksB.accountId,
      amount: txAmount.toString(),
      pointType: 'earned' as const,
      isInPerson: false,
      memo: '',
    };
    const signature = signPayload(internalPayload, txTimestamp, ksA.account.privateKey);
    const apiBody = {
      accountId: ksA.accountId,
      timestamp: txTimestamp,
      signature,
      payload: {
        to: ksB.accountId,
        amount: 100, // display
        pointType: 'earned',
        isInPerson: false,
        memo: '',
      },
    };
    const submitResp = await postJson(aApiPort, '/api/v1/transactions', apiBody);
    assert.equal(
      submitResp.status,
      200,
      `tx submit failed: ${JSON.stringify(submitResp.data)}`,
    );
    assert.equal(submitResp.data.success, true);
    const txId = submitResp.data.data.transaction.id;
    assert.ok(txId);

    // ── 8. Wait for both runners to commit at least block 1 ──────────
    // 60s deadline matches phase 35: a BFT round normally commits in
    // <10s, but parallel test execution + tx-gossip-then-propose
    // sometimes lets round 0 NIL-timeout. Round 1 always commits in a
    // healthy 2-validator mesh.
    const commitDeadline = Date.now() + 60_000;
    while (Date.now() < commitDeadline) {
      const aLatest = getLatestBlock(runnerA.getDb());
      const bLatest = getLatestBlock(runnerB.getDb());
      if ((aLatest?.number ?? 0) >= 1 && (bLatest?.number ?? 0) >= 1) break;
      await wait(100);
    }
    const aLatest = getLatestBlock(runnerA.getDb());
    const bLatest = getLatestBlock(runnerB.getDb());
    assert.ok(
      (aLatest?.number ?? 0) >= 1 && (bLatest?.number ?? 0) >= 1,
      'both runners must commit at least block 1 within deadline',
    );
    // After Session 54 (startup-delay fix), commits are fast enough that
    // one runner is often a block or two ahead of the other when the
    // loop above breaks. Compare hashes at a height BOTH have reached
    // rather than each runner's latest.
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

    // ── 9. Post-block balances agree across runners ──────────────────
    // Both runners should see B's earnedBalance increased by ~100
    // (minus tx fee). Phase 35 doesn't compare exact values because
    // fees are non-zero; we mirror that pattern.
    const aSenderOnA = getAccount(runnerA.getDb(), ksA.accountId)!;
    const aReceiverOnA = getAccount(runnerA.getDb(), ksB.accountId)!;
    const aSenderOnB = getAccount(runnerB.getDb(), ksA.accountId)!;
    const aReceiverOnB = getAccount(runnerB.getDb(), ksB.accountId)!;

    assert.equal(aSenderOnA.earnedBalance, aSenderOnB.earnedBalance, 'sender earnedBalance agrees across runners');
    assert.equal(aReceiverOnA.earnedBalance, aReceiverOnB.earnedBalance, 'receiver earnedBalance agrees across runners');
    // sender's balance went down, receiver's went up
    const initialEarned = pts(5000) - pts(200); // 5000 spec - 200 stake
    assert.ok(aSenderOnA.earnedBalance < initialEarned, 'sender earnedBalance must decrease');
    assert.ok(aReceiverOnA.earnedBalance > initialEarned, 'receiver earnedBalance must increase');
  });
});
