// Tagging operations that ride a block: product register, space register,
// supportive-tag submit, ambient-tag submit — one unified lane (audit #16).
//
// Why this exists
// ---------------
// The daily supportive/ambient mints flow to the makers of the durable goods a
// person uses and the entities behind the spaces they occupy. That flow is
// computed at the day boundary by finalizeSupportiveTags / finalizeAmbientTags,
// which read the supportive_tags / ambient_tags rows and the products / spaces
// they reference. All four of those inputs were written NODE-LOCALLY: the submit
// and register routes INSERTed straight into one node's DB with no gossip and no
// on-chain operation. So every node held a different set of tags and products,
// and each finalized a different ledger at the day boundary — a fork. The VALUE
// math was already deterministic (fixed constants, the now-chain-state
// percentHuman, additive credits, a fixed hierarchy walk); the only fork source
// was the inputs.
//
// This module puts all four inputs on the chain, mirroring vouch-operation /
// miner-operation / panel-operation: a signed operation, queued locally,
// gossiped so any proposer includes it, folded into the block hash, and applied
// deterministically at commit on every node — BEFORE the day cycle runs, so a
// submit committed in the same block as the day boundary is visible to finalize.
//
// Canonical encoding (the load-bearing detail)
// --------------------------------------------
// Unlike vouch/miner ops, tagging ops carry FREE TEXT (product/space names,
// category) and ARRAYS (the tag list). The pipe-join those modules use assumes
// no field contains a pipe, which is false here — a product named "A|B" would
// let the client signer and the node verifier disagree, and every signature
// would fail (or worse, two ops could canonicalize identically). So the signed
// bytes are a JSON positional array (type tag first). JSON.stringify over a
// positional array has no object-key-order ambiguity and encodes identically in
// V8 on the node and in the browser, so the ae-app signer and this verifier
// produce the same bytes. ae-app/src/lib/crypto.ts MUST build the exact same
// strings; a cross-repo byte-match test pins it.
//
// Determinism
// -----------
// Node-local inputs removed: the row ids (were uuid(), now derived from the op
// signature — one per tag row via an index) and the created_at timestamps (were
// Date.now(), now the block timestamp). Re-submission keeps the DELETE-active-
// then-INSERT replace: two distinct submit ops for the same (account, day) apply
// in block-height order, last one wins, identical on every node. A re-delivered
// op is a no-op (register: id already present; submit: first derived row id
// already present). A missing reference (product/space/manufacturer/entity/
// parent) is rejected at validate; at apply the whole op is skipped (never a
// per-row skip — that would change totalMinutes and fork the share denominator).

import { DatabaseSync } from 'node:sqlite';
import { sha256, sign, verify } from '../core/crypto.js';
import { getAccount } from '../core/account.js';
import { getProduct, registerProduct } from './products.js';
import { getSpace, registerSpace } from './spaces.js';
import { submitSupportiveTags } from './supportive.js';
import { submitAmbientTags } from './ambient.js';
import type { SpaceType } from './types.js';

/** The space types a space_register op may carry. Single source of truth; the
 * route imports this rather than keeping its own copy. */
export const VALID_SPACE_TYPES: SpaceType[] = [
  'room', 'building', 'park', 'road', 'transit', 'city', 'state', 'nation', 'custom',
];

export interface TagOpProductRegister {
  type: 'product_register';
  /** The registering account (product creator). Signer. */
  accountId: string;
  name: string;
  category: string;
  manufacturerId: string | null;
  timestamp: number;
  signature: string;
}

export interface TagOpSpaceRegister {
  type: 'space_register';
  /** The registering account. Signer. */
  accountId: string;
  name: string;
  spaceType: SpaceType;
  parentId: string | null;
  entityId: string | null;
  collectionRate: number;
  timestamp: number;
  signature: string;
}

export interface SupportiveTagEntry {
  productId: string;
  minutesUsed: number;
}
export interface AmbientTagEntry {
  spaceId: string;
  minutesOccupied: number;
}

