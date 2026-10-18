import { useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { loadWallet } from '../lib/keys';
import { useAccount } from '../hooks/useAccount';
import { api } from '../lib/api';
import type { CallMessage, PanelSummary, VouchData } from '../lib/types';
import { signPayload, signVouchCreate, signPanelCreate } from '../lib/crypto';
import { wsClient } from '../lib/websocket';
import { truncateId, displayPoints } from '../lib/formatting';
import { hashFileSHA256 } from '../lib/hash';

type Modal = null | 'request-vouch' | 'submit-evidence';

/**
 * Server minimum for a vouch stake (`minStakePercent` on the vouch evidence
 * type). Below this the API rejects with STAKE_TOO_SMALL, so the UI must not
 * offer less.
 */
const MIN_STAKE_PERCENT = 5;

interface VouchRequest {
  id: string;
  fromId: string;
  toId: string;
  message: string;
  status: string;
}

// Use the canonical wire shape rather than a local re-declaration. The local
// copy that used to live here omitted `id`, so nothing on this screen could
// reference a specific vouch — which is why withdrawal had no way in. Aliasing
// the shared type means the shape-contract suite guards this screen too.
type Vouch = VouchData;

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
  // Stake percentage per incoming request, keyed by request id. Defaults to the
  // server's minimum; anything lower is rejected with STAKE_TOO_SMALL.
  const [stakePercents, setStakePercents] = useState<Record<string, number>>({});
  const [vouchActionBusy, setVouchActionBusy] = useState<string | null>(null);
  const [vouchActionError, setVouchActionError] = useState<string | null>(null);
  // Withdrawal is two-step on purpose: it lowers someone else's score, so the
  // consequence gets stated before the tap rather than discovered after it.
  const [withdrawConfirming, setWithdrawConfirming] = useState<string | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [vouchScore, setVouchScore] = useState<{ totalScore: number; breakdown: { tierA: number; tierB: number; tierC: number }; vouchCount: number } | null>(null);

  // Verification panels (the real proof-of-human flow)
  const [panels, setPanels] = useState<PanelSummary[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelRequested, setPanelRequested] = useState(false);

  const loadPanels = useCallback(async () => {
    if (!wallet?.accountId) return;
    try {
      const res = await api.getAccountPanels(wallet.accountId);
      if (res.success) setPanels(res.data.panels);
    } catch { /* ignore */ }
  }, [wallet?.accountId]);

  // Notes from miners about a live call. The miner sets the call up on their
  // own tool and sends the link; the wallet only shows it.
  const [callMessages, setCallMessages] = useState<CallMessage[]>([]);
  const loadCallMessages = useCallback(async () => {
    if (!wallet?.accountId || !wallet.privateKey) return;
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {};
      const signature = signPayload(payload, timestamp, wallet.privateKey);
      const res = await api.getMyCallMessages({ accountId: wallet.accountId, timestamp, signature, payload });
      if (res.success) setCallMessages(res.data.messages.filter((m) => m.toId === wallet.accountId));
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.accountId]);

  useEffect(() => {
    if (!wallet?.accountId) return;
    loadVouchData();
    loadPanels();
    loadCallMessages();

    // Refresh on panel completion (server emits verification:complete + score:changed)
    const offComplete = wsClient.on('verification:complete', () => loadPanels());
    const offScore = wsClient.on('score:changed', () => loadPanels());
    const offCall = wsClient.on('verification:call-message', () => loadCallMessages());
    return () => { offComplete(); offScore(); offCall(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.accountId]);

  async function handleWithdrawVouch(v: Vouch) {
    if (!wallet?.accountId || !wallet.privateKey) return;
    setWithdrawError(null);
    setWithdrawBusy(v.id);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { vouchId: v.id };
      const signature = signPayload(payload, ts, wallet.privateKey);
      const res = await api.withdrawVouch(v.id, {
        accountId: wallet.accountId,
        timestamp: ts,
        signature,
        payload,
      });
      if (!res.success) {
        setWithdrawError(res.error?.message ?? 'Could not take that stake back.');
        return;
      }
      setWithdrawConfirming(null);
      // Reload rather than splice locally: the stake returning to the balance
      // and the other account's score dropping both happened server-side.
      loadVouchData();
    } catch (e) {
      setWithdrawError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setWithdrawBusy(null);
    }
  }

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
        setVouchScore({
          totalScore: res.data.score.totalScore,
          breakdown: res.data.score.breakdown,
          vouchCount: res.data.vouchCount,
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

  /**
   * Accept a vouch request: LOCK THE STAKE FIRST, then mark the request handled.
   *
   * This used to be a single PUT that only flipped the row to 'accepted'. No
   * stake was locked, no vouch row was written, and the friend who asked got
   * nothing — while the request vanished from both inboxes forever, because the
   * server only returns rows with status='pending'. Silent, and unrecoverable
   * through the UI.
   *
   * Order matters and is the same as ae-miner's: if the stake fails we must
   * leave the request pending so it can be retried. Marking it accepted first
   * would strand it exactly the way the old code did.
   */
  async function acceptVouchRequest(req: VouchRequest, stakePercent: number) {
    if (!wallet?.accountId || !wallet.privateKey) return;
    setVouchActionError(null);
    setVouchActionBusy(req.id);
    try {
      const ts = Math.floor(Date.now() / 1000);
      // The vouch rides the chain now: sign a VouchOperation and send it; the
      // auth envelope is signed over the same { op } payload.
      const op = signVouchCreate(wallet.accountId, req.fromId, stakePercent, ts, wallet.privateKey);
      const vouchPayload = { op };
      const vouchRes = await api.createVouch({
        accountId: wallet.accountId,
        timestamp: ts,
        signature: signPayload(vouchPayload, ts, wallet.privateKey),
        payload: vouchPayload,
      });
      if (!vouchRes.success) {
        // Server rejects a stake below the minimum, above the balance, or one
        // that rounds to zero. Surface it — the old code swallowed everything.
        setVouchActionError(vouchRes.error?.message ?? 'Could not lock the stake.');
        return;
      }

      const ts2 = Math.floor(Date.now() / 1000);
      const statusPayload = { status: 'accepted' as const };
      await api.updateVouchRequest(req.id, {
        accountId: wallet.accountId,
        timestamp: ts2,
        signature: signPayload(statusPayload, ts2, wallet.privateKey),
        payload: statusPayload,
      });
      loadVouchData();
    } catch (e) {
      setVouchActionError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setVouchActionBusy(null);
    }
  }

  /**
   * What a given percentage would lock, as base units.
   *
   * Matches the server's computeStakeFromPercent: the percentage applies to
   * TOTAL holdings (earned + already-locked), not just spendable earned. Using
   * earned alone here would under-report the cost on any account that already
   * has a vouch out.
   */
  function previewStake(pct: number): string {
    if (!account) return '0';
    const holdings = BigInt(account.earnedBalance) + BigInt(account.lockedBalance);
    return ((holdings * BigInt(Math.max(0, Math.round(pct)))) / 100n).toString();
  }

  /** Decline stays a single PUT — nothing is staked, so there is nothing to undo. */
  async function declineVouchRequest(req: VouchRequest) {
    if (!wallet?.accountId || !wallet.privateKey) return;
    setVouchActionError(null);
    setVouchActionBusy(req.id);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = { status: 'declined' as const };
      const res = await api.updateVouchRequest(req.id, {
        accountId: wallet.accountId,
        timestamp: ts,
        signature: signPayload(payload, ts, wallet.privateKey),
        payload,
      });
      if (!res.success) {
        setVouchActionError(res.error?.message ?? 'Could not decline that request.');
        return;
      }
      loadVouchData();
    } catch (e) {
      setVouchActionError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setVouchActionBusy(null);
    }
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
      // The panel rides the chain now: sign a panel_create operation and send
      // it. It is created deterministically at block commit on every node (panel
      // completion writes percentHuman, which must be consensus state). The auth
      // envelope signs the same { op } payload.
      const timestamp = Math.floor(Date.now() / 1000);
      const op = signPanelCreate(wallet.accountId, timestamp, wallet.privateKey);
      const payload = { op };
      const signature = signPayload(payload, timestamp, wallet.privateKey);
      const res = await api.requestPanel({
        accountId: wallet.accountId,
        timestamp,
        signature,
        payload,
      });
      if (res.success) {
        // Chain-ordered: the panel appears once the block commits, up to one
        // block interval later. Show "Requested" now so the tap visibly did
        // something, then poll until the panel shows up.
        setPanelRequested(true);
        setTimeout(() => { void loadPanels(); }, 1500);
        setTimeout(() => { void loadPanels(); }, 12000);
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
  const reviewRequested = !!openPanel || panelRequested;

  const score = account?.percentHuman ?? 0;
  const scoreColor = score >= 80 ? 'text-green-400' : score >= 50 ? 'text-yellow-400' : 'text-red-400';
  const ringColor = score >= 80 ? 'stroke-green-400' : score >= 50 ? 'stroke-yellow-400' : 'stroke-red-400';

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-xl font-serif text-white">Prove Human</h2>

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

      {/* Evidence score.
          Two numbers on this screen move independently and people read them as
          the same thing. Evidence Score climbs as vouches and documents come
          in; the big % human gauge above does not move until a miner panel
          completes and writes the median of the reviewers' scores. Someone who
          collected five vouches and watched their spendable value stay at zero
          reasonably concluded the app was broken. Say plainly that evidence is
          the case, and the panel is the verdict. */}
      {vouchScore && (
        <div className="bg-navy rounded-xl p-3 border border-navy-light space-y-3">
          <div className="flex justify-around text-center">
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
          {score === 0 && vouchScore.totalScore > 0 && (
            <p className="text-xs text-gray-400 leading-relaxed border-t border-navy-light pt-3">
              Your evidence is building, but your % human is still 0. Vouches and
              documents do not set your score on their own, a miner does. Request a
              review below and the miners assigned to you will read this evidence and
              set your score between them.
            </p>
          )}
        </div>
      )}

      {/* Three steps: request a vouch, upload evidence, have a call with a
          miner. Each row carries its own button, so the card is the whole
          flow. Uploading evidence still starts a miner review on its own (see
          handleSubmitEvidence); step 3 is for people who only have vouches,
          which was the one path with no button at all. There is no live-call
          channel yet, so step 3's button opens a miner review panel; the call
          itself is still to be built. */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
        <h3 className="text-sm font-medium text-white">Prove you are a unique human with one account</h3>
        <ol className="space-y-2">
          <ProveStep
            n={1}
            title="Request a vouch"
            detail="Verified friends stake their own points on you."
            action="Request a vouch"
            onClick={() => { setModal('request-vouch'); setVouchSuccess(false); setVouchError(null); }}
          />
          <ProveStep
            n={2}
            title="Upload evidence"
            detail="A photo ID, a selfie, a voice clip, etc. The file itself never leaves this device."
            action="Upload evidence"
            onClick={() => { setModal('submit-evidence'); setEvidenceSuccess(false); setEvidenceError(null); }}
          />
          <ProveStep
            n={3}
            title="Have a call with a miner"
            detail="A live call raises your % human score. The miner also reviews your vouches and evidence."
            action={panelLoading ? 'Requesting…' : reviewRequested ? 'Requested' : 'Request a call'}
            onClick={handleRequestPanel}
            disabled={panelLoading || reviewRequested}
          />
        </ol>
        {panelError && !panelLoading && <p className="text-xs text-gold">{panelError}</p>}
        {reviewRequested && !panelError && !panelLoading && callMessages.length === 0 && (
          <p className="text-xs text-teal">Request sent. When a miner sends you a call link, it shows up here.</p>
        )}
        {callMessages.length > 0 && (
          <div className="border-t border-navy-light pt-3 space-y-2">
            <p className="text-xs font-medium text-white">Message from a miner</p>
            {callMessages.map((m) => (
              <div key={m.id} className="bg-navy-dark rounded-lg p-3">
                <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
                  <Linkified text={m.text} />
                </p>
                <p className="text-[11px] text-gray-500 mt-1">{new Date(m.createdAt * 1000).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </div>


      {/* Incoming vouch requests */}
      {incomingRequests.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">Incoming Vouch Requests</h3>
          {vouchActionError && (
            <p className="text-xs text-red-400 mb-2">{vouchActionError}</p>
          )}
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
                  <>
                    {/* Vouching stakes real points. The card had no stake
                        control at all, which is part of why Accept did nothing
                        — the server requires a percentage and rejects anything
                        below the 5% minimum. Say what it costs before the tap. */}
                    <div className="flex items-center gap-2 mb-2">
                      <label className="text-xs text-gray-400 shrink-0">Stake</label>
                      <input
                        type="number"
                        min={MIN_STAKE_PERCENT}
                        max={100}
                        value={stakePercents[req.id] ?? MIN_STAKE_PERCENT}
                        onChange={(e) =>
                          setStakePercents((m) => ({ ...m, [req.id]: Number(e.target.value) }))
                        }
                        className="w-16 bg-navy-light border border-navy-light rounded px-2 py-1 text-xs text-white tabular-nums focus:border-teal focus:outline-none"
                      />
                      <span className="text-xs text-gray-400">
                        % · locks ≈{' '}
                        {displayPoints(
                          previewStake(stakePercents[req.id] ?? MIN_STAKE_PERCENT),
                        )}{' '}
                        pts
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-500 mb-2">
                      You get this back if they turn out to be real. You lose it if a
                      court finds they are not.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          acceptVouchRequest(req, stakePercents[req.id] ?? MIN_STAKE_PERCENT)
                        }
                        disabled={vouchActionBusy === req.id}
                        className="flex-1 py-2 bg-teal/20 text-teal rounded-lg text-xs hover:bg-teal/30 transition-colors disabled:opacity-50"
                      >
                        {vouchActionBusy === req.id ? 'Staking…' : 'Accept & stake'}
                      </button>
                      <button
                        onClick={() => declineVouchRequest(req)}
                        disabled={vouchActionBusy === req.id}
                        className="flex-1 py-2 bg-red-900/20 text-red-400 rounded-lg text-xs hover:bg-red-900/30 transition-colors disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </div>
                  </>
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
                <div className="text-right">
                  <p className="text-xs text-gray-400 tabular-nums">{v.stakedPercentage ?? '--'}%</p>
                  <p className="text-[11px] text-gray-500 tabular-nums">{displayPoints(String(v.stakeAmount))} pts</p>
                </div>
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
              <div key={i} className="bg-navy rounded-xl p-3 border border-navy-light">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-white font-mono">{truncateId(v.vouchedId)}</p>
                  <div className="text-right">
                    <p className="text-xs text-gray-400 tabular-nums">{v.stakedPercentage ?? '--'}%</p>
                    <p className="text-[11px] text-gray-500 tabular-nums">{displayPoints(String(v.stakeAmount))} pts</p>
                  </div>
                </div>

                {withdrawConfirming === v.id ? (
                  <div className="mt-3 pt-3 border-t border-navy-light">
                    {/* Say the cost out loud before the tap. The person who
                        loses the score is not here to object, and the drop is
                        immediate — it can take them below what they need to
                        spend at all. */}
                    <p className="text-xs text-red-400">
                      Taking back your {displayPoints(String(v.stakeAmount))} points drops{' '}
                      {truncateId(v.vouchedId)}'s human score by {v.stakedPercentage ?? 0} points
                      right away. They may not be able to spend afterwards.
                    </p>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => setWithdrawConfirming(null)}
                        disabled={withdrawBusy === v.id}
                        className="flex-1 text-xs py-2 rounded-lg border border-navy-light text-gray-300 disabled:opacity-50"
                      >
                        Keep vouching
                      </button>
                      <button
                        onClick={() => handleWithdrawVouch(v)}
                        disabled={withdrawBusy === v.id}
                        className="flex-1 text-xs py-2 rounded-lg bg-red-600 text-white disabled:opacity-50"
                      >
                        {withdrawBusy === v.id ? 'Taking back…' : 'Take back stake'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setWithdrawError(null); setWithdrawConfirming(v.id); }}
                    className="mt-2 text-xs text-gray-400 underline underline-offset-2"
                  >
                    Take back this stake
                  </button>
                )}
              </div>
            ))}
          </div>
          {withdrawError && <p className="text-xs text-red-400 mt-2">{withdrawError}</p>}
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

/**
 * A miner's note with its http(s) links made tappable. Only http and https
 * become links; any other scheme (javascript:, data:) stays plain text.
 */
function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-teal underline break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function ProveStep({
  n,
  title,
  detail,
  action,
  onClick,
  disabled = false,
}: {
  n: number;
  title: string;
  detail: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <li className="flex items-start gap-3 bg-navy-dark/60 rounded-lg p-3">
      <span className="w-6 h-6 rounded-full bg-teal/20 text-teal text-xs font-medium flex items-center justify-center shrink-0">
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white">{title}</p>
        <p className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{detail}</p>
        <button
          onClick={onClick}
          disabled={disabled}
          className="mt-2 px-3 py-1.5 bg-teal text-white rounded-lg text-xs font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 disabled:cursor-default"
        >
          {action}
        </button>
      </div>
    </li>
  );
}
