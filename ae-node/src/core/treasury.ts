// Treasury account.
//
// A protocol-controlled "company" account that receives a configurable
// slice of every block's fees (treasury.fee_share, default 10%). It funds
// public goods: audits, the block explorer, docs, the nonprofit running
// the network. The 0.5% transaction fee was 100% miner-bound until now;
// post-treasury it splits Tier 1 / treasury / Tier 2.
//
// Why a sentinel publicKey instead of a real keypair:
//   - The treasury must NOT be spendable by any one operator. Putting a
//     real private key anywhere creates a single point of compromise.
//   - All-zero hex (`'00'.repeat(1952)`) cannot be the publicKey of a
//     real ML-DSA-65 keypair — the key generation produces structured
//     bytes, not zeros. So the treasury accountId is deterministic and
//     no one's private key can ever be claimed to "be" the treasury.
//   - Spending from the treasury becomes possible only when governance is
//     wired (Milestone 2 sub-task), at which point this can be replaced
//     with a multisig keypair governed by validator votes.
//
// The sentinel publicKey deterministically derives a fixed accountId
// across every operator, so the treasury address is verifiable just by
// running deriveAccountId on the all-zero string. We persist that id
// in protocol_params as a convenience for callers that want the value
// without recomputing.

import { DatabaseSync } from 'node:sqlite';
import { deriveAccountId } from './crypto.js';
import { accountStore } from './account.js';
import { setParam, getParam } from '../config/params.js';

const TREASURY_PUBLIC_KEY_LEN_BYTES = 1952;
const TREASURY_PUBLIC_KEY = '00'.repeat(TREASURY_PUBLIC_KEY_LEN_BYTES);

/** Deterministic across every node that runs this code. */
export const TREASURY_ACCOUNT_ID = deriveAccountId(TREASURY_PUBLIC_KEY);

const TREASURY_PARAM_KEY = 'treasury.account_id';

/**
 * Create the treasury account if it doesn't exist yet, and stamp its
 * accountId into protocol_params['treasury.account_id'] so other code
 * can fetch it without reaching into this module. Idempotent.
 *
 * Called from fee-distribution paths so a fresh chain (no genesis spec
 * with a treasury, no manual setup) auto-creates the treasury on its
 * first block-with-fees.
 */
export function ensureTreasuryAccount(db: DatabaseSync): string {
  const store = accountStore(db);
  if (!store.findById(TREASURY_ACCOUNT_ID)) {
    store.insert({
      id: TREASURY_ACCOUNT_ID,
      publicKey: TREASURY_PUBLIC_KEY,
      // 'company' so the treasury never receives daily allocations
      // (those are individuals-only). It can hold earned-balance fees.
      type: 'company',
      // Treasury is the network's own account; nothing to verify.
      // 100 means received fees aren't subject to spend-time decay.
      percentHuman: 100,
      joinedDay: 0,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }
  // Cache the id in protocol_params so getTreasuryAccountId is cheap and
  // doesn't have to recompute the SHA-256 prefix every call.
  if (getParam<string>(db, TREASURY_PARAM_KEY) !== TREASURY_ACCOUNT_ID) {
    setParam(db, TREASURY_PARAM_KEY, TREASURY_ACCOUNT_ID);
  }
  return TREASURY_ACCOUNT_ID;
}

export function getTreasuryAccountId(db: DatabaseSync): string {
  // Always returns the canonical id — ensureTreasuryAccount() persists
  // it on first need but the value is fully derivable from constants
  // so callers that haven't triggered the ensure path still get the
  // right answer.
  void db;
  return TREASURY_ACCOUNT_ID;
}
