// Validator registration: lock stake, store keys, mark active.
//
// This is the protocol-level entry point for "an account wants to become a
// validator." It:
//
//   1. Verifies the account exists, is active, and has enough earnedBalance
//      to cover the stake.
//   2. Validates the supplied keys (correct hex length for Ed25519 32-byte
//      public keys).
//   3. Atomically:
//        - debits the stake from earnedBalance
//        - credits it to lockedBalance
//        - inserts a row into `validators`
//        - writes a transaction_log entry tagged 'vouch_lock' (re-using the
//          existing change-type vocabulary; we may add a dedicated
//          'validator_stake_lock' in a follow-up if the audit log gets
//          confused).
//
// Deregister reverses the stake lock and marks the validator inactive. It
// does NOT delete the row — keeping deregistered validators in the table
// preserves audit history and lets a future re-register reuse the same
// keys without a UNIQUE collision (when re-activating, mark_active is used
// instead of insert).

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { runTransaction } from '../../db/connection.js';
import { getAccount, updateBalance } from '../account.js';
import { recordLog } from '../transaction.js';
import { SqliteValidatorSet } from './SqliteValidatorSet.js';
import type { IValidatorSet, ValidatorInfo } from './IValidatorSet.js';

export const MIN_VALIDATOR_STAKE: bigint = 100_00n; // 100.00 points (display * 100)

function isHex32(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

export interface RegisterValidatorInput {
  /** Account ID staking. Must exist and be active. */
  accountId: string;
  /** Hex Ed25519 P2P-layer publicKey (32 bytes / 64 hex). */
  nodePublicKey: string;
  /** Hex Ed25519 VRF publicKey (32 bytes / 64 hex). */
  vrfPublicKey: string;
  /** How many fixed-precision points to lock as stake. >= MIN_VALIDATOR_STAKE. */
  stake: bigint;
  /** Override the timestamp (for tests / deterministic replays). */
  now?: number;
}

/**
 * Register an account as a validator. Returns the freshly-created
 * ValidatorInfo. Throws if any precondition fails — caller decides how to
 * surface the error to the user.
 */
export function registerValidator(
  db: DatabaseSync,
  input: RegisterValidatorInput,
): ValidatorInfo {
  if (!isHex32(input.nodePublicKey)) {
    throw new Error('nodePublicKey must be 32 bytes (64 hex chars)');
  }
  if (!isHex32(input.vrfPublicKey)) {
    throw new Error('vrfPublicKey must be 32 bytes (64 hex chars)');
  }
  if (input.stake < MIN_VALIDATOR_STAKE) {
    throw new Error(
      `Validator stake ${input.stake} below minimum ${MIN_VALIDATOR_STAKE}`,
    );
  }

  const account = getAccount(db, input.accountId);
  if (!account) throw new Error(`Account not found: ${input.accountId}`);
  if (!account.isActive) throw new Error(`Account is inactive: ${input.accountId}`);
  if (account.earnedBalance < input.stake) {
    throw new Error(
      `Insufficient earned balance to stake: has ${account.earnedBalance}, needs ${input.stake}`,
    );
  }

  const validatorSet: IValidatorSet = new SqliteValidatorSet(db);
  if (validatorSet.findByAccountId(input.accountId)) {
    throw new Error(`Account ${input.accountId} is already a registered validator`);
  }
  if (validatorSet.findByNodePublicKey(input.nodePublicKey)) {
    throw new Error(`nodePublicKey already used by another validator`);
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const newEarned = account.earnedBalance - input.stake;
  const newLocked = account.lockedBalance + input.stake;

  runTransaction(db, () => {
    updateBalance(db, input.accountId, 'earned_balance', newEarned);
    updateBalance(db, input.accountId, 'locked_balance', newLocked);
    validatorSet.insert({
      accountId: input.accountId,
      nodePublicKey: input.nodePublicKey,
      vrfPublicKey: input.vrfPublicKey,
      stake: input.stake,
      registeredAt: now,
    });
    // Audit-log the stake lock. We re-use 'vouch_lock' change-type because
    // the audit-log vocabulary already covers "earned points being locked
    // by a protocol-level action." A dedicated change-type can be added
    // once the audit-log surface is reviewed for clarity.
    recordLog(
      db,
      input.accountId,
      'vouch_lock',
      'earned',
      input.stake,
      account.earnedBalance,
      newEarned,
      `validator-register:${uuid()}`,
      now,
    );
  });

  const fresh = validatorSet.findByAccountId(input.accountId);
  if (!fresh) throw new Error('Validator registration succeeded but row not found (race?)');
  return fresh;
}

export interface DeregisterValidatorInput {
  accountId: string;
  /** Override the timestamp (for tests). */
  now?: number;
}

/**
 * Deregister a validator. Unlocks their stake back to earnedBalance and
 * marks the validator row inactive. Throws if the account isn't a
 * currently-active validator.
 */
export function deregisterValidator(
  db: DatabaseSync,
  input: DeregisterValidatorInput,
): void {
  const validatorSet: IValidatorSet = new SqliteValidatorSet(db);
  const validator = validatorSet.findByAccountId(input.accountId);
  if (!validator) throw new Error(`Account is not a validator: ${input.accountId}`);
  if (!validator.isActive) throw new Error(`Validator is already deregistered: ${input.accountId}`);

  const account = getAccount(db, input.accountId);
  if (!account) throw new Error(`Account vanished: ${input.accountId}`);

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const newEarned = account.earnedBalance + validator.stake;
  const newLocked = account.lockedBalance - validator.stake;

  if (newLocked < 0n) {
    throw new Error(
      `Locked balance underflow during deregister (stake=${validator.stake}, locked=${account.lockedBalance})`,
    );
  }

  runTransaction(db, () => {
    updateBalance(db, input.accountId, 'earned_balance', newEarned);
    updateBalance(db, input.accountId, 'locked_balance', newLocked);
    validatorSet.markInactive(input.accountId, now);
    recordLog(
      db,
      input.accountId,
      'vouch_unlock',
      'earned',
      validator.stake,
      account.earnedBalance,
      newEarned,
      `validator-deregister:${uuid()}`,
      now,
    );
  });
}
