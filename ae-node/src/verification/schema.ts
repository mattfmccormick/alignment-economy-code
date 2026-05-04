import { DatabaseSync } from 'node:sqlite';

export function initializeVerificationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_evidence (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      evidence_type_id TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      reviewed_by TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS verification_panels (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      median_score INTEGER,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS panel_reviews (
      id TEXT PRIMARY KEY,
      panel_id TEXT NOT NULL,
      miner_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      evidence_hash_of_review TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      FOREIGN KEY (panel_id) REFERENCES verification_panels(id)
    );

    CREATE TABLE IF NOT EXISTS vouches (
      id TEXT PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      vouched_id TEXT NOT NULL,
      stake_amount TEXT NOT NULL,
      staked_percentage REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      withdrawn_at INTEGER,
      FOREIGN KEY (voucher_id) REFERENCES accounts(id),
      FOREIGN KEY (vouched_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_account ON verification_evidence(account_id);
    CREATE INDEX IF NOT EXISTS idx_panels_account ON verification_panels(account_id);
    CREATE INDEX IF NOT EXISTS idx_panels_status ON verification_panels(status);
    CREATE INDEX IF NOT EXISTS idx_vouches_vouched ON vouches(vouched_id);
    CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON vouches(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_vouches_active ON vouches(is_active);
  `);
}
