import { useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { loadWallet } from '../lib/keys';
import { useAccount } from '../hooks/useAccount';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';
import { truncateId, displayPoints } from '../lib/formatting';
import { hashFileSHA256 } from '../lib/hash';

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
  const [evidenceFileName, setEvidenceFileName] = useState('');
  const [evidenceHashing, setEvidenceHashing] = useState(false);
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
      const ts = Math.floor(Date.now() / 1000);
      const payload = { toId: vouchToId.trim(), message: vouchMessage.trim() };
      const signature = signPayload(payload, ts, wallet.privateKey);
      const res = await api.createVouchRequest({
        accountId: wallet.accountId,
        timestamp: ts,
        signature,
        payload,
      });
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

  async function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setEvidenceError(null);
    setEvidenceSuccess(false);
    setEvidenceFileName(file.name);
    setEvidenceHashing(true);
    try {
      // Hash on-device. Only the digest is ever sent; the file stays here.
      const hash = await hashFileSHA256(file);
      setEvidenceHash(hash);
    } catch {
      setEvidenceError('Could not read that file. Try another.');
      setEvidenceHash('');
      setEvidenceFileName('');
    }
    setEvidenceHashing(false);
  }

  async function handleSubmitEvidence() {
    if (!wallet?.accountId || !evidenceHash.trim()) return;
    setEvidenceLoading(true);
    setEvidenceError(null);
    setEvidenceSuccess(false);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { evidenceTypeId: evidenceType, evidenceHash: evidenceHash.trim() };
      const signature = signPayload(payload, ts, wallet.privateKey);
      const res = await api.submitEvidence({
        accountId: wallet.accountId,
        timestamp: ts,
        signature,
        payload,
      });
      if (res.success) {
        setEvidenceSuccess(true);
        setEvidenceHash('');
        setEvidenceFileName('');
        // "Just upload, then submit": kick off the miner review automatically
        // so there's no separate "request a panel" step. Only when one isn't
        // already open (extra evidence rides the existing panel).
        if (!panels.some((p) => p.status !== 'complete')) {
          handleRequestPanel();
        }
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
    if (!wallet?.accountId) return;
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { status };
      const signature = signPayload(payload, ts, wallet.privateKey);
      await api.updateVouchRequest(id, {
        accountId: wallet.accountId,
        timestamp: ts,
        signature,
        payload,
      });
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

      {/* What counts as proof */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
        <div>
          <h3 className="text-sm font-medium text-white">Ways to prove you&apos;re human</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            You don&apos;t have to hand over ID or biometrics. Vouches from people who are already verified can take you all the way, or mix a few of these. A miner reviews whatever you add and judges how convincingly human it is.
          </p>
        </div>
        <ul className="space-y-2">
          {[
            { label: 'Vouches from verified friends', note: 'Strongest. Real people stake their own points on you, which is hard to fake.' },
            { label: 'A short live video call', note: 'Strong. A real-time face and voice are hard to fake.' },
            { label: 'Government ID photo', note: 'Helps, though a miner weighs it since photos can be edited.' },
            { label: 'Selfie or voice sample', note: 'Adds a little. AI can fake these, so they count less on their own.' },
          ].map((it) => (
            <li key={it.label} className="flex gap-2.5">
              <span className="text-teal text-sm mt-0.5">✓</span>
              <div>
                <p className="text-sm text-white">{it.label}</p>
                <p className="text-xs text-gray-500">{it.note}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-gray-500">
          You can get fully verified with vouches alone, no documents required.
        </p>
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
        {panelLoading && <p className="text-xs text-gray-400 text-center pt-1">Requesting a miner review…</p>}
        {panelError && !panelLoading && <p className="text-xs text-gold text-center pt-1">{panelError}</p>}
        {openPanel && !panelError && !panelLoading && <p className="text-xs text-teal text-center pt-1">A miner is reviewing your proof.</p>}
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
                <label className="text-xs text-gray-400 block mb-1">Evidence File</label>
                <label className="flex items-center justify-center gap-2 w-full bg-navy border border-dashed border-navy-light rounded-xl px-4 py-4 text-sm text-gray-400 cursor-pointer hover:border-teal transition-colors">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                  {evidenceFileName ? 'Choose a different file' : 'Choose a file (ID, selfie, document)'}
                  <input type="file" className="hidden" onChange={handleFilePick} />
                </label>
                {evidenceHashing && (
                  <p className="text-[11px] text-gray-400 mt-2">Hashing on your device...</p>
                )}
                {evidenceFileName && !evidenceHashing && (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-white truncate">{evidenceFileName}</p>
                    <p className="text-[10px] text-gray-500 font-mono break-all">SHA-256: {evidenceHash.slice(0, 32)}…</p>
                  </div>
                )}
                <p className="text-[10px] text-gray-600 mt-2">
                  Your file is hashed on your device. Only the hash is sent as proof, the document itself never leaves this device.
                </p>
              </div>

              {evidenceError && <p className="text-xs text-red-400">{evidenceError}</p>}
              {evidenceSuccess && <p className="text-xs text-teal">Evidence submitted!</p>}

              <button
                onClick={handleSubmitEvidence}
                disabled={evidenceLoading || evidenceHashing || !evidenceHash.trim()}
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

