import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { authMiddleware, minerAuthMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as schemas from '../schemas.js';
import { eventBus } from '../websocket.js';
import {
  fileChallenge,
  getCase,
  escalateToFull,
  selectJury,
  submitVote,
  resolveCase,
  getActiveCases,
  courtStore,
  submitArgument,
  getArgumentsForCase,
  fileAppeal,
} from '../../court/court.js';
import { getLatestBlock } from '../../core/block.js';
import { getMiner } from '../../mining/registration.js';
import type { CaseType, Vote } from '../../court/types.js';

export function courtRoutes(db: DatabaseSync): Router {
  const router = Router();

  // POST /court/challenges - file a challenge against an account.
  // Auth + miner-required: only registered miners can challenge. Stake is a
  // percentage of the challenger's Earned, locked at filing and burned if
  // the case is lost.
  router.post('/challenges', authMiddleware(db), minerAuthMiddleware(db), validateBody(schemas.fileChallenge), (req, res, next) => {
    try {
      const challengerAccountId = req.accountId!;
      const { defendantAccountId, caseType, stakePercent, openingArgument, counterpartAccountId } = req.body.payload || req.body;

      if (!defendantAccountId || !caseType || typeof stakePercent !== 'number') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'defendantAccountId, caseType, and stakePercent required' },
        });
        return;
      }
      if (caseType !== 'not_human' && caseType !== 'duplicate_account') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CASE_TYPE', message: 'caseType must be not_human or duplicate_account' },
        });
        return;
      }

      const courtCase = fileChallenge(
        db, challengerAccountId, defendantAccountId, caseType as CaseType, stakePercent,
        typeof openingArgument === 'string' ? openingArgument : undefined,
        typeof counterpartAccountId === 'string' ? counterpartAccountId : undefined,
      );

      // Notify the defendant in real time so their wallet shows the summons.
      eventBus.emit('court:filed-against', {
        accountId: defendantAccountId,
        caseId: courtCase.id,
        challengerAccountId,
        caseType,
      });

      res.json({
        success: true,
        data: { case: serializeCase(courtCase) },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /court/cases - public list of all active cases.
  router.get('/cases', (_req, res, next) => {
    try {
      const cases = getActiveCases(db);
      res.json({
        success: true,
        data: { cases: cases.map(serializeCase) },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /court/cases/:id - public case detail with jury + votes.
  router.get('/cases/:id', (req, res, next) => {
    try {
      const caseId = req.params.id as string;
      const courtCase = getCase(db, caseId);
      if (!courtCase) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Case not found' } });
        return;
      }
      const jury = courtStore(db).findJurorsByCase(caseId);

      // Hide individual votes until all jurors have voted (white-paper sealed-vote rule).
      const allVoted = jury.length > 0 && jury.every((j) => j.vote !== null);

      const caseArguments = getArgumentsForCase(db, caseId);

      res.json({
        success: true,
        data: {
          case: serializeCase(courtCase),
          jury: jury.map((j) => ({
            minerId: j.minerId,
            jurorAccountId: j.jurorAccountId,
            stakeAmount: j.stakeAmount.toString(),
            vote: allVoted ? j.vote : (j.vote === null ? null : 'sealed'),
            votedAt: j.votedAt,
          })),
          votesRevealed: allVoted,
          arguments: caseArguments,
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /court/cases/:id/arguments - submit an argument or rebuttal on a case.
  // Auth required; backend gates the submitter to challenger or defendant.
  router.post('/cases/:id/arguments', authMiddleware(db), validateBody(schemas.submitArgument), (req, res, next) => {
    try {
      const caseId = req.params.id as string;
      const { text, attachmentHash } = req.body.payload || req.body;
      if (typeof text !== 'string' || !text.trim()) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'text is required' },
        });
        return;
      }
      const arg = submitArgument(
        db, caseId, req.accountId!, text,
        typeof attachmentHash === 'string' ? attachmentHash : undefined,
      );
      // Notify both parties so the other side sees the new post in real time.
      const courtCase = getCase(db, caseId);
      if (courtCase) {
        const otherParty = req.accountId === courtCase.challengerId
          ? courtCase.defendantId
          : courtCase.challengerId;
        eventBus.emit('court:argument', {
          accountId: otherParty,
          caseId,
          argumentId: arg.id,
          role: arg.role,
        });
      }
      res.json({
        success: true,
        data: { argument: arg },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /court/cases/:id/escalate - challenger escalates from arbitration to full court.
  // Auth required; only the original challenger can escalate.
  router.post('/cases/:id/escalate', authMiddleware(db), (req, res, next) => {
    try {
      const caseId = req.params.id as string;
      const courtCase = getCase(db, caseId);
      if (!courtCase) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Case not found' } });
        return;
      }
      if (courtCase.challengerId !== req.accountId) {
        res.status(403).json({ success: false, error: { code: 'NOT_CHALLENGER', message: 'Only the challenger can escalate' } });
        return;
      }
      const updated = escalateToFull(db, caseId);

      // Auto-select the jury at the latest block hash for deterministic randomness.
      const latest = getLatestBlock(db);
      const jurorMinerIds = selectJury(db, caseId, latest?.hash ?? 'genesis');

      // Notify each juror miner that they've been called.
      for (const minerId of jurorMinerIds) {
        const miner = getMiner(db, minerId);
        if (miner) {
          eventBus.emit('jury:called', {
            accountId: miner.accountId,
            minerId,
            caseId,
          });
        }
      }

      res.json({
        success: true,
        data: { case: serializeCase(updated), juryMinerIds: jurorMinerIds },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /cases/:id/appeal - the losing party asks for a second jury.
  //
  // fileAppeal existed and had no production caller, so the entire appeal
  // system was unreachable from both apps: a verdict was final regardless of
  // what the white paper says, and the appeal settlement logic could never run
  // because nothing could create an appeal to settle.
  //
  // fileAppeal itself checks the case is appealable but says nothing about WHO
  // may appeal, so standing is enforced here. Only the party that lost has it:
  // a guilty verdict is the defendant's to appeal, an innocent one the
  // challenger's. Without this, either side could appeal a result they won, or
  // an uninvolved account could drag a settled case back open.
  router.post('/cases/:id/appeal', authMiddleware(db), (req, res, next) => {
    try {
      const caseId = req.params.id as string;
      const original = getCase(db, caseId);
      if (!original) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Case not found' } });
        return;
      }
      if (!original.verdict) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_VERDICT', message: 'Case has no verdict to appeal' },
        });
        return;
      }

      const losingParty =
        original.verdict === 'guilty' ? original.defendantId : original.challengerId;
      if (req.accountId !== losingParty) {
        res.status(403).json({
          success: false,
          error: {
            code: 'NO_STANDING',
            message: `Only the losing party may appeal (verdict: ${original.verdict})`,
          },
        });
        return;
      }

      const latest = getLatestBlock(db);
      const appeal = fileAppeal(db, caseId, latest?.hash ?? 'genesis');

      // Tell the other side their win is being contested, and call the new jury.
      const otherParty =
        losingParty === original.defendantId ? original.challengerId : original.defendantId;
      eventBus.emit('court:appeal', { accountId: otherParty, caseId, appealId: appeal.id });
      for (const juror of courtStore(db).findJurorsByCase(appeal.id)) {
        const miner = getMiner(db, juror.minerId);
        if (miner) {
          eventBus.emit('jury:called', {
            accountId: miner.accountId,
            minerId: juror.minerId,
            caseId: appeal.id,
          });
        }
      }

      res.json({
        success: true,
        data: { case: serializeCase(appeal), appealOf: caseId },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // POST /court/cases/:id/vote - juror submits a sealed vote.
  // Auth + miner-required: only the assigned juror miner can vote.
  router.post('/cases/:id/vote', authMiddleware(db), minerAuthMiddleware(db), validateBody(schemas.castVote), (req, res, next) => {
    try {
      const caseId = req.params.id as string;
      const minerId = req.minerId!;
      const { vote } = req.body.payload || req.body;
      if (vote !== 'human' && vote !== 'not_human') {
        res.status(400).json({ success: false, error: { code: 'INVALID_VOTE', message: "vote must be 'human' or 'not_human'" } });
        return;
      }

      submitVote(db, caseId, minerId, vote as Vote);

      // If all jurors have voted, resolve the verdict and notify both parties.
      const remaining = courtStore(db).countUnvoted(caseId);

      let verdict: string | null = null;
      if (remaining === 0) {
        verdict = resolveCase(db, caseId);
        const courtCase = getCase(db, caseId);
        if (courtCase) {
          eventBus.emit('court:verdict', {
            accountId: courtCase.defendantId,
            caseId,
            verdict,
          });
          eventBus.emit('court:verdict', {
            accountId: courtCase.challengerId,
            caseId,
            verdict,
          });
        }
      }

      res.json({
        success: true,
        data: { recorded: true, verdict },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /court/jury-duty/:accountId - cases where this miner has jury duty.
  //
  // Sealed-vote rule (audit #13). This endpoint is unauthenticated, so it must
  // not reveal any juror's vote before that case's jury has fully voted - the
  // same rule GET /court/cases/:id already enforces. Before this fix it
  // returned j.vote and j.voted_at unconditionally, which let anyone read a
  // juror's choice mid-vote by hitting this route, defeating the seal the
  // case-detail page was careful to keep. A juror's OWN duty list can still show
  // their vote, but only once the case is decided; until then it reads 'sealed'.
  router.get('/jury-duty/:accountId', (req, res, next) => {
    try {
      const accountId = req.params.accountId as string;
      const rows = db.prepare(
        `SELECT j.case_id, j.stake_amount, j.vote, j.voted_at,
                c.type, c.level, c.status, c.challenger_id, c.defendant_id, c.voting_deadline, c.verdict
         FROM court_jury j
         JOIN court_cases c ON c.id = j.case_id
         WHERE j.juror_account_id = ?
         ORDER BY c.created_at DESC`
      ).all(accountId) as Array<Record<string, unknown>>;

      // Per case: has every juror voted? If not, this case's votes stay sealed.
      const allVotedByCase = new Map<string, boolean>();
      for (const r of rows) {
        const caseId = r.case_id as string;
        if (allVotedByCase.has(caseId)) continue;
        const jurors = courtStore(db).findJurorsByCase(caseId);
        allVotedByCase.set(caseId, jurors.length > 0 && jurors.every((j) => j.vote !== null));
      }

      res.json({
        success: true,
        data: {
          assignments: rows.map((r) => {
            const revealed = allVotedByCase.get(r.case_id as string) === true;
            return {
              caseId: r.case_id,
              caseType: r.type,
              caseLevel: r.level,
              caseStatus: r.status,
              challengerId: r.challenger_id,
              defendantId: r.defendant_id,
              votingDeadline: r.voting_deadline,
              verdict: r.verdict,
              stakeAmount: r.stake_amount,
              // Sealed until the whole jury has voted; null stays null so the UI
              // can still tell "not yet voted" from "voted, sealed".
              myVote: revealed ? r.vote : (r.vote === null ? null : 'sealed'),
              votedAt: revealed ? r.voted_at : null,
              votesRevealed: revealed,
            };
          }),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  // GET /court/my-cases/:accountId - cases where this account is the defendant or challenger.
  router.get('/my-cases/:accountId', (req, res, next) => {
    try {
      const accountId = req.params.accountId as string;
      const cases = courtStore(db).findCasesByAccount(accountId);
      res.json({
        success: true,
        data: {
          cases: cases.map((c) => ({
            id: c.id,
            type: c.type,
            level: c.level,
            status: c.status,
            challengerId: c.challengerId,
            defendantId: c.defendantId,
            challengerStake: c.challengerStake.toString(),
            challengerStakePercent: c.challengerStakePercent,
            verdict: c.verdict,
            createdAt: c.createdAt,
            resolvedAt: c.resolvedAt,
            isDefendant: c.defendantId === accountId,
            isChallenger: c.challengerId === accountId,
          })),
        },
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      });
    } catch (e) { next(e); }
  });

  return router;
}

function serializeCase(c: ReturnType<typeof getCase> & object) {
  return {
    id: c.id,
    type: c.type,
    level: c.level,
    challengerId: c.challengerId,
    defendantId: c.defendantId,
    challengerStake: c.challengerStake.toString(),
    challengerStakePercent: c.challengerStakePercent,
    status: c.status,
    arbitrationDeadline: c.arbitrationDeadline,
    votingDeadline: c.votingDeadline,
    verdict: c.verdict,
    appealOf: c.appealOf,
    counterpartId: c.counterpartId,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
  };
}
