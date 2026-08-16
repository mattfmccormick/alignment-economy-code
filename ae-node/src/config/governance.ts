// WP v2 Appendix A: Parameter governance classifications.
//
// Every tunable param falls into one of four classes:
//   Constitutional — fixed, defines what the AE is, not governable
//   Bounded        — governance sets value inside hardcoded floor/ceiling
//   Algorithmic    — set by formula, no vote
//   Open           — freely governable, low blast radius

export type ParamClass = 'constitutional' | 'bounded' | 'algorithmic' | 'open';

export interface ParamSpec {
  class: ParamClass;
  low?: number;
  high?: number;
  description: string;
}

export const PARAM_GOVERNANCE: Record<string, ParamSpec> = {

  // ── Verification Evidence Weights (Open: miner judgment) ──────────

  'verification.tier_a.gov_id':                   { class: 'open', description: 'Gov ID evidence weight' },
  'verification.tier_a.photo_match':              { class: 'open', description: 'Photo match evidence weight' },
  'verification.tier_a.voice_print':              { class: 'open', description: 'Voice print evidence weight' },
  'verification.tier_a.captcha':                  { class: 'open', description: 'Captcha evidence weight' },
  'verification.tier_a.in_person_tx':             { class: 'open', description: 'In-person tx evidence weight' },
  'verification.tier_a.in_person_tx_max_per_window': { class: 'open', description: 'Max in-person tx credits per window' },
  'verification.tier_a.in_person_tx_window_days': { class: 'open', description: 'In-person tx credit window (days)' },
  'verification.tier_a.tier_a_max':               { class: 'open', description: 'Max score from Tier A evidence' },

  'verification.tier_b.biometric_1':              { class: 'open', description: 'Primary biometric evidence weight' },
  'verification.tier_b.biometric_2':              { class: 'open', description: 'Secondary biometric evidence weight' },
  'verification.tier_b.biometric_3':              { class: 'open', description: 'Tertiary biometric evidence weight' },
  'verification.tier_b.tier_b_max':               { class: 'open', description: 'Max score from Tier B evidence' },

  'verification_policy':                           { class: 'open', description: 'Full verification policy object (evidence types, weights, thresholds)' },
  'verification.tier_c.vouch_value':              { class: 'open', description: 'Score value per vouch' },
  'verification.tier_c.vouch_min_stake_percent':  { class: 'open', description: 'Minimum vouch stake percentage' },
  'verification.tier_c.tier_c_max':               { class: 'constitutional', description: 'Max score from vouching (null = unlimited, guaranteeing vouch-only path to 100%)' },

  'verification.total_max':                       { class: 'constitutional', description: 'Maximum percent-human score (100%)' },

  // ── Score Decay (Bounded per WP v2 Appendix A) ───────────────────

  'decay.monthly_decay_percent':   { class: 'bounded', low: 2, high: 25, description: 'Monthly score decay (%)' },
  'decay.in_person_offset_per_tx': { class: 'bounded', low: 1, high: 10, description: 'Human-tag score credit per tx (%)' },
  'decay.max_offset_per_window':   { class: 'open', description: 'Max decay offset per window' },

  // ── Mining Fee Split (Bounded per WP v2 Appendix A) ──────────────

  'mining.tier1_fee_share':           { class: 'bounded', low: 0.10, high: 0.40, description: 'Tier 1 (nodes) fee share' },
  'mining.tier2_fee_share':           { class: 'bounded', low: 0.60, high: 0.90, description: 'Tier 2 (validators) fee share' },
  'mining.tier2_lottery_share':       { class: 'bounded', low: 0.40, high: 0.70, description: 'Tier 2 lottery share of Tier 2 pool' },
  'mining.tier2_baseline_share':      { class: 'bounded', low: 0.30, high: 0.60, description: 'Tier 2 baseline share of Tier 2 pool' },
  'mining.tier1_uptime_threshold':    { class: 'bounded', low: 0.80, high: 0.99, description: 'Tier 1 uptime requirement' },
  'mining.tier2_accuracy_threshold':  { class: 'bounded', low: 0.60, high: 0.95, description: 'Tier 2 accuracy threshold' },
  'mining.tier2_jury_attendance_required': { class: 'constitutional', description: '100% jury attendance required for Tier 2' },
  'mining.rolling_window_days':       { class: 'bounded', low: 7, high: 90, description: 'Tier evaluation rolling window (days)' },
  'mining.min_miners_for_jury':       { class: 'open', description: 'Minimum miners to seat a jury' },
  'mining.bootstrap_miner_count':     { class: 'open', description: 'Miners a new network may seat before the percentHuman floor applies' },
  'mining.panel_size':                { class: 'bounded', low: 3, high: 7, description: 'Verification panel size (odd, median rule)' },
  'mining.heartbeat_interval_seconds': { class: 'open', description: 'Miner heartbeat interval' },
  'mining.verification_deadline_hours': { class: 'open', description: 'Hours to complete assigned verification' },

  // ── Court (Bounded per WP v2 Appendix A) ─────────────────────────

  'court.arbitration_response_days':       { class: 'bounded', low: 3, high: 30, description: 'Arbitration response window (days)' },
  'court.court_voting_days':               { class: 'bounded', low: 3, high: 30, description: 'Court voting window (days)' },
  'court.jury_size':                       { class: 'bounded', low: 7, high: 25, description: 'Jury size (odd)' },
  'court.juror_stake_percent':             { class: 'bounded', low: 1, high: 15, description: 'Juror stake (% of earned)' },
  'court.bounty_percent':                  { class: 'bounded', low: 5, high: 35, description: 'Fraud bounty (% of condemned balance)' },
  'court.burn_percent':                    { class: 'bounded', low: 65, high: 95, description: 'Burn (% of condemned balance, 100 - bounty)' },
  'court.protection_window_days':          { class: 'bounded', low: 30, high: 365, description: 'Post-case protection window (days)' },
  'court.max_appeals':                     { class: 'bounded', low: 0, high: 2, description: 'Maximum appeals allowed' },
  'court.appeal_window_days':              { class: 'open', description: 'Appeal filing window (days)' },
  'court.evidence_deadline_days':          { class: 'open', description: 'Evidence submission deadline (days)' },
  'court.forfeited_challenger_def_share':  { class: 'bounded', low: 0.25, high: 0.75, description: 'Defendant share of forfeited challenger stake' },
  'court.duplicate_penalty_multiplier':    { class: 'bounded', low: 1, high: 4, description: 'Duplicate-account penalty multiplier (x overlap days x 1,440)' },

  // ── Governance ────────────────────────────────────────────────────

  'governance.referendum_quorum':          { class: 'bounded', low: 0.05, high: 0.25, description: 'Referendum quorum (% of verified participants)' },
  'governance.referendum_supermajority':   { class: 'constitutional', description: 'Referendum supermajority (2/3 of votes cast)' },

  // ── Blockchain & Infrastructure ───────────────────────────────────

  'blockchain.history_window_years':       { class: 'bounded', low: 3, high: 15, description: 'Rolling history window for pruning (years)' },

  // ── Network (Open: operational tuning) ────────────────────────────

  'network.day_length_seconds':            { class: 'constitutional', description: 'Day length (86,400 seconds, not governable)' },
  'network.block_interval_seconds':        { class: 'open', description: 'Target block interval' },
  'network.max_peers':                     { class: 'open', description: 'Maximum peer connections' },
};

export function validateParamChange(key: string, value: unknown): void {
  const spec = PARAM_GOVERNANCE[key];
  if (!spec) {
    throw new Error(`Unknown parameter: ${key}. Only registered protocol parameters may be set.`);
  }

  if (spec.class === 'constitutional') {
    throw new Error(
      `Parameter '${key}' is constitutional and cannot be changed. ${spec.description}`
    );
  }

  if (spec.class === 'algorithmic') {
    throw new Error(
      `Parameter '${key}' is algorithmic (set by formula) and cannot be changed manually.`
    );
  }

  if (spec.class === 'bounded') {
    if (typeof value !== 'number') {
      throw new Error(`Bounded parameter '${key}' must be a number, got ${typeof value}`);
    }
    if (spec.low !== undefined && value < spec.low) {
      throw new Error(
        `Parameter '${key}' value ${value} is below the minimum bound ${spec.low}`
      );
    }
    if (spec.high !== undefined && value > spec.high) {
      throw new Error(
        `Parameter '${key}' value ${value} is above the maximum bound ${spec.high}`
      );
    }
  }
}
