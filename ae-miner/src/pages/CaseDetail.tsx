// Court case detail page (miner side).
//
// Mirrors the wallet's CaseDetail but adds the juror viewpoint: if the
// signed-in miner is on the jury, they can vote here (instead of having to go
// back to the Jury Duty list). Both parties can still post arguments. Onlookers
// see the case header + arguments + jury sealed state, but no vote/post
// affordances.

import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadMinerWallet } from '../lib/keys';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';
import { displayPoints, truncateId, timeAgo } from '../lib/formatting';

interface CaseHeader {
  id: string;
  type: string;
  level: string;
  status: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  challengerStakePercent: number;
  verdict: string | null;
  appealOf: string | null;
  arbitrationDeadline: number | null;
  votingDeadline: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface CaseArgument {
  id: string;
  caseId: string;
  submitterId: string;
  role: 'challenger' | 'defendant';
  text: string;
  attachmentHash: string | null;
  createdAt: number;
}

interface JurorRow {
  minerId: string;
  jurorAccountId: string;
  stakeAmount: string;
  vote: string | null;       // 'human' | 'not_human' | 'sealed' | null
  votedAt: number | null;
}

const CASE_OPEN_STATUSES = new Set([
  'arbitration_open', 'arbitration_response',
  'court_open', 'court_waiting_jury', 'court_voting',
  'appeal_open', 'appeal_voting',
]);

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const wallet = loadMinerWallet();

  const [caseHeader, setCaseHeader] = useState<CaseHeader | null>(null);
  const [argumentLog, setArgumentLog] = useState<CaseArgument[]>([]);
  const [jury, setJury] = useState<JurorRow[]>([]);
  const [votesRevealed, setVotesRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);

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
    const offArg = wsClient.on('court:argument', (data: any) => {
      if (data?.caseId === id) load();
    });
    const offVerdict = wsClient.on('court:verdict', (data: any) => {
      if (data?.caseId === id) load();
    });
    return () => { offArg(); offVerdict(); };
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
  const isJuror = myJurorRow !== null;
  const caseOpen = caseHeader.verdict === null && CASE_OPEN_STATUSES.has(caseHeader.status);

