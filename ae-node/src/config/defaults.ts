// Default configurable parameter values from the white paper.
// These are starting values, not constants. Changeable by governance.

export const DEFAULT_PARAMS: Record<string, unknown> = {
  // Verification Evidence Weights
  'verification.tier_a.gov_id': 15,
  'verification.tier_a.photo_match': 10,
  'verification.tier_a.voice_print': 5,
  'verification.tier_a.captcha': 5,
  'verification.tier_a.in_person_tx': 2.5,
  'verification.tier_a.in_person_tx_max_per_window': 10,
  'verification.tier_a.in_person_tx_window_days': 30,
  'verification.tier_a.tier_a_max': 30,

  'verification.tier_b.biometric_1': 60,
  'verification.tier_b.biometric_2': 15,
  'verification.tier_b.biometric_3': 5,
  'verification.tier_b.tier_b_max': 80,

  'verification.tier_c.vouch_value': 10,
  'verification.tier_c.vouch_min_stake_percent': 5,
  'verification.tier_c.tier_c_max': null,

  'verification.total_max': 100,

  // Score Decay
  'decay.monthly_decay_percent': 10,
  'decay.in_person_offset_per_tx': 2.5,
  'decay.max_offset_per_window': 10,

  // Mining + Treasury split. Per-block fees are sliced three ways:
  //   - tier1_fee_share goes to Tier 1 operators (equal split)
  //   - treasury_fee_share routes to the protocol treasury account
  //     (funds public goods: audits, explorer, docs, the nonprofit)
  //   - the remainder goes to Tier 2 (60/40 lottery/baseline within tier 2)
  // The three must sum to <= 1.0; the rest is implicitly burned.
  'mining.tier1_fee_share': 0.18,
  'treasury.fee_share': 0.10,
  // Default empty so getParam doesn't throw before ensureTreasuryAccount
  // runs. Filled in with the deterministic id on the first fee distribution.
  'treasury.account_id': '',
  'mining.tier2_fee_share': 0.72,
  'mining.tier2_lottery_share': 0.60,
  'mining.tier2_baseline_share': 0.40,
  'mining.tier1_uptime_threshold': 0.90,
  'mining.tier2_accuracy_threshold': 0.80,
  'mining.tier2_jury_attendance_required': 1.00,
  'mining.rolling_window_days': 30,
  'mining.min_miners_for_jury': 11,
  'mining.panel_size': 3,
  'mining.heartbeat_interval_seconds': 60,
  'mining.verification_deadline_hours': 72,

  // Court
  'court.arbitration_response_days': 7,
  'court.court_voting_days': 7,
  'court.jury_size': 11,
  'court.juror_stake_percent': 5,
  'court.bounty_percent': 20,
  'court.burn_percent': 80,
  'court.protection_window_days': 180,
  'court.max_appeals': 1,
  'court.appeal_window_days': 7,
  'court.evidence_deadline_days': 7,

  // Network
  'network.day_length_seconds': 86400,
  'network.block_interval_seconds': 10,
  'network.max_peers': 20,
};
