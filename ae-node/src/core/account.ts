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
    throw new Error(`Account already exists for this public key: ${id}`);
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

export function deactivateAccount(db: DatabaseSync, accountId: string): void {
  accountStore(db).deactivate(accountId);
}

export function countActiveParticipants(db: DatabaseSync): number {
  return accountStore(db).countActiveParticipants();
}

export function getTotalEarnedPool(db: DatabaseSync): bigint {
  return accountStore(db).totalEarnedPool();
}
