// VRF (Verifiable Random Function) for the Tier 2 lottery.
//
// The current implementation is HmacVrfProvider — a placeholder that uses
// HMAC-SHA256(privateKey, seed) as the proof. It's deterministic (same key
// + same seed → same proof) but it has a fundamental security weakness:
// the only way to verify the proof is to recompute it, which requires the
// secret key. So a third party cannot independently audit a winning miner.
// Acceptable today because we have a single authority producing blocks.
// NOT acceptable in Phase 3 — that's where EcvrfProvider (RFC 9381 over
// Ed25519) drops in. Both implement IVRFProvider; the swap is mechanical.

import { hmacSha256 } from '../core/crypto.js';
import type { IVRFProvider, VRFProof } from '../core/consensus/IVRFProvider.js';

export class HmacVrfProvider implements IVRFProvider {
  generateProof(seed: string, secretKeyHex: string): VRFProof {
    const proof = hmacSha256(Buffer.from(secretKeyHex, 'hex'), seed);
    return { proof, value: this.proofToValue(proof) };
  }

  /**
   * HMAC-VRF "verify": regenerate from the secret and compare. The
   * publicKeyHex argument is unused for HMAC because the construction is not
   * publicly verifiable — callers wanting real third-party verifiability
   * must use EcvrfProvider. This implementation accepts the key argument so
   * the interface signature stays uniform.
   *
   * To actually call this with HMAC, callers pass the SECRET KEY as the
   * "publicKeyHex" argument. This is ugly but it's the price of using a
   * placeholder VRF behind a real-VRF-shaped interface.
   */
  verifyProof(seed: string, secretKeyHex: string, proof: string): boolean {
    const expected = hmacSha256(Buffer.from(secretKeyHex, 'hex'), seed);
    return expected === proof;
  }

  proofToValue(proof: string): bigint {
    // First 8 bytes (16 hex chars) treated as an unsigned bigint.
    return BigInt('0x' + proof.slice(0, 16));
  }
}

/** Default VRF provider for the current protocol version. Will be flipped to
 *  EcvrfProvider when ECVRF is implemented (next session). */
export const vrfProvider: IVRFProvider = new HmacVrfProvider();

// ── Back-compat shims so existing callers keep working ───────────────

export interface VRFProofLegacy {
  minerId: string;
  proof: string;
  value: bigint;
}

export function generateVRFProof(minerPrivateKeyHex: string, seed: string): string {
  return vrfProvider.generateProof(seed, minerPrivateKeyHex).proof;
}

export function proofToValue(proof: string): bigint {
  return vrfProvider.proofToValue(proof);
}

export function selectLotteryWinner(
  miners: Array<{ minerId: string; privateKeyHex: string }>,
  blockPreviousHash: string,
): { winnerId: string; proof: string } | null {
  if (miners.length === 0) return null;

  let lowestValue = BigInt('0xffffffffffffffff');
  let winnerId = '';
  let winnerProof = '';

  for (const miner of miners) {
    const { proof, value } = vrfProvider.generateProof(blockPreviousHash, miner.privateKeyHex);
    if (value < lowestValue) {
      lowestValue = value;
      winnerId = miner.minerId;
      winnerProof = proof;
    }
  }

  return { winnerId, proof: winnerProof };
}
