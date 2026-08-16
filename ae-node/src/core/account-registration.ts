// Account registrations that ride a block.
//
// Why this exists
// ---------------
// Accounts started life as a purely local row: `createAccount` was reachable
// only from POST /accounts and the seed script, and both did a plain INSERT
// with no gossip, no mempool, and no transaction type. An account therefore
// existed only on the node whose API created it, and every other validator
// threw `Replay: sender account not found` on the first block carrying one of
// its transactions.
//
// Gossip (`new_account`) closed the live case: a node that is online when an
// account is created learns about it within a round trip, long before anyone
// can type a send. It did not close the offline case. A node that is down at
// that moment and later catches up by syncing blocks still has no row, because
// ChainSync ships blocks and certs only — so it fail-stops on the first block
// that references the account.
//
// This module closes it properly, by mirroring exactly what validator changes
// already do (see ./consensus/validator-change.ts): registrations queue
// locally, the proposer drains them into the block it builds, the set is
// folded into the block hash so it cannot be tampered with or reordered, and
// every node — live or catching up months later — applies them from the block
// itself.
//
// Ordering note: registrations apply BEFORE the block's transactions. An
// account registered in block N starts at zero balance, so within that same
// block it can only receive — and receiving requires its row to exist first.

import { DatabaseSync } from 'node:sqlite';
import { sha256, deriveAccountId } from './crypto.js';
import { accountStore, applyPeerAccountRegistration } from './account.js';
import { ValidationError } from './errors.js';
import type { AccountType } from './types.js';

/**
 * One account joining the ledger, as carried by a block.
 *
 * Deliberately does NOT carry a balance or a percentHuman: a registration
 * creates an empty shell, and everything after that is earned through
 * transactions and verification panels. It also does not carry createdAt —
 * that comes from the block timestamp so every node writes the same value.
 */
export interface AccountRegistration {
  accountId: string;
  publicKey: string;
  type: AccountType;
  joinedDay: number;
}

/**
 * Stable fingerprint of one registration. Fixed field order, pipe-delimited;
 * none of the values can contain a pipe (hex keys, hex ids, an enum, an
 * integer), so no escaping is needed.
 */
function canonicalBytesFor(reg: AccountRegistration): string {
  return `${reg.accountId}|${reg.publicKey}|${reg.type}|${reg.joinedDay}`;
}

/**
 * Hash of the whole registration set, folded into the block hash.
 *
 * Sorted before hashing so two nodes that drained their queues in a different
 * order still agree, and so a tampered block that merely reorders the list
 * produces the same hash (reordering is not a meaningful attack; dropping or
 * adding entries is, and both change the digest).
 *
 * Mirrors computeValidatorChangesHash, including the empty-set sentinel, so
 * the two behave identically at every call site.
 */
export function computeAccountRegistrationsHash(regs: AccountRegistration[]): string {
  if (regs.length === 0) return sha256('no-account-registrations');
  return sha256(regs.map(canonicalBytesFor).sort().join('|'));
}

/**
 * Apply one registration deterministically.
 *
 * `blockTimestampSec` becomes the row's createdAt so the value is byte-
 * identical on every node rather than each node's local clock. Idempotent:
 * returns false when the account already exists, which is the common case on
 * the node that created it and on any node that already had it via gossip.
 *
 * The accountId is re-derived from the public key inside
 * applyPeerAccountRegistration, so a block claiming an id that does not match
 * its key is rejected rather than applied.
 */
export function applyAccountRegistration(
  db: DatabaseSync,
  reg: AccountRegistration,
  blockTimestampSec: number,
): boolean {
  return applyPeerAccountRegistration(accountStore(db), {
    id: reg.accountId,
    publicKey: reg.publicKey,
    type: reg.type,
    joinedDay: reg.joinedDay,
    createdAt: blockTimestampSec,
  });
}

/**
 * Queue a registration for inclusion in the next block this node proposes.
 *
 * Other operators have nothing in our queue, but they still receive and apply
 * the registration from the block payload, so every node converges. Validated
 * on the way in: a malformed entry queued here would otherwise become a block
 * that no honest node can apply.
 */
export function queueAccountRegistration(db: DatabaseSync, reg: AccountRegistration): void {
  if (deriveAccountId(reg.publicKey) !== reg.accountId) {
    throw new ValidationError(
      `Account registration id ${reg.accountId} does not match its public key`,
      'ACCOUNT_ID_MISMATCH',
    );
  }
  db.prepare(
    `INSERT INTO pending_account_registrations (account_id, registration_json, created_at)
     VALUES (?, ?, ?)`,
  ).run(reg.accountId, JSON.stringify(reg), Math.floor(Date.now() / 1000));
}

/** Pending registrations in FIFO order, for the proposer to include. */
export function drainAccountRegistrations(
  db: DatabaseSync,
  limit: number = 100,
): AccountRegistration[] {
  const rows = db
    .prepare(
      `SELECT registration_json FROM pending_account_registrations
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Array<{ registration_json: string }>;
  return rows.map((r) => JSON.parse(r.registration_json) as AccountRegistration);
}

/**
 * Drop queue entries that have landed in a block. Matched on accountId, which
 * is unique per registration (an account can only join once). Idempotent, and
 * a no-op on nodes that never queued these — every node runs this after a
 * commit, but only the proposer had rows to remove.
 */
export function removeAppliedAccountRegistrations(
  db: DatabaseSync,
  applied: AccountRegistration[],
): number {
  if (applied.length === 0) return 0;
  let removed = 0;
  for (const reg of applied) {
    const res = db
      .prepare('DELETE FROM pending_account_registrations WHERE account_id = ?')
      .run(reg.accountId);
    removed += Number(res.changes ?? 0);
  }
  return removed;
}
