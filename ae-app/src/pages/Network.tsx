import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { displayPoints, timeAgo, truncateId } from '../lib/formatting';
import type { BlockSummary, NetworkStatus } from '../lib/types';

// Blocks land every ~10 seconds, so refresh on about that beat while the
// screen is open. Without it the "latest" list is stale the moment you read it.
const REFRESH_MS = 10_000;

export function Network() {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [blocks, setBlocks] = useState<BlockSummary[]>([]);

  useEffect(() => {
    let active = true;
    const load = () => {
      api.getNetworkStatus().then((r) => { if (active && r.success) setStatus(r.data); });
      api.getBlocks(20).then((r) => { if (active && r.success) setBlocks(r.data.blocks); });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { active = false; clearInterval(t); };
  }, []);

  if (!status) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const stats: Array<{ label: string; value: string | number; to?: string }> = [
    { label: 'Day', value: status.currentDay },
    { label: 'Participants', value: status.participantCount },
    { label: 'Miners', value: status.minerCount },
    { label: 'Block Height', value: status.blockHeight, to: `/block/${status.blockHeight}` },
    { label: 'Transactions Today', value: status.transactionsToday },
    { label: 'Total Earned Pool', value: displayPoints(status.totalEarnedPool) },
    { label: 'Fee Pool', value: displayPoints(status.feePoolBalance) },
  ];

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">Network Status</h2>

      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => {
          const body = (
            <>
              <p className="text-xs text-gray-500">{s.label}</p>
              <p className="text-lg text-white tabular-nums mt-0.5">{s.value}</p>
            </>
          );
          return s.to ? (
            <Link
              key={s.label}
              to={s.to}
              className="bg-navy rounded-xl p-3 border border-navy-light hover:border-teal transition-colors"
            >
              {body}
            </Link>
          ) : (
            <div key={s.label} className="bg-navy rounded-xl p-3 border border-navy-light">
              {body}
            </div>
          );
        })}
      </div>

      {/* The chain itself. Every block is tappable, and inside each one every
          transfer and every other operation it carried is listed, down to the
          single transaction. */}
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">Latest blocks</h3>
        {blocks.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">No blocks yet</p>
        ) : (
          <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
            {blocks.map((b) => (
              <Link
                key={b.number}
                to={`/block/${b.number}`}
                className="flex items-center gap-3 p-3 hover:bg-navy-light/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white tabular-nums">Block {b.number.toLocaleString()}</p>
                  <p className="text-[11px] text-gray-500 font-mono truncate">{truncateId(b.hash, 10)}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-xs ${b.transaction_count > 0 ? 'text-teal' : 'text-gray-500'}`}>
                    {b.transaction_count} {b.transaction_count === 1 ? 'transaction' : 'transactions'}
                  </p>
                  <p className="text-[11px] text-gray-500">{timeAgo(b.timestamp)}</p>
                </div>
                <span className="text-gray-500 text-sm">›</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
