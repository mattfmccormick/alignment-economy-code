// Two honest nodes must not ban each other over a block-height race.
//
// Found live during the first two-laptop run. The chain committed blocks 1-7 in
// under a second, then instantly partitioned:
//
//   15:09:12.626  BFT committed block 7 (0 txs)
//   15:09:12.785  closed (reason=bad sync block: Height gap: expected 8, got 7)
//
// Two compounding faults. The stale-block guard compared against the height
// captured when the sync STARTED, so gossip advancing the chain mid-batch let a
// block we already held slip through to validation. And any validation failure
// - including a pure ordering mismatch - was treated as proof of dishonesty and
// earned a permanent ban. The ban list is memory-only with no expiry, so a
// race lasting milliseconds locked two healthy nodes apart until a restart.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOrderingFailure } from '../src/network/sync.js';

describe('sync: ordering races are not misbehaviour', () => {
  test('the exact error that partitioned the two-laptop chain is not bannable', () => {
    assert.equal(
      isOrderingFailure('Height gap: expected 8, got 7'),
      true,
      'this string cost a working chain its peer link',
    );
  });

  test('other ordering failures are also forgiven', () => {
    for (const e of [
      'Height gap: expected 2, got 1',
      'Previous hash mismatch',
      'Previous block 4 not found',
      'parent cert missing',
    ]) {
      assert.equal(isOrderingFailure(e), true, `should forgive: ${e}`);
    }
  });

  test('cryptographic failures still ban — these cannot happen by accident', () => {
    for (const e of [
      'Block hash mismatch: expected abc, got def',
      'Invalid signature on block',
      'Merkle root mismatch',
      'Commit certificate has insufficient quorum',
      'Producer is not a current validator',
    ]) {
      assert.equal(isOrderingFailure(e), false, `must still ban: ${e}`);
    }
  });

  test('an absent error is not treated as forgivable', () => {
    assert.equal(isOrderingFailure(undefined), false);
    assert.equal(isOrderingFailure(''), false);
  });
});
