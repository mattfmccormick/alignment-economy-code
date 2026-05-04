import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';

let db: DatabaseSync | null = null;

export function getDb(path: string = ':memory:'): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(path);
    // Durability stack:
    //   journal_mode=WAL → multiple readers + one writer; commits append to WAL
    //   synchronous=NORMAL → fsync the WAL on every commit. NORMAL (not FULL)
    //                        is the recommended pairing with WAL: committed data
    //                        survives power loss; only the rare un-checkpointed
    //                        WAL tail can be lost on crash, and it gets replayed
    //                        on next open.
    //   foreign_keys=ON   → enforce relational integrity
    //   busy_timeout      → wait up to 5s before erroring on a locked DB
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    initializeSchema(db);
  }
  return db;
}

// Force-merge the WAL into the main DB file. Call before taking a file-level
// backup (e.g., before an S3 snapshot of the .db file) so the snapshot is
// self-contained and a restore doesn't depend on copying the .wal/.shm files.
export function checkpointWAL(database: DatabaseSync = db!): void {
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb(): void {
  closeDb();
}

// Helper: run a function inside BEGIN/COMMIT with ROLLBACK on error
// Supports nesting: if already in a transaction, just run the function directly
const txDepth = new WeakMap<DatabaseSync, number>();

export function runTransaction<T>(database: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(database) ?? 0;
  if (depth > 0) {
    // Already in a transaction, just run the function
    txDepth.set(database, depth + 1);
    try {
      const result = fn();
      txDepth.set(database, depth);
      return result;
    } catch (e) {
      txDepth.set(database, depth);
      throw e;
    }
  }

  txDepth.set(database, 1);
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    txDepth.set(database, 0);
    return result;
  } catch (e) {
    database.exec('ROLLBACK');
    txDepth.set(database, 0);
    throw e;
  }
}
