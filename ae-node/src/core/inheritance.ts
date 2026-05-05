// Inheritance / dead-man-switch.
//
// Whitepaper §10: when an account holder loses access to their key (or
// dies), their balance otherwise sits in the rebase target forever and
// dilutes everyone else. Inheritance is the protocol's answer: the owner
// configures M-of-N beneficiaries plus an inactivity threshold; once the
// account has been idle past the threshold, beneficiaries can co-sign
// a claim that drains the account into their own.
//
// Key design choices:
//   - Threshold (M-of-N) signing prevents a single beneficiary from
//     stealing the inheritance unilaterally.
//   - The inactivity clock starts at lastActivityAt (set on every
//     outbound transaction; null until the first send). A brand-new
//     account that has set inheritance but never sent CAN'T be claimed
//     yet — the clock hasn't started.
//   - Minimum deadManSwitchDays = 30 to prevent abuse via short timers
//     (e.g. configuring 1-day timeout to claim someone else's account
//     after they don't sign for a day).
//   - Drain semantics: claimed earned balance splits evenly among the
//     beneficiaries who actually signed the claim, not all listed
//     beneficiaries. Non-signers don't get a cut. Locked balance (vouch
//     stakes) stays locked — those resolve through court / withdrawal
//     pathways.
//   - The dead account is deactivated after a successful claim so it
//     stops appearing in rebase / daily mint / etc.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { verifyPayload } from './crypto.js';
import { runTransaction } from '../db/connection.js';
import { accountStore, getAccount, updateBalance, deactivateAccount } from './account.js';
import { recordLog } from './transaction.js';
import type { AccountInheritance } from './types.js';

const MIN_DEAD_MAN_SWITCH_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

export class InheritanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'InheritanceError';
  }
}

/**
 * Configure (or update) the inheritance plan on an account. Validates
 * that beneficiaries exist, threshold is in [1, beneficiaries.length],
 * deadManSwitchDays >= MIN_DEAD_MAN_SWITCH_DAYS, and that the owner is
 * not their own beneficiary (would defeat the recovery purpose).
 *
 * Idempotent: calling again with a new config replaces the old one.
 * Pass null to clear.
 */
export function setInheritance(
  db: DatabaseSync,
  accountId: string,
  config: { beneficiaries: string[]; threshold: number; deadManSwitchDays: number } | null,
  now: number = Math.floor(Date.now() / 1000),
): void {
  const store = accountStore(db);
  const owner = store.findById(accountId);
  if (!owner) throw new InheritanceError('OWNER_NOT_FOUND', `Owner account not found: ${accountId}`);

  if (config === null) {
    store.setInheritance(accountId, null);
    return;
  }

  const beneficiaries = config.beneficiaries.filter((b) => b && typeof b === 'string');
  const seen = new Set<string>();
  for (const b of beneficiaries) {
    if (b === accountId) {
      throw new InheritanceError('SELF_BENEFICIARY', 'Owner cannot be their own beneficiary');
    }
    if (seen.has(b)) {
      throw new InheritanceError('DUPLICATE_BENEFICIARY', `Duplicate beneficiary: ${b}`);
    }
    seen.add(b);
    if (!store.findById(b)) {
      throw new InheritanceError('BENEFICIARY_NOT_FOUND', `Beneficiary account not found: ${b}`);
    }
  }
  if (beneficiaries.length === 0) {
    throw new InheritanceError('NO_BENEFICIARIES', 'At least one beneficiary required');
  }
  if (config.threshold < 1 || config.threshold > beneficiaries.length) {
    throw new InheritanceError('BAD_THRESHOLD', `Threshold ${config.threshold} not in [1, ${beneficiaries.length}]`);
  }
  if (config.deadManSwitchDays < MIN_DEAD_MAN_SWITCH_DAYS) {
    throw new InheritanceError('DAYS_TOO_LOW', `deadManSwitchDays must be >= ${MIN_DEAD_MAN_SWITCH_DAYS}`);
  }

  const stored: AccountInheritance = {
    beneficiaries,
    threshold: config.threshold,
    deadManSwitchDays: config.deadManSwitchDays,
    configuredAt: now,
  };
  store.setInheritance(accountId, stored);
}

export interface InheritanceClaimSignature {
  beneficiaryId: string;
  /** Signature over `{action:'claim_inheritance', deceasedId}` + timestamp. */
  signature: string;
}

export interface InheritanceClaimResult {
  totalDistributed: bigint;
  perSigner: bigint;
  signers: string[];
  txReferenceId: string;
}

/**
 * Execute a claim against an account whose dead-man-switch has armed.
 * Verifies:
 *   - Inheritance is configured
 *   - lastActivityAt + deadManSwitchDays have passed
 *   - At least `threshold` distinct beneficiaries signed
 *   - Each signature verifies against that beneficiary's publicKey
 *
 * Drains earnedBalance evenly among the SIGNERS (not all beneficiaries),
 * deactivates the deceased account, records audit entries.
 */
