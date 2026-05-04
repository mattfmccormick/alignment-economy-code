// Court case detail page (wallet side).
//
// Shows the full case: header, argument log, jury panel (when escalated),
// verdict if resolved. Both the challenger and defendant can post arguments
// while the case is open; jurors read those alongside the case header before
// voting. The challenger sees the "Escalate to full court" action here when
// the case is in arbitration; the defendant sees a response form.
//
// Voting itself happens in the miner app (only registered miners can be
// jurors, and the wallet doesn't carry a miner role).

import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadWallet } from '../lib/keys';
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

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const wallet = loadWallet();

  const [caseHeader, setCaseHeader] = useState<CaseHeader | null>(null);
  const [argumentLog, setArgumentLog] = useState<CaseArgument[]>([]);
  const [jury, setJury] = useState<JurorRow[]>([]);
  const [votesRevealed, setVotesRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading case…</p>
      </div>
    );
  }
  if (!caseHeader) {
    return (
      <div className="p-4 space-y-3">
        <Link to="/court" className="text-xs text-teal hover:text-teal-dark">← Back to cases</Link>
        <p className="text-sm text-red-400">{error ?? 'Case not found'}</p>
      </div>
    );
  }

  const myAccountId = wallet?.accountId ?? '';
  const isChallenger = myAccountId === caseHeader.challengerId;
  const isDefendant = myAccountId === caseHeader.defendantId;
  const isParty = isChallenger || isDefendant;
  const caseOpen = caseHeader.verdict === null && CASE_OPEN_STATUSES.has(caseHeader.status);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/court" className="text-xs text-teal hover:text-teal-dark">← Back to cases</Link>
        <span className="text-[11px] text-gray-500 font-mono">{truncateId(caseHeader.id)}</span>
      </div>

      <CaseHeaderCard caseHeader={caseHeader} myAccountId={myAccountId} />

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-900/30 rounded-lg text-sm text-red-400">{error}</div>
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

      {!isParty && (
        <p className="text-xs text-gray-500 text-center px-4">
          Only the challenger or defendant can post arguments on this case.
        </p>
      )}

      {jury.length > 0 && <JuryPanel jury={jury} votesRevealed={votesRevealed} />}
    </div>
  );
}

function CaseHeaderCard({ caseHeader, myAccountId }: { caseHeader: CaseHeader; myAccountId: string }) {
  const isChallenger = myAccountId === caseHeader.challengerId;
  const isDefendant = myAccountId === caseHeader.defendantId;
  const youAre = isChallenger ? 'You filed this' : isDefendant ? 'You are the defendant' : null;

  return (
    <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gold uppercase tracking-wider">
          {caseHeader.type.replace('_', ' ')}
        </span>
        <span className="text-xs text-gray-500 capitalize">
          {caseHeader.status.replace('_', ' ')}
        </span>
      </div>

      {youAre && <p className="text-xs text-teal">{youAre}</p>}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-gray-500 mb-0.5">Challenger</div>
          <div className="font-mono text-gray-300 truncate">{truncateId(caseHeader.challengerId)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Defendant</div>
          <div className="font-mono text-gray-300 truncate">{truncateId(caseHeader.defendantId)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Stake</div>
          <div className="text-gray-300">
            {displayPoints(caseHeader.challengerStake)} pts ({caseHeader.challengerStakePercent}%)
          </div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Filed</div>
          <div className="text-gray-300">{timeAgo(caseHeader.createdAt)}</div>
        </div>
      </div>

      {caseHeader.verdict && (
        <div className={`mt-2 p-2 rounded text-sm font-medium ${
          caseHeader.verdict === 'guilty' ? 'bg-red-500/10 text-red-400' : 'bg-teal/10 text-teal'
        }`}>
          Verdict: {caseHeader.verdict}
          {caseHeader.resolvedAt && (
            <span className="text-xs text-gray-500 ml-2">{timeAgo(caseHeader.resolvedAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ArgumentTimeline({
  argumentLog, myAccountId,
}: {
  argumentLog: CaseArgument[];
  myAccountId: string;
}) {
  if (argumentLog.length === 0) {
    return (
      <div className="bg-navy rounded-xl p-4 border border-navy-light text-center">
        <p className="text-xs text-gray-500">No arguments posted yet.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-300 px-1">Arguments</h3>
      {argumentLog.map((arg) => {
        const isMine = arg.submitterId === myAccountId;
        const accent = arg.role === 'challenger' ? 'border-l-orange-400/50' : 'border-l-teal/50';
        return (
          <div
            key={arg.id}
            className={`bg-navy rounded-r-lg rounded-l-md border border-navy-light border-l-4 ${accent} p-3`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className={`text-[11px] uppercase tracking-wider ${
                arg.role === 'challenger' ? 'text-orange-300' : 'text-teal'
              }`}>
                {arg.role}{isMine ? ' (you)' : ''}
              </span>
              <span className="text-[11px] text-gray-500">{timeAgo(arg.createdAt)}</span>
            </div>
            <p className="text-sm text-gray-200 whitespace-pre-wrap">{arg.text}</p>
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
        setErr(r.error?.message ?? 'Failed to post argument');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-2">
      <h3 className="text-sm font-medium text-gray-300">
        Post {role === 'challenger' ? 'evidence / rebuttal' : 'response'}
      </h3>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={4}
        maxLength={5000}
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-sm text-white placeholder-gray-600"
      />
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>{text.length} / 5,000</span>
        {err && <span className="text-red-400">{err}</span>}
      </div>
      <button
        onClick={submit}
        disabled={posting || !text.trim()}
        className="w-full bg-teal hover:bg-teal-dark text-white text-sm py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {posting ? 'Posting…' : 'Post argument'}
      </button>
    </div>
  );
}

function JuryPanel({ jury, votesRevealed }: { jury: JurorRow[]; votesRevealed: boolean }) {
  return (
    <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">Jury</h3>
        <span className="text-xs text-gray-500">
          {votesRevealed ? 'Votes revealed' : 'Sealed until all vote'}
        </span>
      </div>
      <ul className="space-y-1">
        {jury.map((j) => (
          <li key={j.minerId} className="flex items-center justify-between text-xs">
            <span className="font-mono text-gray-400">{truncateId(j.jurorAccountId)}</span>
            <span className={`tabular-nums ${
              j.vote === 'human' ? 'text-teal' : j.vote === 'not_human' ? 'text-red-400' : 'text-gray-500'
            }`}>
              {j.vote === 'sealed' ? '🔒 sealed' : (j.vote ?? 'awaiting')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
