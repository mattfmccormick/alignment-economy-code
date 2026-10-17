import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { displayPoints, pointTypeLabel, truncateId } from '../lib/formatting';
import type { BlockContents, BlockOperation } from '../lib/types';

// Plain-language names for every operation a block can carry. Anything the
// node adds later still shows, under its raw type, rather than disappearing.
const OPERATION_LABELS: Record<string, string> = {
  account_register: 'New account',
  vouch_create: 'Vouch',
  vouch_withdraw: 'Vouch taken back',
  miner_register: 'Miner joined',
  miner_deregister: 'Miner left',
  panel_create: 'Asked miners to verify',
  panel_score: 'Miner set a score',
  product_register: 'Product registered',
  space_register: 'Space registered',
  supportive_tag_submit: 'Products tagged',
  ambient_tag_submit: 'Spaces tagged',
};

function operationLabel(op: BlockOperation): string {
  if (op.kind === 'validator') return op.type === 'deregister' ? 'Validator left' : 'Validator joined';
  return OPERATION_LABELS[op.type] ?? op.type;
}

/**
 * One block, opened from the Network screen: when it was made, its hash and
 * the hash it builds on, then everything it carried. Transfers open the full
 * transaction; every other operation is named with the account that signed it.
 */
export function BlockDetail() {
  const { number } = useParams<{ number: string }>();
  const [block, setBlock] = useState<BlockContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chain head, only to decide whether a "next block" exists yet.
  const [head, setHead] = useState<number | null>(null);

  useEffect(() => {
    api.getNetworkStatus().then((r) => { if (r.success) setHead(r.data.blockHeight); }).catch(() => {});
  }, [number]);

  useEffect(() => {
    let active = true;
    setBlock(null);
    setError(null);
    api
      .getBlockContents(Number(number))
      .then((r) => {
        if (!active) return;
        if (r.success) setBlock(r.data);
        else setError(r.error?.message ?? 'Could not load that block.');
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Network error.'); });
    return () => { active = false; };
  }, [number]);

  if (error) return <div className="p-4 text-sm text-red-400">{error}</div>;
  if (!block) return <div className="p-4 text-sm text-gray-400">Loading block…</div>;

  const when = new Date(block.timestamp * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  const empty = block.transactions.length === 0 && block.operations.length === 0;

  return (
    <div className="p-4 space-y-4">
      <div>
        <h2 className="text-xl font-serif text-white tabular-nums">Block {block.number.toLocaleString()}</h2>
        <p className="text-xs text-gray-500 mt-0.5">{when} · Day {block.day}</p>
      </div>

      <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
        <Field label="Hash" value={block.hash} />
        <Field
          label="Builds on"
          value={block.previousHash}
          to={block.number > 0 ? `/block/${block.number - 1}` : undefined}
        />
        {block.stateRoot && <Field label="State root" value={block.stateRoot} />}
      </div>

      {empty && (
        <p className="text-xs text-gray-500 text-center py-2">
          Nothing in this block. The chain keeps making blocks on schedule even when no one sends anything.
        </p>
      )}

      {block.transactions.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            Transactions ({block.transactions.length})
          </h3>
          <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
            {block.transactions.map((tx) => (
              <Link
                key={tx.id}
                to={`/tx/${tx.id}`}
                className="flex items-center gap-3 p-3 hover:bg-navy-light/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-300 font-mono truncate">
                    {truncateId(tx.from, 6)} → {truncateId(tx.to, 6)}
                  </p>
                  <p className="text-[11px] text-gray-500">{pointTypeLabel(tx.pointType)} points</p>
                </div>
                <span className="text-sm text-white tabular-nums shrink-0">{displayPoints(tx.amount)}</span>
                <span className="text-gray-500 text-sm">›</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {block.operations.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            Other activity ({block.operations.length})
          </h3>
          <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
            {block.operations.map((op, i) => (
              <div key={`${op.kind}-${i}`} className="flex items-center justify-between gap-3 p-3">
                <span className="text-sm text-white">{operationLabel(op)}</span>
                {op.accountId && (
                  <span className="text-[11px] text-gray-500 font-mono">{truncateId(op.accountId, 6)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center text-sm pt-1">
        {block.number > 0 && (
          <Link to={`/block/${block.number - 1}`} className="text-teal hover:text-teal-dark">
            ‹ Block {(block.number - 1).toLocaleString()}
          </Link>
        )}
        <span className="flex-1" />
        {head !== null && block.number < head && (
          <Link to={`/block/${block.number + 1}`} className="text-teal hover:text-teal-dark">
            Block {(block.number + 1).toLocaleString()} ›
          </Link>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, to }: { label: string; value: string; to?: string }) {
  return (
    <div className="p-3">
      <p className="text-[11px] text-gray-500 mb-0.5">{label}</p>
      {to ? (
        <Link to={to} className="text-xs text-teal font-mono break-all hover:text-teal-dark">
          {value}
        </Link>
      ) : (
        <p className="text-xs text-white font-mono break-all">{value}</p>
      )}
    </div>
  );
}
