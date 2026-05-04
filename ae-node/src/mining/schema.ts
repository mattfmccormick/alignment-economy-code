import { DatabaseSync } from 'node:sqlite';

export function initializeMiningSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS miners (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE,
      tier INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      registered_at INTEGER NOT NULL,
      deactivated_at INTEGER,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS miner_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      miner_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      block_height INTEGER NOT NULL,
      FOREIGN KEY (miner_id) REFERENCES miners(id)
    );

    CREATE TABLE IF NOT EXISTS miner_tier_changes (
      id TEXT PRIMARY KEY,
      miner_id TEXT NOT NULL,
      from_tier INTEGER NOT NULL,
      to_tier INTEGER NOT NULL,
      reason TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (miner_id) REFERENCES miners(id)
    );

    CREATE TABLE IF NOT EXISTS fee_distributions (
      block_number INTEGER PRIMARY KEY,
      total_fees TEXT NOT NULL,
      tier1_pool TEXT NOT NULL,
      tier2_pool TEXT NOT NULL,
      tier2_lottery TEXT NOT NULL,
      tier2_baseline TEXT NOT NULL,
      lottery_winner_id TEXT,
      tier1_miner_count INTEGER NOT NULL,
      tier2_miner_count INTEGER NOT NULL,
      per_tier1_miner TEXT NOT NULL,
      per_tier2_miner_baseline TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS miner_verification_assignments (
      id TEXT PRIMARY KEY,
      miner_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      deadline INTEGER NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      missed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (miner_id) REFERENCES miners(id)
    );

    CREATE TABLE IF NOT EXISTS miner_jury_service (
      id TEXT PRIMARY KEY,
      miner_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      called_at INTEGER NOT NULL,
      voted INTEGER NOT NULL DEFAULT 0,
      vote_matched_verdict INTEGER,
      FOREIGN KEY (miner_id) REFERENCES miners(id)
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeats_miner ON miner_heartbeats(miner_id);
    CREATE INDEX IF NOT EXISTS idx_heartbeats_time ON miner_heartbeats(timestamp);
    CREATE INDEX IF NOT EXISTS idx_miners_active ON miners(is_active);
    CREATE INDEX IF NOT EXISTS idx_miners_tier ON miners(tier);
    CREATE INDEX IF NOT EXISTS idx_miner_assignments ON miner_verification_assignments(miner_id);
  `);
}
