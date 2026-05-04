// Evidence submission business logic.

import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { verificationStore } from './panel.js';
import type { Evidence } from './types.js';

export function submitEvidence(
  db: DatabaseSync,
  accountId: string,
  evidenceTypeId: string,
  evidenceHash: string,
): Evidence {
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  verificationStore(db).insertEvidence({ id, accountId, evidenceTypeId, evidenceHash, submittedAt: now });
  return { id, accountId, evidenceTypeId, evidenceHash, submittedAt: now, reviewedBy: null };
}

export function getEvidenceForAccount(db: DatabaseSync, accountId: string): Evidence[] {
  return verificationStore(db).findEvidenceByAccount(accountId);
}
