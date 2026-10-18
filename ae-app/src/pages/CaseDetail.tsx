// Court case page (wallet side).
//
// Built for the person pulled into court. Top to bottom: what the challenger
// says and what is at stake, a tracker of the six steps (tap any step to see
// what it looks like, including steps the case has not reached yet), the
// evidence against you, your side, and a form to answer with text, files and
// an offer to meet on a call or in person.
//
// Voting happens in the miner app (jurors are miners).

import { useEffect, useState, useCallback, useRef, type ChangeEvent, type RefObject } from 'react';
import { useParams } from 'react-router-dom';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
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
  type CaseProgress,
  type CourtStepId,
} from '../lib/courtSteps';
import { CaseTracker } from '../components/court/CaseTracker';
import type { CaseArgumentData, CaseAttachment, CaseOffer, CourtCaseData, JurorData } from '../lib/types';

type Wallet = { accountId: string; privateKey: string };

// While any of these hold, arguments can still be posted.
const CASE_OPEN_STATUSES = new Set([
  'arbitration_open', 'arbitration_response',
  'court_open', 'court_waiting_jury', 'court_voting',
  'appeal_open', 'appeal_voting',
]);

// While any of these hold, the defendant's earned points stay frozen.
const FROZEN_STATUSES = new Set([
  'arbitration_open', 'arbitration_response', 'court_open', 'court_waiting_jury',
  'court_voting', 'verdict_pending',
]);

const OFFER_LABELS: Record<CaseOffer, string> = {
  call: 'Open to a live call',
  in_person: 'Can meet in person',
};

// Sample jurors for the example screens of steps a case has not reached.
const EXAMPLE_JURORS = [
  '7f3a9c21d84e5b06a1c2e9f04d7b3a8e5c216f90',
  '2b8e4d71a3c95f0e86d2b47a1c3e9f5d08a6b2c4',
  'c41d07e9a2b58f63d1e04a9c7b2f85e3a6d10c97',
];

/** Whole days from now until a unix-seconds deadline, never negative. */
function daysUntil(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now() / 1000) / 86400));
}

function signed(wallet: Wallet, payload: object) {
  const timestamp = Math.floor(Date.now() / 1000);
  return { accountId: wallet.accountId, timestamp, signature: signPayload(payload, timestamp, wallet.privateKey), payload };
}

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const wallet = loadWallet();

  const [caseHeader, setCaseHeader] = useState<CourtCaseData | null>(null);
  const [argumentLog, setArgumentLog] = useState<CaseArgumentData[]>([]);
  const [jury, setJury] = useState<JurorData[]>([]);
  const [votesRevealed, setVotesRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CourtStepId | null>(null);
  const [busy, setBusy] = useState<'jury' | 'appeal' | null>(null);
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
    const offs = ['court:argument', 'court:verdict', 'court:trial-demanded', 'court:withdrawn', 'court:appeal'].map((evt) =>
      wsClient.on(evt, (data) => {
        if (data.caseId === id) load();
      }),
    );
    return () => { for (const off of offs) off(); };
  }, [id, load]);

  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading case…</p>
      </div>
    );
  }
  if (!caseHeader) {
    return (
      <div className="p-4 space-y-3">
        <p className="text-sm text-red-400">{error ?? 'Case not found'}</p>
      </div>
    );
  }

  const myAccountId = wallet?.accountId ?? '';
  const isChallenger = myAccountId === caseHeader.challengerId;
  const isDefendant = myAccountId === caseHeader.defendantId;
  const isParty = isChallenger || isDefendant;
  const caseOpen = caseHeader.verdict === null && CASE_OPEN_STATUSES.has(caseHeader.status);
  const progress = caseProgress(caseHeader.status);
  const shown = selected ?? progress.current;

  async function act(kind: 'jury' | 'appeal') {
    if (!wallet?.privateKey || !caseHeader) return;
    setBusy(kind);
    setError(null);
    try {
      const body = signed(wallet, {});
      const r = kind === 'jury' ? await api.demandTrial(caseHeader.id, body) : await api.appealCase(caseHeader.id, body);
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
    <div className="p-4 space-y-4">
      <CaseSummary c={caseHeader} me={myAccountId} progress={progress} />

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-900/30 rounded-lg text-sm text-red-400">{error}</div>
      )}

      <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-white">How your case works</h3>
          <span className="text-[11px] text-gray-500">Tap any step to see it</span>
        </div>
        <CaseTracker progress={progress} selected={shown} onSelect={setSelected} />
        <StepPanel
          stepId={shown}
          progress={progress}
          c={caseHeader}
          me={myAccountId}
          jury={jury}
          votesRevealed={votesRevealed}
          busy={busy}
          onAskJury={() => act('jury')}
          onAppeal={() => act('appeal')}
          onWrite={() => composeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          canWrite={isParty && caseOpen}
        />
      </div>

      <PostSection
        title={isDefendant ? 'Evidence against you' : isChallenger ? 'Your evidence' : "Challenger's evidence"}
        empty={isDefendant ? 'Nothing posted beyond the claim yet.' : 'Nothing posted yet.'}
        posts={challengerPosts}
        me={myAccountId}
      />

      <PostSection
        title={isDefendant ? 'Your side' : isChallenger ? 'Their side' : "Defendant's side"}
        empty={isDefendant ? "You haven't answered yet." : 'No answer yet.'}
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
        <p className="text-xs text-gray-500 text-center px-4">
          Only the challenger or defendant can post on this case.
        </p>
      )}
    </div>
  );
}

