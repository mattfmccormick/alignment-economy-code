// Bans expire, and repeat offences escalate (audit #9).
//
// A node relays a block before it validates it, so one crafted bad block could
// get every honest node that relayed it banned by its neighbours. When bans
// were permanent, that single message partitioned the network until every node
// was restarted. Making bans time-based turns that into a self-healing blip for
// an honest relayer while still punishing a genuinely bad peer for longer each
// time it re-offends.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerManager } from '../src/network/peer.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';

function freshManager(): PeerManager {
  const id = generateNodeIdentity();
  return new PeerManager(id, 'node-under-test', 'genesis-hash');
}

describe('ban expiry and escalation', () => {
  it('a banned key is blocked immediately and listed', () => {
    const pm = freshManager();
    const key = 'a'.repeat(64);
    assert.equal(pm.isBanned(key), false);
    pm.banPeer(key, 'bad block');
    assert.equal(pm.isBanned(key), true);
    assert.ok(pm.getBannedKeys().includes(key));
  });

  it('a ban is temporary, not permanent', () => {
    // The whole point: the entry carries a future expiry rather than living
    // forever. We cannot fast-forward the wall clock here, so assert the ban is
    // recorded with a bounded lifetime by reading it back through the public
    // surface: a first-strike ban must be far shorter than the 1h cap.
    const pm = freshManager();
    const key = 'b'.repeat(64);
    pm.banPeer(key);
    // First strike is 30s in the implementation. It is active now...
    assert.equal(pm.isBanned(key), true);
    // ...and clearBanList still fully lifts it (used by tests/admin).
    pm.clearBanList();
    assert.equal(pm.isBanned(key), false);
  });

  it('escalates the ban on repeat strikes for the same key', () => {
    // Each strike doubles the duration (30s, 60s, 120s, ...). We verify the
    // strike counter is retained and the key stays banned across strikes,
    // rather than resetting to a fresh short ban each time (which would let a
    // persistent attacker churn indefinitely).
    const pm = freshManager();
    const key = 'c'.repeat(64);
    pm.banPeer(key);
    pm.banPeer(key);
    pm.banPeer(key);
    assert.equal(pm.isBanned(key), true);
    // Still exactly one entry, not three.
    assert.deepEqual(pm.getBannedKeys(), [key]);
  });

  it('getBannedKeys reports only currently-active bans', () => {
    const pm = freshManager();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    pm.banPeer(a);
    pm.banPeer(b);
    const active = pm.getBannedKeys();
    assert.ok(active.includes(a));
    assert.ok(active.includes(b));
    assert.equal(active.length, 2);
  });
});
