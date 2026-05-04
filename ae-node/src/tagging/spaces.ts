import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import type { Space, SpaceType } from './types.js';

function rowToSpace(row: Record<string, unknown>): Space {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as SpaceType,
    parentId: row.parent_id as string | null,
    entityId: row.entity_id as string | null,
    collectionRate: row.collection_rate as number,
    isActive: (row.is_active as number) === 1,
    createdAt: row.created_at as number,
  };
}

export function registerSpace(
  db: DatabaseSync,
  name: string,
  type: SpaceType,
  parentId?: string,
  entityId?: string,
  collectionRate: number = 0,
): Space {
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);

  if (collectionRate < 0 || collectionRate > 100) {
    throw new Error('Collection rate must be 0-100');
  }

  db.prepare(
    `INSERT INTO spaces (id, name, type, parent_id, entity_id, collection_rate, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, name, type, parentId ?? null, entityId ?? null, collectionRate, now);

  return getSpace(db, id)!;
}

export function getSpace(db: DatabaseSync, spaceId: string): Space | null {
  const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToSpace(row);
}

export function getSpaceAncestors(db: DatabaseSync, spaceId: string): Space[] {
  const ancestors: Space[] = [];
  let current = getSpace(db, spaceId);
  while (current && current.parentId) {
    const parent = getSpace(db, current.parentId);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}