function CaseSummary({ c, me, progress }: { c: CourtCaseData; me: string; progress: CaseProgress }) {
  const isChallenger = me === c.challengerId;
  const isDefendant = me === c.defendantId;
  const step = COURT_STEPS[stepIndex(progress.current)];
  const where = progress.endedEarly
    ? progress.endedEarly === 'withdrawn' ? 'Closed: challenger withdrew' : 'Closed: dismissed'
    : `Step ${stepIndex(progress.current) + 1} of 6: ${step.label}`;

  return (
    <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gold uppercase tracking-wider">
          {isDefendant ? 'You are the defendant' : isChallenger ? 'You filed this' : 'Court case'}
        </span>
        <span className="text-[11px] text-teal">{where}</span>
      </div>

      <p className="text-sm text-white">
        {isChallenger ? 'You say' : 'The challenger'} {isChallenger ? claimText(c.type).replace(/^says /, '') : claimText(c.type)}
      </p>

      <div className="space-y-2 text-xs">
        <IdRow label="Challenger" id={c.challengerId} you={isChallenger} />
        <IdRow label="Defendant" id={c.defendantId} you={isDefendant} />
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-gray-500 mb-0.5">Challenger staked</div>
          <div className="text-gray-300">
            {displayPoints(c.challengerStake)} pts {stakeNote(c.challengerStake, c.challengerStakePercent)}
          </div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Filed</div>
          <div className="text-gray-300">{timeAgo(c.createdAt)}</div>
        </div>
      </div>

      {isDefendant && !c.verdict && FROZEN_STATUSES.has(c.status) && (
        <div className="p-2 rounded bg-red-500/10 text-xs text-red-300">
          Your earned points are frozen until the case ends. Daily points still work.
        </div>
      )}
    </div>
  );
}

