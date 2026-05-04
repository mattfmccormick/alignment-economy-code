import { useState, useEffect, useCallback } from 'react';
import { loadWallet } from '../lib/keys';
import { useAccount } from '../hooks/useAccount';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';
import { truncateId, displayPoints } from '../lib/formatting';

type Modal = null | 'request-vouch' | 'submit-evidence';

interface VouchRequest {
  id: string;
  fromId: string;
  toId: string;
  message: string;
  status: string;
}

interface Vouch {
  voucherId: string;
  vouchedId: string;
  stakeAmount: number;
}

export function Verify() {
  const wallet = loadWallet();
  const { account } = useAccount(wallet?.accountId ?? null);

  const [modal, setModal] = useState<Modal>(null);

  // Vouch request form
  const [vouchToId, setVouchToId] = useState('');
  const [vouchMessage, setVouchMessage] = useState('');
  const [vouchLoading, setVouchLoading] = useState(false);
  const [vouchError, setVouchError] = useState<string | null>(null);
  const [vouchSuccess, setVouchSuccess] = useState(false);

  // Evidence form
  const [evidenceType, setEvidenceType] = useState('gov_id');
  const [evidenceHash, setEvidenceHash] = useState('');
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceSuccess, setEvidenceSuccess] = useState(false);

  // Vouch data
  const [incomingRequests, setIncomingRequests] = useState<VouchRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<VouchRequest[]>([]);
  const [receivedVouches, setReceivedVouches] = useState<Vouch[]>([]);
  const [givenVouches, setGivenVouches] = useState<Vouch[]>([]);
  const [vouchScore, setVouchScore] = useState<{ totalScore: number; breakdown: { tierA: number; tierB: number; tierC: number }; vouchCount: number } | null>(null);

  // Verification panels (the real proof-of-human flow)
  interface PanelSummary {
    id: string;
    accountId: string;
    status: 'pending' | 'in_progress' | 'complete';
    createdAt: number;
    completedAt: number | null;
    medianScore: number | null;
  }
  const [panels, setPanels] = useState<PanelSummary[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  const loadPanels = useCallback(async () => {
    if (!wallet?.accountId) return;
    try {
      const res = await api.getAccountPanels(wallet.accountId);
      if (res.success) setPanels(res.data.panels as PanelSummary[]);
    } catch { /* ignore */ }
  }, [wallet?.accountId]);

  useEffect(() => {
    if (!wallet?.accountId) return;
    loadVouchData();
    loadPanels();

    // Refresh on panel completion (server emits verification:complete + score:changed)
    const offComplete = wsClient.on('verification:complete', () => loadPanels());
    const offScore = wsClient.on('score:changed', () => loadPanels());
    return () => { offComplete(); offScore(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.accountId]);

  async function loadVouchData() {
    if (!wallet?.accountId) return;
    // Load each independently so one failure doesn't block others
    api.getVouchRequests(wallet.accountId).then(res => {
      if (res.success && res.data) {
        setIncomingRequests(res.data.incoming || []);
        setOutgoingRequests(res.data.outgoing || []);
      }
    }).catch(() => {});

    api.getVouches(wallet.accountId).then(res => {
      if (res.success && res.data) {
        setReceivedVouches(res.data.received || []);
        setGivenVouches(res.data.given || []);
      }
    }).catch(() => {});

    api.getEvidenceScore(wallet.accountId).then(res => {
      if (res.success && res.data) {
        const d = res.data as any;
        // API returns { score: { totalScore, breakdown }, vouchCount }
        const scoreObj = d.score || d;
        setVouchScore({
          totalScore: scoreObj.totalScore ?? scoreObj.score ?? 0,
          breakdown: scoreObj.breakdown || { tierA: 0, tierB: 0, tierC: 0 },
          vouchCount: d.vouchCount ?? 0,
        });
      }
    }).catch(() => {});
  }

  async function handleRequestVouch() {
    if (!wallet?.accountId || !vouchToId.trim()) return;
    setVouchLoading(true);
    setVouchError(null);
    setVouchSuccess(false);
    try {
      const res = await api.createVouchRequest(wallet.accountId, vouchToId.trim(), vouchMessage.trim());
      if (res.success) {
        setVouchSuccess(true);
        setVouchToId('');
        setVouchMessage('');
        loadVouchData();
        setTimeout(() => setModal(null), 1500);
      } else {
        setVouchError(res.error?.message || 'Failed to send request');
      }
    } catch {
      setVouchError('Network error');
    }
    setVouchLoading(false);
  }

  async function handleSubmitEvidence() {
    if (!wallet?.accountId || !evidenceHash.trim()) return;
    setEvidenceLoading(true);
    setEvidenceError(null);
    setEvidenceSuccess(false);
    try {
      const res = await api.submitEvidence(wallet.accountId, evidenceType, evidenceHash.trim());
      if (res.success) {
        setEvidenceSuccess(true);
        setEvidenceHash('');
        setTimeout(() => setModal(null), 1500);
      } else {
        setEvidenceError(res.error?.message || 'Failed to submit evidence');
      }
    } catch {
      setEvidenceError('Network error');
    }
    setEvidenceLoading(false);
  }

  async function handleVouchRequestAction(id: string, status: 'accepted' | 'declined') {
    try {
      await api.updateVouchRequest(id, status);
      loadVouchData();
    } catch { /* ignore */ }
  }

  // Request a verification panel — signed with the wallet's private key.
  // Backend FIFO-assigns available miners; they review the evidence already on
  // file and submit %Human scores. When all assigned reviews are in, the median
  // becomes our percentHuman.
  async function handleRequestPanel() {
    if (!wallet?.accountId || !wallet?.privateKey) return;
    setPanelLoading(true);
    setPanelError(null);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {};
      const signature = signPayload(payload, timestamp, wallet.privateKey);
      const res = await api.requestPanel({
        accountId: wallet.accountId,
        timestamp,
        signature,
        payload,
      });
      if (res.success) {
        if (res.data.assignedMinerCount === 0) {
          setPanelError('No miners are available to review your panel right now. Try again later.');
        }
        await loadPanels();
      } else {
        setPanelError(res.error?.message || 'Failed to request panel');
      }
    } catch (e) {
      setPanelError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setPanelLoading(false);
    }
  }

  const openPanel = panels.find((p) => p.status !== 'complete') || null;

  const score = account?.percentHuman ?? 0;
  const scoreColor = score >= 80 ? 'text-green-400' : score >= 50 ? 'text-yellow-400' : 'text-red-400';
  const ringColor = score >= 80 ? 'stroke-green-400' : score >= 50 ? 'stroke-yellow-400' : 'stroke-red-400';

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-xl font-serif text-white">Verification Score</h2>

      {/* Circular gauge */}
      <div className="flex justify-center">
        <div className="relative w-40 h-40">
          <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
            <circle cx="60" cy="60" r="50" fill="none" stroke="#243556" strokeWidth="8" />
            <circle
              cx="60" cy="60" r="50" fill="none"
              className={ringColor}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${score * 3.14} ${314 - score * 3.14}`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-3xl font-serif tabular-nums ${scoreColor}`}>{score}</span>
            <span className="text-xs text-gray-500">% human</span>
          </div>
        </div>
      </div>

      {/* Evidence score */}
      {vouchScore && (
        <div className="bg-navy rounded-xl p-3 border border-navy-light flex justify-around text-center">
          <div>
            <p className="text-lg text-white tabular-nums">{vouchScore.totalScore}</p>
            <p className="text-xs text-gray-500">Evidence Score</p>
          </div>
          <div className="w-px bg-navy-light" />
          <div>
            <p className="text-lg text-white tabular-nums">{vouchScore.vouchCount}</p>
            <p className="text-xs text-gray-500">Vouches</p>
          </div>
        </div>
      )}

      {/* Tier breakdown */}
      <div className="space-y-3">
        <TierRow label="Tier A" subtitle="Gov ID, Photo, Voice" score={vouchScore?.breakdown?.tierA ?? 0} max={30} />
        <TierRow label="Tier B" subtitle="Biometrics" score={vouchScore?.breakdown?.tierB ?? 0} max={80} />
        <TierRow label="Tier C" subtitle="Vouches" score={vouchScore?.breakdown?.tierC ?? score} max={100} />
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={() => { setModal('request-vouch'); setVouchSuccess(false); setVouchError(null); }}
          className="w-full py-3 bg-teal text-white rounded-xl text-sm font-medium hover:bg-teal-dark transition-colors"
        >
          Request Vouch from Friends
        </button>
        <button
          onClick={() => { setModal('submit-evidence'); setEvidenceSuccess(false); setEvidenceError(null); }}
          className="w-full py-3 bg-navy text-gray-300 rounded-xl text-sm border border-navy-light hover:border-gray-500 transition-colors"
        >
          Submit Evidence
        </button>
      </div>

      {/* Verification panel — the real proof-of-human flow */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
        <div>
          <h3 className="text-sm font-medium text-white">Get Verified by a Miner</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Submit your evidence above, then request a verification panel. Miners will be FIFO-assigned, review your evidence, and the median of their scores becomes your %Human.
          </p>
        </div>

        {openPanel ? (
          <div className="bg-navy-dark rounded-lg p-3 border border-teal/30">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-wider text-teal">Panel {openPanel.status === 'pending' ? 'pending' : 'in progress'}</span>
              <span className="text-xs text-gray-500 font-mono">{truncateId(openPanel.id)}</span>
            </div>
            <p className="text-xs text-gray-400">
              Created {new Date(openPanel.createdAt * 1000).toLocaleString()}.
              {openPanel.status === 'pending' ? ' Waiting for assigned miners to review.' : ' Reviews coming in.'}
            </p>
          </div>
        ) : (
          <button
            onClick={handleRequestPanel}
            disabled={panelLoading}
            className="w-full py-3 bg-gold text-navy-dark rounded-xl text-sm font-semibold hover:bg-gold-light transition-colors disabled:opacity-50"
          >
            {panelLoading ? 'Requesting…' : 'Request Verification Panel'}
          </button>
        )}

        {panelError && <p className="text-xs text-red-400">{panelError}</p>}

        {panels.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Past Panels</p>
            <div className="space-y-1">
              {panels.filter((p) => p.status === 'complete').map((p) => (
                <div key={p.id} className="flex items-center justify-between text-xs bg-navy-dark rounded-lg px-3 py-2">
                  <span className="text-gray-400 font-mono">{truncateId(p.id)}</span>
                  <span className="text-green-400">Median {p.medianScore}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Incoming vouch requests */}
      {incomingRequests.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Incoming Vouch Requests</h3>
          <div className="space-y-2">
            {incomingRequests.map(req => (
              <div key={req.id} className="bg-navy rounded-xl p-3 border border-navy-light">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm text-white font-mono">{truncateId(req.fromId)}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    req.status === 'pending' ? 'bg-gold/20 text-gold' : req.status === 'accepted' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
                  }`}>
                    {req.status}
                  </span>
                </div>
                {req.message && <p className="text-xs text-gray-400 mb-2">{req.message}</p>}
                {req.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleVouchRequestAction(req.id, 'accepted')}
                      className="flex-1 py-2 bg-teal/20 text-teal rounded-lg text-xs hover:bg-teal/30 transition-colors"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => handleVouchRequestAction(req.id, 'declined')}
                      className="flex-1 py-2 bg-red-900/20 text-red-400 rounded-lg text-xs hover:bg-red-900/30 transition-colors"
                    >
                      Decline
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing vouch requests */}
      {outgoingRequests.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Outgoing Vouch Requests</h3>
          <div className="space-y-2">
            {outgoingRequests.map(req => (
              <div key={req.id} className="bg-navy rounded-xl p-3 border border-navy-light flex items-center justify-between">
                <div>
                  <p className="text-sm text-white font-mono">{truncateId(req.toId)}</p>
                  {req.message && <p className="text-xs text-gray-500 mt-0.5">{req.message}</p>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  req.status === 'pending' ? 'bg-gold/20 text-gold' : req.status === 'accepted' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
                }`}>
                  {req.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Received vouches */}
      {receivedVouches.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Who Has Vouched for You</h3>
          <div className="space-y-2">
            {receivedVouches.map((v, i) => (
              <div key={i} className="bg-navy rounded-xl p-3 border border-navy-light flex items-center justify-between">
                <p className="text-sm text-white font-mono">{truncateId(v.voucherId)}</p>
                <p className="text-xs text-gray-400 tabular-nums">{displayPoints(String(v.stakeAmount))} staked</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Given vouches */}
      {givenVouches.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Your Vouches for Others</h3>
          <div className="space-y-2">
            {givenVouches.map((v, i) => (
              <div key={i} className="bg-navy rounded-xl p-3 border border-navy-light flex items-center justify-between">
                <p className="text-sm text-white font-mono">{truncateId(v.vouchedId)}</p>
                <p className="text-xs text-gray-400 tabular-nums">{displayPoints(String(v.stakeAmount))} staked</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Decay status */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light">
        <h3 className="text-sm font-medium text-gray-300 mb-2">Decay Status</h3>
        <p className="text-xs text-gray-400">
          Scores decay 10% per 30 days without activity.
          In-person transactions offset decay.
        </p>
        <div className="mt-2 flex justify-between text-xs">
          <span className="text-gray-500">In-person tx this month</span>
          <span className="text-white">0 / 5 for offset</span>
        </div>
      </div>

      {/* Request Vouch Modal */}
      {modal === 'request-vouch' && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-navy-dark rounded-2xl w-full max-w-md p-6 border border-navy-light">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-serif text-white">Request Vouch</h3>
              <button onClick={() => setModal(null)} className="text-gray-500 hover:text-white text-xl">&times;</button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Friend's Account ID</label>
                <input
                  value={vouchToId}
                  onChange={(e) => setVouchToId(e.target.value)}
                  placeholder="Paste their account ID"
                  className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Message (optional)</label>
                <textarea
                  value={vouchMessage}
                  onChange={(e) => setVouchMessage(e.target.value)}
                  placeholder="Hey, can you vouch for me?"
                  rows={2}
                  className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:border-teal focus:outline-none resize-none"
                />
              </div>

              {vouchError && <p className="text-xs text-red-400">{vouchError}</p>}
              {vouchSuccess && <p className="text-xs text-teal">Vouch request sent!</p>}

              <button
                onClick={handleRequestVouch}
                disabled={vouchLoading || !vouchToId.trim()}
                className="w-full py-3 bg-teal text-white rounded-xl text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
              >
                {vouchLoading ? 'Sending...' : 'Send Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit Evidence Modal */}
      {modal === 'submit-evidence' && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-navy-dark rounded-2xl w-full max-w-md p-6 border border-navy-light">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-serif text-white">Submit Evidence</h3>
              <button onClick={() => setModal(null)} className="text-gray-500 hover:text-white text-xl">&times;</button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Evidence Type</label>
                <select
                  value={evidenceType}
                  onChange={(e) => setEvidenceType(e.target.value)}
                  className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm focus:border-teal focus:outline-none"
                >
                  <option value="gov_id">Government ID</option>
                  <option value="biometric">Biometric Scan</option>
                  <option value="video_call">Video Call Verification</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Evidence Hash</label>
                <input
                  value={evidenceHash}
                  onChange={(e) => setEvidenceHash(e.target.value)}
                  placeholder="SHA-256 hash of your evidence file"
                  className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
                />
                <p className="text-[10px] text-gray-600 mt-1">
                  Hash your evidence file locally, then paste the hash here. Your actual document never leaves your device.
                </p>
              </div>

              {evidenceError && <p className="text-xs text-red-400">{evidenceError}</p>}
              {evidenceSuccess && <p className="text-xs text-teal">Evidence submitted!</p>}

              <button
                onClick={handleSubmitEvidence}
                disabled={evidenceLoading || !evidenceHash.trim()}
                className="w-full py-3 bg-teal text-white rounded-xl text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
              >
                {evidenceLoading ? 'Submitting...' : 'Submit Evidence'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TierRow({ label, subtitle, score, max }: { label: string; subtitle: string; score: number; max: number }) {
  const percent = max > 0 ? Math.min((score / max) * 100, 100) : 0;
  return (
    <div className="bg-navy rounded-xl p-3 border border-navy-light">
      <div className="flex justify-between items-baseline mb-1">
        <div>
          <span className="text-sm text-white">{label}</span>
          <span className="text-xs text-gray-500 ml-2">{subtitle}</span>
        </div>
        <span className="text-xs text-gray-300 tabular-nums">{score} / {max}</span>
      </div>
      <div className="h-1.5 bg-navy-light rounded-full overflow-hidden">
        <div className="h-full bg-teal rounded-full transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
