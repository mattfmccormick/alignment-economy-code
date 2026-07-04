// Repository interface for the day-cycle singleton (the `day_cycle_state` row).
//
// The day cycle (expire -> rebase -> mint, plus the blackout minute) reads and
// writes exactly one row. Routing that access through a store keeps the raw SQL
// out of the business logic — the last place it lingered was an inline
// `SELECT cycle_phase` in the transaction path and four `SELECT current_day`
// reads in the court. Extracting it here finishes the repository-pattern pass
// so the storage layer can be swapped (Postgres, sharded) without touching the
// economics.

import type { CyclePhase } from '../types.js';

export interface CycleState {
  currentDay: number;
  cyclePhase: CyclePhase;
  phaseStartedAt: number;
}

export interface ICycleStateStore {
  /** The full cycle-state row. Throws if the singleton row is missing. */
  getState(): CycleState;

  /** Current protocol day. Falls back to 1 if the row hasn't been created yet. */
  getCurrentDay(): number;

  /** Current cycle phase, or null if the singleton row hasn't been created. */
  getCyclePhase(): CyclePhase | null;

  /** Set the cycle phase and the unix-seconds time it started. */
  setPhase(phase: CyclePhase, phaseStartedAt: number): void;

  /** Advance the protocol day by one. */
  advanceDay(): void;
}
