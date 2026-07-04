import { DatabaseSync } from 'node:sqlite';
import type { CyclePhase } from '../types.js';
import type { CycleState, ICycleStateStore } from './ICycleStateStore.js';

export class SqliteCycleStateStore implements ICycleStateStore {
  constructor(private readonly db: DatabaseSync) {}

  getState(): CycleState {
    const row = this.db
      .prepare('SELECT current_day, cycle_phase, phase_started_at FROM day_cycle_state WHERE id = 1')
      .get() as { current_day: number; cycle_phase: string; phase_started_at: number } | undefined;
    if (!row) throw new Error('day_cycle_state singleton row is missing');
    return {
      currentDay: row.current_day,
      cyclePhase: row.cycle_phase as CyclePhase,
      phaseStartedAt: row.phase_started_at,
    };
  }

  getCurrentDay(): number {
    const row = this.db
      .prepare('SELECT current_day FROM day_cycle_state WHERE id = 1')
      .get() as { current_day: number } | undefined;
    return row?.current_day ?? 1;
  }

  getCyclePhase(): CyclePhase | null {
    const row = this.db
      .prepare('SELECT cycle_phase FROM day_cycle_state WHERE id = 1')
      .get() as { cycle_phase: string } | undefined;
    return (row?.cycle_phase as CyclePhase) ?? null;
  }

  setPhase(phase: CyclePhase, phaseStartedAt: number): void {
    this.db
      .prepare('UPDATE day_cycle_state SET cycle_phase = ?, phase_started_at = ? WHERE id = 1')
      .run(phase, phaseStartedAt);
  }

  advanceDay(): void {
    this.db.prepare('UPDATE day_cycle_state SET current_day = current_day + 1 WHERE id = 1').run();
  }
}

/** Factory mirroring the other store modules (accountStore, transactionStore, …). */
export function cycleStateStore(db: DatabaseSync): ICycleStateStore {
  return new SqliteCycleStateStore(db);
}
