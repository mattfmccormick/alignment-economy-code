import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 16;

const TABLES = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('individual', 'company', 'government', 'ai_bot')),
    earned_balance TEXT NOT NULL DEFAULT '0',
    active_balance TEXT NOT NULL DEFAULT '0',
    supportive_balance TEXT NOT NULL DEFAULT '0',
    ambient_balance TEXT NOT NULL DEFAULT '0',
    locked_balance TEXT NOT NULL DEFAULT '0',
    percent_human INTEGER NOT NULL DEFAULT 0,
    joined_day INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    protection_window_end INTEGER,
    created_at INTEGER NOT NULL,
    -- Phase 69: dead-man-switch inheritance.
    --   last_activity_at: unix sec of the owner's last outbound action.
    --     NULL until the first such action. Drives the dead-man-switch.
    --   inheritance: JSON config or NULL when not configured. Shape:
    --     {beneficiaries:[id,...], threshold:n, deadManSwitchDays:d,
    --      configuredAt:ts}
    last_activity_at INTEGER,
    inheritance TEXT,
    is_escrowed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    amount TEXT NOT NULL,
    fee TEXT NOT NULL,
    net_amount TEXT NOT NULL,
    point_type TEXT NOT NULL CHECK(point_type IN ('active', 'supportive', 'ambient', 'earned')),
    is_in_person INTEGER NOT NULL DEFAULT 0,
    -- WP v2: sender attests the recipient is human. Each tag feeds the
    -- decay-offset engine weighted by the sender's percentHuman.
    recipient_is_human INTEGER NOT NULL DEFAULT 0,
    -- Receiver's countersignature on isInPerson transactions. NULL for
    -- normal (non-in-person) transactions. NOT NULL would break existing
    -- rows from before schema v8.
    receiver_signature TEXT,
    memo TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    block_number INTEGER,
    -- Has this transaction's effect on balances been applied? (schema v14)
    --
    -- Under receipt-time execution (the historical default) every accepted
    -- transaction moves balances the moment the API or gossip sees it, so
    -- every row is applied=1 and this column is inert.
    --
    -- Under commit-time execution the row is written applied=0 and no balance
    -- moves until the block carrying it commits. That is what makes state a
    -- function of the chain rather than of message arrival order — see
    -- AE_EXECUTION_MODE in node/config.ts for why that matters.
    applied INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY ("from") REFERENCES accounts(id),
    FOREIGN KEY ("to") REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS transaction_log (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    point_type TEXT NOT NULL,
    amount TEXT NOT NULL,
    balance_before TEXT NOT NULL,
    balance_after TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS fee_pool (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    total_accumulated TEXT NOT NULL DEFAULT '0',
    total_distributed TEXT NOT NULL DEFAULT '0',
    current_balance TEXT NOT NULL DEFAULT '0'
  );

  CREATE TABLE IF NOT EXISTS blocks (
    number INTEGER PRIMARY KEY,
    day INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    previous_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    merkle_root TEXT NOT NULL,
    transaction_count INTEGER NOT NULL,
    rebase_event TEXT,
    -- BFT commit certificate (JSON-encoded CommitCertificate). NULL for
    -- AuthorityConsensus blocks. Populated for every BFT-committed block;
    -- ChainSync uses this to ship a parent cert in sync replies so a fresh
    -- BFT validator can catch up to the chain head with full cert
    -- verification on every block.
    commit_certificate TEXT,
    -- Snapshot of the validator set at this block height (JSON-encoded
    -- ValidatorInfo[]). NULL for AuthorityConsensus and genesis. Used to
    -- verify a historical cert against the validators-as-they-were-then,
    -- not the current set — critical once validators get slashed or
    -- deregister, since their old precommit signatures must still
    -- verify when syncing past blocks.
    validator_snapshot TEXT,
    -- Hash of the parent block's commit certificate, folded into THIS
    -- block's canonical hash via computeBlockHash. Defense-in-depth on
    -- finality: tampering with a stored cert (swapping signatures,
    -- altering height/round, dropping a vote) changes computeCertHash
    -- and breaks every descendant block's hash. NULL for genesis,
    -- block 1 in BFT, and every AuthorityConsensus block.
    prev_commit_cert_hash TEXT,
    -- Validator-set changes carried by THIS block (Session 51). JSON-
    -- encoded ValidatorChange[]. NULL when no changes rode the block,
    -- which is the steady state — non-null only on the rare blocks
    -- that include register/deregister activity. Persisted so a node
    -- syncing past blocks can re-apply the changes and arrive at the
    -- correct CURRENT validator set.
    validator_changes TEXT,
    -- Accounts that joined the ledger in THIS block (schema v13). JSON-
    -- encoded AccountRegistration[]. NULL when none rode the block.
    --
    -- Before this existed, accounts were a purely local INSERT with no
    -- gossip and no transaction type, so an account lived only on the node
    -- whose API created it, and every other validator threw
    -- "Replay: sender account not found" on the first block referencing it.
    -- Gossip fixed the live case; persisting registrations in the block
    -- fixes the offline one, because a node syncing months later replays
    -- them from the chain like any other state change.
    account_registrations TEXT,
    -- Hash of account state as it stood AFTER this block was applied
    -- (schema v16). Same digest computeStateRoot produces.
    --
    -- Previously the root existed only in the gossip payload, so it was
    -- compared once at receive time and then discarded. Persisting it makes it
    -- (a) queryable, so two operators can compare a specific height instead of
    -- eyeballing live logs, and (b) the anchor a joining node checks a state
    -- snapshot against.
    --
    -- NOT yet folded into the block hash, so it is not consensus-enforced -
    -- see "the state root is diagnostic" in CLAUDE.md for why voting on it
    -- currently deadlocks the chain. Until it is, a snapshot verified against
    -- this value is only as trustworthy as the quorum of peers that agree on
    -- it, which is why the joiner cross-checks rather than trusting one peer.
    state_root TEXT
  );

  CREATE TABLE IF NOT EXISTS rebase_events (
    day INTEGER PRIMARY KEY,
    participant_count INTEGER NOT NULL,
    pre_rebase_total TEXT NOT NULL,
    target_total TEXT NOT NULL,
    rebase_multiplier REAL NOT NULL,
    post_rebase_total TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS day_cycle_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    current_day INTEGER NOT NULL DEFAULT 1,
    cycle_phase TEXT NOT NULL DEFAULT 'idle',
    phase_started_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS protocol_params (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    signature TEXT
  );

  CREATE TABLE IF NOT EXISTS protocol_param_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    signature TEXT
  );

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

  CREATE TABLE IF NOT EXISTS miners (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    tier INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    registered_at INTEGER NOT NULL,
    deactivated_at INTEGER,
    -- Was this miner admitted under the bootstrap exemption? (schema v15)
    --
    -- registerMiner lets the first "mining.bootstrap_miner_count" miners join
    -- below the 50% percentHuman floor, because a new network cannot raise a
    -- score without a panel, run a panel without a miner, or have a miner
    -- without a score. Nothing recorded WHY a miner was admitted, so the tier
    -- evaluator could not tell "never cleared the floor, admitted deliberately"
    -- apart from "cleared it once and has since fallen below" — and those two
    -- deserve opposite treatment. It deactivated both, which silently undid the
    -- exemption registration had just granted.
    --
    -- Set to 1 only when the exemption was actually used. Cleared the first
    -- time the miner reaches 50, so the grace ends at real verification rather
    -- than lasting forever.
    bootstrap_admitted INTEGER NOT NULL DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS court_cases (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    challenger_id TEXT NOT NULL,
    defendant_id TEXT NOT NULL,
    challenger_stake TEXT NOT NULL,
    challenger_stake_percent REAL NOT NULL,
    status TEXT NOT NULL,
    arbitration_deadline INTEGER,
    voting_deadline INTEGER,
    verdict TEXT,
    appeal_of TEXT,
    counterpart_id TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS court_jury (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    miner_id TEXT NOT NULL,
    juror_account_id TEXT NOT NULL,
    stake_amount TEXT NOT NULL,
    vote TEXT,
    voted_at INTEGER,
    FOREIGN KEY (case_id) REFERENCES court_cases(id)
  );

  -- Append-only log of arguments (text submissions) made by the challenger or
  -- defendant on a case. Both sides can post until the verdict resolves; jurors
  -- read these alongside the case header before voting. attachment_hash is for
  -- future use (off-chain file refs); the 2-person test uses text only.
  CREATE TABLE IF NOT EXISTS court_arguments (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    submitter_id TEXT NOT NULL,
    role TEXT NOT NULL,                -- 'challenger' | 'defendant'
    text TEXT NOT NULL,
    attachment_hash TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (case_id) REFERENCES court_cases(id)
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    manufacturer_id TEXT,
    created_by TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    entity_id TEXT,
    collection_rate REAL NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS supportive_tags (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    product_id TEXT NOT NULL,
    minutes_used INTEGER NOT NULL,
    points_allocated TEXT NOT NULL DEFAULT '0',
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS ambient_tags (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    space_id TEXT NOT NULL,
    minutes_occupied INTEGER NOT NULL,
    points_allocated TEXT NOT NULL DEFAULT '0',
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (space_id) REFERENCES spaces(id)
  );

  CREATE TABLE IF NOT EXISTS smart_contracts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    schedule TEXT NOT NULL DEFAULT 'daily',
    start_minute INTEGER,
    end_minute INTEGER,
    days_of_week TEXT,
    allocation_percent REAL NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    overridden_today INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    contact_account_id TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES accounts(id),
    FOREIGN KEY (contact_account_id) REFERENCES accounts(id),
    UNIQUE(owner_id, contact_account_id)
  );

  CREATE TABLE IF NOT EXISTS recurring_transfers (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    point_type TEXT NOT NULL DEFAULT 'active',
    schedule TEXT NOT NULL DEFAULT 'daily',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_executed_day INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (from_id) REFERENCES accounts(id),
    FOREIGN KEY (to_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS vouch_requests (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    FOREIGN KEY (from_id) REFERENCES accounts(id),
    FOREIGN KEY (to_id) REFERENCES accounts(id)
  );

  -- WP v2: human-tag credits. When a sender marks recipientIsHuman=true
  -- on a transaction, we snapshot the tagger's percentHuman and compute
  -- the credit (2.5 * tagger_ph / 100). The decay engine sums credits
  -- in the window instead of counting in-person transactions.
  CREATE TABLE IF NOT EXISTS human_tags (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL,
    tagger_id TEXT NOT NULL,
    tagger_percent_human INTEGER NOT NULL,
    credit REAL NOT NULL,
    transaction_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (recipient_id) REFERENCES accounts(id),
    FOREIGN KEY (tagger_id) REFERENCES accounts(id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  );

  -- Phase-3 BFT consensus validators.
  --
  -- A row in this table means: this account has staked some earned points
  -- and registered cryptographic keys to participate in block proposing
  -- and voting. The validator set is the set of rows where is_active=1.
  --
  -- Why three keys per validator:
  --   account_id          : ML-DSA-65 account, signs transactions (existing column)
  --   node_public_key     : Ed25519 P2P-layer key, signs handshakes + gossip
  --                         (Session 8). Identifies them on the wire.
  --   vrf_public_key      : Ed25519 VRF key, used by the lottery / proposer
  --                         selection. Same construction as Ed25519VrfProvider.
  --
  -- Stake is locked when registering and unlocked on deregister. Slashing
  -- (forfeiting stake for misbehavior) lives in a future session.
  CREATE TABLE IF NOT EXISTS validators (
    account_id TEXT PRIMARY KEY,
    node_public_key TEXT NOT NULL UNIQUE,
    vrf_public_key TEXT NOT NULL UNIQUE,
    stake TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    registered_at INTEGER NOT NULL,
    deregistered_at INTEGER,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  -- Pending validator changes that haven't yet ridden a block.
  --
  -- Session 49: when a validator-change request lands (via API or
  -- direct enqueue), it goes here first. The BFT proposer drains the
  -- queue when building each candidate block, including the changes
  -- in the block payload. After the block commits on every node, the
  -- proposer's onValidatorChangesApplied callback removes the drained
  -- entries from this table.
  --
  -- The table is local-only — every operator has their own queue. A
  -- change submitted to operator A's API enters A's queue; only when
  -- A is the proposer does it land in a block. Other operators don't
  -- see the queue, but they DO see the change once the block lands
  -- (and they apply it via the block payload, no queue interaction).
  --
  -- The change_json field holds the full signed ValidatorChange. We
  -- store as JSON because the shape varies by change.type (register
  -- has nodePublicKey/vrfPublicKey/stake; deregister doesn't).
  -- created_at gives the proposer a deterministic FIFO order to drain.
  CREATE TABLE IF NOT EXISTS pending_validator_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    change_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Accounts created locally via POST /accounts and awaiting inclusion in a
  -- block this node proposes (schema v13). Same shape and lifecycle as
  -- pending_validator_changes: only the proposer's own queue feeds a block,
  -- but every node applies the result from the block payload, so all nodes
  -- converge without anyone reading anyone else's queue.
  CREATE TABLE IF NOT EXISTS pending_account_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL UNIQUE,
    registration_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions("from");
  CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions("to");
  CREATE INDEX IF NOT EXISTS idx_transactions_block ON transactions(block_number);
  CREATE INDEX IF NOT EXISTS idx_transaction_log_account ON transaction_log(account_id);
  CREATE INDEX IF NOT EXISTS idx_transaction_log_type ON transaction_log(change_type);
  CREATE INDEX IF NOT EXISTS idx_blocks_day ON blocks(day);
  CREATE INDEX IF NOT EXISTS idx_evidence_account ON verification_evidence(account_id);
  CREATE INDEX IF NOT EXISTS idx_panels_account ON verification_panels(account_id);
  CREATE INDEX IF NOT EXISTS idx_panels_status ON verification_panels(status);
  CREATE INDEX IF NOT EXISTS idx_vouches_vouched ON vouches(vouched_id);
  CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON vouches(voucher_id);
  CREATE INDEX IF NOT EXISTS idx_vouches_active ON vouches(is_active);
  CREATE INDEX IF NOT EXISTS idx_heartbeats_miner ON miner_heartbeats(miner_id);
  CREATE INDEX IF NOT EXISTS idx_heartbeats_time ON miner_heartbeats(timestamp);
  CREATE INDEX IF NOT EXISTS idx_miners_active ON miners(is_active);
  CREATE INDEX IF NOT EXISTS idx_miners_tier ON miners(tier);
  CREATE INDEX IF NOT EXISTS idx_miner_assignments ON miner_verification_assignments(miner_id);
  CREATE INDEX IF NOT EXISTS idx_court_cases_defendant ON court_cases(defendant_id);
  CREATE INDEX IF NOT EXISTS idx_court_cases_status ON court_cases(status);
  CREATE INDEX IF NOT EXISTS idx_court_jury_case ON court_jury(case_id);
  CREATE INDEX IF NOT EXISTS idx_court_arguments_case ON court_arguments(case_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON products(manufacturer_id);
  CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id);
  CREATE INDEX IF NOT EXISTS idx_supportive_tags_account_day ON supportive_tags(account_id, day);
  CREATE INDEX IF NOT EXISTS idx_ambient_tags_account_day ON ambient_tags(account_id, day);
  CREATE INDEX IF NOT EXISTS idx_smart_contracts_account ON smart_contracts(account_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_favorite ON contacts(owner_id, is_favorite);
  CREATE INDEX IF NOT EXISTS idx_recurring_from ON recurring_transfers(from_id);
  CREATE INDEX IF NOT EXISTS idx_vouch_requests_to ON vouch_requests(to_id);
  CREATE INDEX IF NOT EXISTS idx_human_tags_recipient ON human_tags(recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_validators_active ON validators(is_active);
  CREATE INDEX IF NOT EXISTS idx_pending_changes_created ON pending_validator_changes(created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_account_regs_created ON pending_account_registrations(created_at);
`;

export function initializeSchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .all() as Array<{ name: string }>;

  // The version row, if the table exists at all. Read as possibly-undefined:
  // a table that exists does NOT guarantee a row in it.
  const current =
    rows.length === 0
      ? undefined
      : (db.prepare('SELECT version FROM schema_version').get() as
          | { version: number }
          | undefined);

  if (current === undefined) {
    // Either a genuinely fresh database, or a half-initialised one where the
    // tables exist but the version row does not.
    //
    // That second state is reachable: the init below creates every table and
    // only then inserts the version, so a process that dies in between leaves
    // exactly this. It used to crash on `undefined.version` with a TypeError
    // pointing into schema.ts, which tells an operator nothing about what is
    // wrong or how to fix it — and it recurs on every subsequent start, so the
    // node is permanently unbootable until someone deletes the file.
    //
    // Distinguish the two cases before assuming it is safe to stamp the
    // current version. A database carrying real data with no version row is
    // NOT something to guess at: claiming SCHEMA_VERSION would skip every
    // migration and silently leave the schema behind the code.
    if (rows.length > 0 && hasUserData(db)) {
      throw new Error(
        'Database has tables and data but no schema_version row, so its schema ' +
          'version cannot be determined. Migrating blind would skip migrations ' +
          'and corrupt the schema. This usually means the file was edited or ' +
          'restored by hand. Restore a known-good backup, or start from a fresh ' +
          'database if there is nothing worth keeping.',
      );
    }

    // Atomic: a crash partway through leaves no tables at all rather than the
    // half-initialised state described above, so a retry takes the clean path.
    db.exec('BEGIN');
    try {
      db.exec(TABLES);
      db.exec(INDEXES);
      // DELETE first so a retry after a partial init cannot leave two rows.
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
      db.prepare(
        "INSERT OR IGNORE INTO fee_pool (id, total_accumulated, total_distributed, current_balance) VALUES (1, '0', '0', '0')"
      ).run();
      db.prepare(
        "INSERT OR IGNORE INTO day_cycle_state (id, current_day, cycle_phase, phase_started_at) VALUES (1, 1, 'idle', ?)"
      ).run(Math.floor(Date.now() / 1000));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return;
  }

  if (current.version < SCHEMA_VERSION) {
    runMigrations(db, current.version, SCHEMA_VERSION);
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

/**
 * Does this database hold anything an operator would miss?
 *
 * Used only to tell "half-initialised, safe to set up" apart from "real data
 * with a missing version row, do not touch". Checks accounts and blocks
 * because either being non-empty means the node has real history.
 */
function hasUserData(db: DatabaseSync): boolean {
  for (const table of ['accounts', 'blocks']) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) continue;
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    if (row.c > 0) return true;
  }
  return false;
}

function runMigrations(db: DatabaseSync, from: number, _to: number): void {
  if (from < 2) {
    db.exec(TABLES);
    db.exec(INDEXES);
  }
  if (from < 3) {
    // Add contacts, recurring transfers, vouch requests
    db.exec(TABLES); // CREATE IF NOT EXISTS is safe to re-run
    db.exec(INDEXES);
  }
  if (from < 4) {
    // Add blocks.prev_commit_cert_hash for cert-in-block-hash promotion.
    // ALTER TABLE ADD COLUMN is the only safe way to add a column to an
    // existing blocks table; CREATE TABLE IF NOT EXISTS won't run.
    // Existing rows get NULL, which is the correct historical value
    // (those blocks were hashed without a cert hash, and null produces
    // the same hash as the legacy 5-arg form via empty-string concat).
    const cols = db
      .prepare("PRAGMA table_info(blocks)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'prev_commit_cert_hash')) {
      db.exec('ALTER TABLE blocks ADD COLUMN prev_commit_cert_hash TEXT');
    }
  }
  if (from < 5) {
    // Session 49: pending_validator_changes table. CREATE TABLE IF NOT
    // EXISTS in TABLES is idempotent so re-execing TABLES + INDEXES is
    // safe — the new table appears, existing tables are untouched.
    db.exec(TABLES);
    db.exec(INDEXES);
  }
  if (from < 6) {
    // Session 51: blocks.validator_changes column. ALTER TABLE for
    // existing block rows; new rows get NULL when no changes ride
    // the block. NULL stored vs. empty list is intentional — most
    // blocks will not carry any validator changes at all.
    const cols = db
      .prepare("PRAGMA table_info(blocks)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'validator_changes')) {
      db.exec('ALTER TABLE blocks ADD COLUMN validator_changes TEXT');
    }
  }
  if (from < 7) {
    // court_arguments table: append-only log of text submissions by the
    // challenger or defendant on a court case. We CREATE the new table
    // explicitly here rather than re-exec'ing the full TABLES string, which
    // observed-flakily fails to add the trailing new table on some upgrade
    // paths through node:sqlite's multi-statement parser.
    db.exec(`
      CREATE TABLE IF NOT EXISTS court_arguments (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        submitter_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        attachment_hash TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (case_id) REFERENCES court_cases(id)
      );
      CREATE INDEX IF NOT EXISTS idx_court_arguments_case ON court_arguments(case_id, created_at);
    `);
  }
  if (from < 8) {
    // transactions.receiver_signature column. The whitepaper requires both
    // parties to dual-sign an in-person tx (sender + receiver). Pre-v8 rows
    // had only the sender's sig, so we ALTER instead of recreate. New rows
    // populate this when isInPerson=true; non-in-person rows leave it NULL.
    const cols = db
      .prepare("PRAGMA table_info(transactions)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'receiver_signature')) {
      db.exec('ALTER TABLE transactions ADD COLUMN receiver_signature TEXT');
    }
  }
  if (from < 9) {
    // accounts.last_activity_at + accounts.inheritance columns. Adds
    // dead-man-switch inheritance support per whitepaper §10. Existing
    // rows get NULL for both, matching the no-inheritance-configured
    // default; the dead-man-switch can't fire on a NULL config.
    const cols = db
      .prepare("PRAGMA table_info(accounts)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'last_activity_at')) {
      db.exec('ALTER TABLE accounts ADD COLUMN last_activity_at INTEGER');
    }
    if (!cols.some((c) => c.name === 'inheritance')) {
      db.exec('ALTER TABLE accounts ADD COLUMN inheritance TEXT');
    }
  }
  if (from < 10) {
    // WP v2: recipientIsHuman tag on transactions + human_tags table.
    const txCols = db
      .prepare("PRAGMA table_info(transactions)")
      .all() as Array<{ name: string }>;
    if (!txCols.some((c) => c.name === 'recipient_is_human')) {
      db.exec('ALTER TABLE transactions ADD COLUMN recipient_is_human INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS human_tags (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL,
        tagger_id TEXT NOT NULL,
        tagger_percent_human INTEGER NOT NULL,
        credit REAL NOT NULL,
        transaction_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (recipient_id) REFERENCES accounts(id),
        FOREIGN KEY (tagger_id) REFERENCES accounts(id),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_human_tags_recipient ON human_tags(recipient_id, created_at);
    `);
  }
  if (from < 11) {
    // WP v2 court escrow: freeze defendant's earned outbound transfers
    // while a challenge is pending. The column defaults to 0 (not escrowed).
    const cols = db
      .prepare("PRAGMA table_info(accounts)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'is_escrowed')) {
      db.exec('ALTER TABLE accounts ADD COLUMN is_escrowed INTEGER NOT NULL DEFAULT 0');
    }
  }
  if (from < 12) {
    // WP §9.3 duplicate-account cases: the counterpart is the earlier
    // (surviving) account the defendant duplicates. NULL for not_human cases.
    const cols = db
      .prepare("PRAGMA table_info(court_cases)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'counterpart_id')) {
      db.exec('ALTER TABLE court_cases ADD COLUMN counterpart_id TEXT');
    }
  }
  if (from < 13) {
    // On-chain account registrations. Two parts: a column on blocks holding
    // the accounts that joined in that block, and the proposer's pending
    // queue feeding it.
    //
    // Existing block rows get NULL, which is the correct historical value —
    // those blocks were hashed without a registrations hash, and null
    // produces the same digest as the previous form via empty-string concat,
    // so every already-committed block still verifies unchanged.
    const cols = db.prepare('PRAGMA table_info(blocks)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'account_registrations')) {
      db.exec('ALTER TABLE blocks ADD COLUMN account_registrations TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_account_registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL UNIQUE,
        registration_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_account_regs_created
        ON pending_account_registrations(created_at);
    `);
  }
  if (from < 16) {
    // blocks.state_root. Existing rows get NULL, which is correct: those blocks
    // were committed before the root was recorded, and it cannot be
    // reconstructed after the fact without replaying the whole chain.
    const cols = db.prepare('PRAGMA table_info(blocks)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'state_root')) {
      db.exec('ALTER TABLE blocks ADD COLUMN state_root TEXT');
    }
  }
  if (from < 15) {
    // miners.bootstrap_admitted. Existing rows default to 0, which is the safe
    // reading: they are treated as ordinary miners and the percentHuman floor
    // applies to them normally. A miner genuinely admitted under the exemption
    // before this column existed will be deactivated once and can re-register,
    // which is preferable to blanket-exempting every historical miner.
    const cols = db.prepare('PRAGMA table_info(miners)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'bootstrap_admitted')) {
      db.exec('ALTER TABLE miners ADD COLUMN bootstrap_admitted INTEGER NOT NULL DEFAULT 0');
    }
  }
  if (from < 14) {
    // transactions.applied, for commit-time execution.
    //
    // DEFAULT 1 is the correct historical value: every existing row was
    // applied to balances the moment it was accepted, because receipt-time
    // execution was the only mode. Defaulting to 0 would make the node think
    // the entire chain's history was unapplied and re-apply it on the next
    // block, doubling every balance.
    const cols = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'applied')) {
      db.exec('ALTER TABLE transactions ADD COLUMN applied INTEGER NOT NULL DEFAULT 1');
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(applied, "from")',
    );
  }
}
