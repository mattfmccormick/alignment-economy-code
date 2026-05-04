import { useState, useEffect } from 'react';
import { api, type Account } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { displayPoints } from '../lib/formatting';

export default function Income() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const wallet = loadMinerWallet();
    if (!wallet) return;

    async function fetchData() {
      try {
        const res = await api.getAccount(wallet!.accountId);
        if (res.success) {
          setAccount(res.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load income data');
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
          Loading income data...
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

  return (
    <div className="space-y-6">
      {/* Balance summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-panel border border-border rounded-lg p-5">
          <div className="text-xs text-muted mb-1">Earned Balance</div>
          <div className="text-2xl font-bold text-gold">
            {account ? displayPoints(account.balances.earned) : '0'}
          </div>
          <div className="text-xs text-muted mt-1">saveable points</div>
        </div>
        <div className="bg-panel border border-border rounded-lg p-5">
          <div className="text-xs text-muted mb-1">Active Balance</div>
          <div className="text-2xl font-bold">
            {account ? displayPoints(account.balances.active) : '0'}
          </div>
          <div className="text-xs text-muted mt-1">daily allocation (expires)</div>
        </div>
        <div className="bg-panel border border-border rounded-lg p-5">
          <div className="text-xs text-muted mb-1">Locked Balance</div>
          <div className="text-2xl font-bold text-teal">
            {account ? displayPoints(account.balances.locked) : '0'}
          </div>
          <div className="text-xs text-muted mt-1">staked in vouches/challenges</div>
        </div>
        <div className="bg-panel border border-border rounded-lg p-5">
          <div className="text-xs text-muted mb-1">% Human Score</div>
          <div className="text-2xl font-bold">{account?.percentHuman ?? 0}%</div>
          <div className="text-xs text-muted mt-1">determines daily allocation</div>
        </div>
      </div>

      {/* Income breakdown - empty state */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted mb-4">Income History</h3>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg className="w-12 h-12 text-muted/15 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
            </svg>
            <p className="text-sm text-muted mb-1">No income data yet</p>
            <p className="text-xs text-muted/60 max-w-sm">
              Income from verifications, court service, and fee pool distributions will appear here as you participate in the network.
            </p>
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted mb-4">Income Sources</h3>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg className="w-10 h-10 text-muted/15 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z" />
            </svg>
            <p className="text-xs text-muted">No sources yet</p>
          </div>
        </div>
      </div>

      {/* How miners earn */}
      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-muted mb-4">How Miners Earn Points</h3>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              </div>
              <h4 className="text-sm font-semibold">Verification Fees</h4>
            </div>
            <p className="text-xs text-muted">
              When a participant submits identity evidence, the verification fee is split among the miners who review it. Higher accuracy = larger share.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-gold/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0012 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 01-2.031.352 5.989 5.989 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 01-2.031.352 5.989 5.989 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971z" />
                </svg>
              </div>
              <h4 className="text-sm font-semibold">Court Rewards</h4>
            </div>
            <p className="text-xs text-muted">
              Serving as a juror and voting with the consensus earns you a share of the dispute bounty. Filing successful challenges earns a bounty from the fraudulent account's stake.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-muted/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M18.75 4.236c.982.143 1.954.317 2.916.52A6.003 6.003 0 0016.27 9.728M18.75 4.236V4.5c0 2.108-.966 3.99-2.48 5.228m0 0a6.023 6.023 0 01-7.54 0" />
                </svg>
              </div>
              <h4 className="text-sm font-semibold">Fee Pool Lottery</h4>
            </div>
            <p className="text-xs text-muted">
              Each epoch, a portion of the fee pool is distributed via lottery to active miners. Tier 2 validators get more entries than Tier 1 nodes.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
