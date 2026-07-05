// W4: catch-up sync stall watchdog.
//
// Before this fix, ChainSync.startSync() sent a get_blocks request and waited
// on the reply. If that reply was dropped (lost message, a peer that went away
// mid-batch), isSyncing stayed true forever — and because startSync() early-
// returns while syncing, the follower wedged until it reconnected. The watchdog
// re-requests the outstanding batch a few times, then gives up and frees
// isSyncing so a later startSync can try again.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createGenesisBlock } from '../src/core/block.js';
import { ChainSync } from '../src/network/sync.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import type { PeerManager } from '../src/network/peer.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await wait(10);
  }
  return cond();
}

// A peer manager that advertises a higher chain but never answers get_blocks,
// simulating a dropped sync reply. Records every batch request it receives.
class SilentPeerManager {
  sentBatches: Array<{ from: number; to: number }> = [];
  on(): void { /* ChainSync registers listeners we never fire */ }
  getConnectedPeers(): Array<{ id: string; blockHeight: number }> {
    return [{ id: 'peer1', blockHeight: 3 }];
  }
  sendTo(_peerId: string, type: string, data: { fromHeight: number; toHeight: number }): void {
    if (type === 'get_blocks') this.sentBatches.push({ from: data.fromHeight, to: data.toHeight });
  }
  setBlockHeight(): void {}
  banPeer(): void {}
}

function makeSync(pm: SilentPeerManager) {
  const db = freshDb();
  createGenesisBlock(db); // local head = block 0
  const consensus = new AuthorityConsensus('authority', 'test-node', 3, '00');
  return new ChainSync(db, pm as unknown as PeerManager, consensus, undefined, {
    batchTimeoutMs: 30,
    maxBatchRetries: 2,
  });
}

describe('W4: catch-up sync retry + stall recovery', () => {
  it('retries an unanswered batch then frees isSyncing instead of wedging', async () => {
    const pm = new SilentPeerManager();
    const sync = makeSync(pm);

    sync.startSync();
    // The first request goes out immediately.
    assert.equal(pm.sentBatches.length, 1);
    assert.equal(sync.getState().isSyncing, true);

    // No reply ever comes. After the retry budget is spent, the watchdog must
    // give up and clear isSyncing — the whole point of the fix.
    const freed = await until(() => !sync.getState().isSyncing);
    assert.equal(freed, true, 'isSyncing must be freed after retries are exhausted');

    // 1 initial request + 2 retries = 3 total.
    assert.equal(pm.sentBatches.length, 3);
  });

  it('can start a fresh sync after a stalled one gave up', async () => {
    const pm = new SilentPeerManager();
    const sync = makeSync(pm);

    sync.startSync();
    await until(() => !sync.getState().isSyncing);
    const afterFirst = pm.sentBatches.length;

    // A later periodic tick must be able to try again (previously impossible:
    // isSyncing was stuck true, so startSync was a permanent no-op).
    sync.startSync();
    assert.equal(sync.getState().isSyncing, true);
    assert.ok(pm.sentBatches.length > afterFirst, 'a fresh sync re-requests blocks');
  });
});
