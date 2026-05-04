// Ed25519-based publicly-verifiable VRF.
//
// ─── What this is ──────────────────────────────────────────────────────
//
// Construction: VRF.proof = Ed25519_Sign(seed, secretKey).
//               VRF.value = SHA-512(proof) interpreted as bigint.
//               Verify   = Ed25519_Verify(seed, publicKey, proof).
//
// Properties this gives us:
//   ✓ Deterministic. Ed25519 is deterministic per RFC 8032 — same key + same
//     seed always produce the same signature, so same proof, same value.
//   ✓ Publicly verifiable. Anyone with the holder's Ed25519 public key can
//     check Ed25519_Verify(seed, pk, proof). This is the security property
//     the HmacVrfProvider lacks.
//   ✓ Non-forgeable. Producing a valid signature without the secret key is
//     equivalent to forging Ed25519, which is computationally infeasible.
//   ✓ Pseudorandom output. The signature is a 64-byte string; SHA-512 of it
//     is uniformly distributed in {0, 1}^512, so the lottery `value` is
//     uniformly distributed and unbiased per (key, seed).
//
// ─── What this is NOT ──────────────────────────────────────────────────
//
// This is NOT RFC 9381 ECVRF-EDWARDS25519-SHA512-ELL2. RFC 9381 has stronger
// formal properties — specifically a "uniqueness" guarantee that the same
// (key, message) input cannot have two valid proofs even with malicious key
// construction. Ed25519 signatures are deterministic in normal use but the
// formal uniqueness analysis is weaker, and the standard ECVRF security
// proofs do not apply directly.
//
// For the Alignment Economy's Tier 2 lottery — "pick a winning miner per
// block from a small honest set" — the threat model is "a participating
// miner shouldn't be able to bias their probability of winning." This
// construction satisfies that. Migrating to RFC 9381 ECVRF later is a
// protocol upgrade (the proof byte layout and value derivation change).
//
// ─── A note on keys ────────────────────────────────────────────────────
//
// Account/transaction keys in the AE are ML-DSA-65 (post-quantum). This VRF
// uses Ed25519. That means a miner who wants to participate in the lottery
// needs a SEPARATE Ed25519 keypair registered alongside their account. The
// integration of "miner registers VRF key on chain" lives in the validator
// registration module (Tier 2 work). This file just provides the VRF
// primitives.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import type { IVRFProvider, VRFProof } from './IVRFProvider.js';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex string length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class Ed25519VrfProvider implements IVRFProvider {
  /** Generate a fresh Ed25519 keypair for VRF use. Both keys are 32 bytes. */
  static generateKeyPair(): { publicKey: string; secretKey: string } {
    const secretKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(secretKey);
    return {
      publicKey: bytesToHex(publicKey),
      secretKey: bytesToHex(secretKey),
    };
  }

  /** Derive an Ed25519 public key from a secret key (32 bytes). */
  static derivePublicKey(secretKeyHex: string): string {
    return bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex)));
  }

  generateProof(seed: string, secretKeyHex: string): VRFProof {
    const sk = hexToBytes(secretKeyHex);
    if (sk.length !== 32) {
      throw new Error(`Ed25519 secret key must be 32 bytes (64 hex chars), got ${sk.length} bytes`);
    }
    const message = new TextEncoder().encode(seed);
    const sig = ed25519.sign(message, sk);
    const proof = bytesToHex(sig);
    return { proof, value: this.proofToValue(proof) };
  }

  verifyProof(seed: string, publicKeyHex: string, proof: string): boolean {
    try {
      const pk = hexToBytes(publicKeyHex);
      if (pk.length !== 32) return false;
      const sig = hexToBytes(proof);
      if (sig.length !== 64) return false;
      const message = new TextEncoder().encode(seed);
      return ed25519.verify(sig, message, pk);
    } catch {
      return false;
    }
  }

  proofToValue(proof: string): bigint {
    // Hash the full 64-byte signature with SHA-512, take the first 8 bytes
    // as a uniformly-distributed unsigned 64-bit value.
    const sigBytes = hexToBytes(proof);
    const digest = sha512(sigBytes);
    let value = 0n;
    for (let i = 0; i < 8; i++) {
      value = (value << 8n) | BigInt(digest[i]);
    }
    return value;
  }
}
