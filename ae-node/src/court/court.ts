import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { sha256 } from '../core/crypto.js';
import { getAccount, updateBalance, deactivateAccount, setEscrowed } from '../core/account.js';
import { recordLog } from '../core/transaction.js';
import { PRECISION } from '../core/constants.js';
import { runTransaction } from '../db/connection.js';
import { getParam } from '../config/params.js';
import { NotFoundError, ValidationError, ForbiddenError, ConflictError, InsufficientBalanceError } from '../core/errors.js';
import { cycleStateStore } from '../core/stores/SqliteCycleStateStore.js';
import { getMinerByAccount, getActiveMiners, getMiner, setMinerTier, miningStore } from '../mining/registration.js';
import { burnAllVouchesOnAccount, burnVouch, getVouchesGivenBy } from '../verification/vouching.js';
import { getCompositeAccuracy } from '../mining/accuracy.js';
import { SqliteCourtStore } from '../core/stores/SqliteCourtStore.js';
import type { ICourtStore } from '../core/stores/ICourtStore.js';
import type { ChangeType } from '../core/types.js';
import type {
  CourtCase, CaseType, Vote, Verdict, CaseArgument, ArgumentRole, JurorRecord, ArgumentAttachment, ArgumentOffer,
} from './types.js';
import { logger } from '../node/logger.js';

// How a case moves (October 16, 2026 rules, from Matt's answers to the court
// rebuild plan):
//
//   file ──► arbitration (7 days) ──► court ──► jury seated ──► voting
//              │  challenger withdraws      (at the next day-cycle sweep,
//              │  (floor to the defendant)   never at a moment a party picks)
//              ▼
//   voting ──► verdict_pending ──► (appeal window, everything still frozen)
//                    │                       │
//                    │ no appeal             │ loser appeals: a new jury of
//                    ▼                       ▼ the same size, nobody reused
//              settle ONCE against the final verdict, every juror included
//
// Nothing irreversible happens before the final verdict. The old court
// burned the defendant and paid the bounty the moment the first jury voted,
// so winning an appeal left the victim at zero while the challenger kept
// the bounty.
//
// The court is still node-local (see assertCourtRunsOnThisNetwork). These
// functions are the rules; the on-chain court lane will call them with block
// timestamps and deterministic ids, the way the panel and tag lanes do.

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

// ========== Small helpers ==========

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A points figure from the params table, in base units. */
function pointsParam(db: DatabaseSync, key: string): bigint {
  return BigInt(Math.round(getParam<number>(db, key) * Number(PRECISION)));
}

/**
 * `amount` times a percentage param, in integer basis points.
 *
 * `BigInt(percent)` threw on any fractional value, so a governance change to
 * a bounty of 20.5% (inside its bounds) made every guilty settlement throw.
 */
function percentOf(amount: bigint, percent: number): bigint {
  return (amount * BigInt(Math.round(percent * 100))) / 10000n;
}

/**
 * Take up to `amount` out of an account's locked balance and return what was
 * taken. Clamped to what is actually locked: the daily rebase rescales locked
 * balances while a case sits open, and subtracting a stale figure blind is
 * what used to drive balances negative.
 *
 * `burnLog` records the removal as a burn. Leave it off when the caller is
 * about to credit the same points somewhere else and log that instead.
 */
function takeLocked(
  db: DatabaseSync,
  accountId: string,
  amount: bigint,
  refId: string,
  now: number,
  burnLog = false,
): bigint {
  const acct = getAccount(db, accountId);
  if (!acct || amount <= 0n) return 0n;
  const take = amount > acct.lockedBalance ? acct.lockedBalance : amount;
  if (take <= 0n) return 0n;
  updateBalance(db, accountId, 'locked_balance', acct.lockedBalance - take);
  if (burnLog) {
    recordLog(db, accountId, 'vouch_burn', 'earned', take, acct.lockedBalance, acct.lockedBalance - take, refId, now);
  }
  return take;
}

function creditEarned(
  db: DatabaseSync,
  accountId: string,
  amount: bigint,
  changeType: ChangeType,
  refId: string,
  now: number,
): void {
  if (amount <= 0n) return;
  const acct = getAccount(db, accountId);
  if (!acct) return;
  const after = acct.earnedBalance + amount;
  updateBalance(db, accountId, 'earned_balance', after);
  recordLog(db, accountId, changeType, 'earned', amount, acct.earnedBalance, after, refId, now);
}

/** Hash of the newest committed block, the seed for every jury draw. */
function latestBlockHash(db: DatabaseSync): string {
  const row = db.prepare('SELECT hash FROM blocks ORDER BY number DESC LIMIT 1').get() as
    | { hash: string }
    | undefined;
  return row?.hash ?? 'genesis';
}

// ========== Network guard ==========

/**
 * Refuse to open new cases on a network with more than one validator.
 *
 * Every court effect (stakes, burns, the bounty, the freeze, voucher burns,
 * miner accuracy) is written to THIS node's database only; no court operation
 * rides a block yet. On a multi-validator chain that is worse than a wrong
 * balance: miner accuracy weights which validator proposes the next block, so
 * one guilty verdict on one node can leave the validators disagreeing about
 * whose turn it is, and a stake locked here but spent through another node
 * makes this node fail-stop on replay. On a single-validator network there is
 * only one copy of the truth, so the court is safe to use there until it moves
 * onto the chain. Cases already open finish normally.
 */
