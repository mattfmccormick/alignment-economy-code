import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { sha256 } from '../core/crypto.js';
import { getAccount, updateBalance, deactivateAccount, setEscrowed } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { runTransaction } from '../db/connection.js';
import { getParam } from '../config/params.js';
import { NotFoundError, ValidationError, ForbiddenError, ConflictError, InsufficientBalanceError } from '../core/errors.js';
import { cycleStateStore } from '../core/stores/SqliteCycleStateStore.js';
import { getMinerByAccount, getActiveMiners, getMiner, setMinerTier, miningStore } from '../mining/registration.js';
import { burnAllVouchesOnAccount } from '../verification/vouching.js';
import { getCompositeAccuracy } from '../mining/accuracy.js';
import { SqliteCourtStore } from '../core/stores/SqliteCourtStore.js';
import type { ICourtStore } from '../core/stores/ICourtStore.js';
import type { CourtCase, CaseType, Vote, Verdict, CaseArgument, ArgumentRole, JurorRecord } from './types.js';
import { logger } from '../node/logger.js';

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
  counterpartAccountId?: string,
): CourtCase {
  // Verify challenger is an active miner
  const miner = getMinerByAccount(db, challengerAccountId);
  if (!miner) throw new ForbiddenError('Only active miners can file challenges', 'NOT_ACTIVE_MINER');

  const challenger = getAccount(db, challengerAccountId)!;
  // A closed account has no standing, and an account that is itself under
  // challenge may not file. The second rule is not about fairness: filing
  // moves earned points into locked, and a guilty verdict burns earned only.
  // A defendant could file a 100%-stake challenge against anyone and walk
  // their whole balance out from under the verdict.
  if (!challenger.isActive) throw new ForbiddenError('A closed account cannot file a challenge', 'ACCOUNT_INACTIVE');
  if (challenger.isEscrowed) {
    throw new ForbiddenError('An account that is under challenge cannot file one until its own case is resolved', 'ACCOUNT_ESCROWED');
  }
  const defendant = getAccount(db, defendantAccountId);
  if (!defendant) throw new NotFoundError('Defendant account not found');
  if (!defendant.isActive) throw new ValidationError('Defendant account is inactive', 'ACCOUNT_INACTIVE');
  if (challengerAccountId === defendantAccountId) throw new ValidationError('Cannot challenge yourself', 'SELF_CHALLENGE');
  // Both case types ask a jury whether a PERSON is real and unique. A company,
  // government or bot account is truthfully "not human", so without this an
  // honest jury would close any organisation's account and hand the
  // challenger a fifth of its balance.
  if (defendant.type !== 'individual') {
    throw new ValidationError('Only individual accounts can be challenged in court', 'DEFENDANT_NOT_INDIVIDUAL');
  }

  // WP §9.3: a duplicate_account challenge names the counterpart — the earlier
  // account the defendant is alleged to duplicate. You challenge the newer
  // (duplicate) account and name the older (surviving) one, so the counterpart
  // must be strictly older than the defendant. On a guilty verdict the
  // defendant closes and the counterpart pays the overlap penalty.
  let counterpartId: string | null = null;
  if (caseType === 'duplicate_account') {
    if (!counterpartAccountId) {
      throw new ValidationError('A duplicate-account challenge must name the counterpart account', 'COUNTERPART_REQUIRED');
    }
    if (counterpartAccountId === defendantAccountId || counterpartAccountId === challengerAccountId) {
      throw new ValidationError('Counterpart must differ from the defendant and challenger', 'INVALID_COUNTERPART');
    }
    const counterpart = getAccount(db, counterpartAccountId);
    if (!counterpart) throw new NotFoundError('Counterpart account not found');
    if (!counterpart.isActive) throw new ValidationError('Counterpart account is inactive', 'COUNTERPART_INACTIVE');
    // "Earliest survives": the counterpart must have joined on an earlier day
    // than the defendant, so the defendant is unambiguously the later duplicate.
    if (counterpart.joinedDay >= defendant.joinedDay) {
      throw new ValidationError('Counterpart must have joined before the defendant (challenge the newer duplicate)', 'COUNTERPART_NOT_OLDER');
    }
    counterpartId = counterpartAccountId;
  }

  const store = courtStore(db);

  // Protection window
  const state = { current_day: cycleStateStore(db).getCurrentDay() };
  if (defendant.protectionWindowEnd && state.current_day <= defendant.protectionWindowEnd) {
    throw new ForbiddenError(`Account in protection window until day ${defendant.protectionWindowEnd}`, 'PROTECTION_WINDOW');
  }

  // No active case against defendant
  if (store.findActiveCaseAgainst(defendantAccountId)) {
    throw new ConflictError('Active case already exists against this defendant', 'ACTIVE_CASE_EXISTS');
  }

  if (stakePercent < 1) throw new ValidationError('Minimum stake is 1%', 'STAKE_TOO_SMALL');

  const stakeAmount = (challenger.earnedBalance * BigInt(Math.round(stakePercent * 100))) / 10000n;
  if (stakeAmount > challenger.earnedBalance) throw new InsufficientBalanceError('Insufficient balance for stake');

  // A challenge MUST cost the challenger something.
  //
  // The stake is a percentage of the challenger's own earned balance, so a
  // challenger holding zero stakes zero — and the `> earnedBalance` check
  // above passes, because 0 > 0 is false. Filing then escrowed the defendant
  // for free. That is a griefing vector against any account on the network:
  // register as a miner (the first miner on a fresh network needs no
  // percentHuman at all), spend down to zero, and freeze anyone's earned
  // balance at no cost, repeatedly, since escrow lifts only when the case
  // resolves. Skin in the game is the entire mechanism that makes filing
  // self-limiting, and a zero stake removes it.
  if (stakeAmount <= 0n) {
    throw new InsufficientBalanceError(
      `Challenge stake rounds to zero: ${stakePercent}% of a ${challenger.earnedBalance} earned balance. ` +
        'Filing a challenge must cost the challenger real points.',
    );
  }

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

    // WP v2 §9.3: escrow defendant's earned balance from the moment the
    // challenge is posted. Earned-point outbound transfers are blocked;
    // daily allocations still mint and are spendable.
    setEscrowed(db, defendantAccountId, true);

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
      counterpartId,
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
  if (!courtCase) throw new NotFoundError('Case not found');

  // Only the parties can post; jurors and onlookers cannot. Prevents the
  // jury pool from prejudicing the case from the bench.
  let role: ArgumentRole;
  if (submitterAccountId === courtCase.challengerId) role = 'challenger';
  else if (submitterAccountId === courtCase.defendantId) role = 'defendant';
  else throw new ForbiddenError('Only the challenger or defendant can submit arguments', 'NOT_A_PARTY');

  // Once the verdict is in, the case is closed for new arguments. Earlier
  // statuses (arbitration_open, court_voting, etc.) are all open for posting.
  if (courtCase.verdict !== null || courtCase.status === 'closed' || courtCase.status === 'withdrawn') {
    throw new ValidationError(`Case is no longer open for arguments (status: ${courtCase.status})`, 'CASE_NOT_OPEN');
  }

  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError('Argument text is required', 'ARGUMENT_REQUIRED');
  if (trimmed.length > 5000) throw new ValidationError('Argument text exceeds 5,000 character limit', 'ARGUMENT_TOO_LONG');

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
  if (!courtCase) throw new NotFoundError('Case not found');
  if (courtCase.level !== 'arbitration') throw new ValidationError('Can only escalate from arbitration', 'NOT_ARBITRATION');
  // Level alone is not enough. A case dismissed at the arbitration deadline
  // keeps level 'arbitration' and has already had its stake refunded;
  // escalating it seated a jury on a case nobody had anything staked on, and
  // the eventual settlement tried to release a stake that was no longer
  // locked.
  if (
    courtCase.verdict !== null ||
    (courtCase.status !== 'arbitration_open' && courtCase.status !== 'arbitration_response')
  ) {
    throw new ValidationError(`Case is closed and cannot be escalated (status: ${courtCase.status})`, 'CASE_NOT_OPEN');
  }

  courtStore(db).setLevelToCourt(caseId);

  return getCase(db, caseId)!;
}

