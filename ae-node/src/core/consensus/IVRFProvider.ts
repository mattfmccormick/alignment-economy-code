// Verifiable Random Function provider.
//
// A VRF lets a participant generate a random value tied to (seed, their key)
// such that anyone can verify the value came from that key without learning
// the key. The Alignment Economy uses it to pick the lottery winner among
// Tier 2 miners every block — the winner gets 60% of the Tier 2 fee pool.
//
// Two implementations live behind this interface:
//   - HmacVrfProvider (current placeholder): generates HMAC-SHA256(privateKey, seed)
//     as the "proof". Cheap and deterministic, BUT verifying it requires the
//     private key — meaning only the prover can verify. This is acceptable
//     today because we only have one authority producing blocks. It is NOT
//     acceptable in Phase 3 because a malicious validator could fabricate a
//     proof for a key they don't hold.
//   - EcvrfProvider (Phase 3, future): real RFC 9381 ECVRF over Ed25519.
//     The prover signs with their secret key; anyone with the public key
//     can verify. This closes the only-prover-can-verify hole.
//
// IMPORTANT: when we swap from HMAC to ECVRF, the proof byte layout changes,
// so historical lottery results from before the swap can't be re-verified.
// That migration belongs in a protocol upgrade, not a hot swap.

export interface VRFProof {
  /** Hex-encoded proof bytes. Format depends on the implementation. */
  proof: string;
  /** Numeric value derived from the proof. Used to compare and pick a winner. */
  value: bigint;
}

export interface IVRFProvider {
  /**
   * Generate a VRF proof for (seed, secret).
   * @param seed   Bytes the network agreed on (typically previous block hash).
   * @param secretKeyHex  Hex-encoded private key of the prover.
   */
  generateProof(seed: string, secretKeyHex: string): VRFProof;

  /**
   * Verify a proof was produced by the holder of `publicKeyHex` for `seed`.
   * Returns false if the proof is malformed, doesn't match the public key,
   * or wasn't generated for the given seed.
   *
   * NOTE: HmacVrfProvider's implementation requires `secretKeyHex` rather
   * than the public key — it cannot verify against a public key alone.
   * Callers that need real third-party verifiability must use EcvrfProvider.
   */
  verifyProof(seed: string, publicKeyHex: string, proof: string): boolean;

  /**
   * Reduce a proof to a numeric value. Used for "lowest value wins" lottery.
   * Two valid proofs from different keys must produce different values
   * (with overwhelming probability) — i.e., this must be approximately
   * uniform over the value space.
   */
  proofToValue(proof: string): bigint;
}