  async function castVote(vote: 'human' | 'not_human') {
    if (!wallet?.privateKey || !id) return;
    setVoting(true); setError(null);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { vote };
      const sig = signPayload(payload, ts, wallet.privateKey);
      const r = await api.submitVote(id, {
        accountId: wallet.accountId, timestamp: ts, signature: sig, payload,
      });
      if (r.success) await load();
      else setError(r.error?.message ?? 'Vote failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setVoting(false);
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <Link to="/court" className="text-xs text-teal hover:underline">← Back to court</Link>
        <span className="text-[11px] text-muted font-mono">{truncateId(caseHeader.id)}</span>
      </div>

      <CaseHeaderCard caseHeader={caseHeader} myAccountId={myAccountId} isJuror={isJuror} />

      {error && (
        <div className="p-3 bg-red/10 border border-red/20 rounded text-sm text-red">{error}</div>
      )}

      <ArgumentTimeline
        argumentLog={argumentLog}
        myAccountId={myAccountId}
      />

      {isParty && caseOpen && (
        <ComposeArgumentCard
          caseId={caseHeader.id}
          wallet={wallet!}
          role={isChallenger ? 'challenger' : 'defendant'}
          onPosted={load}
        />
      )}

      {isJuror && caseOpen && !myJurorRow!.vote && (
        <JurorVoteCard onVote={castVote} voting={voting} />
      )}

      {isJuror && myJurorRow!.vote && (
        <p className="text-xs text-teal text-center">
          You voted: <span className="font-semibold">{myJurorRow!.vote}</span>
          {caseHeader.verdict && <span className="text-muted ml-2">— Verdict: {caseHeader.verdict}</span>}
        </p>
      )}

      {jury.length > 0 && <JuryPanel jury={jury} votesRevealed={votesRevealed} myAccountId={myAccountId} />}
    </div>
  );
}

function CaseHeaderCard({
  caseHeader, myAccountId, isJuror,
}: { caseHeader: CaseHeader; myAccountId: string; isJuror: boolean }) {
  const isChallenger = myAccountId === caseHeader.challengerId;
  const isDefendant = myAccountId === caseHeader.defendantId;
  const role = isChallenger ? 'You filed this' : isDefendant ? 'You are the defendant' : isJuror ? 'You are a juror' : null;

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gold uppercase tracking-wider">
          {caseHeader.type.replace('_', ' ')}
        </span>
        <span className="text-xs text-muted capitalize">
          {caseHeader.status.replace(/_/g, ' ')}
        </span>
      </div>

      {role && <p className="text-xs text-teal">{role}</p>}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted mb-0.5">Challenger</div>
          <div className="font-mono text-white truncate">{truncateId(caseHeader.challengerId)}</div>
        </div>
        <div>
          <div className="text-muted mb-0.5">Defendant</div>
          <div className="font-mono text-white truncate">{truncateId(caseHeader.defendantId)}</div>
        </div>
        <div>
          <div className="text-muted mb-0.5">Stake</div>
          <div className="text-white">
            {displayPoints(caseHeader.challengerStake)} pts ({caseHeader.challengerStakePercent}%)
          </div>
        </div>
        <div>
          <div className="text-muted mb-0.5">Filed</div>
          <div className="text-white">{timeAgo(caseHeader.createdAt)}</div>
        </div>
      </div>

      {caseHeader.verdict && (
        <div className={`p-2 rounded text-sm font-medium ${
          caseHeader.verdict === 'guilty' ? 'bg-red/10 text-red' : 'bg-teal/10 text-teal'
        }`}>
          Verdict: {caseHeader.verdict}
          {caseHeader.resolvedAt && (
            <span className="text-xs text-muted ml-2">{timeAgo(caseHeader.resolvedAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ArgumentTimeline({ argumentLog, myAccountId }: { argumentLog: CaseArgument[]; myAccountId: string }) {
  if (argumentLog.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-4 text-center">
        <p className="text-xs text-muted">No arguments posted yet.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-white">Arguments</h3>
      {argumentLog.map((arg) => {
        const isMine = arg.submitterId === myAccountId;
        const accent = arg.role === 'challenger' ? 'border-l-orange-400/50' : 'border-l-teal/50';
        return (
          <div key={arg.id} className={`bg-card border border-border border-l-4 ${accent} rounded-r-md rounded-l p-3`}>
            <div className="flex items-center justify-between mb-1.5">
              <span className={`text-[11px] uppercase tracking-wider ${
                arg.role === 'challenger' ? 'text-orange-300' : 'text-teal'
              }`}>
                {arg.role}{isMine ? ' (you)' : ''}
              </span>
              <span className="text-[11px] text-muted">{timeAgo(arg.createdAt)}</span>
            </div>
            <p className="text-sm text-white whitespace-pre-wrap">{arg.text}</p>
          </div>
        );
      })}
    </div>
  );
}

function ComposeArgumentCard({
  caseId, wallet, role, onPosted,
}: {
  caseId: string;
  wallet: { accountId: string; privateKey: string };
  role: 'challenger' | 'defendant';
  onPosted: () => void;
}) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const placeholder = role === 'challenger'
    ? 'Add evidence or rebut the defendant’s response. Jurors will read this before voting.'
    : 'Respond to the challenge. Explain why this challenge is wrong, attach context, etc.';

  async function submit() {
    setErr(null);
    if (!text.trim()) { setErr('Argument text is required.'); return; }
    setPosting(true);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { text: text.trim() };
      const sig = signPayload(payload, ts, wallet.privateKey);
      const r = await api.submitCaseArgument(caseId, {
        accountId: wallet.accountId, timestamp: ts, signature: sig, payload,
      });
      if (r.success) {
        setText('');
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
    <div className="bg-card border border-border rounded-lg p-4 space-y-2">
      <h3 className="text-sm font-medium text-white">
        Post {role === 'challenger' ? 'evidence / rebuttal' : 'response'}
      </h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={4}
        maxLength={5000}
        className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder-muted/40"
      />
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{text.length} / 5,000</span>
        {err && <span className="text-red">{err}</span>}
      </div>
      <button
        onClick={submit}
        disabled={posting || !text.trim()}
        className="w-full bg-teal text-white text-sm py-2 rounded hover:bg-teal/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {posting ? 'Posting…' : 'Post argument'}
      </button>
    </div>
  );
}

function JurorVoteCard({
  onVote, voting,
}: { onVote: (v: 'human' | 'not_human') => void; voting: boolean }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-medium text-white">Cast your vote</h3>
      <p className="text-xs text-muted">
        Sealed until every juror votes. If your vote matches the verdict, your accuracy goes up;
        if not, it goes down. Read the argument log carefully.
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onVote('human')}
          disabled={voting}
          className="flex-1 py-2 bg-white/5 border border-border text-white rounded text-xs hover:bg-teal/10 disabled:opacity-50"
        >
          Vote Human
        </button>
        <button
          onClick={() => onVote('not_human')}
          disabled={voting}
          className="flex-1 py-2 bg-white/5 border border-border text-white rounded text-xs hover:bg-red/10 disabled:opacity-50"
        >
          Vote Not Human
        </button>
      </div>
    </div>
  );
}

function JuryPanel({
  jury, votesRevealed, myAccountId,
}: { jury: JurorRow[]; votesRevealed: boolean; myAccountId: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Jury</h3>
        <span className="text-xs text-muted">
          {votesRevealed ? 'Votes revealed' : 'Sealed until all vote'}
        </span>
      </div>
      <ul className="space-y-1">
        {jury.map((j) => {
          const isMe = j.jurorAccountId === myAccountId;
          return (
            <li key={j.minerId} className="flex items-center justify-between text-xs">
              <span className="font-mono text-muted">
                {truncateId(j.jurorAccountId)}{isMe ? ' (you)' : ''}
              </span>
              <span className={`tabular-nums ${
                j.vote === 'human' ? 'text-teal' : j.vote === 'not_human' ? 'text-red' : 'text-muted'
              }`}>
                {j.vote === 'sealed' ? '🔒 sealed' : (j.vote ?? 'awaiting')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
