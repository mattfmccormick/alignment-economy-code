// Evidence submission business logic.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { verificationStore } from './panel.js';
import { ConflictError } from '../core/errors.js';
import type { Evidence } from './types.js';

export function submitEvidence(
  db: DatabaseSync,
  accountId: string,
  evidenceTypeId: string,
  evidenceHash: string,
): Evidence {
  const store = verificationStore(db);

  // Nullifier duplicate check (WP §8.2). The evidence hash is derived from the
  // credential file, so the same document always produces the same hash. If it
  // is already registered to a DIFFERENT account, reject it — one credential
  // can only verify one human. Re-submitting the same file on the SAME account
  // (a re-verification) is fine. This catches the basic duplicate attack
  // ("one person submitting the same ID ten times"). It does NOT catch forged
  // credentials (a fake ID hashes differently) — miner judgment, life
  // fingerprints, and vouching cover that. The zero-knowledge circuit that
  // would let the hash be checked without revealing the credential is a
  // Phase-3 privacy enhancement; the duplicate-catching function works today
  // with a plain content hash.
  const existingOwners = store.findAccountIdsByEvidenceHash(evidenceHash);
  if (existingOwners.some((owner) => owner !== accountId)) {
    throw new ConflictError('This credential is already registered to another account', 'DUPLICATE_CREDENTIAL');
  }

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  store.insertEvidence({ id, accountId, evidenceTypeId, evidenceHash, submittedAt: now });
  return { id, accountId, evidenceTypeId, evidenceHash, submittedAt: now, reviewedBy: null };
}

export function getEvidenceForAccount(db: DatabaseSync, accountId: string): Evidence[] {
  return verificationStore(db).findEvidenceByAccount(accountId);
}
