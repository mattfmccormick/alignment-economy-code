import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { sha256 } from '../core/crypto.js';
import { getAccount, updateBalance, deactivateAccount } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { addToFeePool } from '../core/fee-pool.js';
import { runTransaction } from '../db/connection.js';
import { getParam } from '../config/params.js';
import { getMinerByAccount, getActiveMiners, getMiner, setMinerTier, miningStore } from '../mining/registration.js';
import { burnAllVouchesOnAccount } from '../verification/vouching.js';
import { getCompositeAccuracy } from '../mining/accuracy.js';
import { SqliteCourtStore } from '../core/stores/SqliteCourtStore.js';
import type { ICourtStore } from '../core/stores/ICourtStore.js';
import type { CourtCase, CaseType, Vote, Verdict, JuryAssignment, CaseArgument, ArgumentRole } from './types.js';

export function courtStore(db: DatabaseSync): ICourtStore {
  return new SqliteCourtStore(db);
}

// ========== Schema ==========

export function initializeCourtSchema(db: DatabaseSync): void {
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_court_cases_defendant ON court_cases(defendant_id);
    CREATE INDEX IF NOT EXISTS idx_court_cases_status ON court_cases(status);
    CREATE INDEX IF NOT EXISTS idx_court_jury_case ON court_jury(case_id);
  `);
}

// ========== File Challenge ==========

export function fileChallenge(
  db: DatabaseSync,
  challengerAccountId: string,
  defendantAccountId: string,
  caseType: CaseType,
  stakePercent: number,
  openingArgument?: string,
): CourtCase {
  // Verify challenger is an active miner
  const miner = getMinerByAccount(db, challengerAccountId);
  if (!miner) throw new Error('Only active miners can file challenges');

  const challenger = getAccount(db, challengerAccountId)!;
  const defendant = getAccount(db, defendantAccountId);
  if (!defendant) throw new Error('Defendant account not found');
  if (!defendant.isActive) throw new Error('Defendant account is inactive');
  if (challengerAccountId === defendantAccountId) throw new Error('Cannot challenge yourself');

  const store = courtStore(db);

  // Protection window
  const state = db.prepare('SELECT current_day FROM day_cycle_state WHERE id = 1').get() as { current_day: number };
  if (defendant.protectionWindowEnd && state.current_day <= defendant.protectionWindowEnd) {
    throw new Error(`Account in protection window until day ${defendant.protectionWindowEnd}`);
  }

  // No active case against defendant
  if (store.findActiveCaseAgainst(defendantAccountId)) {
    throw new Error('Active case already exists against this defendant');
  }

  if (stakePercent < 1) throw new Error('Minimum stake is 1%');

  const stakeAmount = (challenger.earnedBalance * BigInt(Math.round(stakePercent * 100))) / 10000n;
  if (stakeAmount > challenger.earnedBalance) throw new Error('Insufficient balance for stake');

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  const arbDays = getParam<number>(db, 'court.arbitration_response_days');
  const deadline = now + arbDays * 86400;

  runTransaction(db, () => {
    // Lock stake
    const newEarned = challenger.earnedBalance - stakeAmount;
    const newLocked = challenger.lockedBalance + stakeAmount;
    updateBalance(db, challengerAccountId, 'earned_balance', newEarned);
    updateBalance(db, challengerAccountId, 'locked_balance', newLocked);
    recordLog(db, challengerAccountId, 'vouch_lock', 'earned', stakeAmount, challenger.earnedBalance, newEarned, id, now);

    store.insertCase({
      id,
      type: caseType,
      level: 'arbitration',
      challengerId: challengerAccountId,
      defendantId: defendantAccountId,
      challengerStake: stakeAmount,
      challengerStakePercent: stakePercent,
      status: 'arbitration_open',
      arbitrationDeadline: deadline,
      votingDeadline: null,
      appealOf: null,
      createdAt: now,
    });

    // Persist the challenger's opening argument as the first row in the case's
    // argument log. Optional but encouraged: a challenge without context gives
    // the defendant nothing to respond to and the jury nothing to weigh.
    if (openingArgument && openingArgument.trim()) {
      insertArgument(db, {
        id: uuid(),
        caseId: id,
        submitterId: challengerAccountId,
        role: 'challenger',
        text: openingArgument.trim(),
        attachmentHash: null,
        createdAt: now,
      });
    }
  });

  return getCase(db, id)!;
}

// ========== Arguments / Evidence ==========
//
// Arguments are the case's discussion log. Both sides can post text rebuttals
// at any time before the verdict is final; jurors read them before voting.
// We store them as an append-only list, so even after a verdict the trail
// stays auditable. attachment_hash is reserved for future off-chain file
// references (we don't host files in the protocol layer).

function insertArgument(db: DatabaseSync, arg: CaseArgument): void {
  db.prepare(
    `INSERT INTO court_arguments (id, case_id, submitter_id, role, text, attachment_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    arg.id, arg.caseId, arg.submitterId, arg.role, arg.text,
    arg.attachmentHash, arg.createdAt,
  );
}

