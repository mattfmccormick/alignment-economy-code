import { useEffect, useState } from 'react';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { displayPoints, timeAgo } from '../lib/formatting';

export function History() {
  const wallet = loadWallet();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!wallet?.accountId) return;
    api.getTransactions(wallet.accountId, page, 20).then((r) => {
      if (r.success) {
        setTransactions(r.data.transactions);
        setTotal(r.data.total);
      }
    });
  }, [wallet?.accountId, page]);

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">Transaction History</h2>
      <p className="text-xs text-gray-500">{total} total transactions</p>

      <div className="space-y-2">
        {transactions.map((tx: any) => (
          <div key={tx.id} className="bg-navy rounded-lg p-3 border border-navy-light">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white">
                  {tx.from === wallet?.accountId ? 'Sent' : 'Received'}
                  <span className="text-gray-500 ml-1 text-xs">{tx.point_type}</span>
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{timeAgo(tx.timestamp)}</p>
              </div>
              <p className={`text-sm tabular-nums ${tx.from === wallet?.accountId ? 'text-red-400' : 'text-teal'}`}>
                {tx.from === wallet?.accountId ? '-' : '+'}{displayPoints(tx.amount)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {total > 20 && (
        <div className="flex justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="text-sm text-teal disabled:text-gray-600"
          >
            Previous
          </button>
          <span className="text-xs text-gray-400">Page {page}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page * 20 >= total}
            className="text-sm text-teal disabled:text-gray-600"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
