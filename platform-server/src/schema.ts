// SQLite schema for the platform server.
//
// Versioned the same way ae-node does it: a single `schema_version` row
// drives idempotent migrations on boot. Bump SCHEMA_VERSION whenever you
// add a migration to runMigrations().

import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion === 0) {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        email_verified_at INTEGER,
        /* Argon2id hash of the password. Used to authenticate signin. */
        password_hash TEXT NOT NULL,
        /* AE account id (derived from the account public key). One AE
           account per platform user. The platform user logs in, the
           wallet UI uses this account id for all on-chain operations. */
        account_id TEXT NOT NULL UNIQUE,
        /* Client-encrypted blob. Holds the user's AE private key,
           encrypted with a key derived from their password (Argon2id +
           AES-256-GCM). Server can't decrypt this in normal operation. */
        vault_blob TEXT NOT NULL,
        /* Server-side recovery envelope. Same plaintext (AE private key),
           encrypted with the server's x25519 public key during signup.
           Server can decrypt during a verified recovery flow. */
        recovery_blob TEXT NOT NULL,
        /* Optional TOTP secret for 2FA. */
        totp_secret TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE INDEX idx_users_email ON users(email);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE email_verifications (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        verified_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_email_verifs_user ON email_verifications(user_id);

      CREATE TABLE recovery_tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        /* Earliest UTC second the recovery can complete. Server enforces a
           cooldown between recover/start and recover/complete so a stolen
           email account can't instantly take a victim's wallet. */
        eligible_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        /* Was the email click recorded? Required before recover/complete. */
        verified_at INTEGER,
        /* Was the recovery completed? Marks the token spent. */
        completed_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_recovery_user ON recovery_tokens(user_id);
    `);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    return;
  }

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `Schema version ${currentVersion} is newer than this code expects (${SCHEMA_VERSION}). Refusing to start.`,
    );
  }

  // Future migrations land here: switch on currentVersion, run ALTER
  // statements, bump schema_version.version. Idempotent on re-run.
}
