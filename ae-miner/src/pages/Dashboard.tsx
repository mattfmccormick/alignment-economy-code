import { useState, useEffect } from 'react';
import { api, type MinerStatus, type Account, type NetworkStatus, type EvidenceScore } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { displayPoints } from '../lib/formatting';
import TierBadge from '../components/dashboard/TierBadge';
import UptimeGauge from '../components/dashboard/UptimeGauge';
import IncomeCard from '../components/dashboard/IncomeCard';

export default function Dashboard() {
  const [minerStatus, setMinerStatus] = useState<MinerStatus | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [evidenceScore, setEvidenceScore] = useState<EvidenceScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const wallet = loadMinerWallet();
    if (!wallet) return;

    async function fetchData() {
      try {
        const [minerRes, accountRes, networkRes, evidenceRes] = await Promise.allSettled([
          api.getMinerStatus(wallet!.accountId),
          api.getAccount(wallet!.accountId),
          api.getNetworkStatus(),
          api.getEvidenceScore(wallet!.accountId),
        ]);

        if (minerRes.status === 'fulfilled' && minerRes.value.success) {
          setMinerStatus(minerRes.value.data);
        }
        if (accountRes.status === 'fulfilled' && accountRes.value.success) {
          setAccount(accountRes.value.data);
        }
        if (networkRes.status === 'fulfilled' && networkRes.value.success) {
          setNetwork(networkRes.value.data);
        }
        if (evidenceRes.status === 'fulfilled' && evidenceRes.value.success) {
          setEvidenceScore(evidenceRes.value.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-muted">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading dashboard...
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

  const tier = (minerStatus?.miner?.tier || 1) as 1 | 2;

  return (
    <div className="space-y-6">
      {/* Stat Cards Row */}
      <div className="grid grid-cols-4 gap-4">
        {/* Tier Card */}
        <TierBadge tier={tier} />

        {/* Uptime Gauge Card */}
        <div className="bg-panel border border-border rounded-lg p-5 flex flex-col items-center justify-center relative">
          <h3 className="text-sm font-medium text-muted mb-2 self-start">Uptime</h3>
          <div className="relative">
            <UptimeGauge percent={minerStatus?.miner?.is_active ? 100 : 0} />
          </div>
        </div>

        {/* Evidence Score Card */}
        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted mb-2">Evidence Score</h3>
          <div className="text-3xl font-bold text-teal mb-1">
            {evidenceScore ? evidenceScore.score : '--'}
          </div>
          <div className="text-xs text-muted mb-4">verification confidence</div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-muted">Vouch Count</span>
              <span className="text-teal">{evidenceScore?.vouchCount ?? 0}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted">Tier</span>
              <span className="text-teal">{tier}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted">Status</span>
              <span className={minerStatus?.miner?.is_active ? 'text-teal' : 'text-red'}>
                {minerStatus?.miner?.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>

        {/* Balances Card */}
        <IncomeCard
          activeBalance={account ? displayPoints(account.balances.active) : '0'}
          earnedBalance={account ? displayPoints(account.balances.earned) : '0'}
          lockedBalance={account ? displayPoints(account.balances.locked) : '0'}
          percentHuman={account?.percentHuman ?? 0}
        />
      </div>

      {/* Network Stats Row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted mb-3">Network Status</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Block Height</span>
              <span className="text-sm font-mono font-semibold">#{network?.blockHeight?.toLocaleString() ?? '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Current Day</span>
              <span className="text-sm font-semibold">{network?.currentDay ?? '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Participants</span>
              <span className="text-sm font-semibold">{network?.participantCount?.toLocaleString() ?? '--'}</span>
            </div>
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted mb-3">Your Balances</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Active Points</span>
              <span className="text-sm font-mono text-teal">{account ? displayPoints(account.balances.active) : '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Supportive Points</span>
              <span className="text-sm font-mono">{account ? displayPoints(account.balances.supportive) : '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Ambient Points</span>
              <span className="text-sm font-mono">{account ? displayPoints(account.balances.ambient) : '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Earned Points</span>
              <span className="text-sm font-mono text-gold">{account ? displayPoints(account.balances.earned) : '--'}</span>
            </div>
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted mb-3">Miner Info</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Miner ID</span>
              <span className="text-xs font-mono">{minerStatus?.miner?.id?.slice(0, 12) ?? '--'}...</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">Registered</span>
              <span className="text-sm">{minerStatus?.miner?.registered_at ? new Date(minerStatus.miner.registered_at).toLocaleDateString() : '--'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted">% Human</span>
              <span className="text-sm font-semibold">{account?.percentHuman ?? 0}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Activity - Empty State */}
      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-muted mb-4">Recent Verification Activity</h3>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg className="w-12 h-12 text-muted/20 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
          <p className="text-sm text-muted mb-1">No verification activity yet</p>
          <p className="text-xs text-muted/60 max-w-sm">
            When you verify accounts, your activity will appear here. Head to the Verify tab to start reviewing submissions.
          </p>
        </div>
      </div>
    </div>
  );
}
