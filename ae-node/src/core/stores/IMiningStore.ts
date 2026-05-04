// Repository interface for mining storage.
//
// Tables behind this interface:
//   - miners                         (one row per active miner identity)
//   - miner_heartbeats               (append-only liveness pings)
//   - miner_verification_assignments (FIFO queue rows for verification panels)
//   - miner_jury_service             (audit trail for jury attendance + accuracy)
//   - miner_tier_changes             (audit trail for tier promotions/demotions)
//
// Cross-table operations (account balance changes, transaction logs, etc.)
// stay in mining business logic and use IAccountStore + recordLog as before.

import type { Miner } from '../../mining/types.js';

export interface MinerInsert {
  id: string;
  accountId: string;
  tier: 1 | 2;
  registeredAt: number;
}

export interface AssignmentInsert {
  id: string;
  minerId: string;
  panelId: string;
  assignedAt: number;
  deadline: number;
}

export interface TierChangeInsert {
  id: string;
  minerId: string;
  fromTier: 1 | 2;
  toTier: 1 | 2;
  reason: string;
  timestamp: number;
}

export interface JuryServiceInsert {
  id: string;
  minerId: string;
  caseId: string;
  calledAt: number;
  voted: boolean;
  voteMatchedVerdict: boolean | null;
}

export interface IMiningStore {
  // ── miners ─────────────────────────────────────────────────────

  /** Total miners with is_active=1. Used for the bootstrap exemption. */
  countActiveMiners(): number;

  /** Look up a miner by id. */
  findMinerById(minerId: string): Miner | null;

  /** Look up the active miner record for a given account. */
  findMinerByAccountId(accountId: string): Miner | null;

  /** Active miners, optionally filtered by tier. */
  findActiveMiners(tier?: 1 | 2): Miner[];

  /** Persist a new miner. */
  insertMiner(input: MinerInsert): void;

  /** Mark a miner inactive at the given timestamp. */
  deactivateMiner(minerId: string, deactivatedAt: number): void;

  /** Update a miner's tier (promotion or demotion). */
  setMinerTier(minerId: string, newTier: 1 | 2): void;

  /** Append an audit row to miner_tier_changes. */
  recordTierChange(input: TierChangeInsert): void;

  // ── miner_heartbeats ───────────────────────────────────────────

  /** Append a heartbeat. */
  insertHeartbeat(minerId: string, blockHeight: number, timestamp: number): void;

  /** Count of heartbeats from this miner at or after the given timestamp. */
  countHeartbeatsSince(minerId: string, sinceTimestamp: number): number;

  /** The most recent heartbeat timestamp for a miner, or null if never seen. */
  lastHeartbeatAt(minerId: string): number | null;

  /** Delete heartbeats older than the cutoff. Used by the daily cleanup. */
  deleteHeartbeatsBefore(cutoffTimestamp: number): void;

  // ── miner_verification_assignments ─────────────────────────────

  /** Persist a new FIFO assignment for a miner on a panel. */
  insertAssignment(input: AssignmentInsert): void;

  /** Miner ids already assigned to this panel (for de-dup during selection). */
  findAssignmentMinerIds(panelId: string): string[];

  /** Mark an assignment as completed (the miner submitted a score). */
  markAssignmentComplete(minerId: string, panelId: string): void;

  /** Mark an assignment as missed (deadline passed without a score). */
  markAssignmentMissed(minerId: string, panelId: string): void;

  /** Count of all assignments ever given to this miner. */
  countMinerAssignments(minerId: string): number;

  /** Count of completed (scored) assignments for this miner. */
  countMinerAssignmentsCompleted(minerId: string): number;

  // ── miner_jury_service ─────────────────────────────────────────

  /** Append a jury-service audit row. */
  recordJuryService(input: JuryServiceInsert): void;

  /** Total times this miner has been called for jury duty. */
  countJuryServices(minerId: string): number;

  /** Times the miner actually voted (attendance). */
  countJuryServicesVoted(minerId: string): number;

  /** Times the miner voted AND their vote matched the final verdict. */
  countJuryServicesCorrect(minerId: string): number;
}
