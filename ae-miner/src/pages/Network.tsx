import { useState, useEffect } from 'react';
import { api, type NetworkStatus, type NodeStatus } from '../lib/api';

export default function Network() {
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchData() {
      try {
        const [networkRes, statusRes] = await Promise.allSettled([
          api.getNetworkStatus(),
          api.nodeStatus(),
        ]);

        if (networkRes.status === 'fulfilled' && networkRes.value.success) {
          setNetwork(networkRes.value.data);
        }
        if (statusRes.status === 'fulfilled') {
          setNodeStatus(statusRes.value);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load network data');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 15000);
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
          Loading network data...
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

  const stats = [
    {
      label: 'Block Height',
      value: network?.blockHeight?.toLocaleString() ?? nodeStatus?.chain?.blockHeight?.toLocaleString() ?? '--',
    },
    {
      label: 'Current Day',
      value: network?.currentDay?.toString() ?? nodeStatus?.chain?.currentDay?.toString() ?? '--',
    },
    {
      label: 'Participants',
      value: network?.participantCount?.toLocaleString() ?? '--',
    },
    {
      label: 'Active Miners',
      value: network?.activeMinerCount?.toLocaleString() ?? '--',
    },
    {
      label: 'Total Miners',
      value: network?.totalMiners?.toLocaleString() ?? '--',
    },
    {
      label: 'Fee Pool',
      value: network?.feePool ?? '--',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-6 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-panel border border-border rounded-lg p-4">
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1">{s.label}</div>
            <div className="text-xl font-bold">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Node status */}
      {nodeStatus && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-panel border border-border rounded-lg p-5">
            <h3 className="text-sm font-medium text-muted mb-4">Node Health</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Cycle Phase</span>
                <span className={`text-sm font-medium px-2 py-0.5 rounded ${
                  nodeStatus.cycle?.phase === 'active' ? 'bg-teal/10 text-teal' :
                  nodeStatus.cycle?.phase === 'between_cycles' ? 'bg-gold/10 text-gold' :
                  'bg-muted/10 text-muted'
                }`}>
                  {nodeStatus.cycle?.phase || 'unknown'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Last Cycle</span>
                <span className="text-sm font-mono">
                  {nodeStatus.cycle?.lastCycleAt
                    ? new Date(nodeStatus.cycle.lastCycleAt).toLocaleString()
                    : '--'
                  }
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Memory (RSS)</span>
                <span className="text-sm font-mono">
                  {nodeStatus.memory ? `${Math.round(nodeStatus.memory.rss / 1024 / 1024)} MB` : '--'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Heap Used</span>
                <span className="text-sm font-mono">
                  {nodeStatus.memory ? `${Math.round(nodeStatus.memory.heapUsed / 1024 / 1024)} MB` : '--'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-panel border border-border rounded-lg p-5">
            <h3 className="text-sm font-medium text-muted mb-4">Chain Info</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Block Height</span>
                <span className="text-sm font-mono font-semibold">
                  #{nodeStatus.chain?.blockHeight?.toLocaleString() ?? '--'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Current Day</span>
                <span className="text-sm font-semibold">{nodeStatus.chain?.currentDay ?? '--'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted">Heap Total</span>
                <span className="text-sm font-mono">
                  {nodeStatus.memory ? `${Math.round(nodeStatus.memory.heapTotal / 1024 / 1024)} MB` : '--'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Miner Leaderboard - empty state */}
      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-muted mb-4">Miner Leaderboard</h3>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg className="w-12 h-12 text-muted/15 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
          </svg>
          <p className="text-sm text-muted mb-1">Leaderboard not available yet</p>
          <p className="text-xs text-muted/60 max-w-sm">
            As more miners join and the network grows, a leaderboard ranking miners by accuracy, uptime, and verification count will appear here.
          </p>
        </div>
      </div>
    </div>
  );
}