export function assertCourtRunsOnThisNetwork(db: DatabaseSync): void {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM validators WHERE is_active = 1').get() as { cnt: number };
  if (Number(row.cnt) > 1) {
    throw new ForbiddenError(
      'The court is not on the blockchain yet, so it only runs on a single-validator network. ' +
        'A case filed here would exist on this node only.',
      'COURT_NOT_ON_CHAIN',
    );
  }
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
  assertCourtRunsOnThisNetwork(db);

  // Verify challenger is an active miner
  const miner = getMinerByAccount(db, challengerAccountId);
  if (!miner) throw new ForbiddenError('Only active miners can file challenges', 'NOT_ACTIVE_MINER');

  const challenger = getAccount(db, challengerAccountId)!;
  // A closed account has no standing, and an account that is itself under
  // challenge may not file. The second rule is not about fairness: filing
  // moves earned points into locked, so a defendant could file a 100%-stake
  // challenge against anyone and walk their balance out from under the verdict.
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

  // WP §9.3: a duplicate_account challenge names the counterpart, the earlier
  // account the defendant is alleged to duplicate. You challenge the newer
  // (duplicate) account and name the older (surviving) one, so the counterpart
  // must be strictly older than the defendant.
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
    if (counterpart.joinedDay >= defendant.joinedDay) {
      throw new ValidationError('Counterpart must have joined before the defendant (challenge the newer duplicate)', 'COUNTERPART_NOT_OLDER');
    }
    counterpartId = counterpartAccountId;
  }

  const store = courtStore(db);
  const now = nowSeconds();

  // Protection window
  const state = { current_day: cycleStateStore(db).getCurrentDay() };
  if (defendant.protectionWindowEnd && state.current_day <= defendant.protectionWindowEnd) {
    throw new ForbiddenError(`Account in protection window until day ${defendant.protectionWindowEnd}`, 'PROTECTION_WINDOW');
  }

  // No active case against defendant
  if (store.findActiveCaseAgainst(defendantAccountId)) {
    throw new ConflictError('Active case already exists against this defendant', 'ACTIVE_CASE_EXISTS');
  }

  // A challenger who withdrew may not come straight back. Without a cooldown,
  // withdraw-and-refile freezes someone's savings indefinitely for the price
  // of the forfeited floor each round.
  const cooldownDays = getParam<number>(db, 'court.refile_cooldown_days');
  const lastWithdrawal = db
    .prepare(
      `SELECT resolved_at FROM court_cases
        WHERE challenger_id = ? AND defendant_id = ? AND status = 'withdrawn' AND resolved_at IS NOT NULL
        ORDER BY resolved_at DESC LIMIT 1`,
    )
    .get(challengerAccountId, defendantAccountId) as { resolved_at: number } | undefined;
  if (lastWithdrawal && now < lastWithdrawal.resolved_at + cooldownDays * 86400) {
    throw new ForbiddenError(
      `You withdrew a case against this account; you can refile after ${cooldownDays} days`,
      'REFILE_COOLDOWN',
    );
  }

  if (!(stakePercent >= 1)) throw new ValidationError('Minimum stake is 1%', 'STAKE_TOO_SMALL');
  if (stakePercent > 100) throw new ValidationError('Stake cannot exceed 100%', 'STAKE_TOO_LARGE');

  // The stake is the percentage the challenger chooses (a higher percentage
  // says more confidence) but never less than a fixed floor. A percentage
  // alone let a challenger with a near-zero balance file for a single base
  // unit, freeze anyone's savings, and lose nothing.
  const floor = pointsParam(db, 'court.min_challenge_stake_points');
  const percentStake = (challenger.earnedBalance * BigInt(Math.round(stakePercent * 100))) / 10000n;
  const stakeAmount = percentStake > floor ? percentStake : floor;
  if (stakeAmount > challenger.earnedBalance) {
    throw new InsufficientBalanceError(
      `Filing a challenge needs at least ${getParam<number>(db, 'court.min_challenge_stake_points')} points in Earned`,
    );
  }
  // With the floor governed down to zero, a zero balance still stakes zero.
  if (stakeAmount <= 0n) {
    throw new InsufficientBalanceError(
      `Challenge stake rounds to zero: ${stakePercent}% of a ${challenger.earnedBalance} earned balance. ` +
        'Filing a challenge must cost the challenger real points.',
    );
  }

  const id = uuid();
  const arbDays = getParam<number>(db, 'court.arbitration_response_days');
  const deadline = now + arbDays * 86400;

  runTransaction(db, () => {
    // Lock stake
    const newEarned = challenger.earnedBalance - stakeAmount;
    const newLocked = challenger.lockedBalance + stakeAmount;
    updateBalance(db, challengerAccountId, 'earned_balance', newEarned);
    updateBalance(db, challengerAccountId, 'locked_balance', newLocked);
    recordLog(db, challengerAccountId, 'vouch_lock', 'earned', stakeAmount, challenger.earnedBalance, newEarned, id, now);

    // WP §9.3: escrow the defendant's earned balance from the moment the
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

    if (openingArgument && openingArgument.trim()) {
      const text = openingArgument.trim();
      if (text.length > MAX_ARGUMENT_LENGTH) {
        throw new ValidationError('Argument text exceeds 5,000 character limit', 'ARGUMENT_TOO_LONG');
      }
      insertArgument(db, {
        id: uuid(),
        caseId: id,
        submitterId: challengerAccountId,
        role: 'challenger',
        text,
        attachmentHash: null,
        attachments: [],
        offers: [],
        createdAt: now,
      });
    }
  });

  return getCase(db, id)!;
}

// ========== Withdraw (challenger) / Demand trial (defendant) ==========

const ARBITRATION_STATUSES = new Set(['arbitration_open', 'arbitration_response']);

/**
 * The challenger drops the case during arbitration, for example because the
 * defendant's response convinced them.
 *
 * Withdrawing is not free: the fixed floor of the stake goes to the defendant
 * for the freeze they sat through, the rest comes back, and the same
 * challenger cannot refile against the same defendant for the cooldown. A free
 * withdrawal let anyone freeze anyone, back out at day 6, and do it again.
 */
export function withdrawChallenge(
  db: DatabaseSync,
  caseId: string,
  accountId: string,
  nowSec: number = nowSeconds(),
): CourtCase {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  if (courtCase.challengerId !== accountId) {
    throw new ForbiddenError('Only the challenger can withdraw a case', 'NOT_CHALLENGER');
  }
  if (courtCase.verdict !== null || courtCase.level !== 'arbitration' || !ARBITRATION_STATUSES.has(courtCase.status)) {
    throw new ValidationError(
      `Only a case still in arbitration can be withdrawn (status: ${courtCase.status})`,
      'CASE_NOT_WITHDRAWABLE',
    );
  }

  const floor = pointsParam(db, 'court.min_challenge_stake_points');

  runTransaction(db, () => {
    const lockedBefore = getAccount(db, courtCase.challengerId)?.lockedBalance ?? 0n;
    const released = takeLocked(db, courtCase.challengerId, courtCase.challengerStake, caseId, nowSec);
    const forfeit = released < floor ? released : floor;
    if (forfeit > 0n) {
      recordLog(db, courtCase.challengerId, 'court_compensation', 'earned', forfeit, lockedBefore, lockedBefore - released, caseId, nowSec);
    }
    creditEarned(db, courtCase.challengerId, released - forfeit, 'vouch_unlock', caseId, nowSec);
    creditEarned(db, courtCase.defendantId, forfeit, 'court_compensation', caseId, nowSec);
    setEscrowed(db, courtCase.defendantId, false);
    courtStore(db).setVerdict(caseId, null, 'withdrawn', nowSec);
  });

  return getCase(db, caseId)!;
}

