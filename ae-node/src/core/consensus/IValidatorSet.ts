// Validator set interface — the set of accounts authorized to propose and
// vote on blocks under Phase-3 BFT consensus.
//
// Why this exists today (Phase 1, AuthorityConsensus): laying the storage
// shape down now means BFTConsensus drops in without having to retrofit a
// data model. The single Phase-1 authority can register itself as the only
// validator, and AuthorityConsensus.validatorSet() can either ignore this
// table (current behavior) or read from it (future).
//
// Why three keys per validator:
//   - accountId       : their AE account (ML-DSA-65). Identifies them
//                       economically — what they staked, where rewards
//                       and slashing apply.
//   - nodePublicKey   : Ed25519 P2P key. Identifies them on the wire
//                       (signed handshakes + signed gossip from Session 8).
//   - vrfPublicKey    : Ed25519 VRF key (Ed25519VrfProvider). Used by the
//                       lottery / proposer selection. Distinct from the
//                       node key so a validator can rotate one without
//                       the other.
//
// Stake semantics: when registering, the validator locks `stake` from
// their account's earned balance into lockedBalance. On deregister the
// stake unlocks. Slashing (forfeiting stake on misbehavior) is a separate
// system and lives behind ICourtStore — when a court rules against a
// validator, the lock is converted into a burn.

/** A validator's record. Stake is bigint in fixed precision. */
export interface ValidatorInfo {
  accountId: string;
  nodePublicKey: string;
  vrfPublicKey: string;
  stake: bigint;
  isActive: boolean;
  registeredAt: number;
  deregisteredAt: number | null;
}

/** Inputs to register a new validator. */
export interface ValidatorRegistration {
  accountId: string;
  nodePublicKey: string;
  vrfPublicKey: string;
  stake: bigint;
  registeredAt: number;
}

export interface IValidatorSet {
  /** Insert a fresh validator record. Throws if accountId already registered. */
  insert(info: ValidatorRegistration): void;

  /** Mark a validator inactive at the given timestamp. */
  markInactive(accountId: string, deregisteredAt: number): void;

  /** Reactivate a previously deregistered validator. */
  markActive(accountId: string): void;

  /** Look up by account id. Returns null if no record exists. */
  findByAccountId(accountId: string): ValidatorInfo | null;

  /** Look up by node-layer publicKey. Used by validateBlockProducer. */
  findByNodePublicKey(publicKey: string): ValidatorInfo | null;

  /** Every active validator, sorted ascending by accountId for determinism. */
  listActive(): ValidatorInfo[];

  /** Every record (active + deregistered), for audit / observability. */
  listAll(): ValidatorInfo[];

  /** Sum of stake across active validators (used by proposer selection / quorum). */
  totalActiveStake(): bigint;

  /**
   * Quorum threshold for BFT-style 2/3+ consensus over the active set.
   *
   *   quorum(N) = floor(2N/3) + 1
   *
   * For N=1 → 1, N=4 → 3, N=10 → 7. This is the count, not the stake-
   * weighted threshold; stake-weighted quorum can replace this later
   * without changing the interface shape if we add a `mode` parameter.
   */
  quorumCount(): number;
}
