// Regression tests for the peer-address bug the LAN multi-validator test
// surfaced: `outbound connect threw for ::ffff:127.0.0.1:0: Invalid URL:
// ws://::ffff:127.0.0.1:0`.
//
// Two defects, one symptom:
//   1. A peer that connects TO us is recorded with port 0, because the socket
//      reports its ephemeral source port, not the port it listens on. That
//      address got gossiped to every other node during peer exchange, and each
//      of them then burned a reconnect slot on it every interval, forever.
//   2. Node reports IPv4 sockets on a dual-stack listener as ::ffff:127.0.0.1,
//      which is not a legal URL host without brackets.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isDialable, normalizeHost, peerUrl } from '../src/network/peer.js';
import { PeerDiscovery } from '../src/network/discovery.js';
import type { PeerManager } from '../src/network/peer.js';

describe('peer address normalisation', () => {
  test('unwraps IPv4-mapped IPv6 to plain IPv4', () => {
    assert.strictEqual(normalizeHost('::ffff:127.0.0.1'), '127.0.0.1');
    assert.strictEqual(normalizeHost('::FFFF:10.1.10.235'), '10.1.10.235');
  });

  test('leaves real IPv4, hostnames and real IPv6 alone', () => {
    assert.strictEqual(normalizeHost('127.0.0.1'), '127.0.0.1');
    assert.strictEqual(normalizeHost('node.example.com'), 'node.example.com');
    assert.strictEqual(normalizeHost('::1'), '::1');
  });

  test('builds a legal URL for every host form', () => {
    // The exact string that threw in the LAN test.
    assert.strictEqual(peerUrl('::ffff:127.0.0.1', 9302), 'ws://127.0.0.1:9302');
    assert.strictEqual(peerUrl('127.0.0.1', 9301), 'ws://127.0.0.1:9301');
    // Bare IPv6 must be bracketed or `new URL` rejects it.
    assert.strictEqual(peerUrl('::1', 9000), 'ws://[::1]:9000');

    // Prove they actually parse, which is what the old code failed at.
    for (const u of [
      peerUrl('::ffff:127.0.0.1', 9302),
      peerUrl('127.0.0.1', 9301),
      peerUrl('::1', 9000),
    ]) {
      assert.doesNotThrow(() => new URL(u), `should parse: ${u}`);
    }
  });
});

describe('peer address dialability', () => {
  test('port 0 is never dialable', () => {
    assert.strictEqual(isDialable('127.0.0.1', 0), false);
  });

  test('rejects out-of-range and non-integer ports', () => {
    assert.strictEqual(isDialable('127.0.0.1', -1), false);
    assert.strictEqual(isDialable('127.0.0.1', 65536), false);
    assert.strictEqual(isDialable('127.0.0.1', 1.5), false);
    assert.strictEqual(isDialable('127.0.0.1', NaN), false);
  });

  test('rejects an empty host', () => {
    assert.strictEqual(isDialable('', 9000), false);
  });

  test('accepts ordinary peer addresses', () => {
    assert.strictEqual(isDialable('127.0.0.1', 9000), true);
    assert.strictEqual(isDialable('10.1.10.235', 9000), true);
  });
});

describe('discovery refuses to remember undialable addresses', () => {
  function makeDiscovery(): PeerDiscovery {
    // PeerDiscovery only calls back into the manager on connect attempts,
    // which these tests do not trigger.
    const stub = {
      on: () => {},
      getNodeId: () => 'self',
      getPeerCount: () => 0,
      getConnectedPeers: () => [],
      connectToPeer: () => {},
    } as unknown as PeerManager;
    return new PeerDiscovery(stub, { seedNodes: [] });
  }

  test('a port-0 address is dropped rather than stored', () => {
    const d = makeDiscovery();
    d.addAddress('::ffff:127.0.0.1', 0);
    assert.deepStrictEqual(d.getKnownAddresses(), []);
  });

  test('a good address is stored with its host normalised', () => {
    const d = makeDiscovery();
    d.addAddress('::ffff:127.0.0.1', 9302);
    assert.deepStrictEqual(d.getKnownAddresses(), [{ host: '127.0.0.1', port: 9302 }]);
  });

  test('the mapped and plain forms of one address do not double-store', () => {
    const d = makeDiscovery();
    d.addAddress('::ffff:127.0.0.1', 9302);
    d.addAddress('127.0.0.1', 9302);
    assert.strictEqual(d.getKnownAddresses().length, 1);
  });
});
