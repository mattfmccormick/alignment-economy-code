// Block proposer selection for Phase-3 BFT consensus.
//
// Two functions live here, sharing the same input shape but built on
// different sources of randomness:
//
//   1. selectProposer(validators, height, seed)
//      Deterministic, stake-weighted. Every node computes the same
//      proposer for the same (height, seed) — so when a follower
//      receives a block claiming to be from validator V at height H,
//      they can independently confirm "yes, V is the proposer for H."
//      Randomness comes from SHA-256(height || seed); seed is the
//      previous block hash (or any agreed-upon per-height value).
//      Family: Tendermint / Cosmos-SDK style.
//
//   2. selectProposerByVrf(validators, vrfOutputs)
//      Picks whichever validator submitted the lowest VRF value.
//      Inputs are gathered from the network — each validator computes
//      VRF_sign(height || seed, vrf_secret_key) privately and broadcasts
//      the proof + value. The proposer is whoever's value is smallest.
//      Family: Algorand-style commit-reveal. Adds unpredictability —
//      an outside observer can't predict the next proposer because
//      VRF outputs aren't computable without the secret key.
//
// Session 13 ships both. The deterministic path is what BFTConsensus
// will use first (it's simpler and Tendermint-correct). The VRF path is
// pre-built so a later session can swap in commit-reveal without
// having to redesign the proposer-selection layer.

import { sha256 } from '../crypto.js';
import type { ValidatorInfo } from './IValidatorSet.js';

/**
 * Deterministic stake-weighted proposer selection.
 *
 * Given a list of active validators, a block height, a round number, and a
 * per-height seed (typically the previous block's hash), returns the
 * validator chosen to propose the block. Same inputs always return the
 * same validator.
 *
 * Probability of selection at any individual (height, round) is proportional
 * to a validator's stake:
 *   P(V_i) = V_i.stake / totalActiveStake
 *
 * Why round matters: when a round NIL-times-out (proposer offline, partition,
 * etc.) the round controller advances to round+1 and re-selects. If the
 * round didn't influence selection, we'd just re-pick the same proposer and
 * loop forever. Including round in the hash input rotates the proposer on
 * every advance.
 *
 * Returns null only when the validator list is empty.
 */
export function selectProposer(
  validators: ValidatorInfo[],
  height: number,
  seed: string,
  round: number = 0,
): ValidatorInfo | null {
  if (validators.length === 0) return null;

  // Sort by accountId so every node's iteration order matches.
  const sorted = [...validators].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

  let totalStake = 0n;
  for (const v of sorted) {
    if (v.stake < 0n) {
      throw new Error(`Validator ${v.accountId} has negative stake; cannot select proposer`);
    }
    totalStake += v.stake;
  }
  if (totalStake === 0n) {
    // Degenerate case: every validator has zero stake. Fall back to
    // round-robin (rotating by round to give every NIL recovery a fresh
    // proposer).
    return sorted[(height + round) % sorted.length];
  }

  // Hash (height, round, seed) → 256-bit value → modulo totalStake.
  // SHA-256 is uniform enough that mod-bias on the high bits is negligible
  // for any realistic totalStake.
  const hashHex = sha256(`${height}|${round}|${seed}`);
  const hashBig = BigInt('0x' + hashHex);
  const target = hashBig % totalStake;

  // Walk the cumulative stake and pick the validator whose range covers
  // `target`.
  let acc = 0n;
  for (const v of sorted) {
    acc += v.stake;
    if (target < acc) return v;
  }
  // Shouldn't reach here because target < totalStake = acc-final, but
  // defensive fallback to last validator.
  return sorted[sorted.length - 1];
}

/**
 * Pick the proposer based on submitted VRF values. The validator whose VRF
 * output is the smallest bigint wins.
 *
 * `vrfOutputs` maps accountId → VRF value (interpreted as a bigint, like
 * the output of Ed25519VrfProvider.proofToValue). Validators not present
 * in the map are skipped — that's how the protocol handles a validator
 * who failed to submit a VRF for this round (they don't compete).
 *
 * Returns null when no eligible validator submitted a value.
 *
 * Ties are broken by accountId ASCII-ascending (deterministic, but should
 * never happen with cryptographic VRF outputs).
 */
export function selectProposerByVrf(
  validators: ValidatorInfo[],
  vrfOutputs: ReadonlyMap<string, bigint>,
): ValidatorInfo | null {
  let winner: ValidatorInfo | null = null;
  let winnerValue: bigint | null = null;

  for (const v of validators) {
    const value = vrfOutputs.get(v.accountId);
    if (value === undefined) continue;
    if (
      winnerValue === null ||
      value < winnerValue ||
      (value === winnerValue && winner !== null && v.accountId < winner.accountId)
    ) {
      winner = v;
      winnerValue = value;
    }
  }
  return winner;
}
