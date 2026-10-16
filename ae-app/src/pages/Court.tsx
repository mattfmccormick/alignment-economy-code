import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { wsClient } from '../lib/websocket';

interface MyCase {
  id: string;
  type: string;
  level: string;
  status: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  challengerStakePercent?: number;
  verdict: string | null;
  createdAt: number;
  resolvedAt: number | null;
  isDefendant: boolean;
  isChallenger: boolean;
}

// Statuses during which the defendant's earned points stay frozen.
const FROZEN_STATUSES = new Set([
  'arbitration_open', 'arbitration_response', 'court_open', 'court_waiting_jury',
  'court_voting', 'verdict_pending',
]);

export function Court() {
  const wallet = loadWallet();
  const [cases, setCases] = useState<MyCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wallet?.accountId) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.getMyCases(wallet.accountId);
      if (res.success) {
        setCases(res.data.cases as MyCase[]);
      } else {
        setError(res.error?.message || 'Failed to load cases');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.accountId]);

  useEffect(() => {
    load();
    // Live refresh on summons + verdicts
    const offs = ['court:filed-against', 'court:verdict', 'court:withdrawn', 'court:trial-demanded', 'court:appeal']
      .map((evt) => wsClient.on(evt, () => load()));
    return () => { for (const off of offs) off(); };
  }, [load]);

  async function act(caseId: string, action: 'withdraw' | 'demand-trial') {
    if (!wallet?.privateKey) return;
    setActing(caseId);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = {};
      const body = {
        accountId: wallet.accountId,
        timestamp: ts,
        signature: signPayload(payload, ts, wallet.privateKey),
        payload,
      };
      const res = action === 'withdraw'
        ? await api.withdrawCase(caseId, body)
        : await api.demandTrial(caseId, body);
      if (res.success) {
        await load();
      } else {
        setError(res.error?.message || 'That did not go through');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setActing(null);
    }
  }

  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading cases…</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">Court Cases</h2>

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-900/30 rounded-lg text-sm text-red-400">{error}</div>
      )}

      {cases.length === 0 ? (
        <div className="bg-navy rounded-xl p-6 border border-navy-light text-center">
          <p className="text-gray-500">No active cases involving your account</p>
          <p className="text-xs text-gray-600 mt-2">
            If someone challenges your identity verification, it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {cases.map((c) => (
            <div key={c.id} className="bg-navy rounded-xl border border-navy-light hover:border-teal/40 transition-colors">
              <Link to={`/court/${c.id}`} className="block p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gold uppercase tracking-wider">
                    {c.isDefendant ? 'You are the defendant' : 'You filed this'}
                  </span>
                  <span className="text-xs text-gray-500">{c.status}</span>
                </div>
                <p className="text-sm text-white mb-1">
                  <span className="text-gray-400 text-xs uppercase mr-2">{c.type.replace('_', ' ')}</span>
                </p>
                <p className="text-xs text-gray-400">
                  {c.isDefendant
                    ? `Challenger: ${c.challengerId.slice(0, 12)}…`
                    : `Defendant: ${c.defendantId.slice(0, 12)}…`}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Stake: {c.challengerStakePercent != null ? `${c.challengerStakePercent}%` : c.challengerStake}
                </p>
                {c.isDefendant && FROZEN_STATUSES.has(c.status) && (
                  <p className="text-xs text-red-400 mt-1">Earned transfers frozen until the case ends</p>
                )}
                {c.verdict && (
                  <p className={`text-sm mt-2 font-medium ${c.verdict === 'guilty' ? 'text-red-400' : 'text-teal'}`}>
                    Verdict: {c.verdict}
                    {c.status === 'verdict_pending' && (
                      <span className="block text-xs font-normal text-gray-400 mt-0.5">
                        Final after the 7-day appeal window. Nothing moves until then.
                      </span>
                    )}
                  </p>
                )}
                <p className="text-[11px] text-teal mt-2">View case →</p>
              </Link>
              {c.status === 'arbitration_open' && !c.verdict && c.isChallenger && (
                <div className="px-4 pb-4">
                  <button
                    onClick={() => act(c.id, 'withdraw')}
                    disabled={acting === c.id}
                    className="w-full py-2 bg-orange-500/20 text-orange-300 rounded-lg text-xs hover:bg-orange-500/30 transition-colors disabled:opacity-50"
                  >
                    {acting === c.id ? 'Withdrawing…' : 'Withdraw case'}
                  </button>
                  <p className="text-[11px] text-gray-500 mt-1.5">
                    1,440 points of your stake go to the defendant. Otherwise the case goes to a jury on day 7.
                  </p>
                </div>
              )}
              {c.status === 'arbitration_open' && !c.verdict && c.isDefendant && (
                <div className="px-4 pb-4">
                  <button
                    onClick={() => act(c.id, 'demand-trial')}
                    disabled={acting === c.id}
                    className="w-full py-2 bg-teal/20 text-teal rounded-lg text-xs hover:bg-teal/30 transition-colors disabled:opacity-50"
                  >
                    {acting === c.id ? 'Sending…' : 'Ask for a jury now'}
                  </button>
                  <p className="text-[11px] text-gray-500 mt-1.5">
                    Otherwise your case goes to a jury on day 7, unless the challenger withdraws.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
