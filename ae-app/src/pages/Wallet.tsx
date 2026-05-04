import { useEffect, useState } from 'react';
import { useAccount } from '../hooks/useAccount';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { ShareDisplay } from '../components/wallet/ShareDisplay';
import { BalanceCard } from '../components/wallet/BalanceCard';
import { AllocationBar } from '../components/wallet/AllocationBar';
import { displayPoints, timeAgo } from '../lib/formatting';

export function Wallet() {
  const wallet = loadWallet();
  const { account, loading, error } = useAccount(wallet?.accountId ?? null);
  const [network, setNetwork] = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);

  useEffect(() => {
    api.getNetworkStatus().then((r) => { if (r.success) setNetwork(r.data); });
    if (wallet?.accountId) {
      api.getTransactions(wallet.accountId, 1, 5).then((r) => {
        if (r.success) setTransactions(r.data.transactions);
      });
    }
  }, [wallet?.accountId]);

  if (!wallet) return null; // Should redirect to onboarding

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="p-4 text-center text-red-400">
        <p>{error || 'Failed to load account'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ShareDisplay
        percentOfEconomy={account.percentOfEconomy || 0}
        participantCount={network?.participantCount || 0}
      />

      <BalanceCard
        earnedBalance={account.earnedBalance}
        lockedBalance={account.lockedBalance}
      />

      <VerificationStatus percentHuman={account.percentHuman ?? 0} />

      <div className="bg-navy rounded-xl p-4 mx-4 border border-navy-light space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-300">Daily Allocations</h3>
          <span className="text-xs text-gray-500">Expires in 14h</span>
        </div>
        <AllocationBar label="Active" total={String(144_000_000_000)} remaining={account.activeBalance} />
        <AllocationBar label="Supportive" total={String(14_400_000_000)} remaining={account.supportiveBalance} />
        <AllocationBar label="Ambient" total={String(1_440_000_000)} remaining={account.ambientBalance} />
      </div>

      <div className="mx-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Recent Activity</h3>
          <a href="/history" className="text-xs text-teal hover:text-teal-dark">See all</a>
        </div>
        {transactions.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">No transactions yet</p>
        ) : (
          <div className="space-y-1">
            {transactions.map((tx: any) => (
              <div key={tx.id} className="bg-navy rounded-lg p-3 flex items-center justify-between border border-navy-light">
                <div>
                  <p className="text-sm text-white">
                    {tx.from === wallet.accountId ? 'Sent' : 'Received'}
                  </p>
                  <p className="text-xs text-gray-500">{timeAgo(tx.timestamp)}</p>
                </div>
                <p className={`text-sm tabular-nums ${tx.from === wallet.accountId ? 'text-red-400' : 'text-teal'}`}>
                  {tx.from === wallet.accountId ? '-' : '+'}{displayPoints(tx.amount)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VerificationStatus({ percentHuman }: { percentHuman: number }) {
  const multiplier = (percentHuman / 100).toFixed(2);
  const fullyVerified = percentHuman >= 100;
  const unverified = percentHuman === 0;

  if (fullyVerified) {
    return (
      <div className="mx-4 flex items-center justify-between bg-navy rounded-xl px-4 py-2 border border-teal/40">
        <span className="text-xs text-gray-400">Verification</span>
        <span className="text-sm text-teal">✓ 100% human · full spend</span>
      </div>
    );
  }

  if (unverified) {
    return (
      <a
        href="/verify"
        className="block mx-4 bg-red-500/10 rounded-xl p-4 border border-red-500/40 hover:border-red-500/70 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-red-300">Not verified yet</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Your daily mint accumulates, but spends transfer 0 until a miner verifies you.
            </p>
          </div>
          <span className="text-red-300 text-xl">→</span>
        </div>
      </a>
    );
  }

  return (
    <a
      href="/verify"
      className="block mx-4 bg-gold/10 rounded-xl p-4 border border-gold/40 hover:border-gold/70 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gold">{percentHuman}% verified</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Spend multiplier {multiplier}× — recipients get {percentHuman}% of what you send.
          </p>
        </div>
        <span className="text-gold text-xl">→</span>
      </div>
    </a>
  );
}