/**
 * The defendant asks for a jury now instead of waiting out arbitration.
 *
 * The case moves to court at once, but the jury is still drawn at the next
 * day-cycle sweep. If asking also drew the jury, the defendant could pick the
 * block that seats it, the same grinding the challenger's escalate button
 * allowed.
 */
export function demandTrial(
  db: DatabaseSync,
  caseId: string,
  accountId: string,
  nowSec: number = nowSeconds(),
): CourtCase {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  if (courtCase.defendantId !== accountId) {
    throw new ForbiddenError('Only the defendant can demand a trial', 'NOT_DEFENDANT');
  }
  return escalateToFull(db, caseId, nowSec);
}

// ========== Arguments / Evidence ==========
//
// Arguments are the case's discussion log. Both sides can post text rebuttals
// at any time before the verdict is final; jurors read them before voting.
// We store them as an append-only list, so even after a verdict the trail
// stays auditable. We don't host files in the protocol layer: a post carries
// each file's name and SHA-256, and the file stays with whoever added it.

const MAX_ARGUMENT_LENGTH = 5000;
const MAX_ATTACHMENTS = 10;
const ARGUMENT_OFFERS: ReadonlySet<ArgumentOffer> = new Set(['call', 'in_person']);

function insertArgument(db: DatabaseSync, arg: CaseArgument): void {
  db.prepare(
    `INSERT INTO court_arguments (id, case_id, submitter_id, role, text, attachment_hash, attachments, offers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    arg.id, arg.caseId, arg.submitterId, arg.role, arg.text,
    arg.attachmentHash,
    arg.attachments.length > 0 ? JSON.stringify(arg.attachments) : null,
    arg.offers.length > 0 ? JSON.stringify(arg.offers) : null,
    arg.createdAt,
  );
}

function parseJsonList<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export interface ArgumentExtras {
  attachmentHash?: string;
  attachments?: ArgumentAttachment[];
  offers?: ArgumentOffer[];
}

export function submitArgument(
  db: DatabaseSync,
  caseId: string,
  submitterAccountId: string,
  text: string,
  extras: ArgumentExtras = {},
): CaseArgument {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');

  // Only the parties can post; jurors and onlookers cannot. Prevents the
  // jury pool from prejudicing the case from the bench.
  let role: ArgumentRole;
  if (submitterAccountId === courtCase.challengerId) role = 'challenger';
  else if (submitterAccountId === courtCase.defendantId) role = 'defendant';
  else throw new ForbiddenError('Only the challenger or defendant can submit arguments', 'NOT_A_PARTY');

  // Once a jury has decided, the case is closed for new arguments.
  if (
    courtCase.verdict !== null ||
    courtCase.status === 'closed' ||
    courtCase.status === 'withdrawn' ||
    courtCase.status === 'dismissed'
  ) {
    throw new ValidationError(`Case is no longer open for arguments (status: ${courtCase.status})`, 'CASE_NOT_OPEN');
  }

  const attachments = (extras.attachments ?? []).map((a) => ({ name: a.name.trim(), hash: a.hash.toLowerCase() }));
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new ValidationError(`At most ${MAX_ATTACHMENTS} files per post`, 'TOO_MANY_ATTACHMENTS');
  }
  for (const a of attachments) {
    if (!a.name || a.name.length > 200) throw new ValidationError('Each file needs a name of 1 to 200 characters', 'INVALID_ATTACHMENT');
    if (!/^[0-9a-f]{64}$/.test(a.hash)) throw new ValidationError('Each file needs its SHA-256 fingerprint', 'INVALID_ATTACHMENT');
  }
  const offers = [...new Set(extras.offers ?? [])];
  if (offers.some((o) => !ARGUMENT_OFFERS.has(o))) {
    throw new ValidationError("Offers must be 'call' or 'in_person'", 'INVALID_OFFER');
  }

  // A post can be just a file or just an offer ("I'm open to a call"), but it
  // has to carry something.
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0 && offers.length === 0) {
    throw new ValidationError('Write something, attach a file, or make an offer', 'ARGUMENT_REQUIRED');
  }
  if (trimmed.length > MAX_ARGUMENT_LENGTH) throw new ValidationError('Argument text exceeds 5,000 character limit', 'ARGUMENT_TOO_LONG');

  const arg: CaseArgument = {
    id: uuid(),
    caseId,
    submitterId: submitterAccountId,
    role,
    text: trimmed,
    attachmentHash: extras.attachmentHash ?? null,
    attachments,
    offers,
    createdAt: nowSeconds(),
  };
  insertArgument(db, arg);
  return arg;
}

export function getArgumentsForCase(db: DatabaseSync, caseId: string): CaseArgument[] {
  const rows = db.prepare(
    `SELECT id, case_id, submitter_id, role, text, attachment_hash, attachments, offers, created_at
     FROM court_arguments WHERE case_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).all(caseId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    caseId: r.case_id as string,
    submitterId: r.submitter_id as string,
    role: r.role as ArgumentRole,
    text: r.text as string,
    attachmentHash: (r.attachment_hash as string | null) ?? null,
    attachments: parseJsonList<ArgumentAttachment>(r.attachments),
    offers: parseJsonList<ArgumentOffer>(r.offers),
    createdAt: r.created_at as number,
  }));
}

export function getCase(db: DatabaseSync, caseId: string): CourtCase | null {
  return courtStore(db).findCaseById(caseId);
}

// ========== Escalate to Court ==========

/**
 * Move a case out of arbitration. Called by the day-cycle sweep when the
 * arbitration window closes without a withdrawal, and by `demandTrial`.
 * There is no challenger-facing escalate any more: whoever chose the moment
 * of escalation used to choose the block hash that drew the jury.
 */
