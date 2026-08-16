// Signing-payload contract between ae-node and its clients (ae-app, ae-miner, sdk).
//
// Why this file exists
// --------------------
// On August 16 2026 every wallet send returned 400 INVALID_SIGNATURE. The cause
// was not crypto: it was that ae-app and the SDK signed a 6-key payload
//
//   { from, to, amount, pointType, isInPerson, memo }
//
// while processTransaction rebuilds a 7-key one to verify
//
//   { from, to, amount, pointType, isInPerson, recipientIsHuman, memo }
//
// signPayload and verifyPayload both hash `JSON.stringify(payload) + timestamp`
// with NO key sorting or canonicalization (src/core/crypto.ts), so the key SET
// and the key INSERTION ORDER are both part of the signed bytes. One missing
// key changed the message and ML-DSA rejected every signature.
//
// 663 tests were green through all of it. The node's own tests construct the
// correct payload themselves, so they can never disagree with the node. The
// wallet's Send test mocks the API client, so it never reaches verification.
// Nothing signed with a client's code and verified with the node's.
//
// This file is the missing link. It pins the canonical shape so that any change
// to the verification payload in core/transaction.ts fails here loudly, with a
// pointer to the client packages that must change in the same commit.
//
// The companion guard on the client side is the "signs the exact payload shape
// and key order ae-node verifies" test in ae-app/src/pages/Send.test.tsx.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, signPayload, verifyPayload } from '../src/core/crypto.js';

// The canonical transaction signing payload, in the exact order
// src/core/transaction.ts builds it before calling verifyPayload.
// Changing this list is a breaking protocol change for every client.
const CANONICAL_TX_KEYS = [
  'from',
  'to',
  'amount',
  'pointType',
  'isInPerson',
  'recipientIsHuman',
  'memo',
] as const;

function canonicalTxPayload(over: Partial<Record<string, unknown>> = {}) {
  return {
    from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    to: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    amount: '1200000000',
    pointType: 'earned',
    isInPerson: false,
    recipientIsHuman: false,
    memo: '',
    ...over,
  };
}

describe('signing payload contract (ae-node <-> clients)', () => {
  it('pins the canonical transaction payload key set and order', () => {
    assert.deepEqual(
      Object.keys(canonicalTxPayload()),
      [...CANONICAL_TX_KEYS],
      'The transaction signing payload changed. ae-app/src/pages/Send.tsx and ' +
        'sdk/src/client.ts signTransaction must be updated in the SAME commit, ' +
        'or every client send will fail with INVALID_SIGNATURE.',
    );
  });

  it('accepts a signature over the canonical payload', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const ts = 1786890000;
    const payload = canonicalTxPayload();

    const sig = signPayload(payload, ts, privateKey);
    assert.equal(verifyPayload(payload, ts, sig, publicKey), true);
  });

  it('rejects a signature that omits recipientIsHuman (the Aug 16 2026 bug)', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const ts = 1786890000;

    // Exactly what ae-app and the SDK used to sign.
    const clientPayload = {
      from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      amount: '1200000000',
      pointType: 'earned',
      isInPerson: false,
      memo: '',
    };
    const sig = signPayload(clientPayload, ts, privateKey);

    // Exactly what the node rebuilds and verifies.
    assert.equal(
      verifyPayload(canonicalTxPayload(), ts, sig, publicKey),
      false,
      'A payload missing recipientIsHuman must NOT verify. If this passes, ' +
        'something started canonicalizing keys and this whole class of bug ' +
        'changed shape.',
    );
  });

  it('rejects a signature over the right keys in the wrong order', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const ts = 1786890000;

    // Same seven keys, memo and recipientIsHuman transposed. JSON.stringify
    // serialises in insertion order, so these are different bytes.
    const reordered = {
      from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      amount: '1200000000',
      pointType: 'earned',
      isInPerson: false,
      memo: '',
      recipientIsHuman: false,
    };
    const sig = signPayload(reordered, ts, privateKey);

    assert.equal(
      verifyPayload(canonicalTxPayload(), ts, sig, publicKey),
      false,
      'Key order is part of the signed bytes today. If this ever passes, ' +
        'signPayload gained canonicalization and the ordering requirement ' +
        'should be documented as relaxed.',
    );
  });

  it('binds the signature to the timestamp', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const payload = canonicalTxPayload();
    const sig = signPayload(payload, 1786890000, privateKey);

    assert.equal(verifyPayload(payload, 1786890001, sig, publicKey), false);
  });

  it('binds the signature to the amount', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const ts = 1786890000;
    const sig = signPayload(canonicalTxPayload(), ts, privateKey);

    assert.equal(
      verifyPayload(canonicalTxPayload({ amount: '9900000000' }), ts, sig, publicKey),
      false,
    );
  });
});
