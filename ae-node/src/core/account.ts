// Account business logic.
//
// This file deliberately contains no SQL. All persistence goes through
// IAccountStore (see ./stores/IAccountStore.ts). The functions exported here
// keep their original DatabaseSync-taking signatures so the rest of the
// codebase doesn't have to change all at once — internally each one wraps the
// db in a SqliteAccountStore. As callers migrate to take IAccountStore
// directly, these shims become unnecessary.

import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair, deriveAccountId } from './crypto.js';
import { ConflictError, ValidationError } from './errors.js';
import type { Account, AccountCreationResult, AccountType } from './types.js';
import { SqliteAccountStore } from './stores/SqliteAccountStore.js';
import type { BalanceField, IAccountStore } from './stores/IAccountStore.js';

export type { BalanceField } from './stores/IAccountStore.js';

/** Construct a fresh SqliteAccountStore wrapping the given db handle. */
export function accountStore(db: DatabaseSync): IAccountStore {
  return new SqliteAccountStore(db);
}

/**
 * Create a new account. Two key-custody modes:
 *   - Provide a publicKey (preferred for client-controlled custody, where the
 *     user holds a BIP39 mnemonic and never lets the private key touch the
 *     server).
 *   - Omit the publicKey and let the server generate the keypair (legacy /
 *     test mode). The privateKey is returned ONCE and the caller is
 *     responsible for storing it.
 *
 * Pure protocol logic: validate keys, derive id, check uniqueness, persist.
 * No SQL — talks to IAccountStore only.
 */
export function createAccountWithStore(
  store: IAccountStore,
  type: AccountType,
  currentDay: number = 1,
  percentHuman: number = 0,
  providedPublicKey?: string,
): AccountCreationResult {
  let publicKey: string;
  let privateKey: string;

  if (providedPublicKey) {
    publicKey = providedPublicKey;
    privateKey = ''; // Client custody — server never sees the private key.
  } else {
    const keyPair = generateKeyPair();
    publicKey = keyPair.publicKey;
    privateKey = keyPair.privateKey;
  }

  const id = deriveAccountId(publicKey);

  // Reject duplicate public keys. ML-DSA collision is astronomically unlikely;
  // this catches the case where a client retries account creation with the
  // same mnemonic after a network blip.
  if (store.findById(id)) {
    throw new ConflictError(`Account already exists for this public key: ${id}`, 'ACCOUNT_EXISTS');
  }

  store.insert({
    id,
    publicKey,
    type,
    percentHuman,
    joinedDay: currentDay,
    createdAt: Math.floor(Date.now() / 1000),
  });

  const account = store.findById(id)!;
  return { account, publicKey, privateKey };
}

/** Wire shape for an account replicated from a peer. */
export interface PeerAccountRegistration {
  id: string;
  publicKey: string;
  type: AccountType;
  joinedDay: number;
  createdAt: number;
}

/**
 * Apply an account registration received from a peer.
 *
 * Accounts used to be a purely local INSERT: `createAccount` was reachable only
 * from POST /accounts and the seed script, with no gossip and no transaction
 * type. On a multi-validator network that meant an account existed solely on
 * the node that created it, so the first block carrying one of its transactions
 * threw `Replay: sender account not found` on every other node — which, before
 * the fail-stop landed, killed them.
 *
 * Returns true if a row was written, false if we already had it. Both are
 * success: gossip is at-least-once and arrives out of order, so this must be
 * idempotent.
 *
 * What a peer is NOT trusted to set:
 *   - the id. It is recomputed from the public key and the claimed id must
 *     match, so a peer cannot inject a row under an id it does not hold the
 *     key for.
 *   - percentHuman. Always 0 here. Verification score is raised by panel
 *     completion, never by a peer's say-so.
 *   - balances. Always 0 (the store's insert defaults). Value only ever moves
 *     through replayed transactions.
 *
 * A forged-but-well-formed registration therefore costs a row and nothing else:
 * a zero-balance, zero-score account whose key the sender may not even hold.
 * Spam bounding is the gossip layer's dedupe plus peer authentication.
 */
export function applyPeerAccountRegistration(
  store: IAccountStore,
  reg: PeerAccountRegistration,
): boolean {
  if (typeof reg.publicKey !== 'string' || !/^[0-9a-f]{3904}$/i.test(reg.publicKey)) {
    throw new ValidationError(
      'Account registration publicKey must be a 1952-byte hex string (ML-DSA-65)',
      'INVALID_PUBLIC_KEY',
    );
  }
  const derived = deriveAccountId(reg.publicKey);
  if (derived !== reg.id) {
    throw new ValidationError(
      `Account registration id ${reg.id} does not match its public key (expected ${derived})`,
      'ACCOUNT_ID_MISMATCH',
    );
  }
  if (store.findById(derived)) return false;

  store.insert({
    id: derived,
    publicKey: reg.publicKey,
    type: reg.type,
    percentHuman: 0,
    joinedDay: reg.joinedDay,
    createdAt: reg.createdAt,
  });
  return true;
}

// ─── Back-compat wrappers. These keep the (db, ...) signatures working ──────

export function createAccount(
  db: DatabaseSync,
  type: AccountType,
  currentDay: number = 1,
  percentHuman: number = 0,
  providedPublicKey?: string,
): AccountCreationResult {
  return createAccountWithStore(accountStore(db), type, currentDay, percentHuman, providedPublicKey);
}

export function getAccount(db: DatabaseSync, id: string): Account | null {
  return accountStore(db).findById(id);
}

export function getAccountByPublicKey(db: DatabaseSync, publicKey: string): Account | null {
  return accountStore(db).findByPublicKey(publicKey);
}

export function getAllAccounts(db: DatabaseSync): Account[] {
  return accountStore(db).findAll();
}

export function getActiveIndividuals(db: DatabaseSync): Account[] {
  return accountStore(db).findActiveIndividuals();
}

export function updateBalance(
  db: DatabaseSync,
  accountId: string,
  field: BalanceField,
  newValue: bigint,
): void {
  accountStore(db).updateBalance(accountId, field, newValue);
}

export function updatePercentHuman(db: DatabaseSync, accountId: string, percentHuman: number): void {
  accountStore(db).updatePercentHuman(accountId, percentHuman);
}

export function setEscrowed(db: DatabaseSync, accountId: string, escrowed: boolean): void {
  accountStore(db).setEscrowed(accountId, escrowed);
}

export function deactivateAccount(db: DatabaseSync, accountId: string): void {
  accountStore(db).deactivate(accountId);
}

export function countActiveParticipants(db: DatabaseSync): number {
  return accountStore(db).countActiveParticipants();
}

export function getTotalEarnedPool(db: DatabaseSync): bigint {
  return accountStore(db).totalEarnedPool();
}