export function escalateToFull(db: DatabaseSync, caseId: string, nowSec: number = nowSeconds()): CourtCase {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  if (courtCase.level !== 'arbitration') throw new ValidationError('Can only escalate from arbitration', 'NOT_ARBITRATION');
  // Level alone is not enough. A withdrawn or dismissed case keeps level
  // 'arbitration' and has already had its stake returned.
  if (courtCase.verdict !== null || !ARBITRATION_STATUSES.has(courtCase.status)) {
    throw new ValidationError(`Case is closed and cannot be escalated (status: ${courtCase.status})`, 'CASE_NOT_OPEN');
  }

  const seatBy = nowSec + getParam<number>(db, 'court.jury_wait_days') * 86400;
  courtStore(db).setLevelToCourt(caseId, seatBy);

  return getCase(db, caseId)!;
}

// ========== Jury Selection ==========

/**
 * Statuses where court stake is still locked in someone's `locked_balance`.
 * A settled, withdrawn or dismissed case has already released (or burned) its
 * stakes, so rescaling those would corrupt history.
 */
const OPEN_CASE_STATUSES = [
  'arbitration_open',
  'arbitration_response',
  'court_open',
  'court_waiting_jury',
  'court_voting',
  'verdict_pending',
  'appeal_open',
  'appeal_voting',
] as const;

/**
 * Rescale outstanding court stakes by the daily rebase multiplier.
 *
 * The rebase multiplies every account's `locked_balance` by
 * `targetTotal / preRebaseTotal`, but court stakes were recorded as a fixed
 * nominal amount at filing/seating time. Below 1 the recorded stake ends up
 * larger than what is locked (balances driven negative at settlement); above
 * 1 it ends up smaller (locked value stranded). Runs inside the rebase
 * transaction so stakes and balances move together or not at all.
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
 * whole attempt rolls back; no juror keeps stake locked against a case that
 * never opened. Caught by selectJury, which parks the case in
 * `court_waiting_jury` instead of advancing it.
 */
class JurySeatingFailed extends Error {}

function countJurors(db: DatabaseSync, caseId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM court_jury WHERE case_id = ?').get(caseId) as { cnt: number };
  return Number(row.cnt);
}

/**
 * Smallest jury that can decide anything: three, and odd, so a majority
 * exists and cannot tie.
 */
const MIN_VIABLE_JURY = 3;

/**
 * How many jurors to seat from `eligible` candidates, never more than
 * `maxSize` (`court.jury_size`).
 *
 * The jury steps up with the network (3, then 7, then 11, in steps of four)
 * and is never more than a third of the eligible pool, so every draw is still
 * a real draw. A small network holds trials with three jurors; the price is
 * that two people decide a case, which is why the size grows as soon as the
 * pool can carry it. Under three eligible jurors there is no trial yet.
 */
export function jurySizeFor(eligible: number, maxSize: number): number {
  const cap = maxSize % 2 === 0 ? maxSize - 1 : maxSize;
  if (eligible < MIN_VIABLE_JURY || cap < MIN_VIABLE_JURY) return 0;
  let size = MIN_VIABLE_JURY;
  for (let s = MIN_VIABLE_JURY + 4; s <= cap; s += 4) {
    if (s * 3 > eligible) break;
    size = s;
  }
  // A governed maximum that is not on the 3/7/11 ladder (say 9) is still
  // reachable once the pool can carry it.
  if (cap > size && cap * 3 <= eligible) size = cap;
  return size;
}

/**
 * Miners who sat on a jury, never voted, and are still inside the no-show
 * suspension window. Read from the jury rows themselves, so there is no
 * separate suspension table to fall out of step.
 */
function suspendedMinerIds(db: DatabaseSync, nowSec: number): Set<string> {
  const days = getParam<number>(db, 'court.no_show_suspension_days');
  const rows = db
    .prepare(
      `SELECT DISTINCT j.miner_id FROM court_jury j
         JOIN court_cases c ON c.id = j.case_id
        WHERE j.vote IS NULL
          AND c.resolved_at IS NOT NULL
          AND c.resolved_at >= ?
          AND c.status IN ('verdict_pending', 'court_verdict', 'appeal_verdict', 'dismissed')`,
    )
    .all(nowSec - days * 86400) as Array<{ miner_id: string }>;
  return new Set(rows.map((r) => r.miner_id));
}

const SEATABLE_STATUSES = new Set(['court_open', 'court_waiting_jury', 'appeal_open']);

