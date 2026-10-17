import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { displayPoints, pointTypeLabel } from '../lib/formatting';
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
  const wallet = loadWallet();

  const [tx, setTx] = useState<TransactionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // Straight from the chain by id, so this opens any transaction: your own
    // from the activity list, or anyone's from a block on the Network screen.
    api
      .getTransaction(id)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message ?? 'Could not load that transaction.');
          return;
        }
        setTx(res.data);
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
  }, [id]);

  if (loading) {
    return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  }

  if (error || !tx) {
    return (
      <div className="p-4 space-y-3">
        <p className="text-sm text-red-400">{error ?? 'Transaction not found.'}</p>
      </div>
    );
  }

  const outgoing = tx.from === wallet?.accountId;
  const incoming = !outgoing && tx.to === wallet?.accountId;
  // Opened from a block: a transfer between two other people.
  const thirdParty = !outgoing && !incoming;

  // What the sender paid, versus what the recipient actually received. The
  // shortfall is fee plus the percentHuman burn. A recipient never sees the
  // sender's burn, so the breakdown shows for the sender and for anyone
  // reading the chain, not for the person who received it.
  const amount = BigInt(tx.amount);
  const fee = BigInt(tx.fee);
  const net = BigInt(tx.netAmount);
  const burned = amount - fee - net;

  const when = new Date(tx.timestamp * 1000);

  return (
    <div className="p-4 space-y-4">
      <div className="text-center py-2">
        <p
          className={`text-3xl tabular-nums ${
            outgoing ? 'text-red-400' : incoming ? 'text-teal' : 'text-white'
          }`}
        >
          {outgoing ? '−' : incoming ? '+' : ''}
          {displayPoints(incoming ? tx.netAmount : tx.amount)}
        </p>
        <p className="text-xs text-gray-400 mt-1">
          {outgoing ? 'sent' : incoming ? 'received' : 'transfer'} · {pointTypeLabel(tx.pointType)} points
        </p>
      </div>

      <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
        {!incoming && <Row label="To" value={tx.to} mono />}
        {!outgoing && <Row label="From" value={tx.from} mono />}
        <Row
          label="When"
          value={when.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        />
        {tx.memo && <Row label="Memo" value={tx.memo} />}
        {tx.blockNumber === null ? (
          <Row label="Status" value="Pending" />
        ) : (
          <div className="flex items-center justify-between p-3 gap-3">
            <span className="text-xs text-gray-400 shrink-0">Status</span>
            <Link to={`/block/${tx.blockNumber}`} className="text-sm text-teal hover:text-teal-dark text-right">
              Settled in block {tx.blockNumber.toLocaleString()} ›
            </Link>
          </div>
        )}
        {tx.recipientIsHuman && <Row label="Human attestation" value="Sender confirmed a real person" />}
        {tx.isInPerson && <Row label="In person" value="Both parties signed" />}
      </div>

      {/* The money breakdown. Not for the recipient: their "what did I get" is
          already the headline number above, and someone else's fee and burn
          would be noise. */}
      {!incoming && (
        <div className="bg-navy rounded-xl border border-navy-light p-3 space-y-2">
          <p className="text-xs text-gray-400">Where it went</p>
          <Line label={thirdParty ? 'Sender paid' : 'You paid'} value={displayPoints(tx.amount)} />
          <Line label="Network fee" value={`−${displayPoints(tx.fee)}`} dim />
          {burned > 0n && (
            <Line
              label={thirdParty ? "Burned (sender's verification score)" : 'Burned (your verification score)'}
              value={`−${displayPoints(burned.toString())}`}
              dim
            />
          )}
          <div className="pt-2 border-t border-navy-light">
            <Line label={thirdParty ? 'Recipient received' : 'They received'} value={displayPoints(tx.netAmount)} strong />
          </div>
          {burned > 0n && !thirdParty && (
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
      <span className={`text-white text-right ${mono ? 'font-mono text-xs break-all' : 'text-sm'}`}>{value}</span>
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
