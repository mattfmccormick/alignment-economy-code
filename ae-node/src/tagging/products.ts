import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import type { Product } from './types.js';

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    name: row.name as string,
    category: row.category as string,
    manufacturerId: row.manufacturer_id as string | null,
    createdBy: row.created_by as string,
    isActive: (row.is_active as number) === 1,
    createdAt: row.created_at as number,
  };
}

export function registerProduct(
  db: DatabaseSync,
  name: string,
  category: string,
  createdBy: string,
  manufacturerId?: string,
  // Chain-ordering (audit #16): when a product_register operation applies at
  // commit it supplies a deterministic id (derived from the op signature) and
  // the block timestamp, so every node stores byte-identical rows. Omitted on
  // the seed/legacy path, which keeps the random uuid + wall clock.
  opts?: { id?: string; now?: number },
): Product {
  const id = opts?.id ?? uuid();
  const now = opts?.now ?? Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO products (id, name, category, manufacturer_id, created_by, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, name, category, manufacturerId ?? null, createdBy, now);

  return getProduct(db, id)!;
}

export function getProduct(db: DatabaseSync, productId: string): Product | null {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToProduct(row);
}

export function linkManufacturer(db: DatabaseSync, productId: string, manufacturerId: string): void {
  db.prepare('UPDATE products SET manufacturer_id = ? WHERE id = ?').run(manufacturerId, productId);
}