export interface TagOpSupportiveSubmit {
  type: 'supportive_tag_submit';
  /** The tagging account. Signer. */
  accountId: string;
  day: number;
  tags: SupportiveTagEntry[];
  timestamp: number;
  signature: string;
}

export interface TagOpAmbientSubmit {
  type: 'ambient_tag_submit';
  /** The tagging account. Signer. */
  accountId: string;
  day: number;
  tags: AmbientTagEntry[];
  timestamp: number;
  signature: string;
}

export type TaggingOperation =
  | TagOpProductRegister
  | TagOpSpaceRegister
  | TagOpSupportiveSubmit
  | TagOpAmbientSubmit;

/**
 * The signed bytes. A JSON positional array, type tag first — see the file
 * header for why this is NOT a pipe-join. This string MUST be byte-identical to
 * the one ae-app/src/lib/crypto.ts builds, or signatures will not verify.
 */
export function canonicalBytesFor(op: TaggingOperation): string {
  switch (op.type) {
    case 'product_register':
      return JSON.stringify([
        'product_register',
        op.accountId,
        op.name,
        op.category,
        op.manufacturerId ?? null,
        op.timestamp,
      ]);
    case 'space_register':
      return JSON.stringify([
        'space_register',
        op.accountId,
        op.name,
        op.spaceType,
        op.parentId ?? null,
        op.entityId ?? null,
        op.collectionRate,
        op.timestamp,
      ]);
    case 'supportive_tag_submit':
      return JSON.stringify([
        'supportive_tag_submit',
        op.accountId,
        op.day,
        op.tags.map((t) => [t.productId, t.minutesUsed]),
        op.timestamp,
      ]);
    case 'ambient_tag_submit':
      return JSON.stringify([
        'ambient_tag_submit',
        op.accountId,
        op.day,
        op.tags.map((t) => [t.spaceId, t.minutesOccupied]),
        op.timestamp,
      ]);
  }
}

export function deriveProductId(op: TagOpProductRegister): string {
  return sha256(`product.id.v1\n${op.signature}`).slice(0, 40);
}
export function deriveSpaceId(op: TagOpSpaceRegister): string {
  return sha256(`space.id.v1\n${op.signature}`).slice(0, 40);
}
export function deriveSupportiveRowId(op: TagOpSupportiveSubmit, index: number): string {
  return sha256(`supportive.tag.v1\n${op.signature}\n${index}`).slice(0, 40);
}
export function deriveAmbientRowId(op: TagOpAmbientSubmit, index: number): string {
  return sha256(`ambient.tag.v1\n${op.signature}\n${index}`).slice(0, 40);
}

// ─── Signing (mirrored byte-for-byte by ae-app/src/lib/crypto.ts) ───────────

