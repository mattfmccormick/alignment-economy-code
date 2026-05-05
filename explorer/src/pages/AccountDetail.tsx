import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { client } from '../sdk';
import type { Account, Transaction } from '@alignmenteconomy/sdk';
import { Loading, ErrorBox } from '../components/Loading';
import { formatTimestamp, pointsDisplay, truncateId } from '../lib/format';

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const [account, setAccount] = useState<Account | null>(null);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [a, t] = await Promise.all([
          client.getAccount(id!),
          client.getTransactions(id!, { limit: 50 }),
        ]);
        if (!active) return;
        setAccount(a);
        setTxs(t.transactions ?? []);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => { active = false; };
  }, [id]);

  if (error) return <ErrorBox message={error} />;
  if (!account) return <Loading what="loading account" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif">Account</h1>
        <div className="text-sm text-slate-400 mt-1 font-mono break-all">{account.id}</div>
        <div className="text-xs text-slate-500 mt-1">
          {account.type} · {account.percentHuman}% verified · joined day {account.joinedDay}
          {!account.isActive && <span className="text-red-400 ml-2">inactive</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Stat label="Earned" value={pointsDisplay(account.earnedBalance)} />
        <Stat label="Locked" value={pointsDisplay(account.lockedBalance)} />
        <Stat label="Active" value={pointsDisplay(account.activeBalance)} />
        <Stat label="Supportive" value={pointsDisplay(account.supportiveBalance)} />
        <Stat label="Ambient" value={pointsDisplay(account.ambientBalance)} />
        <Stat label="Total" value={pointsDisplay(
          (BigInt(account.earnedBalance) + BigInt(account.lockedBalance) + BigInt(account.activeBalance) + BigInt(account.supportiveBalance) + BigInt(account.ambientBalance)).toString(),
        )} />
      </div>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-3">Transactions ({txs.length})</h2>
        <div className="bg-slate-900/40 border border-slate-800 rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-400 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-3 py-2 font-medium">Direction</th>
                <th className="text-left px-3 py-2 font-medium">Counterparty</th>
                <th className="text-right px-3 py-2 font-medium">Amount</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((tx) => {
                const out = tx.from === account.id;
                const counter = out ? tx.to : tx.from;
                return (
                  <tr key={tx.id} className="border-t border-slate-800 hover:bg-slate-900/40">
                    <td className="px-3 py-2 text-slate-400 text-xs">{formatTimestamp(tx.timestamp)}</td>
                    <td className="px-3 py-2">
                      <span className={out ? 'text-orange-400' : 'text-teal-400'}>{out ? 'sent' : 'received'}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link to={`/account/${counter}`} className="hover:text-teal-300">{truncateId(counter)}</Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{pointsDisplay(tx.amount)}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{tx.pointType}{tx.isInPerson ? ' · in-person' : ''}</td>
                  </tr>
                );
              })}
              {txs.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500 italic">No transactions</td></tr>
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
      <div className="text-lg font-mono mt-1 text-slate-100">{value}</div>
    </div>
  );
}
