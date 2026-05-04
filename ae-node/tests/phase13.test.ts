// Phase 13: Ed25519 VRF correctness tests.
//
// Verifies the security properties our lottery depends on:
//   1. Determinism — same (key, seed) always gives the same proof + value.
//   2. Public verifiability — anyone with the public key can verify.
//   3. Non-forgeability — wrong key, wrong seed, or tampered proof fail.
//   4. Distinct keys give distinct values for the same seed.
//   5. Distinct seeds give distinct values for the same key.
//   6. Value distribution — many random keys, same seed, no two collide.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ed25519VrfProvider } from '../src/core/consensus/Ed25519VrfProvider.js';

describe('Phase 13: Ed25519 VRF', () => {
  const vrf = new Ed25519VrfProvider();

  it('produces deterministic proofs for the same (key, seed)', () => {
    const { secretKey } = Ed25519VrfProvider.generateKeyPair();
    const seed = 'block-hash-deadbeef';

    const a = vrf.generateProof(seed, secretKey);
    const b = vrf.generateProof(seed, secretKey);

    assert.equal(a.proof, b.proof, 'Same (key, seed) must yield identical proofs');
    assert.equal(a.value, b.value, 'Same (key, seed) must yield identical values');
  });

  it('verifies a valid proof against the matching public key', () => {
    const { publicKey, secretKey } = Ed25519VrfProvider.generateKeyPair();
    const seed = 'block-hash-cafe';
    const { proof } = vrf.generateProof(seed, secretKey);

    assert.equal(vrf.verifyProof(seed, publicKey, proof), true);
  });

  it('rejects a proof against a different public key', () => {
    const a = Ed25519VrfProvider.generateKeyPair();
    const b = Ed25519VrfProvider.generateKeyPair();
    const seed = 'block-hash-1234';
    const { proof } = vrf.generateProof(seed, a.secretKey);

    assert.equal(vrf.verifyProof(seed, b.publicKey, proof), false);
  });

  it('rejects a proof against a different seed', () => {
    const { publicKey, secretKey } = Ed25519VrfProvider.generateKeyPair();
    const { proof } = vrf.generateProof('seed-1', secretKey);

    assert.equal(vrf.verifyProof('seed-2', publicKey, proof), false);
  });

  it('rejects a tampered proof', () => {
    const { publicKey, secretKey } = Ed25519VrfProvider.generateKeyPair();
    const seed = 'block-hash-tamper';
    const { proof } = vrf.generateProof(seed, secretKey);

    // Flip the last byte of the proof
    const tampered =
      proof.slice(0, proof.length - 2) +
      ((parseInt(proof.slice(-2), 16) ^ 0x01).toString(16).padStart(2, '0'));

    assert.equal(vrf.verifyProof(seed, publicKey, tampered), false);
  });

  it('derivePublicKey from secretKey matches generateKeyPair', () => {
    const { publicKey, secretKey } = Ed25519VrfProvider.generateKeyPair();
    assert.equal(Ed25519VrfProvider.derivePublicKey(secretKey), publicKey);
  });

  it('distinct keys produce distinct values for the same seed', () => {
    const seed = 'shared-seed';
    const values = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { secretKey } = Ed25519VrfProvider.generateKeyPair();
      const { value } = vrf.generateProof(seed, secretKey);
      values.add(value.toString());
    }
    // 50 distinct keys all producing the same 64-bit value would be
    // overwhelmingly unlikely (~50^2 / 2^64 collision probability).
    assert.equal(values.size, 50, 'Different keys should produce different VRF values');
  });

  it('distinct seeds produce distinct values for the same key', () => {
    const { secretKey } = Ed25519VrfProvider.generateKeyPair();
    const values = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { value } = vrf.generateProof(`seed-${i}`, secretKey);
      values.add(value.toString());
    }
    assert.equal(values.size, 50, 'Same key with different seeds should produce different values');
  });

  it('rejects malformed inputs gracefully (no crashes)', () => {
    const { publicKey } = Ed25519VrfProvider.generateKeyPair();

    // Wrong-length proof
    assert.equal(vrf.verifyProof('seed', publicKey, 'cafebabe'), false);
    // Non-hex proof
    assert.equal(vrf.verifyProof('seed', publicKey, 'not-hex-at-all'), false);
    // Wrong-length public key
    const validProof =
      vrf.generateProof('seed', Ed25519VrfProvider.generateKeyPair().secretKey).proof;
    assert.equal(vrf.verifyProof('seed', 'cafebabe', validProof), false);
  });

  it('value is uniformly distributed across the 64-bit range', () => {
    // Smoke test: with 200 random (key, seed) pairs, the values should span
    // a meaningful fraction of the 64-bit range. If proofToValue collapsed
    // to a small space, this would fail.
    const seenHighBits = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const { secretKey } = Ed25519VrfProvider.generateKeyPair();
      const { value } = vrf.generateProof(`seed-${i}`, secretKey);
      // Top 4 bits of the 64-bit value — should see most of 16 possible
      // values across 200 samples.
      const high = Number((value >> 60n) & 0xfn);
      seenHighBits.add(high);
    }
    assert.ok(
      seenHighBits.size >= 12,
      `Expected to see at least 12 of 16 high-bit nibbles; saw ${seenHighBits.size}`,
    );
  });
});