export function claimInheritance(
  db: DatabaseSync,
  deceasedId: string,
  timestamp: number,
  signatures: InheritanceClaimSignature[],
  now: number = Math.floor(Date.now() / 1000),
): InheritanceClaimResult {
  const deceased = getAccount(db, deceasedId);
  if (!deceased) throw new InheritanceError('DECEASED_NOT_FOUND', `Deceased account not found: ${deceasedId}`);
  if (!deceased.isActive) throw new InheritanceError('ALREADY_INACTIVE', 'Account already inactive');
  if (!deceased.inheritance) throw new InheritanceError('NO_INHERITANCE', 'No inheritance configured on this account');

  const cfg = deceased.inheritance;

  // Dead-man-switch check. Owner with no recorded activity at all has not
  // armed the switch yet — be conservative and require at least one
  // outbound action before the switch can fire. (Otherwise a brand-new
  // account configured at t0 could be claimed at t0+deadManSwitchDays
  // even if the owner was just slow to come back.)
  if (deceased.lastActivityAt === null) {
    throw new InheritanceError('NEVER_ACTIVE', 'Owner has never taken an outbound action; dead-man-switch is not armed');
  }
  const elapsed = now - deceased.lastActivityAt;
  const requiredSec = cfg.deadManSwitchDays * SECONDS_PER_DAY;
  if (elapsed < requiredSec) {
    throw new InheritanceError(
      'DEAD_MAN_SWITCH_NOT_ARMED',
      `Account active ${elapsed}s ago; dead-man-switch arms after ${requiredSec}s`,
    );
  }

  // Verify each signature against the canonical claim payload. The
  // signed bytes are `{action:'claim_inheritance', deceasedId}` plus
  // the timestamp argument, mirroring the verifyPayload contract used
  // elsewhere in the protocol.
  const payload = { action: 'claim_inheritance' as const, deceasedId };
  const validSigners = new Set<string>();
  for (const entry of signatures) {
    if (!cfg.beneficiaries.includes(entry.beneficiaryId)) {
      // Not a configured beneficiary; skip silently. We don't reject the
      // whole claim because future versions may allow third-party witness
      // signatures; for now they just don't count toward the threshold.
      continue;
    }
    if (validSigners.has(entry.beneficiaryId)) continue; // dedupe
    const beneficiary = getAccount(db, entry.beneficiaryId);
    if (!beneficiary || !beneficiary.isActive) continue;
    const ok = verifyPayload(payload, timestamp, entry.signature, beneficiary.publicKey);
    if (ok) validSigners.add(entry.beneficiaryId);
  }

  if (validSigners.size < cfg.threshold) {
    throw new InheritanceError(
      'INSUFFICIENT_SIGNATURES',
      `Got ${validSigners.size} valid signatures; need ${cfg.threshold}`,
    );
  }

  const total = deceased.earnedBalance;
  if (total <= 0n) {
    // Even with zero balance, deactivate the account so it stops being
    // included in rebase / mint. The signers got nothing but the lost-key
    // pollution problem is resolved.
    runTransaction(db, () => {
      deactivateAccount(db, deceasedId);
    });
    return { totalDistributed: 0n, perSigner: 0n, signers: [...validSigners], txReferenceId: uuid() };
  }

  const signerList = [...validSigners];
  const perSigner = total / BigInt(signerList.length);
  const remainder = total - perSigner * BigInt(signerList.length);
  const referenceId = uuid();

  runTransaction(db, () => {
    // Drain deceased.
    const beforeBal = deceased.earnedBalance;
    updateBalance(db, deceasedId, 'earned_balance', 0n);
    recordLog(
      db,
      deceasedId,
      'tx_send',
      'earned',
      total,
      beforeBal,
      0n,
      referenceId,
      now,
    );

    // Credit each signer their slice. Remainder (from integer division)
    // goes to the first signer to keep the math conservative — matters
    // only for tiny dust amounts.
    for (let i = 0; i < signerList.length; i++) {
      const id = signerList[i];
      const acct = getAccount(db, id)!;
      const slice = perSigner + (i === 0 ? remainder : 0n);
      const newBal = acct.earnedBalance + slice;
      updateBalance(db, id, 'earned_balance', newBal);
      recordLog(db, id, 'tx_receive', 'earned', slice, acct.earnedBalance, newBal, referenceId, now);
    }

    deactivateAccount(db, deceasedId);
  });

  return {
    totalDistributed: total,
    perSigner,
    signers: signerList,
    txReferenceId: referenceId,
  };
}

export { MIN_DEAD_MAN_SWITCH_DAYS };
