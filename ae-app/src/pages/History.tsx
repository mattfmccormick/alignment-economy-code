import { useEffect, useState } from 'react';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { displayPoints, timeAgo } from '../lib/formatting';

export function History() {
  const wallet = loadWallet();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet?.accountId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTransactions(wallet.accountId, page, 20)
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setTransactions(r.data.transactions);
          setTotal(r.data.total);
        } else {
          setError('Could not load your transactions.');
        }
      })
      .catch(() => {
        if (!cancelled) setError("Can't reach the node. Check that it's running and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet?.accountId, page]);

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">Transaction History</h2>
      <p className="text-xs text-gray-500">{total} total transactions</p>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500 text-sm gap-2">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading transactions...
        </div>
      ) : error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-center">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : transactions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-12 h-12 text-gray-700 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-sm text-gray-400 mb-1">No transactions yet</p>
          <p className="text-xs text-gray-600 max-w-xs">Points you send and receive will show up here.</p>
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
