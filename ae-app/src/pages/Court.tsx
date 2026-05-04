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
  verdict: string | null;
  createdAt: number;
  resolvedAt: number | null;
  isDefendant: boolean;
  isChallenger: boolean;
}

export function Court() {
  const wallet = loadWallet();
  const [cases, setCases] = useState<MyCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [escalating, setEscalating] = useState<string | null>(null);

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
    const offFiled = wsClient.on('court:filed-against', () => load());
    const offVerdict = wsClient.on('court:verdict', () => load());
    return () => { offFiled(); offVerdict(); };
  }, [load]);

  async function escalate(caseId: string) {
    if (!wallet?.privateKey) return;
    setEscalating(caseId);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = {};
      const sig = signPayload(payload, ts, wallet.privateKey);
      const res = await api.escalateCase(caseId, {
        accountId: wallet.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      if (res.success) {
        await load();
      } else {
        setError(res.error?.message || 'Escalation failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setEscalating(null);
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
                <p className="text-xs text-gray-500 mt-1">Stake: {c.challengerStake}</p>
                {c.verdict && (
                  <p className={`text-sm mt-2 font-medium ${c.verdict === 'guilty' ? 'text-red-400' : 'text-teal'}`}>
                    Verdict: {c.verdict}
                  </p>
                )}
                <p className="text-[11px] text-teal mt-2">View case →</p>
              </Link>
              {c.isChallenger && c.status === 'arbitration_open' && !c.verdict && (
                <div className="px-4 pb-4">
                  <button
                    onClick={() => escalate(c.id)}
                    disabled={escalating === c.id}
                    className="w-full py-2 bg-orange-500/20 text-orange-300 rounded-lg text-xs hover:bg-orange-500/30 transition-colors disabled:opacity-50"
                  >
                    {escalating === c.id ? 'Escalating…' : 'Escalate to Full Court (jury draft)'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
