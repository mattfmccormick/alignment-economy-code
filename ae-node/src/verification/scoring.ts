import { DatabaseSync } from 'node:sqlite';
import { getPolicy } from './policy.js';
import { getEvidenceForAccount } from './evidence.js';
import { getActiveVouchesForAccount } from './vouching.js';
import type { ScoreBreakdown } from './types.js';

export function calculateScore(db: DatabaseSync, accountId: string): ScoreBreakdown {
  const policy = getPolicy(db);
  const evidence = getEvidenceForAccount(db, accountId);
  const vouches = getActiveVouchesForAccount(db, accountId);

  let tierA = 0;
  let tierB = 0;
  let tierC = 0;
  const evidenceDetails: Array<{ typeId: string; value: number }> = [];

  // Group evidence by type
  const evidenceByType = new Map<string, number>();
  for (const ev of evidence) {
    evidenceByType.set(ev.evidenceTypeId, (evidenceByType.get(ev.evidenceTypeId) || 0) + 1);
  }

  // Score each evidence type
  for (const evType of policy.evidenceTypes) {
    if (evType.id === 'vouch') continue; // vouches handled separately

    const count = evidenceByType.get(evType.id) || 0;
    if (count === 0) continue;

    // Check prerequisite
    if (evType.requires) {
      const reqCount = evidenceByType.get(evType.requires) || 0;
      if (reqCount === 0) continue;
    }

    // How many can contribute
    const effectiveCount = evType.maxPerAccount ? Math.min(count, evType.maxPerAccount) : count;
    let value = effectiveCount * evType.scoreValue;

    // Per-window cap for repeatable evidence like in_person_tx
    if (evType.maxScorePerWindow) {
      value = Math.min(value, evType.maxScorePerWindow);
    }

    // Add to appropriate tier
    switch (evType.tier) {
      case 'A': tierA += value; break;
      case 'B': tierB += value; break;
      case 'C': tierC += value; break;
    }

    evidenceDetails.push({ typeId: evType.id, value });
  }

  // Apply tier caps
  if (policy.tierCaps.A !== null) tierA = Math.min(tierA, policy.tierCaps.A);
  if (policy.tierCaps.B !== null) tierB = Math.min(tierB, policy.tierCaps.B);
  if (policy.tierCaps.C !== null) tierC = Math.min(tierC, policy.tierCaps.C);

  // Vouches (Tier C)
  const vouchType = policy.evidenceTypes.find((t) => t.id === 'vouch');
  if (vouchType && vouches.length > 0) {
    const vouchScore = vouches.length * vouchType.scoreValue;
    tierC += vouchScore;
    evidenceDetails.push({ typeId: 'vouch', value: vouchScore });
  }
  // Re-apply tier C cap if it exists
  if (policy.tierCaps.C !== null) tierC = Math.min(tierC, policy.tierCaps.C);

  let totalScore = tierA + tierB + tierC;
  totalScore = Math.min(totalScore, policy.totalCap);

  return {
    totalScore,
    breakdown: { tierA, tierB, tierC },
    evidenceDetails,
    decayApplied: false,
    nextDecayDate: null,
  };
}
