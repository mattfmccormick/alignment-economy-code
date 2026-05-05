import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { client } from '../sdk';
import type { Transaction } from '@alignmenteconomy/sdk';
import { SDKError } from '@alignmenteconomy/sdk';
import { Loading, ErrorBox } from '../components/Loading';
import { formatTimestamp, pointsDisplay, truncateId } from '../lib/format';

export function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const [tx, setTx] = useState<Transaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!id) return;
      try {
        const t = await client.getTransaction(id);
        if (!active) return;
        setTx(t);
      } catch (e) {
        if (!active) return;
        if (e instanceof SDKError && e.httpStatus === 404) {
          setError(`No transaction found with id ${truncateId(id, 8, 8)}. The id may be wrong, or the transaction may live on a different network.`);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    load();
    return () => { active = false; };
  }, [id]);

  if (error) return <ErrorBox message={error} />;
  if (!tx) return <Loading what="loading transaction" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif">Transaction</h1>
        <div className="text-sm text-slate-400 mt-1 font-mono">{tx.id}</div>
      </div>

      <Field label="From" value={tx.from} mono link={`/account/${tx.from}`} />
      <Field label="To" value={tx.to} mono link={`/account/${tx.to}`} />
      <Field label="Amount" value={`${pointsDisplay(tx.amount)} ${tx.pointType}`} />
      <Field label="Fee" value={pointsDisplay(tx.fee)} />
      <Field label="Net amount (delivered to recipient)" value={pointsDisplay(tx.netAmount)} />
      <Field label="In-person" value={tx.isInPerson ? 'yes (dual-signed)' : 'no'} />
      {tx.memo && <Field label="Memo" value={tx.memo} />}
      <Field label="Signature" value={truncateId(tx.signature, 16, 16)} mono />
      {tx.receiverSignature && <Field label="Receiver countersignature" value={truncateId(tx.receiverSignature, 16, 16)} mono />}
      <Field label="Timestamp" value={formatTimestamp(tx.timestamp)} />
      {tx.blockNumber !== null && <Field label="Block" value={`#${tx.blockNumber}`} link={`/block/${tx.blockNumber}`} />}
    </div>
  );
}

function Field({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: string }) {
  const cls = `text-sm ${mono ? 'font-mono' : ''} text-slate-200 break-all`;
  const inner = link ? <Link to={link} className={`${cls} text-teal-400 hover:text-teal-300`}>{value}</Link> : <div className={cls}>{value}</div>;
  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-md p-3">
      <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{label}</div>
      {inner}
    </div>
  );
}
