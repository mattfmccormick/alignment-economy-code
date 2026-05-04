// Slashing pipeline — economic consequence for Byzantine validator behavior.
//
// Equivocation (signing two different vote bodies for the same voteId,
// e.g. prevoting for block A AND block B at the same height/round) is
// the classic "provably malicious" pattern in BFT consensus. VoteSet
// already detects and records this evidence (Session 15). This module
// turns evidence into action:
//
//   1. verifyEquivocationEvidence — independent check that the two
//      votes really do constitute slashable equivocation:
//        - same voteId (kind, height, round, validator)
//        - different signed bytes (different blockHash typically)
//        - both signatures cryptographically verify against the same
//          embedded validatorPublicKey
//        - validator account / publicKey match the registered values
//
//   2. slashValidator — atomically:
//        - mark the validator inactive (prevents future block production)
//        - burn the validator's locked stake (lockedBalance → 0; the
//          stake is permanently destroyed, not refunded)
//        - audit-log the event
//
// What this module does NOT do (yet):
//
//   - Auto-detect-and-slash. Real Tendermint bakes evidence INTO blocks
//     so all validators consensus on slashing. Our implementation
//     surfaces the API and lets the caller (a future session) decide
//     when to invoke. Local-detection-and-slash is consistent enough
//     for honest networks; for Byzantine resilience, evidence-in-block
//     is the production path.
//
//   - Slash for unavailability (failing to vote). Tendermint slashes
//     this at a much smaller rate than equivocation. We only handle
//     equivocation here.
//
//   - Slash less than the full stake. Real chains often slash a fixed
//     fraction (1-5%) for equivocation. Our policy is "full burn" for
//     simplicity; a later session can add a configurable fraction.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { runTransaction } from '../../db/connection.js';
import { getAccount, updateBalance } from '../account.js';
import { recordLog } from '../transaction.js';
import { SqliteValidatorSet } from './SqliteValidatorSet.js';
import { verifyVote, type Vote } from './votes.js';
import { voteId } from './votes.js';
import type { EquivocationEvidence } from './vote-aggregator.js';

export interface VerifyEvidenceResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify that an EquivocationEvidence really constitutes slashable
 * Byzantine behavior. All of these must hold:
 *
 *   1. Same voteId (the equivocation predicate)
 *   2. Different signed bytes (otherwise it's a duplicate, not equivocation)
 *   3. Both signatures cryptographically verify
 *   4. Both votes claim the SAME validatorAccountId (otherwise different
 *      validators just happened to vote on different things — not slashable)
 *   5. Both votes claim the SAME validatorPublicKey
 *
 * Verification is INDEPENDENT of the local validator set — anyone who
 * receives the evidence can confirm it without trusting the reporter.
 * That's what makes slashing evidence portable.
 */
export function verifyEquivocationEvidence(
  evidence: EquivocationEvidence,
): VerifyEvidenceResult {
  const a = evidence.first;
  const b = evidence.second;

  if (!a || !b) return { valid: false, reason: 'missing votes in evidence' };
  if (voteId(a) !== voteId(b)) {
    return {
      valid: false,
      reason: `voteIds differ: ${voteId(a)} vs ${voteId(b)}`,
    };
  }
  if (a.signature === b.signature) {
    return {
      valid: false,
      reason: 'identical signatures — duplicate vote, not equivocation',
    };
  }
  if (a.validatorAccountId !== b.validatorAccountId) {
    return { valid: false, reason: 'different validatorAccountId' };
  }
  if (a.validatorPublicKey !== b.validatorPublicKey) {
    return { valid: false, reason: 'different validatorPublicKey' };
  }
  // Both signatures must verify. We pass replayWindowSec=0 + nowSec equal
  // to each vote's own timestamp because evidence may be old by the time
  // it's reported — the cryptographic check is what matters, not the
  // freshness window.
  if (
    !verifyVote(a, { replayWindowSec: 0, nowSec: a.timestamp })
  ) {
    return { valid: false, reason: 'first vote signature invalid' };
  }
  if (
    !verifyVote(b, { replayWindowSec: 0, nowSec: b.timestamp })
  ) {
    return { valid: false, reason: 'second vote signature invalid' };
  }
  return { valid: true };
}

export interface SlashResult {
  slashed: boolean;
  reason?: string;
  /** When slashed === true, the amount burned (the validator's stake). */
  burnedAmount?: bigint;
}

/**
 * Slash a validator for proven equivocation.
 *
 * Atomic: the validator is marked inactive AND their locked stake is
 * burned (lockedBalance -= stake) in a single DB transaction. An audit
 * log entry tagged 'court_burn' records the slash.
 *
 * Idempotent: a validator that's already inactive returns
 * { slashed: false, reason: 'already inactive' } — no double-burn.
 */
export function slashValidator(
  db: DatabaseSync,
  accountId: string,
  evidence: EquivocationEvidence,
  opts: { now?: number } = {},
): SlashResult {
  // Evidence must be valid and bind to the accountId we're slashing
  const ev = verifyEquivocationEvidence(evidence);
  if (!ev.valid) return { slashed: false, reason: ev.reason };
  if (evidence.first.validatorAccountId !== accountId) {
    return {
      slashed: false,
      reason: `evidence is for ${evidence.first.validatorAccountId}, not ${accountId}`,
    };
  }

  const validatorSet = new SqliteValidatorSet(db);
  const validator = validatorSet.findByAccountId(accountId);
  if (!validator) {
    return { slashed: false, reason: `validator not registered: ${accountId}` };
  }
  if (!validator.isActive) {
    return { slashed: false, reason: 'already inactive' };
  }
  // Defense-in-depth: the registered nodePublicKey must match the
  // publicKey on the evidence, otherwise the evidence is for a
  // different key (could happen if the validator rotated keys —
  // distinct entity, different slashing decision).
  if (validator.nodePublicKey !== evidence.first.validatorPublicKey) {
    return {
      slashed: false,
      reason: 'evidence publicKey does not match registered nodePublicKey',
    };
  }

  const account = getAccount(db, accountId);
  if (!account) {
    return { slashed: false, reason: `account vanished: ${accountId}` };
  }

  const stake = validator.stake;
  const newLocked = account.lockedBalance - stake;
  if (newLocked < 0n) {
    return {
      slashed: false,
      reason: `lockedBalance underflow during slash (stake=${stake}, locked=${account.lockedBalance})`,
    };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    updateBalance(db, accountId, 'locked_balance', newLocked);
    validatorSet.markInactive(accountId, now);
    // Audit log. 'court_burn' is the closest existing change-type for
    // "stake permanently destroyed by protocol enforcement"; a dedicated
    // 'slash' change-type can be added when the audit-log vocabulary
    // gets a refresh.
    recordLog(
      db,
      accountId,
      'court_burn',
      'earned',
      stake,
      account.lockedBalance,
      newLocked,
      `slash:${uuid()}`,
      now,
    );
  });

  return { slashed: true, burnedAmount: stake };
}