// ========== Jury Selection ==========

/**
 * Statuses where court stake is still locked in someone's `locked_balance`.
 * A resolved, withdrawn or closed case has already released (or burned) its
 * stakes, so rescaling those would corrupt history.
 */
const OPEN_CASE_STATUSES = [
  'arbitration_open',
  'arbitration_response',
  'court_open',
  'court_waiting_jury',
  'court_voting',
  'appeal_open',
  'appeal_voting',
] as const;

/**
 * Rescale outstanding court stakes by the daily rebase multiplier.
 *
 * The rebase multiplies every account's `locked_balance` by
 * `targetTotal / preRebaseTotal`, but court stakes were recorded as a fixed
 * nominal amount at filing/seating time and never moved with it. Both
 * directions broke:
 *
 *   - Multiplier below 1 (the steady state once the network has any size): the
 *     recorded stake ends up LARGER than what is actually locked, and the
 *     verdict subtracts the recorded figure anyway. Observed in the audit
 *     repro: 12 accounts driven negative, one to -14744000000000. A negative
 *     balance is supply corruption — every total computed from it is wrong.
 *   - Multiplier above 1: the recorded stake is SMALLER than what is locked, so
 *     the verdict releases less than it locked and the remainder is stranded
 *     with nothing left that would ever free it. Observed: 2293823529411 still
 *     locked after the case closed.
 *
 * Vouches already avoid this via `rebalanceVouchLocks`; court stakes had no
 * equivalent. Runs inside the rebase transaction so stakes and balances move
 * together or not at all.
 */
export function rebaseCourtStakes(
  db: DatabaseSync,
  targetTotal: bigint,
  preRebaseTotal: bigint,
): void {
  if (preRebaseTotal <= 0n || targetTotal < 0n) return;

  const placeholders = OPEN_CASE_STATUSES.map(() => '?').join(', ');
  const scale = (raw: string): string =>
    ((BigInt(raw) * targetTotal) / preRebaseTotal).toString();

  const cases = db
    .prepare(`SELECT id, challenger_stake FROM court_cases WHERE status IN (${placeholders})`)
    .all(...OPEN_CASE_STATUSES) as Array<{ id: string; challenger_stake: string }>;
  const setCase = db.prepare('UPDATE court_cases SET challenger_stake = ? WHERE id = ?');
  for (const row of cases) {
    setCase.run(scale(row.challenger_stake), row.id);
  }

  const jurors = db
    .prepare(
      `SELECT j.id, j.stake_amount FROM court_jury j
         JOIN court_cases c ON c.id = j.case_id
        WHERE c.status IN (${placeholders})`,
    )
    .all(...OPEN_CASE_STATUSES) as Array<{ id: string; stake_amount: string }>;
  const setJuror = db.prepare('UPDATE court_jury SET stake_amount = ? WHERE id = ?');
  for (const row of jurors) {
    setJuror.run(scale(row.stake_amount), row.id);
  }
}