export function submitArgument(
  db: DatabaseSync,
  caseId: string,
  submitterAccountId: string,
  text: string,
  attachmentHash?: string,
): CaseArgument {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new Error('Case not found');

  // Only the parties can post; jurors and onlookers cannot. Prevents the
  // jury pool from prejudicing the case from the bench.
  let role: ArgumentRole;
  if (submitterAccountId === courtCase.challengerId) role = 'challenger';
  else if (submitterAccountId === courtCase.defendantId) role = 'defendant';
  else throw new Error('Only the challenger or defendant can submit arguments');

  // Once the verdict is in, the case is closed for new arguments. Earlier
  // statuses (arbitration_open, court_voting, etc.) are all open for posting.
  if (courtCase.verdict !== null || courtCase.status === 'closed' || courtCase.status === 'withdrawn') {
    throw new Error(`Case is no longer open for arguments (status: ${courtCase.status})`);
  }

  const trimmed = text.trim();
  if (!trimmed) throw new Error('Argument text is required');
  if (trimmed.length > 5000) throw new Error('Argument text exceeds 5,000 character limit');

  const arg: CaseArgument = {
    id: uuid(),
    caseId,
    submitterId: submitterAccountId,
    role,
    text: trimmed,
    attachmentHash: attachmentHash ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  };
  insertArgument(db, arg);
  return arg;
}

export function getArgumentsForCase(db: DatabaseSync, caseId: string): CaseArgument[] {
  const rows = db.prepare(
    `SELECT id, case_id, submitter_id, role, text, attachment_hash, created_at
     FROM court_arguments WHERE case_id = ? ORDER BY created_at ASC`,
  ).all(caseId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    caseId: r.case_id as string,
    submitterId: r.submitter_id as string,
    role: r.role as ArgumentRole,
    text: r.text as string,
    attachmentHash: (r.attachment_hash as string | null) ?? null,
    createdAt: r.created_at as number,
  }));
}

export function getCase(db: DatabaseSync, caseId: string): CourtCase | null {
  return courtStore(db).findCaseById(caseId);
}

// ========== Escalate to Court ==========

export function escalateToFull(db: DatabaseSync, caseId: string): CourtCase {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new Error('Case not found');
  if (courtCase.level !== 'arbitration') throw new Error('Can only escalate from arbitration');

  courtStore(db).setLevelToCourt(caseId);

  return getCase(db, caseId)!;
}

// ========== Jury Selection ==========

