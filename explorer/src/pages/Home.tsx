import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../sdk';
import type { Block, NetworkStatus } from '@alignmenteconomy/sdk';
import { Loading, ErrorBox } from '../components/Loading';
import { formatTimestamp, pointsDisplay, truncateId } from '../lib/format';

export function Home() {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [s, b] = await Promise.all([
          client.getNetworkStatus(),
          client.getBlocks({ limit: 10 }),
        ]);
        if (!active) return;
        setStatus(s);
        setBlocks(b.blocks ?? []);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => { active = false; clearInterval(t); };
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!status) return <Loading what="loading network state" />;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-3">Network</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Day" value={status.currentDay.toString()} />
          <Stat label="Block height" value={status.blockHeight.toString()} />
          <Stat label="Participants" value={status.participantCount.toString()} />
          <Stat label="Active miners" value={status.minerCount.toString()} />
          <Stat label="Total earned pool" value={pointsDisplay(status.totalEarnedPool)} />
          <Stat label="Target total" value={pointsDisplay(status.targetTotal)} />
          <Stat label="Txs today" value={status.transactionsToday.toString()} />
          <Stat label="Fee pool" value={pointsDisplay(status.feePoolBalance)} />
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-3">Latest blocks</h2>
        <div className="bg-slate-900/40 border border-slate-800 rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-400 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">#</th>
                <th className="text-left px-4 py-2 font-medium">Time</th>
                <th className="text-left px-4 py-2 font-medium">Hash</th>
                <th className="text-left px-4 py-2 font-medium">Producer</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.number} className="border-t border-slate-800 hover:bg-slate-900/40">
                  <td className="px-4 py-2"><Link to={`/block/${b.number}`} className="text-teal-400 hover:text-teal-300 font-mono">{b.number}</Link></td>
                  <td className="px-4 py-2 text-slate-400">{formatTimestamp(b.timestamp)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{truncateId(b.hash)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{truncateId(b.authorityNodeId ?? '')}</td>
                </tr>
              ))}
              {blocks.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500 italic">No blocks yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-md p-3">
      <div className="text-[11px] text-slate-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-mono mt-1 text-slate-100 truncate">{value}</div>
    </div>
  );
}
