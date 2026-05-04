import { useState, useEffect } from 'react';
import { api, type MinerStatus, type VouchData, type EvidenceScore } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';

export default function Audit() {
  const [minerStatus, setMinerStatus] = useState<MinerStatus | null>(null);
  const [vouches, setVouches] = useState<VouchData | null>(null);
  const [evidenceScore, setEvidenceScore] = useState<EvidenceScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const wallet = loadMinerWallet();
    if (!wallet) return;

    async function fetchData() {
      try {
        const [minerRes, vouchRes, evidenceRes] = await Promise.allSettled([
          api.getMinerStatus(wallet!.accountId),
          api.getVouches(wallet!.accountId),
          api.getEvidenceScore(wallet!.accountId),
        ]);

        if (minerRes.status === 'fulfilled' && minerRes.value.success) {
          setMinerStatus(minerRes.value.data);
        }
        if (vouchRes.status === 'fulfilled' && vouchRes.value.success) {
          setVouches(vouchRes.value.data);
        }
        if (evidenceRes.status === 'fulfilled' && evidenceRes.value.success) {
          setEvidenceScore(evidenceRes.value.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit data');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-muted">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading audit data...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="bg-red/10 border border-red/20 rounded-lg p-6 max-w-md text-center">
          <p className="text-sm text-red mb-2">{error}</p>
          <p className="text-xs text-muted">Make sure the AE node is running at localhost:3000</p>
        </div>
      </div>
    );
  }

  const wallet = loadMinerWallet();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Miner Audit Log</h2>
          <p className="text-sm text-muted mt-1">Your activity history and account status</p>
        </div>
      </div>

      {/* Miner profile */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Miner Status</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Account</span>
              <span className="text-xs font-mono">{wallet?.accountId ? wallet.accountId.slice(0, 16) + '...' : '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Tier</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                minerStatus?.miner?.tier === 2 ? 'bg-teal/10 text-teal' : 'bg-muted/10 text-muted'
              }`}>
                Tier {minerStatus?.miner?.tier ?? '--'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Active</span>
              <span className={minerStatus?.miner?.is_active ? 'text-teal text-xs' : 'text-red text-xs'}>
                {minerStatus?.miner?.is_active ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Registered</span>
              <span className="text-xs">
                {minerStatus?.miner?.registered_at
                  ? new Date(minerStatus.miner.registered_at).toLocaleDateString()
                  : '--'
                }
              </span>
            </div>
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Evidence Score</h3>
          <div className="flex items-center gap-4 mb-4">
            <div className="text-3xl font-bold text-teal">{evidenceScore?.score ?? '--'}</div>
            <div className="text-xs text-muted">out of 100</div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted">Vouch Count</span>
              <span>{evidenceScore?.vouchCount ?? 0}</span>
            </div>
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Vouching Activity</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Vouches Received</span>
              <span className="text-sm font-bold">{vouches?.received?.length ?? 0}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Vouches Given</span>
              <span className="text-sm font-bold">{vouches?.given?.length ?? 0}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Vouch details */}
      {vouches && (vouches.received.length > 0 || vouches.given.length > 0) ? (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-panel border border-border rounded-lg p-5">
            <h3 className="text-sm font-medium text-muted mb-3">Vouches Received</h3>
            {vouches.received.length > 0 ? (
              <div className="space-y-2">
                {vouches.received.map((v) => (
                  <div key={v.id} className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-xs font-mono">{v.voucherId.slice(0, 16)}...</span>
                    <span className="text-xs text-gold">{Number(v.stakeAmount).toLocaleString()} staked</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted/60 py-4 text-center">No vouches received yet</p>
            )}
          </div>
          <div className="bg-panel border border-border rounded-lg p-5">
            <h3 className="text-sm font-medium text-muted mb-3">Vouches Given</h3>
            {vouches.given.length > 0 ? (
              <div className="space-y-2">
                {vouches.given.map((v) => (
                  <div key={v.id} className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-xs font-mono">{v.vouchedId.slice(0, 16)}...</span>
                    <span className="text-xs text-gold">{Number(v.stakeAmount).toLocaleString()} staked</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted/60 py-4 text-center">No vouches given yet</p>
            )}
          </div>
        </div>
      ) : null}

      {/* Activity Log - empty state */}
      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-muted mb-4">Activity Log</h3>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg className="w-12 h-12 text-muted/15 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <p className="text-sm text-muted mb-1">No activity recorded yet</p>
          <p className="text-xs text-muted/60 max-w-sm">
            Your verification decisions, court participation, tier changes, and other miner activity will be logged here as you use the network.
          </p>
        </div>
      </div>
    </div>
  );
}
