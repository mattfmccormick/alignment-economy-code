import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { displayPoints, truncateId } from '../lib/formatting';
import type { TransactionData } from '../lib/types';

/**
 * Detail for a single transaction.
 *
 * The activity list showed only "Sent / Received", a relative time and an
 * amount, and was not clickable. Everything below already came back from the
 * API and was thrown away — counterparty, exact time, memo, fee, and the
 * difference between what left the sender and what actually arrived.
 *
 * That last part is the reason this screen matters. Under the percentHuman
 * discount the amount debited is NOT the amount delivered: an unverified
 * sender's points are burned in proportion to their score. Showing one number
 * makes the gap invisible, and "I sent 100 and they got 60" is exactly the
 * question a person needs answered.
 */
export function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const wallet = loadWallet();

  const [tx, setTx] = useState<TransactionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet?.accountId || !id) return;
    let cancelled = false;
    // There is no GET /transactions/:id, so find it in the account's list.
    // Paged at a generous limit rather than adding an endpoint for one screen.
    api
      .getTransactions(wallet.accountId, 1, 200)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message ?? 'Could not load that transaction.');
          return;
        }
        const found = res.data.transactions.find((t) => t.id === id);
        if (!found) {
          setError('That transaction is not in your recent history.');
          return;
        }
        setTx(found);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Network error.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.accountId, id]);

  if (loading) {
    return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  }

  if (error || !tx) {
    return (
      <div className="p-4 space-y-3">
        <button onClick={() => navigate(-1)} className="text-xs text-teal">
          ← Back
        </button>
        <p className="text-sm text-red-400">{error ?? 'Transaction not found.'}</p>
      </div>
    );
  }

  const outgoing = tx.from === wallet?.accountId;
  const counterparty = outgoing ? tx.to : tx.from;

  // What the sender paid, versus what the recipient actually received. The
  // shortfall is fee plus the percentHuman burn, and it is only meaningful on
  // an outgoing transaction — a recipient never sees the sender's burn.
  const amount = BigInt(tx.amount);
  const fee = BigInt(tx.fee);
  const net = BigInt(tx.netAmount);
  const burned = amount - fee - net;

  const when = new Date(tx.timestamp * 1000);

  return (
    <div className="p-4 space-y-4">
      <button onClick={() => navigate(-1)} className="text-xs text-teal">
        ← Back
      </button>

      <div className="text-center py-2">
        <p className={`text-3xl tabular-nums ${outgoing ? 'text-red-400' : 'text-teal'}`}>
          {outgoing ? '−' : '+'}
          {displayPoints(outgoing ? tx.amount : tx.netAmount)}
        </p>
        <p className="text-xs text-gray-400 mt-1">
          {outgoing ? 'sent' : 'received'} · {tx.pointType} points
        </p>
      </div>

      <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
        <Row label={outgoing ? 'To' : 'From'} value={truncateId(counterparty)} mono />
        <Row
          label="When"
          value={when.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        />
        {tx.memo && <Row label="Memo" value={tx.memo} />}
        <Row
          label="Status"
          value={tx.blockNumber === null ? 'Pending' : `Settled in block ${tx.blockNumber.toLocaleString()}`}
        />
        {tx.recipientIsHuman && <Row label="Human attestation" value="Sender confirmed a real person" />}
        {tx.isInPerson && <Row label="In person" value="Both parties signed" />}
      </div>

      {/* The money breakdown, outgoing only. A recipient's "what did I get" is
          already the headline number above; showing them someone else's fee and
          burn would be noise. */}
      {outgoing && (
        <div className="bg-navy rounded-xl border border-navy-light p-3 space-y-2">
          <p className="text-xs text-gray-400">Where it went</p>
          <Line label="You paid" value={displayPoints(tx.amount)} />
          <Line label="Network fee" value={`−${displayPoints(tx.fee)}`} dim />
          {burned > 0n && (
            <Line
              label="Burned (your verification score)"
              value={`−${displayPoints(burned.toString())}`}
              dim
            />
          )}
          <div className="pt-2 border-t border-navy-light">
            <Line label="They received" value={displayPoints(tx.netAmount)} strong />
          </div>
          {burned > 0n && (
            <p className="text-[11px] text-gray-500 pt-1 leading-relaxed">
              Raising your verification score means more of what you send actually
              arrives.
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] text-gray-600 font-mono break-all">{tx.id}</p>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between p-3 gap-3">
      <span className="text-xs text-gray-400 shrink-0">{label}</span>
      <span className={`text-sm text-white text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function Line({
  label,
  value,
  dim,
  strong,
}: {
  label: string;
  value: string;
  dim?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-xs ${dim ? 'text-gray-500' : 'text-gray-400'}`}>{label}</span>
      <span
        className={`text-sm tabular-nums ${
          strong ? 'text-white font-medium' : dim ? 'text-gray-500' : 'text-white'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
