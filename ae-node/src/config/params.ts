import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PARAMS } from './defaults.js';
import { runTransaction } from '../db/connection.js';

const cache = new Map<string, unknown>();

export function seedParams(db: DatabaseSync): void {
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO protocol_params (key, value, updated_at) VALUES (?, ?, ?)'
  );
  runTransaction(db, () => {
    for (const [key, value] of Object.entries(DEFAULT_PARAMS)) {
      insert.run(key, JSON.stringify(value), now);
    }
  });
  cache.clear();
}

export function getParam<T = unknown>(db: DatabaseSync, key: string): T {
  if (cache.has(key)) {
    return cache.get(key) as T;
  }

  const row = db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  if (!row) {
    const defaultVal = DEFAULT_PARAMS[key];
    if (defaultVal === undefined) {
      throw new Error(`Unknown protocol param: ${key}`);
    }
    return defaultVal as T;
  }

  const parsed = JSON.parse(row.value) as T;
  cache.set(key, parsed);
  return parsed;
}

export function setParam(
  db: DatabaseSync,
  key: string,
  value: unknown,
  updatedBy?: string,
  signature?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  const jsonValue = JSON.stringify(value);

  const existing = db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  runTransaction(db, () => {
    db.prepare(
      `INSERT INTO protocol_param_changes (key, old_value, new_value, updated_at, updated_by, signature)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(key, existing?.value ?? null, jsonValue, now, updatedBy ?? null, signature ?? null);

    // Upsert
    if (existing) {
      db.prepare(
        'UPDATE protocol_params SET value = ?, updated_at = ?, updated_by = ?, signature = ? WHERE key = ?'
      ).run(jsonValue, now, updatedBy ?? null, signature ?? null, key);
    } else {
      db.prepare(
        'INSERT INTO protocol_params (key, value, updated_at, updated_by, signature) VALUES (?, ?, ?, ?, ?)'
      ).run(key, jsonValue, now, updatedBy ?? null, signature ?? null);
    }
  });

  cache.set(key, value);
}

export function getAllParams(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM protocol_params').all() as Array<{
    key: string;
    value: string;
  }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.value);
  }
  return result;
}

export function invalidateCache(): void {
  cache.clear();
}
