import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { displayPoints } from '../lib/formatting';

export function Network() {
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    api.getNetworkStatus().then((r) => { if (r.success) setStatus(r.data); });
  }, []);

  if (!status) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const stats = [
    { label: 'Day', value: status.currentDay },
    { label: 'Participants', value: status.participantCount },
    { label: 'Miners', value: status.minerCount },
    { label: 'Block Height', value: status.blockHeight },
    { label: 'Transactions Today', value: status.transactionsToday },
    { label: 'Total Earned Pool', value: displayPoints(status.totalEarnedPool) },
    { label: 'Fee Pool', value: displayPoints(status.feePoolBalance) },
  ];

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">Network Status</h2>

      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="bg-navy rounded-xl p-3 border border-navy-light">
            <p className="text-xs text-gray-500">{s.label}</p>
            <p className="text-lg text-white tabular-nums mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
