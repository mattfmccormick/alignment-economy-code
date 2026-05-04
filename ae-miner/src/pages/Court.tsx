import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';

type Tab = 'jury' | 'cases' | 'file';

interface JuryAssignment {
  caseId: string;
  caseType: string;
  caseLevel: string;
  caseStatus: string;
  challengerId: string;
  defendantId: string;
  votingDeadline: number | null;
  verdict: string | null;
  stakeAmount: string;
  myVote: string | null;
  votedAt: number | null;
}

interface CourtCase {
  id: string;
  type: string;
  status: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  verdict: string | null;
  createdAt: number;
}

export default function Court() {
  const [tab, setTab] = useState<Tab>('jury');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assignments, setAssignments] = useState<JuryAssignment[]>([]);
  const [cases, setCases] = useState<CourtCase[]>([]);
  const [voting, setVoting] = useState<string | null>(null);

  // File-challenge form state
  const [defendantId, setDefendantId] = useState('');
  const [caseType, setCaseType] = useState<'not_human' | 'duplicate_account'>('not_human');
  const [stakePercent, setStakePercent] = useState(5);
  const [openingArgument, setOpeningArgument] = useState('');
  const [filing, setFiling] = useState(false);

  const load = useCallback(async () => {
    const wallet = loadMinerWallet();
    if (!wallet?.accountId) {
      setLoading(false);
      return;
    }
    try {
      const [juryRes, casesRes] = await Promise.all([
        api.getJuryDuty(wallet.accountId),
        api.getActiveCases(),
      ]);
      if (juryRes.success) setAssignments(juryRes.data.assignments);
      if (casesRes.success) setCases(casesRes.data.cases);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load court data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const offJury = wsClient.on('jury:called', () => load());
    const offVerdict = wsClient.on('court:verdict', () => load());
    return () => { offJury(); offVerdict(); };
  }, [load]);

  async function castVote(caseId: string, vote: 'human' | 'not_human') {
    const wallet = loadMinerWallet();
    if (!wallet?.privateKey) return;
    setVoting(caseId);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { vote };
      const sig = signPayload(payload, ts, wallet.privateKey);
      const res = await api.submitVote(caseId, {
        accountId: wallet.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      if (res.success) {
        await load();
      } else {
        setError(res.error?.message || 'Vote failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setVoting(null);
    }
  }

  async function fileChallenge() {
    const wallet = loadMinerWallet();
    if (!wallet?.privateKey) return;
    if (!defendantId.trim()) {
      setError('Enter the defendant account ID');
      return;
    }
    setFiling(true);
    setError('');
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        defendantAccountId: defendantId.trim(), caseType, stakePercent,
      };
      const trimmedArg = openingArgument.trim();
      if (trimmedArg) payload.openingArgument = trimmedArg;
      const sig = signPayload(payload, ts, wallet.privateKey);
      const res = await api.fileChallenge({
        accountId: wallet.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      if (res.success) {
        setDefendantId('');
        setOpeningArgument('');
        await load();
        setTab('cases');
      } else {
        setError(res.error?.message || 'Failed to file challenge');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setFiling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted">Loading court data…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-2xl font-bold text-white">Court</h1>

      <div className="flex gap-1 bg-panel border border-border rounded-lg p-1">
        {(['jury', 'cases', 'file'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setError(''); }}
            className={`flex-1 px-4 py-2.5 rounded-md text-sm font-medium transition-colors capitalize ${
              tab === t ? 'bg-teal/10 text-teal' : 'text-muted hover:text-white'
            }`}
          >
            {t === 'jury' ? `Jury Duty (${assignments.filter((a) => !a.myVote).length})` : t === 'cases' ? 'Active Cases' : 'File Challenge'}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>
      )}

      {tab === 'jury' && (
        assignments.length === 0 ? (
          <div className="bg-panel border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-muted">No jury assignments. You&apos;re available; the next case will FIFO-pick from active miners.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {assignments.map((a) => (
              <div key={a.caseId} className="bg-panel border border-border rounded-lg">
                <Link to={`/court/${a.caseId}`} className="block p-4 hover:bg-white/5 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gold uppercase">{a.caseType.replace('_', ' ')}</span>
                    <span className="text-xs text-muted">{a.caseStatus}</span>
                  </div>
                  <p className="text-xs text-muted mb-1">Defendant: {a.defendantId.slice(0, 20)}…</p>
                  <p className="text-xs text-muted mb-1">Challenger: {a.challengerId.slice(0, 20)}…</p>
                  <p className="text-xs text-muted">Your stake: {a.stakeAmount}</p>
                  <p className="text-[11px] text-teal mt-2">View arguments and vote →</p>
                </Link>
                {a.myVote ? (
                  <p className="text-xs text-teal px-4 pb-4">
                    You voted: <span className="font-semibold">{a.myVote}</span>
                    {a.verdict && <span className="ml-2 text-muted">— Verdict: {a.verdict}</span>}
                  </p>
                ) : (
                  <div className="flex gap-2 px-4 pb-4">
                    <button
                      onClick={() => castVote(a.caseId, 'human')}
                      disabled={voting === a.caseId}
                      className="flex-1 py-2 bg-white/5 border border-border text-white rounded-lg text-xs hover:bg-teal/10 transition-colors disabled:opacity-50"
                    >
                      Vote Human
                    </button>
                    <button
                      onClick={() => castVote(a.caseId, 'not_human')}
                      disabled={voting === a.caseId}
                      className="flex-1 py-2 bg-white/5 border border-border text-white rounded-lg text-xs hover:bg-red/10 transition-colors disabled:opacity-50"
                    >
                      Vote Not Human
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'cases' && (
        cases.length === 0 ? (
          <div className="bg-panel border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-muted">No active cases on the network.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {cases.map((c) => (
              <Link
                key={c.id}
                to={`/court/${c.id}`}
                className="block bg-panel border border-border rounded-lg p-4 hover:border-teal/40 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gold uppercase">{c.type.replace('_', ' ')}</span>
                  <span className="text-xs text-muted">{c.status}</span>
                </div>
                <p className="text-xs text-muted">Defendant: {c.defendantId.slice(0, 20)}…</p>
                <p className="text-xs text-muted">Challenger: {c.challengerId.slice(0, 20)}…</p>
                <p className="text-xs text-muted mt-1">Stake: {c.challengerStake}</p>
                {c.verdict && (
                  <p className={`text-sm mt-2 font-medium ${c.verdict === 'guilty' ? 'text-red' : 'text-teal'}`}>Verdict: {c.verdict}</p>
                )}
                <p className="text-[11px] text-teal mt-2">View case →</p>
              </Link>
            ))}
          </div>
        )
      )}

      {tab === 'file' && (
        <div className="bg-panel border border-border rounded-lg p-6 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-white">File a Challenge</h3>
            <p className="text-xs text-muted mt-1">
              Stake a percentage of your Earned points. Win and you get a bounty (20% of defendant&apos;s Earned). Lose and your stake is burned.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Defendant Account ID</label>
            <input
              value={defendantId}
              onChange={(e) => setDefendantId(e.target.value)}
              placeholder="acc_..."
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-muted/40 focus:outline-none focus:border-teal"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Case Type</label>
            <select
              value={caseType}
              onChange={(e) => setCaseType(e.target.value as 'not_human' | 'duplicate_account')}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-teal"
            >
              <option value="not_human">Not Human (suspected bot/AI)</option>
              <option value="duplicate_account">Duplicate Account (Sybil)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Stake: {stakePercent}% of your Earned</label>
            <input
              type="range" min={1} max={50} value={stakePercent}
              onChange={(e) => setStakePercent(parseInt(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">
              Opening argument <span className="text-muted/70">(strongly recommended)</span>
            </label>
            <textarea
              value={openingArgument}
              onChange={(e) => setOpeningArgument(e.target.value)}
              placeholder="Lay out your evidence: what makes you think this account isn't a real human? Specific behaviors, timing patterns, anything the defendant and the jury should weigh."
              rows={4}
              maxLength={5000}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder-muted/40"
            />
            <div className="text-[11px] text-muted mt-1">{openingArgument.length} / 5,000</div>
          </div>
          <button
            onClick={fileChallenge}
            disabled={filing || !defendantId.trim()}
            className="w-full py-2.5 bg-red text-white rounded-lg text-sm font-medium hover:bg-red/80 transition-colors disabled:opacity-50"
          >
            {filing ? 'Filing…' : `File Challenge with ${stakePercent}% Stake`}
          </button>
        </div>
      )}
    </div>
  );
}
