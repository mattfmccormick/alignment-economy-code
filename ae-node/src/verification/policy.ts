import { DatabaseSync } from 'node:sqlite';
import { getParam, setParam } from '../config/params.js';
import type { VerificationPolicy } from './types.js';

const DEFAULT_POLICY: VerificationPolicy = {
  version: 1,
  evidenceTypes: [
    { id: 'gov_id', name: 'Government-Issued ID', tier: 'A', scoreValue: 15, maxPerAccount: 1, description: 'Verified government-issued identification document' },
    { id: 'photo_match', name: 'Photo/Video Matched to ID', tier: 'A', scoreValue: 10, maxPerAccount: 1, description: 'Photo or video verified against submitted ID' },
    { id: 'voice_print', name: 'Voice Print Analysis', tier: 'A', scoreValue: 5, maxPerAccount: 1, description: 'Voice pattern analysis' },
    { id: 'captcha', name: 'CAPTCHA/Behavioral Analysis', tier: 'A', scoreValue: 5, maxPerAccount: 1, description: 'Automated human verification challenge' },
    { id: 'in_person_tx', name: 'In-Person Transaction Confirmation', tier: 'A', scoreValue: 2.5, maxPerAccount: null, maxScorePerWindow: 10, windowDays: 30, description: 'Verified point-of-sale terminal confirms human' },
    { id: 'biometric_primary', name: 'Primary Biometric', tier: 'B', scoreValue: 60, maxPerAccount: 1, description: 'First biometric scan' },
    { id: 'biometric_secondary', name: 'Secondary Biometric', tier: 'B', scoreValue: 15, maxPerAccount: 1, requires: 'biometric_primary', description: 'Second biometric modality' },
    { id: 'biometric_tertiary', name: 'Tertiary Biometric', tier: 'B', scoreValue: 5, maxPerAccount: 1, requires: 'biometric_secondary', description: 'Third biometric modality' },
    { id: 'vouch', name: 'Human Vouch (Stake-Backed)', tier: 'C', scoreValue: 10, maxPerAccount: null, minStakePercent: 5, description: 'Another verified human stakes earned points' },
  ],
  tierCaps: { A: 30, B: 80, C: null },
  totalCap: 100,
  decay: { monthlyRate: 10, inPersonOffset: 2.5, maxOffsetPerWindow: 10, windowDays: 30 },
};

export function getPolicy(db: DatabaseSync): VerificationPolicy {
  try {
    return getParam<VerificationPolicy>(db, 'verification_policy');
  } catch {
    // Seed default policy
    setParam(db, 'verification_policy', DEFAULT_POLICY);
    return DEFAULT_POLICY;
  }
}

export function setPolicy(db: DatabaseSync, policy: VerificationPolicy, updatedBy?: string): void {
  setParam(db, 'verification_policy', policy, updatedBy);
}

export function getEvidenceType(db: DatabaseSync, typeId: string): VerificationPolicy['evidenceTypes'][0] | undefined {
  const policy = getPolicy(db);
  return policy.evidenceTypes.find((t) => t.id === typeId);
}
