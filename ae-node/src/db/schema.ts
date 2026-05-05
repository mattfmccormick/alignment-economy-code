import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 9;

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
    inheritance TEXT
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
    -- Receiver's countersignature on isInPerson transactions. NULL for
    -- normal (non-in-person) transactions. NOT NULL would break existing
    -- rows from before schema v8.
    receiver_signature TEXT,
    memo TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    block_number INTEGER,
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
    validator_changes TEXT
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
  CREATE INDEX IF NOT EXISTS idx_validators_active ON validators(is_active);
  CREATE INDEX IF NOT EXISTS idx_pending_changes_created ON pending_validator_changes(created_at);
`;

export function initializeSchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .all() as Array<{ name: string }>;

  if (rows.length === 0) {
    db.exec(TABLES);
    db.exec(INDEXES);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    db.prepare(
      "INSERT OR IGNORE INTO fee_pool (id, total_accumulated, total_distributed, current_balance) VALUES (1, '0', '0', '0')"
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO day_cycle_state (id, current_day, cycle_phase, phase_started_at) VALUES (1, 1, 'idle', ?)"
    ).run(Math.floor(Date.now() / 1000));
    return;
  }

  const current = db.prepare('SELECT version FROM schema_version').get() as { version: number };
  if (current.version < SCHEMA_VERSION) {
    runMigrations(db, current.version, SCHEMA_VERSION);
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
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
}
