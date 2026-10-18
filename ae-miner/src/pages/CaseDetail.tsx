// Court case page (miner side).
//
// The wallet's case page from the miner's seats. A miner meets a case either
// as the challenger who filed it or as a juror who decides it. Top to bottom:
// what the case claims and what you have staked, a tracker of the six steps
// (tap any step to see what happens and what it means for you, including
// steps the case has not reached yet), the challenger's evidence, the
// defendant's side, and, depending on your seat, a form to add evidence or
// your vote.

import { useEffect, useState, useCallback, useRef, type ChangeEvent, type RefObject } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadMinerWallet } from '../lib/keys';
import { api, type CaseHeader, type CaseArgument, type JurorRow } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';
import { displayPoints, timeAgo } from '../lib/formatting';
import { hashFileSHA256 } from '../lib/hash';
import {
  COURT_STEPS,
  caseProgress,
  claimText,
  stakeNote,
  stepIndex,
  whereLabel,
  type CaseProgress,
  type CourtSeat,
  type CourtStepId,
} from '../lib/courtSteps';
import { CaseTracker } from '../components/court/CaseTracker';

type Wallet = { accountId: string; privateKey: string };
type Offer = 'call' | 'in_person';
type Busy = 'vote' | 'withdraw' | 'appeal' | null;

const CASE_OPEN_STATUSES = new Set([
  'arbitration_open', 'arbitration_response',
  'court_open', 'court_waiting_jury', 'court_voting',
  'appeal_open', 'appeal_voting',
]);

const OFFER_LABELS: Record<Offer, string> = {
  call: 'Open to a live call',
  in_person: 'Can meet in person',
};

// Sample jurors for the example screens of steps a case has not reached.
const EXAMPLE_JURORS = [
  '7f3a9c21d84e5b06a1c2e9f04d7b3a8e5c216f90',
  '2b8e4d71a3c95f0e86d2b47a1c3e9f5d08a6b2c4',
  'c41d07e9a2b58f63d1e04a9c7b2f85e3a6d10c97',
];

function signed(wallet: Wallet, payload: object) {
  const timestamp = Math.floor(Date.now() / 1000);
  return { accountId: wallet.accountId, timestamp, signature: signPayload(payload, timestamp, wallet.privateKey), payload };
}

/** Whole days from now until a unix-seconds deadline, never negative. */
function daysUntil(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now() / 1000) / 86400));
}

function shortDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const wallet = loadMinerWallet();

  const [caseHeader, setCaseHeader] = useState<CaseHeader | null>(null);
  const [argumentLog, setArgumentLog] = useState<CaseArgument[]>([]);
  const [jury, setJury] = useState<JurorRow[]>([]);
  const [votesRevealed, setVotesRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CourtStepId | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const composeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getCase(id);
      if (r.success) {
        setCaseHeader(r.data.case);
        setArgumentLog(r.data.arguments ?? []);
        setJury(r.data.jury ?? []);
        setVotesRevealed(r.data.votesRevealed ?? false);
        setError(null);
      } else {
        setError(r.error?.message ?? 'Failed to load case');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
    const offs = ['court:argument', 'court:verdict', 'court:trial-demanded', 'court:appeal', 'jury:called'].map((evt) =>
      wsClient.on(evt, (data) => {
        if ((data as { caseId?: string }).caseId === id) load();
      }),
    );
    return () => { for (const off of offs) off(); };
  }, [id, load]);

  if (loading) {
    return <div className="p-4"><p className="text-sm text-muted">Loading case…</p></div>;
  }
  if (!caseHeader) {
    return (
      <div className="p-4 space-y-3">
        <Link to="/court" className="text-xs text-teal hover:underline">← Back to court</Link>
        <p className="text-sm text-red">{error ?? 'Case not found'}</p>
      </div>
    );
  }

  const myAccountId = wallet?.accountId ?? '';
  const isChallenger = myAccountId === caseHeader.challengerId;
  const isDefendant = myAccountId === caseHeader.defendantId;
  const isParty = isChallenger || isDefendant;
  const myJurorRow = jury.find((j) => j.jurorAccountId === myAccountId) ?? null;
  const seat: CourtSeat = isChallenger ? 'challenger' : myJurorRow ? 'juror' : 'observer';
  const caseOpen = caseHeader.verdict === null && CASE_OPEN_STATUSES.has(caseHeader.status);
  const progress = caseProgress(caseHeader.status);
  const shown = selected ?? progress.current;

  async function act(kind: Exclude<Busy, null>, vote?: 'human' | 'not_human') {
    if (!wallet?.privateKey || !caseHeader) return;
    setBusy(kind);
    setError(null);
    try {
      const r =
        kind === 'vote'
          ? await api.submitVote(caseHeader.id, signed(wallet, { vote }))
          : kind === 'withdraw'
            ? await api.withdrawCase(caseHeader.id, signed(wallet, {}))
            : await api.appealCase(caseHeader.id, signed(wallet, {}));
      if (r.success) {
        setSelected(null);
        await load();
      } else {
        setError(r.error?.message ?? 'That did not go through');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  const challengerPosts = argumentLog.filter((a) => a.role === 'challenger');
  const defendantPosts = argumentLog.filter((a) => a.role === 'defendant');

  return (
    <div className="p-4 space-y-4 max-w-3xl">
      <Link to="/court" className="text-xs text-teal hover:underline">← Back to court</Link>

      <CaseSummary c={caseHeader} me={myAccountId} juror={myJurorRow} />

      {error && <div className="p-3 bg-red/10 border border-red/20 rounded text-sm text-red">{error}</div>}

      <div className="bg-panel border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-white">How this case works</h3>
          <span className="text-[11px] text-muted">Click any step to see it</span>
        </div>
        <CaseTracker progress={progress} selected={shown} onSelect={setSelected} />
        <StepPanel
          stepId={shown}
          progress={progress}
          seat={seat}
          c={caseHeader}
          me={myAccountId}
          jury={jury}
          myJurorRow={myJurorRow}
          votesRevealed={votesRevealed}
          busy={busy}
          onAct={act}
          onWrite={() => composeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          canWrite={isParty && caseOpen}
        />
      </div>

      <PostSection
        title={isChallenger ? 'Your evidence' : isDefendant ? 'Evidence against you' : "The challenger's evidence"}
        empty="Nothing posted beyond the claim."
        posts={challengerPosts}
        me={myAccountId}
      />
      <PostSection
        title={isChallenger ? 'Their side' : isDefendant ? 'Your side' : "The defendant's side"}
        empty="The defendant hasn't answered yet."
        posts={defendantPosts}
        me={myAccountId}
      />

      {isParty && caseOpen && wallet && (
        <ComposeResponse
          innerRef={composeRef}
          caseId={caseHeader.id}
          wallet={wallet}
          role={isChallenger ? 'challenger' : 'defendant'}
          onPosted={load}
        />
      )}

      {!isParty && (
        <p className="text-xs text-muted text-center px-4">
          {myJurorRow ? 'Jurors read both sides but cannot post.' : 'Only the challenger or defendant can post on this case.'}
        </p>
      )}
    </div>
  );
}

function CaseSummary({ c, me, juror }: { c: CaseHeader; me: string; juror: JurorRow | null }) {
  const isChallenger = me === c.challengerId;
  const isDefendant = me === c.defendantId;
  const seatLabel = isChallenger ? 'You filed this' : isDefendant ? 'You are the defendant' : juror ? "You're on the jury" : 'Court case';

  return (
    <div className="bg-panel border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gold uppercase tracking-wider">{seatLabel}</span>
        <span className="text-[11px] text-teal">{whereLabel(c.status)}</span>
      </div>

      <p className="text-sm text-white">
        {isChallenger ? `You say ${claimText(c.type).replace(/^says /, '')}` : `The challenger ${claimText(c.type)}`}
      </p>

      <div className="space-y-2 text-xs">
        <IdRow label="Challenger" id={c.challengerId} you={isChallenger} />
        <IdRow label="Defendant" id={c.defendantId} you={isDefendant} />
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted mb-0.5">{isChallenger ? 'You staked' : 'Challenger staked'}</div>
          <div className="text-white">
            {displayPoints(c.challengerStake)} pts {stakeNote(c.challengerStake, c.challengerStakePercent)}
          </div>
        </div>
        {juror ? (
          <div>
            <div className="text-muted mb-0.5">Your juror stake</div>
            <div className="text-white">{displayPoints(juror.stakeAmount)} pts (5%)</div>
          </div>
        ) : (
          <div>
            <div className="text-muted mb-0.5">Filed</div>
            <div className="text-white">{timeAgo(c.createdAt)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function IdRow({ label, id, you }: { label: string; id: string; you?: boolean }) {
  return (
    <div>
      <div className="text-muted mb-0.5">
        {label}
        {you && <span className="text-teal"> (you)</span>}
      </div>
      <div className="font-mono text-white break-all">{id}</div>
    </div>
  );
}

// ─── Step panel ──────────────────────────────────────────────────────────

type StepState = 'done' | 'now' | 'later' | 'skipped';

function stepState(stepId: CourtStepId, progress: CaseProgress): StepState {
  const idx = stepIndex(stepId);
  const cur = stepIndex(progress.current);
  if (progress.endedEarly && idx > cur) return 'skipped';
  if (idx < cur) return 'done';
  if (idx === cur) return progress.current === 'final' ? 'done' : 'now';
  return 'later';
}

function StepPanel({
  stepId, progress, seat, c, me, jury, myJurorRow, votesRevealed, busy, onAct, onWrite, canWrite,
}: {
  stepId: CourtStepId;
  progress: CaseProgress;
  seat: CourtSeat;
  c: CaseHeader;
  me: string;
  jury: JurorRow[];
  myJurorRow: JurorRow | null;
  votesRevealed: boolean;
  busy: Busy;
  onAct: (kind: Exclude<Busy, null>, vote?: 'human' | 'not_human') => void;
  onWrite: () => void;
  canWrite: boolean;
}) {
  const idx = stepIndex(stepId);
  const step = COURT_STEPS[idx];
  const state = stepState(stepId, progress);
  const badge = {
    done: { text: 'Done', cls: 'bg-teal/15 text-teal' },
    now: { text: progress.endedEarly ? 'Case closed here' : 'You are here', cls: 'bg-gold/15 text-gold' },
    later: { text: 'Coming up', cls: 'bg-border text-muted' },
    skipped: { text: 'Never reached', cls: 'bg-border text-muted' },
  }[state];

  return (
    <div className="bg-bg rounded-lg p-4 border border-border space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted uppercase tracking-wider">
          Step {idx + 1} of 6 · {step.phase}
        </span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.text}</span>
      </div>
      <div>
        <h4 className="text-base font-semibold text-white">{step.title}</h4>
        <p className="text-[11px] text-muted mt-0.5">{step.time}</p>
      </div>
      <ul className="space-y-1.5">
        {step.points.map((p) => (
          <li key={p} className="text-xs text-white/85 leading-relaxed flex gap-2">
            <span className="text-teal shrink-0">•</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <div className="rounded-md bg-teal/10 border border-teal/25 px-3 py-2">
        <p className="text-[11px] uppercase tracking-wider text-teal mb-0.5">For you</p>
        <p className="text-xs text-white leading-relaxed">{step.forYou[seat]}</p>
      </div>

      <div className="border-t border-border pt-3">
        {stepId === 'filed' && <FiledBody c={c} me={me} />}
        {stepId === 'respond' && (
          <RespondBody c={c} me={me} state={state} progress={progress} busy={busy} onAct={onAct} onWrite={onWrite} canWrite={canWrite} />
        )}
        {stepId === 'jury' && <JuryBody state={state} progress={progress} jury={jury} me={me} />}
        {stepId === 'vote' && (
          <VoteBody state={state} c={c} jury={jury} me={me} myJurorRow={myJurorRow} votesRevealed={votesRevealed} busy={busy} onAct={onAct} />
        )}
        {stepId === 'verdict' && <VerdictBody state={state} c={c} me={me} busy={busy} onAct={onAct} />}
        {stepId === 'final' && <FinalBody state={state} c={c} seat={seat} myJurorRow={myJurorRow} />}
      </div>
    </div>
  );
}

function ExampleTag() {
  return <p className="text-[11px] text-gold mb-2">Example. This is what this step looks like when the case gets here.</p>;
}

function FiledBody({ c, me }: { c: CaseHeader; me: string }) {
  return (
    <p className="text-xs text-muted leading-relaxed">
      Filed {new Date(c.createdAt * 1000).toLocaleString()}.{' '}
      {me === c.challengerId ? 'You' : 'The challenger'} staked {displayPoints(c.challengerStake)} points.
    </p>
  );
}

function RespondBody({
  c, me, state, progress, busy, onAct, onWrite, canWrite,
}: {
  c: CaseHeader;
  me: string;
  state: StepState;
  progress: CaseProgress;
  busy: Busy;
  onAct: (kind: Exclude<Busy, null>) => void;
  onWrite: () => void;
  canWrite: boolean;
}) {
  const isChallenger = me === c.challengerId;
  if (progress.endedEarly === 'withdrawn') {
    return (
      <p className="text-xs text-teal">
        {isChallenger ? 'You withdrew the case here.' : 'The challenger withdrew the case here.'} 1,440 points of the stake went to
        the defendant and their freeze lifted.
      </p>
    );
  }
  if (state === 'done') {
    return <p className="text-xs text-muted">The response window is over. Both sides can keep adding until the verdict.</p>;
  }
  return (
    <div className="space-y-3">
      {c.arbitrationDeadline ? (
        <p className="text-xs text-white">
          The defendant has until <span className="text-gold">{shortDate(c.arbitrationDeadline)}</span>
          <span className="text-muted"> ({daysUntil(c.arbitrationDeadline)} days left)</span>, then it goes to a jury.
        </p>
      ) : null}
      {canWrite && (
        <button onClick={onWrite} className="w-full py-2 bg-teal text-white rounded-lg text-sm hover:bg-teal-dark transition-colors">
          {isChallenger ? 'Add evidence' : 'Write your response'}
        </button>
      )}
      {isChallenger && c.status === 'arbitration_open' && (
        <div>
          <button
            onClick={() => onAct('withdraw')}
            disabled={busy === 'withdraw'}
            className="w-full py-2 bg-orange-500/15 text-orange-300 rounded-lg text-sm hover:bg-orange-500/25 transition-colors disabled:opacity-50"
          >
            {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw the case'}
          </button>
          <p className="text-[11px] text-muted mt-1.5">
            1,440 points of your stake go to the defendant, the rest comes back, and you can&apos;t refile against them for 30 days.
          </p>
        </div>
      )}
    </div>
  );
}

type JurorLine = { id: string; status: string; tone: 'muted' | 'teal' | 'red'; you?: boolean };

function JuryList({ jurors }: { jurors: JurorLine[] }) {
  return (
    <ul className="space-y-2">
      {jurors.map((j, i) => (
        <li key={j.id} className={`rounded-md p-2.5 border ${j.you ? 'border-teal/50 bg-teal/5' : 'border-border bg-panel'}`}>
          <div className="flex items-center justify-between text-[11px] mb-0.5">
            <span className="text-muted">
              Juror {i + 1}
              {j.you && <span className="text-teal"> (you)</span>}
            </span>
            <span className={j.tone === 'teal' ? 'text-teal' : j.tone === 'red' ? 'text-red' : 'text-muted'}>{j.status}</span>
          </div>
          <div className="font-mono text-[11px] text-white break-all">{j.id}</div>
        </li>
      ))}
    </ul>
  );
}

function jurorStatus(vote: string | null): { status: string; tone: 'muted' | 'teal' | 'red' } {
  if (vote === 'human') return { status: 'Voted human', tone: 'teal' };
  if (vote === 'not_human') return { status: 'Voted not human', tone: 'red' };
  if (vote === 'sealed') return { status: 'Voted (sealed)', tone: 'muted' };
  return { status: 'Not voted yet', tone: 'muted' };
}

function JuryBody({ state, progress, jury, me }: { state: StepState; progress: CaseProgress; jury: JurorRow[]; me: string }) {
  if (progress.endedEarly === 'dismissed' && state === 'now') {
    return <p className="text-xs text-teal">No jury formed, so the case was dismissed. Nobody was at fault and every stake went back.</p>;
  }
  if (state === 'later' || state === 'skipped') {
    return (
      <div>
        <ExampleTag />
        <p className="text-xs text-muted mb-2">3 jurors seated. Each staked 5% of their savings.</p>
        <JuryList jurors={EXAMPLE_JURORS.map((id) => ({ id, status: 'Seated', tone: 'muted' as const }))} />
      </div>
    );
  }
  if (jury.length === 0) {
    return <p className="text-xs text-muted">Waiting for jurors. They are drawn at the next daily reset.</p>;
  }
  return (
    <div>
      <p className="text-xs text-muted mb-2">{jury.length} jurors seated.</p>
      <JuryList jurors={jury.map((j) => ({ id: j.jurorAccountId, status: 'Seated', tone: 'muted' as const, you: j.jurorAccountId === me }))} />
    </div>
  );
}

function VoteBody({
  state, c, jury, me, myJurorRow, votesRevealed, busy, onAct,
}: {
  state: StepState;
  c: CaseHeader;
  jury: JurorRow[];
  me: string;
  myJurorRow: JurorRow | null;
  votesRevealed: boolean;
  busy: Busy;
  onAct: (kind: Exclude<Busy, null>, vote?: 'human' | 'not_human') => void;
}) {
  if (state === 'later' || state === 'skipped' || jury.length === 0) {
    return (
      <div>
        <ExampleTag />
        <p className="text-xs text-muted mb-2">2 of 3 jurors have voted. Votes stay sealed until all 3 are in.</p>
        <JuryList
          jurors={[
            { id: EXAMPLE_JURORS[0], ...jurorStatus('sealed') },
            { id: EXAMPLE_JURORS[1], ...jurorStatus('sealed') },
            { id: EXAMPLE_JURORS[2], ...jurorStatus(null) },
          ]}
        />
      </div>
    );
  }
  const voted = jury.filter((j) => j.vote !== null).length;
  const canVote = state === 'now' && myJurorRow !== null && myJurorRow.vote === null && c.verdict === null;
  return (
    <div className="space-y-3">
      {canVote && myJurorRow && (
        <div className="rounded-lg border-2 border-gold/40 bg-gold/5 p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-white">Your vote</p>
            <p className="text-xs text-muted mt-1 leading-relaxed">
              Read the challenger&apos;s evidence and the defendant&apos;s side below first. Your vote stays sealed until every juror
              has voted.
              {c.votingDeadline ? (
                <>
                  {' '}Vote by <span className="text-gold">{shortDate(c.votingDeadline)}</span> or you lose your{' '}
                  {displayPoints(myJurorRow.stakeAmount)} point stake.
                </>
              ) : null}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onAct('vote', 'human')}
              disabled={busy === 'vote'}
              className="py-2.5 rounded-lg text-sm font-medium bg-teal/15 border border-teal/50 text-teal hover:bg-teal/25 disabled:opacity-50"
            >
              Human
            </button>
            <button
              onClick={() => onAct('vote', 'not_human')}
              disabled={busy === 'vote'}
              className="py-2.5 rounded-lg text-sm font-medium bg-red/10 border border-red/40 text-red hover:bg-red/20 disabled:opacity-50"
            >
              Not human
            </button>
          </div>
        </div>
      )}
      {myJurorRow && myJurorRow.vote !== null && !votesRevealed && (
        <p className="text-xs text-teal">You voted. Your vote is sealed until every juror has voted.</p>
      )}
      <p className="text-xs text-muted">
        {voted} of {jury.length} jurors have voted. {votesRevealed ? 'All votes are in and shown.' : 'Votes stay sealed until all are in.'}
      </p>
      <JuryList jurors={jury.map((j) => ({ id: j.jurorAccountId, ...jurorStatus(j.vote), you: j.jurorAccountId === me }))} />
    </div>
  );
}

function VerdictBody({
  state, c, me, busy, onAct,
}: {
  state: StepState;
  c: CaseHeader;
  me: string;
  busy: Busy;
  onAct: (kind: Exclude<Busy, null>) => void;
}) {
  if (state === 'later' || state === 'skipped' || !c.verdict) {
    return (
      <div className="space-y-2">
        <ExampleTag />
        <div className="rounded-md p-3 bg-panel border border-border">
          <p className="text-xs text-muted">The jury says</p>
          <p className="text-lg font-semibold text-red">Not human (2 to 1)</p>
          <p className="text-[11px] text-muted mt-1">Final in 7 days unless the losing side appeals.</p>
        </div>
        <button disabled className="w-full py-2 bg-border text-muted rounded-lg text-sm cursor-not-allowed">
          Appeal to a new jury
        </button>
        <p className="text-[11px] text-muted">Only the side that lost sees this button.</p>
      </div>
    );
  }
  const human = c.verdict === 'innocent';
  const losingParty = human ? c.challengerId : c.defendantId;
  return (
    <div className="space-y-2">
      <div className="rounded-md p-3 bg-panel border border-border">
        <p className="text-xs text-muted">The jury says</p>
        <p className={`text-lg font-semibold ${human ? 'text-teal' : 'text-red'}`}>{human ? 'Human' : 'Not human'}</p>
        {state === 'now' && <p className="text-[11px] text-muted mt-1">Final after the 7-day appeal window. Nothing moves until then.</p>}
      </div>
      {state === 'now' && c.status === 'verdict_pending' && me === losingParty && (
        <button
          onClick={() => onAct('appeal')}
          disabled={busy === 'appeal'}
          className="w-full py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors disabled:opacity-50"
        >
          {busy === 'appeal' ? 'Sending…' : 'Appeal to a new jury'}
        </button>
      )}
    </div>
  );
}

function OutcomeCards({ c, seat, myJurorRow }: { c: CaseHeader; seat: CourtSeat; myJurorRow: JurorRow | null }) {
  const stake = displayPoints(c.challengerStake);
  const jurorStake = myJurorRow ? displayPoints(myJurorRow.stakeAmount) : null;
  const notHuman =
    seat === 'challenger'
      ? `You get your ${stake} points back plus 20% of the account's savings.`
      : seat === 'juror'
        ? `If you voted not human: your ${jurorStake} points back plus a share of the other jurors' stakes. If not: you lose them.`
        : 'The account closes. 20% of its savings go to the challenger and the rest is burned.';
  const human =
    seat === 'challenger'
      ? `You lose your ${stake} points: half goes to the defendant, the rest is burned.`
      : seat === 'juror'
        ? `If you voted human: your ${jurorStake} points back plus a share of the other jurors' stakes. If not: you lose them.`
        : "The freeze lifts and the defendant gets half the challenger's stake.";
  return (
    <div className="grid sm:grid-cols-2 gap-2">
      <div className="rounded-md p-3 bg-red/10 border border-red/30">
        <p className="text-xs font-medium text-red mb-1">If the final verdict is not human</p>
        <p className="text-xs text-white/85 leading-relaxed">{notHuman}</p>
      </div>
      <div className="rounded-md p-3 bg-teal/10 border border-teal/30">
        <p className="text-xs font-medium text-teal mb-1">If the final verdict is human</p>
        <p className="text-xs text-white/85 leading-relaxed">{human}</p>
      </div>
    </div>
  );
}

function FinalBody({ state, c, seat, myJurorRow }: { state: StepState; c: CaseHeader; seat: CourtSeat; myJurorRow: JurorRow | null }) {
  if (state !== 'done' || !c.verdict) {
    return (
      <div>
        <ExampleTag />
        <OutcomeCards c={c} seat={seat} myJurorRow={myJurorRow} />
      </div>
    );
  }
  const human = c.verdict === 'innocent';
  return (
    <p className={`text-sm ${human ? 'text-teal' : 'text-red'}`}>
      {human ? 'Found human. The freeze is lifted and the case is closed.' : 'Found not human. The account is closed.'}
    </p>
  );
}

// ─── Posts ───────────────────────────────────────────────────────────────

function PostSection({ title, empty, posts, me }: { title: string; empty: string; posts: CaseArgument[]; me: string }) {
  const hasFiles = posts.some((p) => (p.attachments ?? []).length > 0);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-white px-1">{title}</h3>
      {posts.length === 0 ? (
        <div className="bg-panel border border-border rounded-lg p-4 text-center">
          <p className="text-xs text-muted">{empty}</p>
        </div>
      ) : (
        posts.map((p) => <PostCard key={p.id} post={p} mine={p.submitterId === me} />)
      )}
      {hasFiles && (
        <p className="text-[11px] text-muted px-1">
          Files stay with the person who added them. Each file&apos;s fingerprint is on record, so it can&apos;t be swapped later.
        </p>
      )}
    </div>
  );
}

function PostCard({ post, mine }: { post: CaseArgument; mine: boolean }) {
  const challenger = post.role === 'challenger';
  const files = post.attachments ?? [];
  const offers = post.offers ?? [];
  return (
    <div
      className={`bg-panel border border-border border-l-4 ${
        challenger ? 'border-l-orange-400/50' : 'border-l-teal/50'
      } rounded-r-md rounded-l p-3 space-y-2`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[11px] uppercase tracking-wider ${challenger ? 'text-orange-300' : 'text-teal'}`}>
          {challenger ? 'Challenger' : 'Defendant'}
          {mine ? ' (you)' : ''}
        </span>
        <span className="text-[11px] text-muted">{timeAgo(post.createdAt)}</span>
      </div>
      {post.text && <p className="text-sm text-white whitespace-pre-wrap">{post.text}</p>}
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.hash + f.name} className="flex items-center justify-between gap-2 bg-bg rounded px-2.5 py-1.5">
              <span className="text-xs text-white truncate">📎 {f.name}</span>
              <span className="font-mono text-[10px] text-muted shrink-0" title={f.hash}>
                {f.hash.slice(0, 10)}…
              </span>
            </li>
          ))}
        </ul>
      )}
      {offers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {offers.map((o) => (
            <span key={o} className="text-[11px] px-2 py-0.5 rounded-full bg-teal/15 text-teal">
              {OFFER_LABELS[o]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Compose ─────────────────────────────────────────────────────────────

type PendingFile = { key: string; name: string; hash: string | null };

function ComposeResponse({
  innerRef, caseId, wallet, role, onPosted,
}: {
  innerRef: RefObject<HTMLDivElement | null>;
  caseId: string;
  wallet: Wallet;
  role: 'challenger' | 'defendant';
  onPosted: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isChallenger = role === 'challenger';
  const hashing = files.some((f) => f.hash === null);
  const ready = files.filter((f): f is PendingFile & { hash: string } => f.hash !== null);
  const canPost = !posting && !hashing && (text.trim().length > 0 || ready.length > 0 || offers.length > 0);

  async function addFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of picked) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setFiles((fs) => [...fs, { key, name: file.name, hash: null }]);
      try {
        const hash = await hashFileSHA256(file);
        setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, hash } : f)));
      } catch {
        setFiles((fs) => fs.filter((f) => f.key !== key));
        setErr(`Could not read ${file.name}`);
      }
    }
  }

  async function submit() {
    setErr(null);
    setPosting(true);
    try {
      const payload: { text: string; attachments?: Array<{ name: string; hash: string }>; offers?: Offer[] } = { text: text.trim() };
      if (ready.length > 0) payload.attachments = ready.map((f) => ({ name: f.name, hash: f.hash }));
      if (offers.length > 0) payload.offers = offers;
      const r = await api.submitCaseArgument(caseId, signed(wallet, payload));
      if (r.success) {
        setText('');
        setFiles([]);
        setOffers([]);
        onPosted();
      } else {
        setErr(r.error?.message ?? 'Failed to post');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div ref={innerRef} className="bg-panel border border-border rounded-lg p-4 space-y-3 scroll-mt-4">
      <h3 className="text-sm font-medium text-white">{isChallenger ? 'Add evidence' : 'Post your response'}</h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          isChallenger
            ? 'Add evidence or answer the defendant. Jurors read this before voting.'
            : "Tell your side. What's wrong with their claim? Who can vouch for you?"
        }
        rows={4}
        maxLength={5000}
        className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder-muted/40 focus:border-teal focus:outline-none"
      />
      <div className="text-[11px] text-muted text-right -mt-2">{text.length} / 5,000</div>

      <div className="space-y-2">
        <label className="flex items-center justify-center gap-2 w-full bg-bg border border-dashed border-border rounded-lg px-4 py-3 text-sm text-white/80 cursor-pointer hover:border-teal transition-colors">
          <span>📎</span>
          <span>Attach screenshots, logs or documents</span>
          <input type="file" multiple onChange={addFiles} className="hidden" aria-label="Attach files" />
        </label>
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-2 bg-bg rounded px-2.5 py-1.5">
                <span className="text-xs text-white truncate">{f.name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-muted">{f.hash ? 'Ready' : 'Reading…'}</span>
                  <button
                    onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                    className="text-muted hover:text-white text-sm leading-none"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted">Files stay on this device. The case records each file&apos;s name and fingerprint.</p>
      </div>

      {!isChallenger && (
        <div>
          <p className="text-xs text-muted mb-1.5">Offer another way to prove it</p>
          <div className="flex flex-wrap gap-2">
            {(['call', 'in_person'] as Offer[]).map((o) => {
              const on = offers.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => setOffers((os) => (on ? os.filter((x) => x !== o) : [...os, o]))}
                  aria-pressed={on}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    on ? 'bg-teal/20 border-teal text-teal' : 'border-muted/40 text-white/80 hover:border-teal/60'
                  }`}
                >
                  {on ? '✓ ' : ''}
                  {o === 'call' ? "I'm open to a live call" : 'I can meet in person'}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {err && <p className="text-xs text-red">{err}</p>}
      <button
        onClick={submit}
        disabled={!canPost}
        className="w-full bg-teal hover:bg-teal-dark text-white text-sm py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {posting ? 'Posting…' : isChallenger ? 'Post evidence' : 'Post response'}
      </button>
    </div>
  );
}