/**
 * A jury could not be seated. Thrown inside the seating transaction so the
 * whole attempt rolls back — no juror keeps stake locked against a case that
 * never opened. Caught by selectJury, which parks the case in
 * `court_waiting_jury` instead of advancing it.
 */
class JurySeatingFailed extends Error {}

/** Seated-juror count for a case, read straight off the table. */
function store0(db: DatabaseSync): { countJurors(caseId: string): number } {
  return {
    countJurors(caseId: string): number {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM court_jury WHERE case_id = ?').get(caseId) as { cnt: number };
      return Number(row.cnt);
    },
  };
}

/**
 * Smallest jury that can actually decide anything. Three, and odd, so a
 * majority exists and cannot tie.
 *
 * Below this the case waits rather than proceeding: a verdict burns 80% of the
 * defendant's balance, and one or two people should not be able to do that
 * because nobody else was available.
 */
const MIN_VIABLE_JURY = 3;

export function selectJury(db: DatabaseSync, caseId: string, blockHash: string): string[] {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');

  // A case gets one jury. Nothing stopped a second call from seating a second
  // batch on top of the first: more stakes locked, and (under the old
  // votes-cast rule) a verdict decided by whichever batch happened to vote
  // while the other sat locked and ignored.
  if (
    courtCase.verdict !== null ||
    courtCase.status === 'withdrawn' ||
    courtCase.status === 'closed' ||
    store0(db).countJurors(caseId) > 0
  ) {
    throw new ValidationError(`Case already has a jury or a verdict (status: ${courtCase.status})`, 'CASE_NOT_SEATABLE');
  }

  const jurySize = getParam<number>(db, 'court.jury_size');
  const jurorStakePercent = getParam<number>(db, 'court.juror_stake_percent');
  const votingDays = getParam<number>(db, 'court.court_voting_days');
  const now = Math.floor(Date.now() / 1000);

  // Get eligible Tier 2 miners, excluding conflicts
  let pool = getActiveMiners(db, 2);

  // Exclude everyone with a stake in the outcome. The challenger was already
  // excluded; the defendant was not, so a defendant who happened to be an
  // active tier-2 miner could be seated on the jury deciding their own case and
  // vote in it. Observed directly in the audit repro ("defendant minerId in
  // jury? true").
  //
  // The counterpart matters for the same reason on duplicate_account cases: it
  // is the earlier account the defendant is alleged to be duplicating, so its
  // holder is the other side of the dispute in everything but name and has an
  // obvious interest in a guilty verdict.
  const interested = new Set(
    [courtCase.challengerId, courtCase.defendantId, courtCase.counterpartId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  pool = pool.filter((m) => !interested.has(m.accountId));

  // Exclude miners with a real interest in either party.
  //
  // The test is deliberately one-directional: what the JUROR did, never what
  // a party did to the juror. This used to exclude any miner with any
  // transaction in either direction, and a transfer needs no consent from
  // its recipient. So a challenger could send one base unit to every honest
  // juror, disqualify all of them, and be left with a pool made of their own
  // accounts; a fraudster could do the same on day one and never be triable.
  // Nobody can make a juror pay them, vouch for them, or score their panel.
  const paidParty = db.prepare(
    `SELECT COUNT(*) AS cnt FROM transactions
      WHERE "from" = ? AND "to" IN (?, ?) AND applied = 1`,
  );
  const vouchedForParty = db.prepare(
    `SELECT COUNT(*) AS cnt FROM vouches
      WHERE voucher_id = ? AND vouched_id IN (?, ?) AND is_active = 1`,
  );
  // A miner who scored the defendant's verification has their own accuracy
  // record riding on the verdict (applyAccuracyImpact).
  const reviewedDefendant = db.prepare(
    `SELECT COUNT(*) AS cnt FROM panel_reviews r
       JOIN verification_panels p ON p.id = r.panel_id
      WHERE r.miner_id = ? AND p.account_id = ?`,
  );
  const count = (row: unknown): number => Number((row as { cnt: number }).cnt);
  pool = pool.filter((m) => {
    if (count(paidParty.get(m.accountId, courtCase.challengerId, courtCase.defendantId)) > 0) return false;
    if (count(vouchedForParty.get(m.accountId, courtCase.challengerId, courtCase.defendantId)) > 0) return false;
    if (count(reviewedDefendant.get(m.id, courtCase.defendantId)) > 0) return false;
    return true;
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

  // Drop miners who cannot post the juror stake BEFORE sizing the jury.
  //
  // This filter used to live inside the seating loop as a bare `continue`,
  // after the jury size had already been fixed from the unfiltered pool. So a
  // pool of three where two held nothing produced a "jury" of one, and the case
  // still advanced to voting — one juror then decided a verdict that burns 80%
  // of the defendant's balance. Observed: "pool was 3, jurors actually seated:
  // 1 | status: court_voting". Filtering here means the size reflects who can
  // actually serve.
  pool = pool.filter((m) => {
    const acct = getAccount(db, m.accountId);
    if (!acct) return false;
    const stake = (acct.earnedBalance * BigInt(jurorStakePercent)) / 100n;
    return stake > 0n && stake <= acct.earnedBalance;
  });

  if (pool.length < MIN_VIABLE_JURY) {
    store.setStatusWaitingJury(caseId);
    return [];
  }

  // Deterministic random selection
  const seed = sha256(caseId + blockHash);
  const targetSize = Math.min(jurySize, pool.length);
  // Make it odd
  const actualSize = targetSize % 2 === 0 ? targetSize - 1 : targetSize;

  // Shuffle deterministically using seed
  const indexed = pool.map((m, i) => ({
    miner: m,
    sortKey: sha256(seed + i.toString()),
  }));
  // Plain code-unit order. localeCompare consults the machine's locale data,
  // and two nodes must never disagree about who sits on a jury.
  indexed.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  let jurorIds: string[] = [];

  try {
  runTransaction(db, () => {
    for (let i = 0; i < actualSize; i++) {
      const miner = indexed[i].miner;
      const acct = getAccount(db, miner.accountId)!;
      const stake = (acct.earnedBalance * BigInt(jurorStakePercent)) / 100n;

      // Every miner still in the pool was checked for stakeability above, so
      // this should be unreachable. Throwing rather than silently skipping is
      // the point: a silent skip is exactly how a one-juror jury got seated.
      if (stake <= 0n || stake > acct.earnedBalance) {
        throw new JurySeatingFailed(
          `miner ${miner.id} became unstakeable between filtering and seating`,
        );
      }

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

    // Only advance to voting once a viable jury is actually seated. This used
    // to run unconditionally, so a case moved to court_voting even with an
    // empty or one-member jury. Throwing rolls the whole seating back, so no
    // juror is left with stake locked against a case that never opened.
    if (jurorIds.length < MIN_VIABLE_JURY || jurorIds.length % 2 === 0) {
      throw new JurySeatingFailed(
        `seated ${jurorIds.length} juror(s); need at least ${MIN_VIABLE_JURY} and an odd count`,
      );
    }

    store.setStatusVoting(caseId, now + votingDays * 86400);
  });
  } catch (err) {
    if (!(err instanceof JurySeatingFailed)) throw err;
    // The transaction rolled back, so nothing is locked and no juror rows
    // exist. Reset the in-memory list to match the database and park the case.
    jurorIds = [];
    store.setStatusWaitingJury(caseId);
    return [];
  }

  return jurorIds;
}

/**
 * Release a case that can never seat a jury.
 *
 * Without this, `court_waiting_jury` was a permanent trap. `escalateToFull`
 * refuses to re-run ("Can only escalate from arbitration") and nothing else
 * calls `selectJury`, so the defendant stayed escrowed and the challenger's
 * stake stayed locked with no route out — observed directly in the audit
 * repro. On a small network, where the eligible pool is routinely under three,
 * that is not an edge case.
 *
 * Dismissal is deliberately neutral: no verdict, the challenger's stake is
 * returned in full rather than burned, and the defendant is un-escrowed. The
 * network failed to provide a jury; neither party did anything wrong, so
 * neither should be punished for it.
 */
export function dismissStalledCase(db: DatabaseSync, caseId: string): void {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  if (courtCase.status !== 'court_waiting_jury') {
    throw new ValidationError(
      `Only a case stuck waiting for a jury can be dismissed (status: ${courtCase.status})`,
      'NOT_STALLED',
    );
  }

  dismissCase(db, caseId, Math.floor(Date.now() / 1000));
}

// ========== Voting ==========

export function submitVote(
  db: DatabaseSync,
  caseId: string,
  minerId: string,
  vote: Vote,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  const store = courtStore(db);
  const juror = store.findJurorByMiner(caseId, minerId);
  if (!juror) throw new ForbiddenError('Miner is not a juror on this case', 'NOT_A_JUROR');
  if (juror.vote) throw new ConflictError('Already voted', 'ALREADY_VOTED');

  // A vote counts only while the case is actually in voting. Without this a
  // juror could vote on a case that had already been dismissed, and when the
  // last one did, the route settled a verdict on a case the defendant had
  // been told was over.
  const courtCase = getCase(db, caseId);
  if (!courtCase || courtCase.verdict !== null || courtCase.status !== 'court_voting') {
    throw new ValidationError(`Voting is not open on this case (status: ${courtCase?.status ?? 'unknown'})`, 'VOTING_CLOSED');
  }
  if (courtCase.votingDeadline !== null && nowSec > courtCase.votingDeadline) {
    throw new ValidationError('The voting deadline has passed', 'VOTING_CLOSED');
  }

  store.recordVote(caseId, minerId, vote, nowSec);
}

/**
 * Count a jury's votes. A verdict needs a majority of the jurors SEATED, not
 * of the votes cast.
 *
 * The old rule was a majority of votes cast, with no quorum. At the deadline
 * that let one juror out of eleven decide alone: bribe or be one juror, let
 * the other ten stay silent, and a single vote closed an account and burned
 * four fifths of its balance. Silence is not agreement.
 *
 * Returns null when neither side has a majority of the seats yet. With
 * everyone voted and an odd jury that cannot happen; the tie branch is there
 * for an even jury and goes to the defendant.
 */
export function tallyVotes(jurors: Array<{ vote: Vote | null }>): {
  verdict: Verdict | null;
  seated: number;
  cast: number;
} {
  const seated = jurors.length;
  const human = jurors.filter((j) => j.vote === 'human').length;
  const notHuman = jurors.filter((j) => j.vote === 'not_human').length;
  const cast = human + notHuman;
  let verdict: Verdict | null = null;
  if (seated > 0) {
    if (notHuman * 2 > seated) verdict = 'guilty';
    else if (human * 2 > seated) verdict = 'innocent';
    else if (cast === seated) verdict = 'innocent';
  }
  return { verdict, seated, cast };
}

// ========== Verdict ==========

/**
 * Close out cases whose deadlines have passed.
 *
 * `arbitration_deadline` and `voting_deadline` were written at filing and
 * seating, returned by the API, and rendered in both apps — and no code
 * anywhere compared them to a clock. Nothing expired. A single juror who never
 * voted therefore froze the case, the defendant's escrowed earned balance and
 * every juror's stake, permanently: `resolveVerdict` throws `NO_VOTES` with
 * zero votes, and with a partial set it was simply never called.
 *
 * Two outcomes, both deliberately conservative:
 *
 *   - Voting deadline passed and one side holds a majority of the SEATED jury
 *     → resolve. (See tallyVotes for why it is seats, not votes cast.)
 *   - Voting deadline passed without that majority, or arbitration deadline
 *     passed while still waiting for a jury → dismiss neutrally. Nobody proved
 *     anything, so the challenger's stake comes back and the defendant is
 *     un-escrowed rather than either side being punished for the network's
 *     failure to produce jurors.
 *
 * `nowSec` is passed in rather than read from the clock so the caller decides
 * the reference time. Returns what it did, for logging.
 *
 * NOTE: court state is still node-local (see the state-mutation section in
 * CLAUDE.md), so this expires each node's own view. When court moves onto the
 * chain this belongs in the same ordered path as the rest of it.
 */
export function expireCourtDeadlines(
  db: DatabaseSync,
  nowSec: number,
): { resolved: string[]; dismissed: string[]; failed: string[] } {
  const store = courtStore(db);
  const resolved: string[] = [];
  const dismissed: string[] = [];
  const failed: string[] = [];

  const rows = db
    .prepare(
      `SELECT id, status, voting_deadline, arbitration_deadline
         FROM court_cases
        WHERE verdict IS NULL
          AND status IN ('court_voting', 'court_waiting_jury', 'arbitration_open', 'arbitration_response', 'appeal_open')
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{
      id: string;
      status: string;
      voting_deadline: number | null;
      arbitration_deadline: number | null;
    }>;

  for (const row of rows) {
    // One case's settlement failing must not take the rest down with it.
    //
    // This sweep runs at the top of the daily cycle, before expiry, rebase and
    // mint. It used to have no isolation, so a single case whose settlement
    // threw aborted the whole cycle on that node, every day, for good: no
    // mint, no rebase, the day counter frozen, and every other case's
    // deadline unprocessed behind it. Each settlement is its own SQL
    // transaction, so a throw leaves that one case exactly as it was.
    try {
      const votingExpired = row.voting_deadline !== null && row.voting_deadline <= nowSec;
      const arbExpired = row.arbitration_deadline !== null && row.arbitration_deadline <= nowSec;

      if (row.status === 'court_voting' && votingExpired) {
        if (tallyVotes(store.findJurorsByCase(row.id)).verdict !== null) {
          // resolveCase, not resolveVerdict — an expiring appeal needs the
          // appeal settlement (reopen the account, claw back the bounty).
          resolveCase(db, row.id);
          resolved.push(row.id);
        } else {
          dismissCase(db, row.id, nowSec);
          dismissed.push(row.id);
        }
        continue;
      }

      // Waiting for a jury that never arrived, or a defendant who never
      // responded and no jury was ever seated. Either way there is nothing to
      // decide and no reason to keep the defendant's balance frozen.
      if (
        ((row.status === 'court_waiting_jury' || row.status === 'appeal_open') && (arbExpired || votingExpired)) ||
        ((row.status === 'arbitration_open' || row.status === 'arbitration_response') && arbExpired)
      ) {
        dismissCase(db, row.id, nowSec);
        dismissed.push(row.id);
      }
    } catch (err) {
      failed.push(row.id);
      logger.error(
        'court',
        `Could not settle case ${row.id} (status ${row.status}); leaving it open and continuing. ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { resolved, dismissed, failed };
}

/**
 * Neutral close: return the challenger's stake, lift the defendant's escrow,
 * record no verdict. Shared by `dismissStalledCase` and the deadline sweep.
 *
 * The stake release is clamped to what is actually locked. The daily rebase
 * rescales `locked_balance` while a case sits open, so the nominal figure
 * recorded at filing can exceed it — subtracting blind is what used to drive
 * balances negative.
 */
function dismissCase(db: DatabaseSync, caseId: string, nowSec: number): void {
  const store = courtStore(db);
  const courtCase = getCase(db, caseId);
  if (!courtCase || courtCase.verdict !== null) return;

  // An appeal locks no challenger stake and does not escrow the defendant:
  // the stake figure on its row is a copy of the original case's, and the
  // original verdict stands if the appeal goes nowhere. Dismissing one used
  // to "return" that copied stake by taking it out of whatever else the
  // challenger had locked, and lifted an escrow that was not this case's to
  // lift.
  const isAppeal = courtCase.level === 'appeal';
  const challenger = isAppeal ? null : getAccount(db, courtCase.challengerId);

  runTransaction(db, () => {
    // Jurors did nothing wrong by being seated on a case that went nowhere.
    // Their stakes used to stay locked forever, because only the challenger's
    // was released here.
    for (const juror of store.findJurorsByCase(caseId)) {
      releaseJurorStake(db, juror, caseId, nowSec);
    }
    if (challenger) {
      const release =
        courtCase.challengerStake > challenger.lockedBalance
          ? challenger.lockedBalance
          : courtCase.challengerStake;
      if (release > 0n) {
        updateBalance(db, courtCase.challengerId, 'locked_balance', challenger.lockedBalance - release);
        updateBalance(db, courtCase.challengerId, 'earned_balance', challenger.earnedBalance + release);
        recordLog(
          db, courtCase.challengerId, 'vouch_unlock', 'earned', release,
          challenger.earnedBalance, challenger.earnedBalance + release, caseId, nowSec,
        );
      }
    }
    if (!isAppeal) setEscrowed(db, courtCase.defendantId, false);
    store.setVerdict(caseId, null, 'withdrawn', nowSec);
  });
}

export function resolveVerdict(db: DatabaseSync, caseId: string): Verdict {
  const store = courtStore(db);
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');

  // Resolve exactly once.
  //
  // Every payout in applyGuiltyVerdict / applyInnocentVerdict is an
  // unconditional balance move, so a second call ran the whole settlement
  // again: burning the defendant twice, paying the bounty twice, unlocking
  // juror stakes that were already unlocked. Nothing downstream deduplicated
  // it, and the route is reachable from an ordinary HTTP retry or a
  // double-clicked button.
  if (courtCase.verdict !== null) {
    throw new ConflictError(
      `Case ${caseId} already resolved as ${courtCase.verdict}`,
      'ALREADY_RESOLVED',
    );
  }

  // `verdict !== null` does not cover a dismissed case, whose verdict is null
  // by design. Only a case in voting can be decided.
  if (courtCase.status !== 'court_voting') {
    throw new ValidationError(`Case is not in voting (status: ${courtCase.status})`, 'NOT_VOTING');
  }

  const jurors = store.findJurorsByCase(caseId);
  const tally = tallyVotes(jurors);

  if (tally.cast === 0) throw new ValidationError('No votes cast', 'NO_VOTES');
  if (tally.verdict === null) {
    throw new ValidationError(
      `No majority of the seated jury yet (${tally.cast} of ${tally.seated} voted)`,
      'NO_QUORUM',
    );
  }

  const verdict: Verdict = tally.verdict;
  const now = Math.floor(Date.now() / 1000);
  const finalStatus = courtCase.level === 'appeal' ? 'appeal_verdict' : 'court_verdict';

  runTransaction(db, () => {
    store.setVerdict(caseId, verdict, finalStatus, now);

    if (verdict === 'guilty') {
      applyGuiltyVerdict(db, courtCase, jurors, now);
    } else {
      applyInnocentVerdict(db, courtCase, jurors, now);
    }

    // Feed the outcome back to the miners who verified this account.
    //
    // applyAccuracyImpact had no production caller, so a court finding that an
    // account was not human never reflected on the miners who had passed it.
    // That is the accountability loop the whole proof-of-human model rests on
    // — the white paper's "miner accuracy is measured against court outcomes"
    // — and without it a miner could wave through fraudulent accounts forever
    // at no cost to their tier or their standing.
    //
    // `courtCase` was read before the verdict was written, so its `verdict` is
    // still null; pass the decided value or the function returns immediately.
    applyAccuracyImpact(db, { ...courtCase, verdict });
  });

  return verdict;
}

function applyGuiltyVerdict(
  db: DatabaseSync,
  courtCase: CourtCase,
  jurors: JurorRecord[],
  now: number,
  // False when the challenger's stake is no longer locked: an appeal that
  // reverses an innocent verdict arrives here after that verdict already
  // burned the stake, and "returning" it again drove locked negative, which
  // throws and left the appeal impossible to settle.
  opts: { releaseChallengerStake: boolean } = { releaseChallengerStake: true },
): void {
  const defendant = getAccount(db, courtCase.defendantId)!;
  const bountyPercent = getParam<number>(db, 'court.bounty_percent');

  // Challenger receives the bounty; the defendant's entire earned balance is
  // then zeroed (below). Net effect: bounty transferred, remainder burned,
  // which is why burn_percent isn't read separately here.
  const bountyAmount = (defendant.earnedBalance * BigInt(bountyPercent)) / 100n;

  // Close defendant account
  deactivateAccount(db, courtCase.defendantId);

  // Pay bounty to challenger
  const challenger = getAccount(db, courtCase.challengerId)!;
  const newChallengerEarned = challenger.earnedBalance + bountyAmount;
  updateBalance(db, courtCase.challengerId, 'earned_balance', newChallengerEarned);
  recordLog(db, courtCase.challengerId, 'bounty', 'earned', bountyAmount, challenger.earnedBalance, newChallengerEarned, courtCase.id, now);

  updateBalance(db, courtCase.defendantId, 'earned_balance', 0n);
  recordLog(db, courtCase.defendantId, 'court_burn', 'earned', defendant.earnedBalance, defendant.earnedBalance, 0n, courtCase.id, now);

  // Return challenger stake
  if (opts.releaseChallengerStake) {
    const challengerAfterBounty = getAccount(db, courtCase.challengerId)!;
    const unlockedEarned = challengerAfterBounty.earnedBalance + courtCase.challengerStake;
    const unlockedLocked = challengerAfterBounty.lockedBalance - courtCase.challengerStake;
    updateBalance(db, courtCase.challengerId, 'earned_balance', unlockedEarned);
    updateBalance(db, courtCase.challengerId, 'locked_balance', unlockedLocked);
    recordLog(db, courtCase.challengerId, 'vouch_unlock', 'earned', courtCase.challengerStake, challengerAfterBounty.earnedBalance, unlockedEarned, courtCase.id, now);
  }

  // Burn voucher stakes on defendant
  burnAllVouchesOnAccount(db, courtCase.defendantId);

  // WP §9.3 duplicate-account outcome: the defendant (the duplicate) closes
  // above like any non-human account.
  //
  // The white paper also has the earlier account it duplicated (the
  // counterpart) pay twice the overlap allocations. That penalty is NOT
  // applied, on purpose, until the counterpart is a real party to the case.
  // As built, the counterpart was whoever the challenger typed into the
  // filing: never notified, unable to respond, unable to appeal, and the
  // jury is asked only whether the DEFENDANT is human. So anyone could age a
  // throwaway account, have it truthfully convicted, name a stranger as the
  // counterpart, and burn that stranger's savings with an honest jury. No
  // account is debited by a case it had no voice in. Restoring the penalty
  // needs the counterpart served, heard, able to appeal, and a separate
  // finding that the two accounts share an owner.

  // Juror stakes: majority returned, minority burned
  const majorityVote: Vote = 'not_human'; // guilty = not_human won
  processJurorStakes(db, jurors, majorityVote, courtCase.id, now);
}

function applyInnocentVerdict(
  db: DatabaseSync,
  courtCase: CourtCase,
  jurors: JurorRecord[],
  now: number,
): void {
  // WP v2 §9.3: release escrow on innocent verdict.
  setEscrowed(db, courtCase.defendantId, false);

  // WP v2: challenger stake split 50% to defendant (compensation for the
  // freeze), 50% true-burned.
  const challenger = getAccount(db, courtCase.challengerId)!;
  const newLocked = challenger.lockedBalance - courtCase.challengerStake;
  updateBalance(db, courtCase.challengerId, 'locked_balance', newLocked);
  recordLog(db, courtCase.challengerId, 'vouch_burn', 'earned', courtCase.challengerStake, challenger.lockedBalance, newLocked, courtCase.id, now);

  const defendantShare = courtCase.challengerStake / 2n;
  if (defendantShare > 0n) {
    const defendant = getAccount(db, courtCase.defendantId)!;
    const newDefEarned = defendant.earnedBalance + defendantShare;
    updateBalance(db, courtCase.defendantId, 'earned_balance', newDefEarned);
    recordLog(db, courtCase.defendantId, 'court_compensation', 'earned', defendantShare, defendant.earnedBalance, newDefEarned, courtCase.id, now);
  }

  const protectionDays = getParam<number>(db, 'court.protection_window_days');
  const state = { current_day: cycleStateStore(db).getCurrentDay() };
  db.prepare('UPDATE accounts SET protection_window_end = ? WHERE id = ?').run(
    state.current_day + protectionDays, courtCase.defendantId,
  );

  const majorityVote: Vote = 'human';
  processJurorStakes(db, jurors, majorityVote, courtCase.id, now);
}

/**
 * Give a juror their stake back. Clamped to what is actually locked, for the
 * same reason dismissCase clamps the challenger's: the daily rebase rescales
 * locked balances while a case sits open.
 */
function releaseJurorStake(
  db: DatabaseSync,
  juror: JurorRecord,
  caseId: string,
  now: number,
): void {
  const acct = getAccount(db, juror.jurorAccountId);
  if (!acct) return;
  const release = juror.stakeAmount > acct.lockedBalance ? acct.lockedBalance : juror.stakeAmount;
  if (release <= 0n) return;
  const newEarned = acct.earnedBalance + release;
  updateBalance(db, juror.jurorAccountId, 'earned_balance', newEarned);
  updateBalance(db, juror.jurorAccountId, 'locked_balance', acct.lockedBalance - release);
  recordLog(db, juror.jurorAccountId, 'vouch_unlock', 'earned', release, acct.earnedBalance, newEarned, caseId, now);
}

function processJurorStakes(
  db: DatabaseSync,
  jurors: JurorRecord[],
  majorityVote: Vote,
  caseId: string,
  now: number,
): void {
  for (const juror of jurors) {
    if (!juror.vote) {
      // Abstained: stake returned. The comment here always said so and the
      // code did nothing, so a juror who missed a vote had 5% of their
      // balance locked for good.
      releaseJurorStake(db, juror, caseId, now);
      continue;
    }
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
      const newLocked = acct.lockedBalance - stake;
      updateBalance(db, acctId, 'locked_balance', newLocked);
      recordLog(db, acctId, 'vouch_burn', 'earned', stake, acct.lockedBalance, newLocked, caseId, now);
    }
  }
}

// ========== Protection Window ==========

export function isInProtectionWindow(db: DatabaseSync, accountId: string): boolean {
  const acct = getAccount(db, accountId);
  if (!acct || !acct.protectionWindowEnd) return false;
  const state = { current_day: cycleStateStore(db).getCurrentDay() };
  return state.current_day <= acct.protectionWindowEnd;
}

export function getActiveCases(db: DatabaseSync): CourtCase[] {
  return courtStore(db).findActiveCases();
}

// ========== Appeals ==========

export function fileAppeal(db: DatabaseSync, caseId: string, blockHash: string): CourtCase {
  const store = courtStore(db);
  const original = getCase(db, caseId);
  if (!original) throw new NotFoundError('Case not found');
  if (!original.verdict) throw new ValidationError('Case has no verdict to appeal', 'NO_VERDICT');
  if (original.level === 'appeal') throw new ValidationError('Cannot appeal an appeal', 'CANNOT_APPEAL_APPEAL');

  const maxAppeals = getParam<number>(db, 'court.max_appeals');
  if (store.countAppealsOf(caseId) >= maxAppeals) throw new ValidationError('Maximum appeals reached', 'MAX_APPEALS');

  const id = uuid();
  const now = Math.floor(Date.now() / 1000);

  // An appeal has a window. `court.appeal_window_days` was defined, governed
  // and never read, so a verdict was never final: the losing side could
  // reopen it years later, at a moment of its choosing.
  const windowDays = getParam<number>(db, 'court.appeal_window_days');
  if (original.resolvedAt !== null && now > original.resolvedAt + windowDays * 86400) {
    throw new ValidationError(`The ${windowDays}-day appeal window has closed`, 'APPEAL_WINDOW_CLOSED');
  }
  // And a deadline of its own. With both deadlines null an appeal that could
  // not seat a jury was never swept: it sat open forever, used up the one
  // appeal, and blocked every future case against the same defendant.
  const seatBy = now + getParam<number>(db, 'court.court_voting_days') * 86400;

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
      arbitrationDeadline: seatBy,
      votingDeadline: null,
      appealOf: caseId,
      counterpartId: original.counterpartId,
      createdAt: now,
    });
  });

  // Select jury for appeal (excludes original jurors via court_jury table)
  selectJury(db, id, blockHash);

  return getCase(db, id)!;
}

/**
 * Resolve a case, appeal or not.
 *
 * Use this from every call site instead of picking a function by hand. The
 * vote route called `resolveVerdict` unconditionally, so an appeal never ran
 * its own settlement — `resolveAppeal` had zero production callers. A reversal
 * therefore never reopened the defendant's account, never clawed back the
 * bounty, and unlocked the challenger's stake through the ordinary path on top
 * of whatever the original verdict had already done.
 *
 * The two settlements are genuinely different, so the choice belongs here
 * rather than in each caller.
 */
export function resolveCase(db: DatabaseSync, caseId: string): Verdict {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  return courtCase.level === 'appeal' ? resolveAppeal(db, caseId) : resolveVerdict(db, caseId);
}

export function resolveAppeal(db: DatabaseSync, appealCaseId: string): Verdict {
  const store = courtStore(db);
  const appealCase = getCase(db, appealCaseId);
  if (!appealCase) throw new NotFoundError('Appeal case not found');
  if (appealCase.level !== 'appeal') throw new ValidationError('Not an appeal case', 'NOT_APPEAL');

  // Same once-only rule as resolveVerdict: every branch below is an
  // unconditional balance move, so a repeat would claw back the bounty twice
  // and re-run the reversal.
  if (appealCase.verdict !== null) {
    throw new ConflictError(
      `Appeal ${appealCaseId} already resolved as ${appealCase.verdict}`,
      'ALREADY_RESOLVED',
    );
  }

  if (appealCase.status !== 'court_voting') {
    throw new ValidationError(`Appeal is not in voting (status: ${appealCase.status})`, 'NOT_VOTING');
  }

  const originalCase = getCase(db, appealCase.appealOf!)!;

  const jurors = store.findJurorsByCase(appealCaseId);
  const tally = tallyVotes(jurors);

  if (tally.cast === 0) throw new ValidationError('No votes cast', 'NO_VOTES');
  if (tally.verdict === null) {
    throw new ValidationError(
      `No majority of the seated jury yet (${tally.cast} of ${tally.seated} voted)`,
      'NO_QUORUM',
    );
  }
  const verdict: Verdict = tally.verdict;
  const now = Math.floor(Date.now() / 1000);

  runTransaction(db, () => {
    store.setVerdict(appealCaseId, verdict, 'appeal_verdict', now);

    const reversed = verdict !== originalCase.verdict;

    if (reversed && originalCase.verdict === 'guilty' && verdict === 'innocent') {
      // Reverse guilty: reopen defendant account (but balance stays 0, burns are irreversible)
      db.prepare('UPDATE accounts SET is_active = 1 WHERE id = ?').run(appealCase.defendantId);
      setEscrowed(db, appealCase.defendantId, false);

      // Burn the bounty from challenger (clawback). The original bounty amount
      // can't be reconstructed once the defendant balance is gone, so we claw
      // back the challenger's stake instead (it was already unlocked on reversal).
      const challenger = getAccount(db, appealCase.challengerId)!;
      const burnAmount = appealCase.challengerStake;
      if (challenger.earnedBalance >= burnAmount) {
        const newEarned = challenger.earnedBalance - burnAmount;
        updateBalance(db, appealCase.challengerId, 'earned_balance', newEarned);
        recordLog(db, appealCase.challengerId, 'vouch_burn', 'earned', burnAmount, challenger.earnedBalance, newEarned, appealCaseId, now);
      }

      // Set protection window for defendant
      const protectionDays = getParam<number>(db, 'court.protection_window_days');
      const state = { current_day: cycleStateStore(db).getCurrentDay() };
      db.prepare('UPDATE accounts SET protection_window_end = ? WHERE id = ?').run(
        state.current_day + protectionDays, appealCase.defendantId,
      );
    } else if (reversed && originalCase.verdict === 'innocent' && verdict === 'guilty') {
      // Reverse innocent: apply guilty verdict now. The original innocent
      // verdict already consumed the challenger's stake, so there is none
      // locked to hand back.
      applyGuiltyVerdict(db, appealCase, jurors, now, { releaseChallengerStake: false });
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