export function signProductRegister(input: {
  accountId: string;
  name: string;
  category: string;
  manufacturerId?: string | null;
  timestamp: number;
  accountPrivateKey: string;
}): TagOpProductRegister {
  const unsigned: Omit<TagOpProductRegister, 'signature'> = {
    type: 'product_register',
    accountId: input.accountId,
    name: input.name,
    category: input.category,
    manufacturerId: input.manufacturerId ?? null,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as TaggingOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function signSpaceRegister(input: {
  accountId: string;
  name: string;
  spaceType: SpaceType;
  parentId?: string | null;
  entityId?: string | null;
  collectionRate: number;
  timestamp: number;
  accountPrivateKey: string;
}): TagOpSpaceRegister {
  const unsigned: Omit<TagOpSpaceRegister, 'signature'> = {
    type: 'space_register',
    accountId: input.accountId,
    name: input.name,
    spaceType: input.spaceType,
    parentId: input.parentId ?? null,
    entityId: input.entityId ?? null,
    collectionRate: input.collectionRate,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as TaggingOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function signSupportiveSubmit(input: {
  accountId: string;
  day: number;
  tags: SupportiveTagEntry[];
  timestamp: number;
  accountPrivateKey: string;
}): TagOpSupportiveSubmit {
  const unsigned: Omit<TagOpSupportiveSubmit, 'signature'> = {
    type: 'supportive_tag_submit',
    accountId: input.accountId,
    day: input.day,
    tags: input.tags,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as TaggingOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function signAmbientSubmit(input: {
  accountId: string;
  day: number;
  tags: AmbientTagEntry[];
  timestamp: number;
  accountPrivateKey: string;
}): TagOpAmbientSubmit {
  const unsigned: Omit<TagOpAmbientSubmit, 'signature'> = {
    type: 'ambient_tag_submit',
    accountId: input.accountId,
    day: input.day,
    tags: input.tags,
    timestamp: input.timestamp,
  };
  const bytes = new TextEncoder().encode(canonicalBytesFor(unsigned as TaggingOperation));
  return { ...unsigned, signature: sign(bytes, input.accountPrivateKey) };
}

export function verifyTaggingOperation(op: TaggingOperation, accountPublicKey: string): boolean {
  try {
    if (
      op.type !== 'product_register' &&
      op.type !== 'space_register' &&
      op.type !== 'supportive_tag_submit' &&
      op.type !== 'ambient_tag_submit'
    ) {
      return false;
    }
    if (typeof op.accountId !== 'string' || op.accountId.length === 0) return false;
    if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return false;
    if (typeof op.signature !== 'string') return false;
    const bytes = new TextEncoder().encode(canonicalBytesFor(op));
    return verify(bytes, op.signature, accountPublicKey);
  } catch {
    return false;
  }
}

/** Order-independent hash of the operation set, folded into the block hash. The
 * SORT is for the tamper-check only; apply uses the block's payload array order. */
export function computeTaggingOperationsHash(ops: TaggingOperation[]): string {
  if (ops.length === 0) return sha256('no-tagging-operations');
  return sha256(ops.map(canonicalBytesFor).sort().join('|'));
}

/**
 * Apply one tagging operation deterministically at commit. Idempotent; uses the
 * block timestamp for every write.
 *
 * NEVER THROWS. Every reason an op cannot apply is turned into a deterministic
 * whole-op SKIP, because apply runs on the consensus commit path with no
 * pre-commit applicability filter (the gossip, block-validation, and vote-time
 * dry-run paths check only the signature). If apply threw on a validly-signed
 * but non-applicable op — over the minute cap, non-positive/non-integer minutes,
 * collectionRate out of range — every node would fail-stop at that height and
 * the certified-but-unappliable block would brick the chain on restart. So we
 * mirror the tolerate-at-apply discipline of applyVouch/Miner/PanelOperation:
 * skip, never throw. The skip is a pure function of the op plus CHAIN-PURE state
 * only (`intrinsicSkip`), so every honest node makes the identical decision.
 *
 * Deliberately does NOT check manufacturer/entity ACCOUNT existence: account
 * rows are not a pure function of the applied chain (they gossip ahead of their
 * on-chain account_registrations), so a getAccount()-gated skip here would fork
 * honest nodes. The ref is stored verbatim and day-boundary finalization, which
 * runs much later once accounts are settled, decides whether it pays out.
 * Product/space refs ARE chain-pure (chain-ordered), so those are checked.
 */
export function applyTaggingOperation(
  db: DatabaseSync,
  op: TaggingOperation,
  blockTimestampSec: number,
): void {
  if (intrinsicSkip(db, op)) return;
  switch (op.type) {
    case 'product_register': {
      const id = deriveProductId(op);
      if (getProduct(db, id)) return; // already applied
      // Store the manufacturerId verbatim — no getAccount() gate (see above).
      registerProduct(db, op.name, op.category, op.accountId, op.manufacturerId ?? undefined, {
        id,
        now: blockTimestampSec,
      });
      return;
    }
    case 'space_register': {
      const id = deriveSpaceId(op);
      if (getSpace(db, id)) return; // already applied
      // parentId/entityId stored verbatim; getSpaceAncestors + finalization
      // tolerate a missing parent/entity at the day boundary.
      registerSpace(
        db,
        op.name,
        op.spaceType,
        op.parentId ?? undefined,
        op.entityId ?? undefined,
        op.collectionRate,
        { id, now: blockTimestampSec },
      );
      return;
    }
    case 'supportive_tag_submit': {
      const rowIds = op.tags.map((_, i) => deriveSupportiveRowId(op, i));
      submitSupportiveTags(db, op.accountId, op.day, op.tags, { rowIds });
      return;
    }
    case 'ambient_tag_submit': {
      const rowIds = op.tags.map((_, i) => deriveAmbientRowId(op, i));
      submitAmbientTags(db, op.accountId, op.day, op.tags, { rowIds });
      return;
    }
  }
}

/**
 * Should this op be skipped at apply? A pure function of the op plus chain-pure
 * state (products/spaces are chain-ordered; accounts are NOT consulted). Covers
 * everything the underlying submit / register helpers would otherwise THROW on,
 * plus idempotent re-delivery. Identical decision on every node.
 */
function intrinsicSkip(db: DatabaseSync, op: TaggingOperation): boolean {
  switch (op.type) {
    case 'product_register':
      return false; // registerProduct never throws; verbatim store
    case 'space_register':
      // registerSpace throws on collectionRate out of range.
      return typeof op.collectionRate !== 'number' || op.collectionRate < 0 || op.collectionRate > 100;
    case 'supportive_tag_submit': {
      if (!Array.isArray(op.tags) || op.tags.length === 0) return true;
      // Idempotent re-delivery: this op's first derived row already present.
      if (db.prepare('SELECT 1 FROM supportive_tags WHERE id = ? LIMIT 1').get(deriveSupportiveRowId(op, 0))) {
        return true;
      }
      let total = 0;
      for (const t of op.tags) {
        if (!Number.isInteger(t.minutesUsed) || t.minutesUsed <= 0) return true;
        if (!getProduct(db, t.productId)) return true; // chain-pure ref
        total += t.minutesUsed;
      }
      return total > 1440;
    }
    case 'ambient_tag_submit': {
      if (!Array.isArray(op.tags) || op.tags.length === 0) return true;
      if (db.prepare('SELECT 1 FROM ambient_tags WHERE id = ? LIMIT 1').get(deriveAmbientRowId(op, 0))) {
        return true;
      }
      let total = 0;
      for (const t of op.tags) {
        if (!Number.isInteger(t.minutesOccupied) || t.minutesOccupied <= 0) return true;
        if (!getSpace(db, t.spaceId)) return true; // chain-pure ref
        total += t.minutesOccupied;
      }
      return total > 1440;
    }
  }
}

/**
 * Canonical apply order for a block's tagging operations.
 *
 * computeTaggingOperationsHash sorts the ops, so the block hash is INDEPENDENT
 * of the payload array order. Apply must therefore not depend on payload order
 * either, or a Byzantine proposer could ship two orderings that hash identically
 * yet apply to different state (two submits for the same account+day are
 * last-writer-wins), forking honest followers under one certificate. Applying in
 * the same canonical order the hash uses closes that: every node applies the
 * same sequence regardless of the order it received. Callers MUST iterate this,
 * not the raw payload array.
 */
export function orderTaggingOperationsForApply(ops: TaggingOperation[]): TaggingOperation[] {
  return [...ops].sort((a, b) => {
    const ka = canonicalBytesFor(a);
    const kb = canonicalBytesFor(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Can this node apply the op? Runs at HTTP entry (so a proposer never queues an
 * unappliable op) and in block validation (so a follower never votes for one).
 * All existence reads are against chain state now that products/spaces are
 * chain-ordered. Returns an error string or null.
 */
export function validateTaggingOperationApplicable(
  db: DatabaseSync,
  op: TaggingOperation,
): string | null {
  if (!getAccount(db, op.accountId)) return `account not found: ${op.accountId}`;
  switch (op.type) {
    case 'product_register':
      if (!op.name || !op.category) return 'name and category are required';
      if (op.manufacturerId && !getAccount(db, op.manufacturerId)) {
        return `manufacturer account not found: ${op.manufacturerId}`;
      }
      return null;
    case 'space_register':
      if (!op.name) return 'name is required';
      if (!VALID_SPACE_TYPES.includes(op.spaceType)) return `invalid space type: ${op.spaceType}`;
      if (typeof op.collectionRate !== 'number' || op.collectionRate < 0 || op.collectionRate > 100) {
        return 'collectionRate must be 0-100';
      }
      if (op.parentId && !getSpace(db, op.parentId)) return `parent space not found: ${op.parentId}`;
      if (op.entityId && !getAccount(db, op.entityId)) return `entity account not found: ${op.entityId}`;
      return null;
    case 'supportive_tag_submit': {
      if (!Array.isArray(op.tags) || op.tags.length === 0) return 'tags[] is required';
      let total = 0;
      for (const t of op.tags) {
        if (!Number.isInteger(t.minutesUsed) || t.minutesUsed <= 0) return 'minutesUsed must be a positive integer';
        if (!getProduct(db, t.productId)) return `product not found: ${t.productId}`;
        total += t.minutesUsed;
      }
      if (total > 1440) return `total supportive minutes ${total} exceeds the 1,440 daily cap`;
      return null;
    }
    case 'ambient_tag_submit': {
      if (!Array.isArray(op.tags) || op.tags.length === 0) return 'tags[] is required';
      let total = 0;
      for (const t of op.tags) {
        if (!Number.isInteger(t.minutesOccupied) || t.minutesOccupied <= 0) return 'minutesOccupied must be a positive integer';
        if (!getSpace(db, t.spaceId)) return `space not found: ${t.spaceId}`;
        total += t.minutesOccupied;
      }
      if (total > 1440) return `total ambient minutes ${total} exceeds the 1,440 daily cap`;
      return null;
    }
  }
}

// ─── Persisted queue (mirror of pending_miner_operations) ──────────────────

export function enqueueTaggingOperation(db: DatabaseSync, op: TaggingOperation): number {
  const result = db
    .prepare(
      `INSERT INTO pending_tagging_operations (account_id, op_json, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(op.accountId, JSON.stringify(op), Math.floor(Date.now() / 1000));
  return Number(result.lastInsertRowid);
}

export function drainTaggingOperations(db: DatabaseSync, limit = 100): TaggingOperation[] {
  const rows = db
    .prepare(
      `SELECT op_json FROM pending_tagging_operations ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Array<{ op_json: string }>;
  return rows.map((r) => JSON.parse(r.op_json) as TaggingOperation);
}

export function removeAppliedTaggingOperations(db: DatabaseSync, applied: TaggingOperation[]): number {
  if (applied.length === 0) return 0;
  let removed = 0;
  const byAccount = new Map<string, Set<string>>();
  for (const op of applied) {
    const set = byAccount.get(op.accountId) ?? new Set<string>();
    set.add(canonicalBytesFor(op));
    byAccount.set(op.accountId, set);
  }
  for (const [accountId, canonicals] of byAccount) {
    const rows = db
      .prepare('SELECT id, op_json FROM pending_tagging_operations WHERE account_id = ?')
      .all(accountId) as Array<{ id: number; op_json: string }>;
    for (const row of rows) {
      try {
        const op = JSON.parse(row.op_json) as TaggingOperation;
        if (canonicals.has(canonicalBytesFor(op))) {
          db.prepare('DELETE FROM pending_tagging_operations WHERE id = ?').run(row.id);
          removed++;
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return removed;
}

export function pendingTaggingOperationCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM pending_tagging_operations').get() as { c: number };
  return r.c;
}