function IdRow({ label, id, you }: { label: string; id: string; you?: boolean }) {
  return (
    <div>
      <div className="text-gray-500 mb-0.5">
        {label}
        {you && <span className="text-teal"> (you)</span>}
      </div>
      <div className="font-mono text-gray-300 break-all">{id}</div>
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
  stepId, progress, c, me, jury, votesRevealed, busy, onAskJury, onAppeal, onWrite, canWrite,
}: {
  stepId: CourtStepId;
  progress: CaseProgress;
  c: CourtCaseData;
  me: string;
  jury: JurorData[];
  votesRevealed: boolean;
  busy: 'jury' | 'appeal' | null;
  onAskJury: () => void;
  onAppeal: () => void;
  onWrite: () => void;
  canWrite: boolean;
}) {
  const idx = stepIndex(stepId);
  const step = COURT_STEPS[idx];
  const state = stepState(stepId, progress);
  const badge = {
    done: { text: 'Done', cls: 'bg-teal/15 text-teal' },
    now: { text: progress.endedEarly ? 'Case closed here' : 'You are here', cls: 'bg-gold/15 text-gold' },
    later: { text: 'Coming up', cls: 'bg-navy-light text-gray-400' },
    skipped: { text: 'Never reached', cls: 'bg-navy-light text-gray-500' },
  }[state];

  return (
    <div className="bg-navy-dark rounded-lg p-4 border border-navy-light space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-500 uppercase tracking-wider">
          Step {idx + 1} of 6 · {step.phase}
        </span>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.text}</span>
      </div>
      <div>
        <h4 className="text-base font-serif text-white">{step.title}</h4>
        <p className="text-[11px] text-gray-500 mt-0.5">{step.time}</p>
      </div>
      <ul className="space-y-1.5">
        {step.points.map((p) => (
          <li key={p} className="text-xs text-gray-300 leading-relaxed flex gap-2">
            <span className="text-teal shrink-0">•</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>

      <div className="border-t border-navy-light pt-3">
        {stepId === 'filed' && <FiledBody c={c} me={me} />}
        {stepId === 'respond' && (
          <RespondBody c={c} me={me} state={state} progress={progress} busy={busy} onAskJury={onAskJury} onWrite={onWrite} canWrite={canWrite} />
        )}
        {stepId === 'jury' && <JuryBody state={state} progress={progress} jury={jury} />}
        {stepId === 'vote' && <VoteBody state={state} jury={jury} votesRevealed={votesRevealed} />}
        {stepId === 'verdict' && <VerdictBody state={state} c={c} me={me} busy={busy} onAppeal={onAppeal} />}
        {stepId === 'final' && <FinalBody state={state} c={c} me={me} />}
      </div>
    </div>
  );
}

function ExampleTag() {
  return (
    <p className="text-[11px] text-gold mb-2">Example. This is what this step looks like when your case gets here.</p>
  );
}

function FiledBody({ c, me }: { c: CourtCaseData; me: string }) {
  const filedOn = new Date(c.createdAt * 1000).toLocaleString();
  return (
    <p className="text-xs text-gray-400 leading-relaxed">
      Filed {filedOn}. The challenger staked {displayPoints(c.challengerStake)} points.
      {me === c.defendantId && ' Your earned points froze at that moment.'}
    </p>
  );
}

function RespondBody({
  c, me, state, progress, busy, onAskJury, onWrite, canWrite,
}: {
  c: CourtCaseData;
  me: string;
  state: StepState;
  progress: CaseProgress;
  busy: 'jury' | 'appeal' | null;
  onAskJury: () => void;
  onWrite: () => void;
  canWrite: boolean;
}) {
  if (progress.endedEarly === 'withdrawn') {
    return (
      <p className="text-xs text-teal">
        The challenger dropped the case here. The freeze lifted and 1,440 of their points went to the defendant.
      </p>
    );
  }
  if (state === 'done') {
    return <p className="text-xs text-gray-400">The response window is over. Both sides can keep adding until the verdict.</p>;
  }
  const deadline = c.arbitrationDeadline;
  const daysLeft = deadline ? daysUntil(deadline) : null;
  const isDefendant = me === c.defendantId;

  return (
    <div className="space-y-3">
      {deadline && (
        <p className="text-xs text-white">
          {isDefendant ? 'Respond by ' : 'The defendant has until '}
          <span className="text-gold">
            {new Date(deadline * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
          {daysLeft !== null && <span className="text-gray-400"> ({daysLeft} {daysLeft === 1 ? 'day' : 'days'} left)</span>}
        </p>
      )}
      {canWrite && (
        <button
          onClick={onWrite}
          className="w-full py-2 bg-teal text-white rounded-lg text-sm hover:bg-teal-dark transition-colors"
        >
          {isDefendant ? 'Write your response' : 'Add to your case'}
        </button>
      )}
      {isDefendant && c.status === 'arbitration_open' && (
        <div>
          <button
            onClick={onAskJury}
            disabled={busy === 'jury'}
            className="w-full py-2 bg-teal/15 text-teal rounded-lg text-sm hover:bg-teal/25 transition-colors disabled:opacity-50"
          >
            {busy === 'jury' ? 'Sending…' : 'Ask for a jury now'}
          </button>
          <p className="text-[11px] text-gray-500 mt-1.5">
            Skips the rest of the wait. The jury is drawn at the next daily reset.
          </p>
        </div>
      )}
    </div>
  );
}

function JuryList({ jurors }: { jurors: Array<{ id: string; status: string; tone: 'muted' | 'teal' | 'red' }> }) {
  return (
    <ul className="space-y-2">
      {jurors.map((j, i) => (
        <li key={j.id} className="bg-navy rounded-md p-2.5 border border-navy-light">
          <div className="flex items-center justify-between text-[11px] mb-0.5">
            <span className="text-gray-500">Juror {i + 1}</span>
            <span className={j.tone === 'teal' ? 'text-teal' : j.tone === 'red' ? 'text-red-400' : 'text-gray-400'}>{j.status}</span>
          </div>
          <div className="font-mono text-[11px] text-gray-300 break-all">{j.id}</div>
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

function JuryBody({ state, progress, jury }: { state: StepState; progress: CaseProgress; jury: JurorData[] }) {
  if (progress.endedEarly === 'dismissed' && state === 'now') {
    return (
      <p className="text-xs text-teal">
        No jury formed, so the case was dismissed. Nobody was at fault, every stake went back and the freeze lifted.
      </p>
    );
  }
  if (state === 'later' || state === 'skipped') {
    return (
      <div>
        <ExampleTag />
        <p className="text-xs text-gray-400 mb-2">3 jurors seated. Each staked 5% of their savings.</p>
        <JuryList jurors={EXAMPLE_JURORS.map((id) => ({ id, status: 'Seated', tone: 'muted' as const }))} />
      </div>
    );
  }
  if (jury.length === 0) {
    return <p className="text-xs text-gray-400">Waiting for jurors. They are drawn at the next daily reset.</p>;
  }
  return (
    <div>
      <p className="text-xs text-gray-400 mb-2">{jury.length} jurors seated.</p>
      <JuryList jurors={jury.map((j) => ({ id: j.jurorAccountId, status: 'Seated', tone: 'muted' as const }))} />
    </div>
  );
}

function VoteBody({ state, jury, votesRevealed }: { state: StepState; jury: JurorData[]; votesRevealed: boolean }) {
  if (state === 'later' || state === 'skipped' || jury.length === 0) {
    return (
      <div>
        <ExampleTag />
        <p className="text-xs text-gray-400 mb-2">2 of 3 jurors have voted. Votes stay sealed until all 3 are in.</p>
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
  return (
    <div>
      <p className="text-xs text-gray-400 mb-2">
        {voted} of {jury.length} jurors have voted. {votesRevealed ? 'All votes are in and shown.' : 'Votes stay sealed until all are in.'}
      </p>
      <JuryList jurors={jury.map((j) => ({ id: j.jurorAccountId, ...jurorStatus(j.vote) }))} />
    </div>
  );
}

function OutcomeCards({ c, me }: { c: CourtCaseData; me: string }) {
  const half = displayPoints((BigInt(c.challengerStake) / 2n).toString());
  const isDefendant = me === c.defendantId;
  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="rounded-md p-3 bg-teal/10 border border-teal/30">
        <p className="text-xs font-medium text-teal mb-1">If the jury says human</p>
        <p className="text-xs text-gray-300 leading-relaxed">
          {isDefendant
            ? `Your freeze lifts, you get ${half} points from the challenger, and nobody can challenge you for 180 days.`
            : `The freeze lifts, the defendant gets ${half} points of the challenger's stake, and gets 180 days of protection.`}
        </p>
      </div>
      <div className="rounded-md p-3 bg-red-500/10 border border-red-500/30">
        <p className="text-xs font-medium text-red-300 mb-1">If the jury says not human</p>
        <p className="text-xs text-gray-300 leading-relaxed">
          {isDefendant
            ? 'Your account closes. 20% of your savings go to the challenger and the rest is burned.'
            : 'The account closes. 20% of its savings go to the challenger and the rest is burned.'}
        </p>
      </div>
    </div>
  );
}

function VerdictBody({
  state, c, me, busy, onAppeal,
}: {
  state: StepState;
  c: CourtCaseData;
  me: string;
  busy: 'jury' | 'appeal' | null;
  onAppeal: () => void;
}) {
  if (state === 'later' || state === 'skipped' || !c.verdict) {
    return (
      <div className="space-y-2">
        <ExampleTag />
        <div className="rounded-md p-3 bg-navy border border-navy-light">
          <p className="text-xs text-gray-400">The jury says</p>
          <p className="text-lg font-serif text-teal">Human (2 to 1)</p>
          <p className="text-[11px] text-gray-500 mt-1">Final in 7 days unless the losing side appeals.</p>
        </div>
        <button disabled className="w-full py-2 bg-navy-light text-gray-400 rounded-lg text-sm cursor-not-allowed">
          Appeal to a new jury
        </button>
        <p className="text-[11px] text-gray-500">Only the side that lost sees this button.</p>
      </div>
    );
  }
  const human = c.verdict === 'innocent';
  const losingParty = human ? c.challengerId : c.defendantId;
  return (
    <div className="space-y-2">
      <div className="rounded-md p-3 bg-navy border border-navy-light">
        <p className="text-xs text-gray-400">The jury says</p>
        <p className={`text-lg font-serif ${human ? 'text-teal' : 'text-red-400'}`}>{human ? 'Human' : 'Not human'}</p>
        {state === 'now' && <p className="text-[11px] text-gray-500 mt-1">Final after the 7-day appeal window. Nothing moves until then.</p>}
      </div>
      {state === 'now' && c.status === 'verdict_pending' && me === losingParty && (
        <button
          onClick={onAppeal}
          disabled={busy === 'appeal'}
          className="w-full py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors disabled:opacity-50"
        >
          {busy === 'appeal' ? 'Sending…' : 'Appeal to a new jury'}
        </button>
      )}
    </div>
  );
}

function FinalBody({ state, c, me }: { state: StepState; c: CourtCaseData; me: string }) {
  if (state !== 'done' || !c.verdict) {
    return (
      <div>
        <ExampleTag />
        <OutcomeCards c={c} me={me} />
      </div>
    );
  }
  const human = c.verdict === 'innocent';
  const isDefendant = me === c.defendantId;
  return (
    <p className={`text-sm ${human ? 'text-teal' : 'text-red-400'}`}>
      {human
        ? isDefendant ? 'Found human. Your freeze is lifted and you are protected for 180 days.' : 'Found human. The case is closed.'
        : isDefendant ? 'Found not human. This account is closed.' : 'Found not human. The account is closed.'}
    </p>
  );
}

// ─── Posts ───────────────────────────────────────────────────────────────

function PostSection({ title, empty, posts, me }: { title: string; empty: string; posts: CaseArgumentData[]; me: string }) {
  const hasFiles = posts.some((p) => (p.attachments ?? []).length > 0);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-300 px-1">{title}</h3>
      {posts.length === 0 ? (
        <div className="bg-navy rounded-xl p-4 border border-navy-light text-center">
          <p className="text-xs text-gray-500">{empty}</p>
        </div>
      ) : (
        posts.map((p) => <PostCard key={p.id} post={p} mine={p.submitterId === me} />)
      )}
      {hasFiles && (
        <p className="text-[11px] text-gray-500 px-1">
          Files stay with the person who added them. Each file&apos;s fingerprint is on record, so it can&apos;t be swapped later.
        </p>
      )}
    </div>
  );
}

function PostCard({ post, mine }: { post: CaseArgumentData; mine: boolean }) {
  const challenger = post.role === 'challenger';
  const files = post.attachments ?? [];
  const offers = post.offers ?? [];
  return (
    <div
      className={`bg-navy rounded-r-lg rounded-l-md border border-navy-light border-l-4 ${
        challenger ? 'border-l-orange-400/50' : 'border-l-teal/50'
      } p-3 space-y-2`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[11px] uppercase tracking-wider ${challenger ? 'text-orange-300' : 'text-teal'}`}>
          {challenger ? 'Challenger' : 'Defendant'}
          {mine ? ' (you)' : ''}
        </span>
        <span className="text-[11px] text-gray-500">{timeAgo(post.createdAt)}</span>
      </div>
      {post.text && <p className="text-sm text-gray-200 whitespace-pre-wrap">{post.text}</p>}
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.hash + f.name} className="flex items-center justify-between gap-2 bg-navy-dark rounded px-2.5 py-1.5">
              <span className="text-xs text-white truncate">📎 {f.name}</span>
              <span className="font-mono text-[10px] text-gray-500 shrink-0" title={f.hash}>
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
  const [offers, setOffers] = useState<CaseOffer[]>([]);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isDefendant = role === 'defendant';
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

  function toggleOffer(o: CaseOffer) {
    setOffers((os) => (os.includes(o) ? os.filter((x) => x !== o) : [...os, o]));
  }

  async function submit() {
    setErr(null);
    setPosting(true);
    try {
      const payload: { text: string; attachments?: CaseAttachment[]; offers?: CaseOffer[] } = { text: text.trim() };
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
    <div ref={innerRef} className="bg-navy rounded-xl p-4 border border-navy-light space-y-3 scroll-mt-4">
      <h3 className="text-sm font-medium text-white">{isDefendant ? 'Post your response' : 'Add to your case'}</h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          isDefendant
            ? "Tell your side. What's wrong with their claim? Who can vouch for you?"
            : 'Add evidence or answer the defendant. Jurors read this before voting.'
        }
        rows={4}
        maxLength={5000}
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-teal focus:outline-none"
      />
      <div className="text-[11px] text-gray-500 text-right -mt-2">{text.length} / 5,000</div>

      <div className="space-y-2">
        <label className="flex items-center justify-center gap-2 w-full bg-navy-dark border border-dashed border-navy-light rounded-lg px-4 py-3 text-sm text-gray-300 cursor-pointer hover:border-teal transition-colors">
          <span>📎</span>
          <span>Attach photos, documents or a voice clip</span>
          <input type="file" multiple onChange={addFiles} className="hidden" aria-label="Attach files" />
        </label>
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-2 bg-navy-dark rounded px-2.5 py-1.5">
                <span className="text-xs text-white truncate">{f.name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-gray-500">{f.hash ? 'Ready' : 'Reading…'}</span>
                  <button
                    onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                    className="text-gray-500 hover:text-white text-sm leading-none"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-gray-500">
          Files stay on this device. The case records each file&apos;s name and fingerprint.
        </p>
      </div>

      <div>
        <p className="text-xs text-gray-400 mb-1.5">Offer another way to prove it</p>
        <div className="flex flex-wrap gap-2">
          {(['call', 'in_person'] as CaseOffer[]).map((o) => {
            const on = offers.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => toggleOffer(o)}
                aria-pressed={on}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  on ? 'bg-teal/20 border-teal text-teal' : 'border-gray-600 text-gray-300 hover:border-teal/60'
                }`}
              >
                {on ? '✓ ' : ''}
                {o === 'call' ? "I'm open to a live call" : 'I can meet in person'}
              </button>
            );
          })}
        </div>
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}
      <button
        onClick={submit}
        disabled={!canPost}
        className="w-full bg-teal hover:bg-teal-dark text-white text-sm py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {posting ? 'Posting…' : isDefendant ? 'Post response' : 'Post'}
      </button>
    </div>
  );
}
