// SnapshotValidatorSet — IValidatorSet adapter over a frozen list of
// ValidatorInfo records. Used to verify a HISTORICAL CommitCertificate
// against the validator set as it was at the time of commit, not the
// (possibly very different) current set.
//
// Why this matters: validators get slashed (Session 35) or deregister.
// A precommit signed by validator V at height 100 must still verify when
// a fresh node syncs through height 100 — even if V is no longer active
// at the local node's "current" height. The fix is to verify cert(H)
// against snapshot(H), not the live set.
//
// All mutator methods (insert, markActive, markInactive) throw — these
// snapshots are immutable. The set lives only long enough to verify
// one historical cert.

import type {
  IValidatorSet,
  ValidatorInfo,
  ValidatorRegistration,
} from './IValidatorSet.js';

export class SnapshotValidatorSet implements IValidatorSet {
  private readonly byAccountId: Map<string, ValidatorInfo>;
  private readonly byNodePublicKey: Map<string, ValidatorInfo>;
  private readonly all: ValidatorInfo[];

  constructor(validators: ValidatorInfo[]) {
    // Defensive copy + frozen — snapshots are immutable.
    this.all = validators.map((v) => ({ ...v }));
    this.byAccountId = new Map();
    this.byNodePublicKey = new Map();
    for (const v of this.all) {
      this.byAccountId.set(v.accountId, v);
      this.byNodePublicKey.set(v.nodePublicKey, v);
    }
  }

  insert(_info: ValidatorRegistration): void {
    throw new Error('SnapshotValidatorSet is immutable');
  }
  markInactive(_accountId: string, _deregisteredAt: number): void {
    throw new Error('SnapshotValidatorSet is immutable');
  }
  markActive(_accountId: string): void {
    throw new Error('SnapshotValidatorSet is immutable');
  }

  findByAccountId(accountId: string): ValidatorInfo | null {
    return this.byAccountId.get(accountId) ?? null;
  }

  findByNodePublicKey(publicKey: string): ValidatorInfo | null {
    return this.byNodePublicKey.get(publicKey) ?? null;
  }

  listActive(): ValidatorInfo[] {
    return this.all
      .filter((v) => v.isActive)
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }

  listAll(): ValidatorInfo[] {
    return [...this.all].sort((a, b) =>
      a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
    );
  }

  totalActiveStake(): bigint {
    let total = 0n;
    for (const v of this.all) if (v.isActive) total += v.stake;
    return total;
  }

  /** floor(2N/3) + 1 over the active set in this snapshot. */
  quorumCount(): number {
    let n = 0;
    for (const v of this.all) if (v.isActive) n++;
    if (n === 0) return 0;
    return Math.floor((2 * n) / 3) + 1;
  }
}
