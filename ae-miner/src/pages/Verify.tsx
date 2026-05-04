import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';

interface Assignment {
  panelId: string;
  applicantAccountId: string;
  panelStatus: 'pending' | 'in_progress' | 'complete';
  panelCreatedAt: number;
  panelCompletedAt: number | null;
  medianScore: number | null;
  assignedAt: number;
  deadline: number;
  myReviewSubmitted: boolean;
  missed: boolean;
}

interface PanelDetail {
  panel: {
    id: string;
    accountId: string;
    status: string;
    createdAt: number;
    completedAt: number | null;
    medianScore: number | null;
  };
  evidence: Array<{ id: string; evidenceTypeId: string; evidenceHash: string; submittedAt: number }>;
  reviews: Array<{ id: string; minerId: string; score: number; submittedAt: number }>;
  assignedMiners: Array<{ miner_id: string; completed: number; missed: number }>;
  liveScore: { totalScore: number; breakdown: { tierA: number; tierB: number; tierC: number } };
}

export default function Verify() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [minerRegistered, setMinerRegistered] = useState(false);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [panelDetail, setPanelDetail] = useState<PanelDetail | null>(null);
  const [proposedScore, setProposedScore] = useState(80);
  const [submitting, setSubmitting] = useState(false);

  const loadAssignments = useCallback(async () => {
    const wallet = loadMinerWallet();
    if (!wallet?.accountId) {
      setError('No wallet found. Sign in first.');
      setLoading(false);
      return;
    }
    try {
      const res = await api.getAssignedPanels(wallet.accountId);
      if (res.success) {
        setAssignments(res.data.assignments);
        setMinerRegistered(res.data.minerRegistered);
        setError('');
      } else {
        setError(res.error?.message || 'Failed to load assignments');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAssignments();

    // Live refresh when a new verification is assigned to this miner
    const offAssigned = wsClient.on('verification:assigned', () => loadAssignments());
    return () => { offAssigned(); };
  }, [loadAssignments]);

  async function openPanel(panelId: string) {
    setSelectedPanelId(panelId);
    setPanelDetail(null);
    try {
      const res = await api.getPanel(panelId);
      if (res.success) setPanelDetail(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load panel');
    }
  }

  async function submitScore() {
    if (!selectedPanelId) return;
    const wallet = loadMinerWallet();
    if (!wallet?.privateKey) {
      setError('Private key missing — sign in again.');
      return;
    }

    setSubmitting(true);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = { score: proposedScore };
      const signature = signPayload(payload, timestamp, wallet.privateKey);
      const res = await api.submitPanelScore(selectedPanelId, {
        accountId: wallet.accountId,
        timestamp,
        signature,
        payload,
      });
      if (res.success) {
        // Refresh assignments + panel detail
        await loadAssignments();
        await openPanel(selectedPanelId);
      } else {
        setError(res.error?.message || 'Failed to submit score');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-muted">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading verification queue...
        </div>
      </div>
    );
  }

  if (!minerRegistered) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-panel border border-border rounded-xl p-8 text-center">
          <p className="text-lg font-semibold text-white mb-2">Not registered as a miner</p>
          <p className="text-sm text-muted">Register your account as a miner first to receive verification assignments.</p>
        </div>
      </div>
    );
  }

  const pending = assignments.filter((a) => !a.myReviewSubmitted && a.panelStatus !== 'complete');
  const past = assignments.filter((a) => a.myReviewSubmitted || a.panelStatus === 'complete');
  const selected = assignments.find((a) => a.panelId === selectedPanelId);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Verification Queue</h1>
          <p className="text-sm text-muted mt-1">FIFO-assigned panels awaiting your %Human score.</p>
        </div>
        <button
          onClick={loadAssignments}
          className="text-xs text-teal hover:underline"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>
      )}

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Queue list */}
        <div className="lg:col-span-2 space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted">Pending ({pending.length})</div>
          {pending.length === 0 ? (
            <div className="bg-panel border border-border rounded-xl p-6 text-center text-sm text-muted">
              Queue is empty. New assignments arrive in FIFO order.
            </div>
          ) : (
            pending.map((a) => (
              <button
                key={a.panelId}
                onClick={() => openPanel(a.panelId)}
                className={`w-full text-left bg-panel border rounded-xl p-4 transition-colors ${
                  selectedPanelId === a.panelId ? 'border-teal ring-2 ring-teal/20' : 'border-border hover:border-border/60'
                }`}
              >
                <div className="text-sm font-medium text-white truncate">
                  {a.applicantAccountId.slice(0, 16)}…
                </div>
                <div className="text-xs text-muted mt-1">
                  Assigned {new Date(a.assignedAt * 1000).toLocaleString()}
                </div>
              </button>
            ))
          )}

          {past.length > 0 && (
            <>
              <div className="text-xs uppercase tracking-wider text-muted mt-6">History ({past.length})</div>
              {past.map((a) => (
                <button
                  key={a.panelId}
                  onClick={() => openPanel(a.panelId)}
                  className={`w-full text-left bg-panel border rounded-xl p-4 transition-colors opacity-70 ${
                    selectedPanelId === a.panelId ? 'border-teal ring-2 ring-teal/20' : 'border-border'
                  }`}
                >
                  <div className="text-sm font-medium text-white truncate">
                    {a.applicantAccountId.slice(0, 16)}…
                  </div>
                  <div className="text-xs text-muted mt-1 flex items-center gap-2">
                    <span className={a.panelStatus === 'complete' ? 'text-green' : 'text-muted'}>
                      {a.panelStatus === 'complete' ? `Median ${a.medianScore}%` : 'Awaiting other miners'}
                    </span>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Detail */}
        <div className="lg:col-span-3">
          {!selected || !panelDetail ? (
            <div className="bg-panel border border-border rounded-xl p-12 text-center text-muted">
              <p>Select a panel to review the applicant&apos;s evidence and submit a score.</p>
            </div>
          ) : (
            <div className="bg-panel border border-border rounded-xl p-6 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white">Review applicant</h2>
                <p className="text-xs font-mono text-muted mt-1">{panelDetail.panel.accountId}</p>
              </div>

              <div className="bg-bg rounded-lg p-4">
                <h3 className="text-xs uppercase tracking-wider text-muted mb-2">Submitted Evidence</h3>
                {panelDetail.evidence.length === 0 ? (
                  <p className="text-sm text-muted italic">No evidence submitted yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {panelDetail.evidence.map((e) => (
                      <li key={e.id} className="flex justify-between text-white">
                        <span>{e.evidenceTypeId}</span>
                        <span className="font-mono text-xs text-muted">{e.evidenceHash.slice(0, 12)}…</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="bg-bg rounded-lg p-4">
                <h3 className="text-xs uppercase tracking-wider text-muted mb-2">Live Auto-Score (informational)</h3>
                <div className="text-2xl font-bold text-teal">{panelDetail.liveScore.totalScore}%</div>
                <div className="text-xs text-muted mt-1">
                  Tier A {panelDetail.liveScore.breakdown.tierA} · Tier B {panelDetail.liveScore.breakdown.tierB} · Tier C {panelDetail.liveScore.breakdown.tierC}
                </div>
                <p className="text-xs text-muted/70 mt-2">
                  Final score is the median of submitted miner reviews, not this auto-score.
                </p>
              </div>

              {panelDetail.panel.status === 'complete' ? (
                <div className="bg-green/10 border border-green/20 rounded-lg p-4">
                  <div className="text-xs uppercase tracking-wider text-green mb-1">Panel Complete</div>
                  <div className="text-2xl font-bold text-white">Median {panelDetail.panel.medianScore}%</div>
                  <p className="text-xs text-muted mt-1">
                    Applicant&apos;s percentHuman has been updated.
                  </p>
                </div>
              ) : selected.myReviewSubmitted ? (
                <div className="bg-bg border border-border rounded-lg p-4">
                  <p className="text-sm text-muted">
                    You&apos;ve already scored this panel. Waiting for other miners.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <h3 className="text-xs uppercase tracking-wider text-muted">Your Score</h3>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={proposedScore}
                      onChange={(e) => setProposedScore(parseInt(e.target.value))}
                      className="flex-1"
                    />
                    <div className="bg-bg border border-border rounded-md px-3 py-1.5 w-20 text-center">
                      <span className="text-lg font-mono text-white">{proposedScore}</span>
                      <span className="text-xs text-muted">%</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted">
                    Per the white paper, you decide the weight. Tier classifications are hints, not caps.
                  </p>
                  <button
                    onClick={submitScore}
                    disabled={submitting}
                    className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
                  >
                    {submitting ? 'Submitting…' : `Submit ${proposedScore}% Human Score`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