export function selectJury(db: DatabaseSync, caseId: string, blockHash: string): string[] {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new Error('Case not found');

  const jurySize = getParam<number>(db, 'court.jury_size');
  const jurorStakePercent = getParam<number>(db, 'court.juror_stake_percent');
  const votingDays = getParam<number>(db, 'court.court_voting_days');
  const now = Math.floor(Date.now() / 1000);

  // Get eligible Tier 2 miners, excluding conflicts
  let pool = getActiveMiners(db, 2);

  // Exclude challenger's miner record
  pool = pool.filter((m) => m.accountId !== courtCase.challengerId);

  // Exclude miners with tx history with either party
  pool = pool.filter((m) => {
    const txCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM transactions
       WHERE ("from" = ? AND "to" IN (?, ?)) OR ("to" = ? AND "from" IN (?, ?))`
    ).get(m.accountId, courtCase.challengerId, courtCase.defendantId, m.accountId, courtCase.challengerId, courtCase.defendantId) as { cnt: number };
    return txCount.cnt === 0;
  });

  // Exclude prior jurors on this case and any related cases (for appeals)
  const store = courtStore(db);
  const relatedCaseIds = [caseId];
  if (courtCase.appealOf) {
    relatedCaseIds.push(courtCase.appealOf);
  }
  // Also check if any appeal references this case
  for (const ac of store.findAppealsOf(caseId)) relatedCaseIds.push(ac.id);

  const priorSet = new Set<string>();
  for (const rid of relatedCaseIds) {
    for (const minerId of store.findJurorMinerIds(rid)) priorSet.add(minerId);
  }
  pool = pool.filter((m) => !priorSet.has(m.id));

  if (pool.length < 3) {
    store.setStatusWaitingJury(caseId);
    return [];
  }

  // Deterministic random selection
  const seed = sha256(caseId + blockHash);
  const selected: typeof pool = [];
  const targetSize = Math.min(jurySize, pool.length);
  // Make it odd
  const actualSize = targetSize % 2 === 0 ? targetSize - 1 : targetSize;

  // Shuffle deterministically using seed
  const indexed = pool.map((m, i) => ({
    miner: m,
    sortKey: sha256(seed + i.toString()),
  }));
  indexed.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const jurorIds: string[] = [];

  runTransaction(db, () => {
    for (let i = 0; i < actualSize; i++) {
      const miner = indexed[i].miner;
      const acct = getAccount(db, miner.accountId)!;
      const stake = (acct.earnedBalance * BigInt(jurorStakePercent)) / 100n;

      if (stake === 0n || stake > acct.earnedBalance) continue; // skip if can't stake

      // Lock juror stake
      const newEarned = acct.earnedBalance - stake;
      const newLocked = acct.lockedBalance + stake;
      updateBalance(db, miner.accountId, 'earned_balance', newEarned);
      updateBalance(db, miner.accountId, 'locked_balance', newLocked);
      recordLog(db, miner.accountId, 'vouch_lock', 'earned', stake, acct.earnedBalance, newEarned, caseId, now);

      store.insertJuror({
        id: uuid(),
        caseId,
        minerId: miner.id,
        jurorAccountId: miner.accountId,
        stakeAmount: stake,
      });

      jurorIds.push(miner.id);
    }

    store.setStatusVoting(caseId, now + votingDays * 86400);
  });

  return jurorIds;
}

// ========== Voting ==========

export function submitVote(db: DatabaseSync, caseId: string, minerId: string, vote: Vote): void {
  const store = courtStore(db);
  const juror = store.findJurorByMiner(caseId, minerId);
  if (!juror) throw new Error('Miner is not a juror on this case');
  if (juror.vote) throw new Error('Already voted');

  store.recordVote(caseId, minerId, vote, Math.floor(Date.now() / 1000));
}

// ========== Verdict ==========

export function resolveVerdict(db: DatabaseSync, caseId: string): Verdict {
  const store = courtStore(db);
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new Error('Case not found');

  const jurors = store.findJurorsByCase(caseId);
  const votes = jurors.filter((j) => j.vote !== null);

  if (votes.length === 0) throw new Error('No votes cast');

  const humanVotes = votes.filter((j) => j.vote === 'human').length;
  const notHumanVotes = votes.filter((j) => j.vote === 'not_human').length;

  // Tie = dismissed (innocent)
  const verdict: Verdict = notHumanVotes > humanVotes ? 'guilty' : 'innocent';
  const now = Math.floor(Date.now() / 1000);
  const finalStatus = courtCase.level === 'appeal' ? 'appeal_verdict' : 'court_verdict';

  runTransaction(db, () => {
    store.setVerdict(caseId, verdict, finalStatus, now);

    if (verdict === 'guilty') {
      applyGuiltyVerdict(db, courtCase, jurors, now);
    } else {
      applyInnocentVerdict(db, courtCase, jurors, now);
    }
  });

  return verdict;
}

function applyGuiltyVerdict(
  db: DatabaseSync,
  courtCase: CourtCase,
  jurors: import('./types.js').JurorRecord[],
  now: number,
): void {
  const defendant = getAccount(db, courtCase.defendantId)!;
  const bountyPercent = getParam<number>(db, 'court.bounty_percent');
  const burnPercent = getParam<number>(db, 'court.burn_percent');

  const bountyAmount = (defendant.earnedBalance * BigInt(bountyPercent)) / 100n;
  const burnAmount = (defendant.earnedBalance * BigInt(burnPercent)) / 100n;

  // Close defendant account
  deactivateAccount(db, courtCase.defendantId);

  // Pay bounty to challenger
  const challenger = getAccount(db, courtCase.challengerId)!;
  const newChallengerEarned = challenger.earnedBalance + bountyAmount;
  updateBalance(db, courtCase.challengerId, 'earned_balance', newChallengerEarned);
  recordLog(db, courtCase.challengerId, 'bounty', 'earned', bountyAmount, challenger.earnedBalance, newChallengerEarned, courtCase.id, now);

  // Burn defendant balance. Whatever wasn't paid as bounty routes into the
  // fee pool so miners pick it up across subsequent blocks. At small scale
  // pure deflation would empty the network in a single case; this keeps
  // total supply conserved while preserving the deterrent (the defendant
  // still loses everything).
  updateBalance(db, courtCase.defendantId, 'earned_balance', 0n);
  recordLog(db, courtCase.defendantId, 'court_burn', 'earned', defendant.earnedBalance, defendant.earnedBalance, 0n, courtCase.id, now);
  const burnToPool = defendant.earnedBalance - bountyAmount;
  if (burnToPool > 0n) {
    addToFeePool(db, burnToPool);
  }

  // Return challenger stake
  const challengerAfterBounty = getAccount(db, courtCase.challengerId)!;
  const unlockedEarned = challengerAfterBounty.earnedBalance + courtCase.challengerStake;
  const unlockedLocked = challengerAfterBounty.lockedBalance - courtCase.challengerStake;
  updateBalance(db, courtCase.challengerId, 'earned_balance', unlockedEarned);
  updateBalance(db, courtCase.challengerId, 'locked_balance', unlockedLocked);
  recordLog(db, courtCase.challengerId, 'vouch_unlock', 'earned', courtCase.challengerStake, challengerAfterBounty.earnedBalance, unlockedEarned, courtCase.id, now);

  // Burn voucher stakes on defendant
  burnAllVouchesOnAccount(db, courtCase.defendantId);

  // Juror stakes: majority returned, minority burned
  const majorityVote: Vote = 'not_human'; // guilty = not_human won
  processJurorStakes(db, jurors, majorityVote, courtCase.id, now);
}

function applyInnocentVerdict(
  db: DatabaseSync,
  courtCase: CourtCase,
  jurors: import('./types.js').JurorRecord[],
  now: number,
): void {
  // Burn challenger stake (frivolous-challenge deterrent). Routes to the
  // fee pool rather than disappearing.
  const challenger = getAccount(db, courtCase.challengerId)!;
  const newLocked = challenger.lockedBalance - courtCase.challengerStake;
  updateBalance(db, courtCase.challengerId, 'locked_balance', newLocked);
  recordLog(db, courtCase.challengerId, 'vouch_burn', 'earned', courtCase.challengerStake, challenger.lockedBalance, newLocked, courtCase.id, now);
  if (courtCase.challengerStake > 0n) {
    addToFeePool(db, courtCase.challengerStake);
  }

  // Set protection window
  const protectionDays = getParam<number>(db, 'court.protection_window_days');
  const state = db.prepare('SELECT current_day FROM day_cycle_state WHERE id = 1').get() as { current_day: number };
  db.prepare('UPDATE accounts SET protection_window_end = ? WHERE id = ?').run(
    state.current_day + protectionDays, courtCase.defendantId,
  );

  // Juror stakes: majority returned, minority burned
  const majorityVote: Vote = 'human';
  processJurorStakes(db, jurors, majorityVote, courtCase.id, now);
}

function processJurorStakes(
  db: DatabaseSync,
  jurors: import('./types.js').JurorRecord[],
  majorityVote: Vote,
  caseId: string,
  now: number,
): void {
  for (const juror of jurors) {
    if (!juror.vote) continue; // abstained, stake returned
    const stake = juror.stakeAmount;
    const acctId = juror.jurorAccountId;
    const acct = getAccount(db, acctId)!;

    if (juror.vote === majorityVote) {
      // Return stake
      const newEarned = acct.earnedBalance + stake;
      const newLocked = acct.lockedBalance - stake;
      updateBalance(db, acctId, 'earned_balance', newEarned);
      updateBalance(db, acctId, 'locked_balance', newLocked);
      recordLog(db, acctId, 'vouch_unlock', 'earned', stake, acct.earnedBalance, newEarned, caseId, now);
    } else {
      // Burn stake (minority juror loses to fee pool, not the void).
      const newLocked = acct.lockedBalance - stake;
      updateBalance(db, acctId, 'locked_balance', newLocked);
      recordLog(db, acctId, 'vouch_burn', 'earned', stake, acct.lockedBalance, newLocked, caseId, now);
      if (stake > 0n) {
        addToFeePool(db, stake);
      }
    }
  }
}

// ========== Protection Window ==========

export function isInProtectionWindow(db: DatabaseSync, accountId: string): boolean {
  const acct = getAccount(db, accountId);
  if (!acct || !acct.protectionWindowEnd) return false;
  const state = db.prepare('SELECT current_day FROM day_cycle_state WHERE id = 1').get() as { current_day: number };
  return state.current_day <= acct.protectionWindowEnd;
}

export function getActiveCases(db: DatabaseSync): CourtCase[] {
  return courtStore(db).findActiveCases();
}

// ========== Appeals ==========

export function fileAppeal(db: DatabaseSync, caseId: string, blockHash: string): CourtCase {
  const store = courtStore(db);
  const original = getCase(db, caseId);
  if (!original) throw new Error('Case not found');
  if (!original.verdict) throw new Error('Case has no verdict to appeal');
  if (original.level === 'appeal') throw new Error('Cannot appeal an appeal');

  const maxAppeals = getParam<number>(db, 'court.max_appeals');
  if (store.countAppealsOf(caseId) >= maxAppeals) throw new Error('Maximum appeals reached');

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    store.insertCase({
      id,
      type: original.type,
      level: 'appeal',
      challengerId: original.challengerId,
      defendantId: original.defendantId,
      challengerStake: original.challengerStake,
      challengerStakePercent: original.challengerStakePercent,
      status: 'appeal_open',
      arbitrationDeadline: null,
      votingDeadline: null,
      appealOf: caseId,
      createdAt: now,
    });
  });

  // Select jury for appeal (excludes original jurors via court_jury table)
  selectJury(db, id, blockHash);

  return getCase(db, id)!;
}

export function resolveAppeal(db: DatabaseSync, appealCaseId: string): Verdict {
  const store = courtStore(db);
  const appealCase = getCase(db, appealCaseId);
  if (!appealCase) throw new Error('Appeal case not found');
  if (appealCase.level !== 'appeal') throw new Error('Not an appeal case');

  const originalCase = getCase(db, appealCase.appealOf!)!;

  const jurors = store.findJurorsByCase(appealCaseId);
  const votes = jurors.filter((j) => j.vote !== null);

  if (votes.length === 0) throw new Error('No votes cast');

  const humanVotes = votes.filter((j) => j.vote === 'human').length;
  const notHumanVotes = votes.filter((j) => j.vote === 'not_human').length;
  const verdict: Verdict = notHumanVotes > humanVotes ? 'guilty' : 'innocent';
  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    store.setVerdict(appealCaseId, verdict, 'appeal_verdict', now);

    const reversed = verdict !== originalCase.verdict;

    if (reversed && originalCase.verdict === 'guilty' && verdict === 'innocent') {
      // Reverse guilty: reopen defendant account (but balance stays 0, burns are irreversible)
      db.prepare('UPDATE accounts SET is_active = 1 WHERE id = ?').run(appealCase.defendantId);

      // Burn the bounty from challenger (clawback)
      const challenger = getAccount(db, appealCase.challengerId)!;
      const bountyPercent = getParam<number>(db, 'court.bounty_percent');
      // Recalculate original bounty based on what was taken from defendant
      // The bounty was defendant.earnedBalance * bountyPercent / 100
      // Since we can't know the exact amount anymore, burn challenger's stake instead
      // Actually, the challenger got bounty + stake back. Burn the stake (it was already unlocked).
      const burnAmount = appealCase.challengerStake;
      if (challenger.earnedBalance >= burnAmount) {
        const newEarned = challenger.earnedBalance - burnAmount;
        updateBalance(db, appealCase.challengerId, 'earned_balance', newEarned);
        recordLog(db, appealCase.challengerId, 'vouch_burn', 'earned', burnAmount, challenger.earnedBalance, newEarned, appealCaseId, now);
        if (burnAmount > 0n) {
          addToFeePool(db, burnAmount);
        }
      }

      // Set protection window for defendant
      const protectionDays = getParam<number>(db, 'court.protection_window_days');
      const state = db.prepare('SELECT current_day FROM day_cycle_state WHERE id = 1').get() as { current_day: number };
      db.prepare('UPDATE accounts SET protection_window_end = ? WHERE id = ?').run(
        state.current_day + protectionDays, appealCase.defendantId,
      );
    } else if (reversed && originalCase.verdict === 'innocent' && verdict === 'guilty') {
      // Reverse innocent: apply guilty verdict now
      applyGuiltyVerdict(db, appealCase, jurors, now);
      return;
    }

    // Process juror stakes for appeal jury
    const majorityVote: Vote = verdict === 'guilty' ? 'not_human' : 'human';
    processJurorStakes(db, jurors, majorityVote, appealCaseId, now);
  });

  return verdict;
}

// ========== Accuracy Impact ==========

export function applyAccuracyImpact(db: DatabaseSync, courtCase: CourtCase): void {
  if (courtCase.verdict !== 'guilty') return;

  // Find the original verification panel for the defendant
  const panel = db.prepare(
    "SELECT id FROM verification_panels WHERE account_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(courtCase.defendantId) as { id: string } | undefined;

  if (!panel) return;

  // Get the panel reviews (miner scores)
  const reviews = db.prepare(
    'SELECT miner_id, score FROM panel_reviews WHERE panel_id = ?'
  ).all(panel.id) as Array<{ miner_id: string; score: number }>;

  const now = Math.floor(Date.now() / 1000);

  for (const review of reviews) {
    // If they scored >= 50, they judged the account as likely human (WRONG for guilty)
    // Record this as a verification that did NOT match the court verdict
    const matchedVerdict = review.score < 50 ? 1 : 0;

    // Update or insert into miner_verification_assignments to track accuracy
    // We need to mark this verification as incorrect
    db.prepare(
      `INSERT INTO miner_verification_assignments (id, miner_id, panel_id, assigned_at, deadline, completed, missed)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(uuid(), review.miner_id, panel.id, now, now, matchedVerdict === 0 ? 1 : 0);

    // Check if accuracy dropped below tier 2 threshold
    const miner = getMiner(db, review.miner_id);
    if (miner && miner.isActive && miner.tier === 2) {
      const accuracy = getCompositeAccuracy(db, review.miner_id);
      const threshold = getParam<number>(db, 'mining.tier2_accuracy_threshold') * 100;
      if (accuracy < threshold) {
        setMinerTier(db, review.miner_id, 1, `Demoted: accuracy ${accuracy.toFixed(1)}% after court verdict`);
      }
    }
  }
}

// ========== Jury Service Recording ==========

export function recordJuryService(db: DatabaseSync, caseId: string): void {
  const jurors = courtStore(db).findJurorsByCase(caseId);
  const courtCase = getCase(db, caseId)!;
  const mining = miningStore(db);
  const now = Math.floor(Date.now() / 1000);

  for (const juror of jurors) {
    const voted = juror.vote !== null;
    const matchedVerdict = voted && (
      (courtCase.verdict === 'guilty' && juror.vote === 'not_human') ||
      (courtCase.verdict === 'innocent' && juror.vote === 'human')
    );

    mining.recordJuryService({
      id: uuid(),
      minerId: juror.minerId,
      caseId,
      calledAt: now,
      voted,
      voteMatchedVerdict: voted ? matchedVerdict : null,
    });
  }
}