export function selectJury(
  db: DatabaseSync,
  caseId: string,
  blockHash: string,
  nowSec: number = nowSeconds(),
): string[] {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');

  // A case gets one jury, and only once it has left arbitration.
  if (courtCase.verdict !== null || !SEATABLE_STATUSES.has(courtCase.status) || countJurors(db, caseId) > 0) {
    throw new ValidationError(`Case already has a jury or a verdict (status: ${courtCase.status})`, 'CASE_NOT_SEATABLE');
  }

  const maxJury = getParam<number>(db, 'court.jury_size');
  const jurorStakePercent = getParam<number>(db, 'court.juror_stake_percent');
  const minPercentHuman = getParam<number>(db, 'court.juror_min_percent_human');
  const votingDays = getParam<number>(db, 'court.court_voting_days');

  // A jury seat belongs to a verified human, not to a node. Anyone may run as
  // many miners as they like, AI agents included, but a seat needs an active
  // individual account at a high percent-human score, one seat per account.
  // Miner tier no longer decides it: Tier 2 rested on self-reported
  // heartbeats that no app sends, so honest miners could never reach it and a
  // script could reach it in hours.
  const suspended = suspendedMinerIds(db, nowSec);
  const seenAccounts = new Set<string>();
  let pool = getActiveMiners(db).filter((m) => {
    if (seenAccounts.has(m.accountId)) return false;
    seenAccounts.add(m.accountId);
    const acct = getAccount(db, m.accountId);
    if (!acct || !acct.isActive || acct.type !== 'individual') return false;
    // A frozen account cannot post a stake (it would move savings out of the
    // reach of its own verdict), and a closed one has no standing.
    if (acct.isEscrowed) return false;
    if (acct.percentHuman < minPercentHuman) return false;
    if (suspended.has(m.id)) return false;
    return true;
  });

  // Exclude everyone with a stake in the outcome: the parties, and on a
  // duplicate_account case the counterpart, who is the other side of the
  // dispute in everything but name.
  const interested = new Set(
    [courtCase.challengerId, courtCase.defendantId, courtCase.counterpartId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  pool = pool.filter((m) => !interested.has(m.accountId));

  // Exclude miners with a real interest in either party.
  //
  // The test is deliberately one-directional: what the JUROR did, never what
  // a party did to the juror. A transfer needs no consent from its recipient,
  // so excluding on any transaction let a challenger send one base unit to
  // every honest juror and disqualify them all.
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

  // Exclude prior jurors on this case and every round of it: the original and
  // all of its appeals, siblings included.
  const store = courtStore(db);
  const rootId = courtCase.appealOf ?? caseId;
  const relatedCaseIds = [rootId, ...store.findAppealsOf(rootId).map((a) => a.id)];

  const priorSet = new Set<string>();
  for (const rid of relatedCaseIds) {
    for (const minerId of store.findJurorMinerIds(rid)) priorSet.add(minerId);
  }
  pool = pool.filter((m) => !priorSet.has(m.id));

  // Drop miners who cannot post the juror stake BEFORE sizing the jury, so
  // the size reflects who can actually serve.
  pool = pool.filter((m) => {
    const acct = getAccount(db, m.accountId);
    if (!acct) return false;
    const stake = percentOf(acct.earnedBalance, jurorStakePercent);
    return stake > 0n && stake <= acct.earnedBalance;
  });

  // An appeal is heard by a new jury the same size as the first one. If the
  // network cannot supply that many fresh jurors, the appeal waits and is
  // eventually dismissed, and the first verdict stands.
  const actualSize = courtCase.level === 'appeal' && courtCase.appealOf
    ? (pool.length >= countJurors(db, courtCase.appealOf) ? countJurors(db, courtCase.appealOf) : 0)
    : jurySizeFor(pool.length, maxJury);

  if (actualSize < MIN_VIABLE_JURY) {
    store.setStatusWaitingJury(caseId);
    return [];
  }

  // Deterministic random selection
  const seed = sha256(caseId + blockHash);
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
        const stake = percentOf(acct.earnedBalance, jurorStakePercent);

        // Every miner still in the pool was checked for stakeability above, so
        // this should be unreachable. Throwing rather than silently skipping is
        // the point: a silent skip is exactly how a one-juror jury got seated.
        if (stake <= 0n || stake > acct.earnedBalance) {
          throw new JurySeatingFailed(`miner ${miner.id} became unstakeable between filtering and seating`);
        }

        const newEarned = acct.earnedBalance - stake;
        const newLocked = acct.lockedBalance + stake;
        updateBalance(db, miner.accountId, 'earned_balance', newEarned);
        updateBalance(db, miner.accountId, 'locked_balance', newLocked);
        recordLog(db, miner.accountId, 'vouch_lock', 'earned', stake, acct.earnedBalance, newEarned, caseId, nowSec);

        store.insertJuror({
          id: uuid(),
          caseId,
          minerId: miner.id,
          jurorAccountId: miner.accountId,
          stakeAmount: stake,
        });

        jurorIds.push(miner.id);
      }

      if (jurorIds.length < MIN_VIABLE_JURY || jurorIds.length % 2 === 0) {
        throw new JurySeatingFailed(
          `seated ${jurorIds.length} juror(s); need at least ${MIN_VIABLE_JURY} and an odd count`,
        );
      }

      store.setStatusVoting(caseId, nowSec + votingDays * 86400);
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

// A case that cannot seat a jury is retried at every sweep and dismissed
// neutrally at its seat-by deadline (expireCourtDeadlines). The network failed
// to provide a jury; neither party did anything wrong, so neither is punished.

// ========== Voting ==========

export function submitVote(
  db: DatabaseSync,
  caseId: string,
  minerId: string,
  vote: Vote,
  nowSec: number = nowSeconds(),
): void {
  const store = courtStore(db);
  const juror = store.findJurorByMiner(caseId, minerId);
  if (!juror) throw new ForbiddenError('Miner is not a juror on this case', 'NOT_A_JUROR');
  if (juror.vote) throw new ConflictError('Already voted', 'ALREADY_VOTED');

  // A vote counts only while the case is actually in voting.
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
 * of the votes cast, so one juror cannot decide alone while the rest stay
 * silent. Returns null when neither side has a majority of the seats yet. The
 * tie branch is there for an even jury and goes to the defendant.
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

// ========== Day-cycle sweep ==========

/** Appeals of `caseId` that are still running (not decided, not dismissed). */
function openAppealsOf(db: DatabaseSync, caseId: string): CourtCase[] {
  return courtStore(db)
    .findAppealsOf(caseId)
    .filter((a) => a.verdict === null && a.status !== 'dismissed' && a.status !== 'closed');
}

/**
 * Move every case along at the day boundary.
 *
 *   - Arbitration window closed without a withdrawal: the case moves to court.
 *   - In court (or an appeal) with no jury yet: draw one from the newest
 *     block, a moment no party chose. Still none by the seat-by deadline:
 *     dismiss neutrally.
 *   - Voting deadline passed: a majority of the seated jury decides;
 *     otherwise the case is dismissed and the no-shows pay for it.
 *   - Verdict pending with the appeal window closed and no appeal running:
 *     settle once, against that verdict.
 *
 * Each case is its own SQL transaction, and one failing case is logged and
 * skipped, never allowed to stop the rest of the cycle (expiry, rebase, mint).
 *
 * NOTE: court state is still node-local. When the court moves onto the chain
 * this belongs in the same ordered path as the rest of it, with the block's
 * own timestamp and hash.
 */
export function expireCourtDeadlines(
  db: DatabaseSync,
  nowSec: number,
): { resolved: string[]; dismissed: string[]; failed: string[]; escalated: string[]; seated: string[]; settled: string[] } {
  const store = courtStore(db);
  const resolved: string[] = [];
  const dismissed: string[] = [];
  const failed: string[] = [];
  const escalated: string[] = [];
  const seated: string[] = [];
  const settled: string[] = [];
  const seedHash = latestBlockHash(db);
  const appealWindow = getParam<number>(db, 'court.appeal_window_days') * 86400;

  const rows = db
    .prepare(
      `SELECT id FROM court_cases
        WHERE status IN ('arbitration_open', 'arbitration_response', 'court_open', 'court_waiting_jury',
                         'appeal_open', 'court_voting', 'verdict_pending')
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{ id: string }>;

  for (const { id } of rows) {
    try {
      let c = getCase(db, id);
      // An earlier case in this same sweep can settle this one (an appeal
      // dismissal settles its original), so re-read and skip anything closed.
      if (!c) continue;

      if (ARBITRATION_STATUSES.has(c.status) && c.verdict === null) {
        if (c.arbitrationDeadline === null || c.arbitrationDeadline > nowSec) continue;
        escalateToFull(db, id, nowSec);
        escalated.push(id);
        c = getCase(db, id)!;
      }

      if (SEATABLE_STATUSES.has(c.status) && c.verdict === null) {
        // A seating attempt that throws must not keep the case from reaching
        // its seat-by dismissal, or the defendant stays frozen for good.
        let seatedNow = false;
        try {
          seatedNow = selectJury(db, id, seedHash, nowSec).length > 0;
        } catch (err) {
          logger.error('court', `Could not seat a jury for case ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (seatedNow) {
          seated.push(id);
          continue;
        }
        if (c.votingDeadline !== null && c.votingDeadline <= nowSec) {
          dismissCase(db, id, nowSec);
          dismissed.push(id);
        }
        continue;
      }

      if (c.status === 'court_voting' && c.verdict === null) {
        if (c.votingDeadline === null || c.votingDeadline > nowSec) continue;
        if (tallyVotes(store.findJurorsByCase(id)).verdict !== null) {
          resolveCase(db, id, nowSec);
          resolved.push(id);
        } else {
          dismissCase(db, id, nowSec);
          dismissed.push(id);
        }
        continue;
      }

      if (c.status === 'verdict_pending' && c.verdict !== null) {
        if (openAppealsOf(db, id).length > 0) continue;
        if (c.resolvedAt !== null && c.resolvedAt + appealWindow > nowSec) continue;
        finalizeCase(db, id, c.verdict, nowSec);
        settled.push(id);
      }
    } catch (err) {
      failed.push(id);
      logger.error(
        'court',
        `Could not move case ${id} along; leaving it as it is and continuing. ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { resolved, dismissed, failed, escalated, seated, settled };
}

// ========== Dismissal ==========

/**
 * Neutral close: no verdict. The challenger's stake comes back, the
 * defendant is un-frozen, and jurors who voted get their stakes back.
 *
 * Jurors who never voted forfeit their case stake, split among the jurors
 * who did (burned if nobody voted). A dismissal for lack of a majority is
 * usually caused by exactly those no-shows.
 *
 * Dismissing an appeal leaves the first verdict standing, so the original
 * case settles right here against it.
 */
function dismissCase(db: DatabaseSync, caseId: string, nowSec: number): void {
  const store = courtStore(db);
  const courtCase = getCase(db, caseId);
  if (!courtCase || courtCase.verdict !== null) return;

  // An appeal locks no challenger stake and does not escrow the defendant: the
  // stake figure on its row is a copy of the original case's.
  const isAppeal = courtCase.level === 'appeal';

  runTransaction(db, () => {
    settleUndecidedJury(db, store.findJurorsByCase(caseId), caseId, nowSec);
    if (!isAppeal) {
      const released = takeLocked(db, courtCase.challengerId, courtCase.challengerStake, caseId, nowSec);
      creditEarned(db, courtCase.challengerId, released, 'vouch_unlock', caseId, nowSec);
      setEscrowed(db, courtCase.defendantId, false);
    }
    store.setVerdict(caseId, null, 'dismissed', nowSec);
    recordJuryService(db, caseId, null);

    if (isAppeal && courtCase.appealOf) {
      const original = getCase(db, courtCase.appealOf);
      if (original && original.status === 'verdict_pending' && original.verdict) {
        finalizeCase(db, original.id, original.verdict, nowSec);
      }
    }
  });
}

/** Juror stakes on a round that reached no verdict. */
function settleUndecidedJury(db: DatabaseSync, jurors: JurorRecord[], caseId: string, now: number): void {
  const voters = jurors.filter((j) => j.vote !== null);
  let pot = 0n;
  for (const j of jurors) {
    if (j.vote !== null) {
      const back = takeLocked(db, j.jurorAccountId, j.stakeAmount, caseId, now);
      creditEarned(db, j.jurorAccountId, back, 'vouch_unlock', caseId, now);
    } else {
      pot += takeLocked(db, j.jurorAccountId, j.stakeAmount, caseId, now, true);
    }
  }
  splitPot(db, voters, pot, caseId, now);
}

/**
 * Share forfeited juror stakes equally among `recipients`. Integer division
 * leaves at most recipients-1 base units, which are burned with any pot that
 * has nobody to go to. The pot comes from jurors, never from the defendant,
 * so the split pays the same whichever way the verdict goes and gives no
 * juror a reason to prefer "guilty".
 */
function splitPot(db: DatabaseSync, recipients: JurorRecord[], pot: bigint, caseId: string, now: number): void {
  if (pot <= 0n || recipients.length === 0) return;
  const share = pot / BigInt(recipients.length);
  for (const r of recipients) {
    creditEarned(db, r.jurorAccountId, share, 'jury_reward', caseId, now);
  }
}

// ========== Verdict ==========

/**
 * A jury has decided the original case. Nothing moves yet.
 *
 * The verdict is recorded and the case waits out the appeal window with every
 * stake still locked and the defendant still frozen. It then settles once,
 * against the final verdict (finalizeCase). With appeals governed off
 * (`court.max_appeals` = 0) there is nothing to wait for, so it settles now.
 */
export function resolveVerdict(db: DatabaseSync, caseId: string, nowSec: number = nowSeconds()): Verdict {
  const store = courtStore(db);
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  if (courtCase.level === 'appeal') return resolveAppeal(db, caseId, nowSec);

  // Decide exactly once. A repeat (an HTTP retry, a double click) must not
  // run anything a second time.
  if (courtCase.verdict !== null) {
    throw new ConflictError(`Case ${caseId} already resolved as ${courtCase.verdict}`, 'ALREADY_RESOLVED');
  }
  if (courtCase.status !== 'court_voting') {
    throw new ValidationError(`Case is not in voting (status: ${courtCase.status})`, 'NOT_VOTING');
  }

  const tally = tallyVotes(store.findJurorsByCase(caseId));
  if (tally.cast === 0) throw new ValidationError('No votes cast', 'NO_VOTES');
  if (tally.verdict === null) {
    throw new ValidationError(
      `No majority of the seated jury yet (${tally.cast} of ${tally.seated} voted)`,
      'NO_QUORUM',
    );
  }
  const verdict: Verdict = tally.verdict;

  runTransaction(db, () => {
    store.setVerdict(caseId, verdict, 'verdict_pending', nowSec);
    if (getParam<number>(db, 'court.max_appeals') <= 0) {
      finalizeCase(db, caseId, verdict, nowSec);
    }
  });

  return verdict;
}

/**
 * Resolve a case, appeal or not. Use this from every call site instead of
 * picking a function by hand.
 */
export function resolveCase(db: DatabaseSync, caseId: string, nowSec: number = nowSeconds()): Verdict {
  const courtCase = getCase(db, caseId);
  if (!courtCase) throw new NotFoundError('Case not found');
  return courtCase.level === 'appeal' ? resolveAppeal(db, caseId, nowSec) : resolveVerdict(db, caseId, nowSec);
}

/**
 * Settle a decided case once, against the final verdict: the jury's own if
 * nobody appealed, or the appeal jury's.
 *
 * Every juror on every decided round (the first jury and the appeal jury) is
 * judged against the FINAL verdict, as the white paper says. Before, the first
 * jury was settled against its own verdict even when the appeal overturned it,
 * so the jurors who had it right lost their stakes.
 */
function finalizeCase(db: DatabaseSync, caseId: string, finalVerdict: Verdict, nowSec: number): void {
  const store = courtStore(db);
  const original = getCase(db, caseId);
  if (!original) throw new NotFoundError('Case not found');
  if (original.status !== 'verdict_pending') {
    throw new ValidationError(`Only a decided, unsettled case can be settled (status: ${original.status})`, 'NOT_PENDING');
  }

  // Rounds that reached a verdict. A dismissed appeal's jurors were settled
  // when it was dismissed.
  const decidedAppeals = store.findAppealsOf(caseId).filter((a) => a.status === 'appeal_verdict');
  const roundIds = [caseId, ...decidedAppeals.map((a) => a.id)];
  const jurors = roundIds.flatMap((id) => store.findJurorsByCase(id));

  runTransaction(db, () => {
    if (finalVerdict === 'guilty') {
      applyGuiltyVerdict(db, original, nowSec);
    } else {
      applyInnocentVerdict(db, original, nowSec);
    }
    settleJurorsAgainst(db, jurors, finalVerdict, caseId, nowSec);
    // The case row carries the FINAL verdict, so everything that reads it (the
    // case page, "my cases") shows what actually happened. An overturned first
    // verdict is still on record: the appeal row and the first jury's votes.
    store.setVerdict(caseId, finalVerdict, 'court_verdict', original.resolvedAt ?? nowSec);

    // Feed the final outcome back to the miners who verified this account
    // (the white paper's "miner accuracy is measured against court outcomes")
    // and to every juror's duty record. Once, at the end, so an overturned
    // verdict never touches anyone's record.
    applyAccuracyImpact(db, { ...original, verdict: finalVerdict });
    for (const id of roundIds) recordJuryService(db, id, finalVerdict);
  });
}

/**
 * Not human, final. The account closes and all of its savings are taken.
 *
 * Staked points are earned points, so "all of its savings" includes stakes it
 * posted for others (vouches it gave), not only the earned bucket. Taking
 * earned alone let an account move its savings into stakes and leave the
 * verdict, the burn and the bounty with nothing. The bounty is a share of the
 * whole; the rest is burned.
 *
 * Not touched here, because they belong to tables the chain owns and must not
 * change on one node alone: a validator stake, and the account's miner
 * record. A closed account already cannot sit on a jury (selectJury reads the
 * account), and both wait for the on-chain court lane.
 */
function applyGuiltyVerdict(db: DatabaseSync, courtCase: CourtCase, now: number): void {
  const defendant = getAccount(db, courtCase.defendantId)!;
  const bountyPercent = getParam<number>(db, 'court.bounty_percent');

  const given = getVouchesGivenBy(db, courtCase.defendantId);
  let givenTotal = given.reduce((sum, v) => sum + v.stakeAmount, 0n);
  if (givenTotal > defendant.lockedBalance) givenTotal = defendant.lockedBalance;
  const bountyAmount = percentOf(defendant.earnedBalance + givenTotal, bountyPercent);

  // Burn the stakes the defendant posted for others (true burns, out of the
  // defendant's locked balance; the bounty below is paid from the total).
  for (const v of given) burnVouch(db, v.id);

  updateBalance(db, courtCase.defendantId, 'earned_balance', 0n);
  recordLog(db, courtCase.defendantId, 'court_burn', 'earned', defendant.earnedBalance, defendant.earnedBalance, 0n, courtCase.id, now);
  deactivateAccount(db, courtCase.defendantId);

  creditEarned(db, courtCase.challengerId, bountyAmount, 'bounty', courtCase.id, now);

  // The challenger was right: their stake comes back.
  const released = takeLocked(db, courtCase.challengerId, courtCase.challengerStake, courtCase.id, now);
  creditEarned(db, courtCase.challengerId, released, 'vouch_unlock', courtCase.id, now);

  // Burn the stakes others posted for the defendant.
  burnAllVouchesOnAccount(db, courtCase.defendantId);

  // WP §9.3 also has the counterpart in a duplicate-account case pay twice
  // the overlap allocations. That penalty is NOT applied, on purpose: as
  // built, the counterpart was whoever the challenger typed into the filing,
  // never notified, unable to respond or appeal. Parked by Matt (Oct 16 2026)
  // as an area to think about more.
}

/**
 * Human, final. The freeze lifts, the challenger's stake is forfeited (the
 * defendant's share as compensation for the freeze, the rest burned), and the
 * account gets its protection window.
 */
function applyInnocentVerdict(db: DatabaseSync, courtCase: CourtCase, now: number): void {
  setEscrowed(db, courtCase.defendantId, false);

  const forfeited = takeLocked(db, courtCase.challengerId, courtCase.challengerStake, courtCase.id, now, true);
  const defendantShare = percentOf(forfeited, getParam<number>(db, 'court.forfeited_challenger_def_share') * 100);
  creditEarned(db, courtCase.defendantId, defendantShare, 'court_compensation', courtCase.id, now);

  const protectionDays = getParam<number>(db, 'court.protection_window_days');
  const currentDay = cycleStateStore(db).getCurrentDay();
  db.prepare('UPDATE accounts SET protection_window_end = ? WHERE id = ?').run(
    currentDay + protectionDays, courtCase.defendantId,
  );
}

/**
 * Juror stakes on decided rounds, judged against the final verdict.
 *
 * Jurors who matched it get their stake back. Jurors who voted the other way,
 * and jurors who never voted, forfeit theirs, and the forfeited stakes are
 * split among the jurors who matched.
 */
function settleJurorsAgainst(
  db: DatabaseSync,
  jurors: JurorRecord[],
  finalVerdict: Verdict,
  caseId: string,
  now: number,
): void {
  const winning: Vote = finalVerdict === 'guilty' ? 'not_human' : 'human';
  const matched = jurors.filter((j) => j.vote === winning);
  let pot = 0n;
  for (const j of jurors) {
    if (j.vote === winning) {
      const back = takeLocked(db, j.jurorAccountId, j.stakeAmount, j.caseId, now);
      creditEarned(db, j.jurorAccountId, back, 'vouch_unlock', j.caseId, now);
    } else {
      pot += takeLocked(db, j.jurorAccountId, j.stakeAmount, j.caseId, now, true);
    }
  }
  splitPot(db, matched, pot, caseId, now);
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

/**
 * The losing side asks for a second jury. Standing (who may appeal) is
 * checked by the route; this checks the case.
 *
 * Nothing has settled yet (the case is `verdict_pending`), so the appeal
 * needs no stake of its own: the challenger's original stake and the
 * defendant's frozen savings are both still riding on the final verdict.
 * The new jury is drawn at the next day-cycle sweep, not here, so the
 * appellant cannot pick the block that seats it.
 */
export function fileAppeal(db: DatabaseSync, caseId: string, nowSec: number = nowSeconds()): CourtCase {
  const store = courtStore(db);
  const original = getCase(db, caseId);
  if (!original) throw new NotFoundError('Case not found');
  if (!original.verdict) throw new ValidationError('Case has no verdict to appeal', 'NO_VERDICT');
  if (original.level === 'appeal') throw new ValidationError('Cannot appeal an appeal', 'CANNOT_APPEAL_APPEAL');
  if (original.status !== 'verdict_pending') {
    throw new ValidationError('This verdict is final and settled', 'VERDICT_FINAL');
  }

  const maxAppeals = getParam<number>(db, 'court.max_appeals');
  if (store.countAppealsOf(caseId) >= maxAppeals) throw new ValidationError('Maximum appeals reached', 'MAX_APPEALS');
  // One appeal at a time. With two allowed (`court.max_appeals` = 2), two
  // filed together could seat overlapping juries, and whichever was decided
  // first settled the case, leaving the other unable to settle and its
  // jurors' stakes locked for good.
  if (openAppealsOf(db, caseId).length > 0) {
    throw new ConflictError('An appeal of this case is already running', 'APPEAL_IN_PROGRESS');
  }

  const windowDays = getParam<number>(db, 'court.appeal_window_days');
  if (original.resolvedAt !== null && nowSec > original.resolvedAt + windowDays * 86400) {
    throw new ValidationError(`The ${windowDays}-day appeal window has closed`, 'APPEAL_WINDOW_CLOSED');
  }

  const id = uuid();
  // Before a jury is seated, voting_deadline holds the seat-by deadline.
  const seatBy = nowSec + getParam<number>(db, 'court.jury_wait_days') * 86400;

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
    votingDeadline: seatBy,
    appealOf: caseId,
    counterpartId: original.counterpartId,
    createdAt: nowSec,
  });

  return getCase(db, id)!;
}

/**
 * The appeal jury has decided. Its verdict is final, so the whole case settles
 * now, against it.
 */
export function resolveAppeal(db: DatabaseSync, appealCaseId: string, nowSec: number = nowSeconds()): Verdict {
  const store = courtStore(db);
  const appealCase = getCase(db, appealCaseId);
  if (!appealCase) throw new NotFoundError('Appeal case not found');
  if (appealCase.level !== 'appeal') throw new ValidationError('Not an appeal case', 'NOT_APPEAL');

  if (appealCase.verdict !== null) {
    throw new ConflictError(`Appeal ${appealCaseId} already resolved as ${appealCase.verdict}`, 'ALREADY_RESOLVED');
  }
  if (appealCase.status !== 'court_voting') {
    throw new ValidationError(`Appeal is not in voting (status: ${appealCase.status})`, 'NOT_VOTING');
  }

  const original = appealCase.appealOf ? getCase(db, appealCase.appealOf) : null;
  if (!original || original.status !== 'verdict_pending') {
    throw new ValidationError('The case this appeal belongs to is not awaiting a final verdict', 'NOT_PENDING');
  }

  const tally = tallyVotes(store.findJurorsByCase(appealCaseId));
  if (tally.cast === 0) throw new ValidationError('No votes cast', 'NO_VOTES');
  if (tally.verdict === null) {
    throw new ValidationError(
      `No majority of the seated jury yet (${tally.cast} of ${tally.seated} voted)`,
      'NO_QUORUM',
    );
  }
  const verdict: Verdict = tally.verdict;

  runTransaction(db, () => {
    store.setVerdict(appealCaseId, verdict, 'appeal_verdict', nowSec);
    finalizeCase(db, original.id, verdict, nowSec);
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

  const now = nowSeconds();

  for (const review of reviews) {
    // A score of 50 or more judged the account likely human, which the court
    // has now found wrong.
    const matchedVerdict = review.score < 50 ? 1 : 0;

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

/**
 * Write each juror's attendance and accuracy for one round (WP §8.4: jury
 * accuracy is votes matching the FINAL verdict; Tier 2 requires 100%
 * attendance). Pass the final verdict; it defaults to the round's own.
 *
 * With `finalVerdict` null (a dismissed round) only the no-shows are
 * recorded: there was no verdict to match, so recording the voters would
 * count them as wrong.
 *
 * This had no production caller, so attendance was always 100% and jury
 * accuracy was never measured.
 */
export function recordJuryService(db: DatabaseSync, caseId: string, finalVerdict?: Verdict | null): void {
  const jurors = courtStore(db).findJurorsByCase(caseId);
  const courtCase = getCase(db, caseId)!;
  const verdict = finalVerdict === undefined ? courtCase.verdict : finalVerdict;
  const mining = miningStore(db);
  const now = nowSeconds();

  for (const juror of jurors) {
    const voted = juror.vote !== null;
    if (verdict === null && voted) continue;
    const matchedVerdict = voted && (
      (verdict === 'guilty' && juror.vote === 'not_human') ||
      (verdict === 'innocent' && juror.vote === 'human')
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
