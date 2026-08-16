// Deterministic fingerprint of the ledger's account state.
//
// Why this exists
// ---------------
// Blocks commit to their transactions (via merkleRoot) but not to the state
// those transactions produce. `computeBlockHash` covers number, previous hash,
// timestamp, merkle root, day, parent cert and validator changes — no balance
// or account commitment anywhere, and no stateRoot/appHash existed in the
// codebase at all.
//
// The consequence was that two nodes could disagree about every balance on the
// network and nothing would ever say so. Balance drift surfaced only
// indirectly, as a `Replay: insufficient <type> balance` throw the first time a
// divergent account happened to spend more than the lagging node thought it
// had. percentHuman drift produced no error whatsoever, ever, because
// `replayTransaction` takes netAmount off the wire verbatim and never
// re-derives the spend multiplier locally — so nodes silently converged on the
// proposer's arithmetic while holding different views of who is verified.
//
// Scope, deliberately
// -------------------
// The root is carried in the gossiped block payload and compared by receivers,
// and it is DIAGNOSTIC ONLY. It does not affect a vote and it is not folded
// into the block hash.
//
// That is not laziness, it is a correctness requirement. Account rows
// legitimately appear on different nodes at different moments: gossip delivers
// a new account to peers that are online, and the on-chain registration
// reaches everyone else only when a block carrying it commits. Two honest
// nodes therefore hold different state roots for a while, through nobody's
// fault.
//
// An earlier version of this voted NIL on a mismatch. That deadlocks the
// chain: a node that missed the gossip would reject every block, including the
// very block carrying the registration that would fix it — failing precisely
// in the situation the replication work exists to handle. Enforcing a state
// root requires the state to be a deterministic function of the chain alone,
// and account creation is not yet fully that.
//
// Enforcement belongs to the pre-vote dry run (see
// BftBlockProducer.dryRunTransactions), which asks the question that actually
// matters — can this node apply this block? — and correctly distinguishes "the
// proposer references an account I have never heard of" from "I am a few
// seconds behind on registrations".
//
// What this root does provide is audibility. Balance drift used to surface
// only as an incidental `Replay: insufficient <type> balance` throw, and
// percentHuman drift produced no signal at any point, ever. Now both produce a
// log line naming the likely cause.
//
// Making it enforceable is a real follow-up, and the order matters: first make
// account state a pure function of the chain (registrations are on-chain as of
// schema v13, but gossip still front-runs them), then fold a stateRootHash
// into computeBlockHash the way validatorChangesHash already is. Folding it in
// first would just move the deadlock into hash verification.

import { DatabaseSync } from 'node:sqlite';
import { sha256 } from './crypto.js';

/**
 * Hash every account's consensus-relevant fields into one 64-char digest.
 *
 * Ordered by id so the result does not depend on insertion order or on
 * SQLite's row layout. Balances are read as the TEXT they are stored as, which
 * keeps the digest exact — going through Number would silently lose precision
 * above 2^53 and make the root disagree between nodes for large balances,
 * which is precisely the bug class this is meant to catch.
 *
 * Included: id, type, percentHuman, and all five balances. These are the
 * fields consensus actually depends on.
 *
 * Excluded: createdAt and joinedDay (set locally, never re-derived from the
 * chain, and a replicated account legitimately carries the origin node's
 * values), plus anything cosmetic. Including a locally-set timestamp would
 * make the root differ between honest nodes and render it useless.
 */
export function computeStateRoot(db: DatabaseSync): string {
  const rows = db
    .prepare(
      `SELECT id, type, percent_human, active_balance, supportive_balance,
              ambient_balance, earned_balance, locked_balance
         FROM accounts
        ORDER BY id ASC`,
    )
    .all() as Array<{
      id: string;
      type: string;
      percent_human: number;
      active_balance: string;
      supportive_balance: string;
      ambient_balance: string;
      earned_balance: string;
      locked_balance: string;
    }>;

  // Pipe-delimited per row, newline between rows. Field values are hex ids,
  // enum-ish type strings and decimal integers, none of which can contain the
  // delimiters, so the encoding is unambiguous without escaping.
  const canonical = rows
    .map(
      (r) =>
        `${r.id}|${r.type}|${r.percent_human}|${r.active_balance}|${r.supportive_balance}|` +
        `${r.ambient_balance}|${r.earned_balance}|${r.locked_balance}`,
    )
    .join('\n');

  return sha256(`ae.stateRoot.v1\n${canonical}`);
}
