import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { client } from '../sdk';
import type { Block } from '@alignmenteconomy/sdk';
import { Loading, ErrorBox } from '../components/Loading';
import { formatTimestamp, truncateId } from '../lib/format';

export function BlockDetail() {
  const { number } = useParams<{ number: string }>();
  const [block, setBlock] = useState<Block | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBlock(null);
    setError(null);
    async function load() {
      try {
        // Direct lookup by height via the SDK (GET /network/blocks/:number),
        // so any block resolves, not just the latest page.
        const b = await client.getBlock(Number(number));
        if (!active) return;
        setBlock(b);
        // Head height is a best-effort hint for the "next block" link only;
        // a failure here must not block rendering the block itself.
        try {
          const status = await client.getNetworkStatus();
          if (active) setHead(status.blockHeight);
        } catch { /* nav hint only */ }
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => { active = false; };
  }, [number]);

  if (error) return <ErrorBox message={error} />;
  if (!block) return <Loading what={`loading block ${number}`} />;

  const prevNum = block.number - 1;
  const nextNum = block.number + 1;
  const showPrev = prevNum >= 0;
  const showNext = head !== null && nextNum <= head;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif">Block {block.number}</h1>
        <div className="text-sm text-slate-400 mt-1">{formatTimestamp(block.timestamp)} · Day {block.day}</div>
      </div>

      <Field label="Hash" value={block.hash} mono />
      <Field label="Parent hash" value={block.parentHash} mono link={showPrev ? `/block/${prevNum}` : undefined} />
      <Field label="Authority" value={block.authorityNodeId} mono />
      <Field label="Authority signature" value={truncateId(block.authoritySignature ?? '', 12, 12)} mono />

      <div className="flex gap-3 pt-4 border-t border-slate-800 text-sm">
        {showPrev && <Link to={`/block/${prevNum}`} className="text-teal-400 hover:text-teal-300">← Block {prevNum}</Link>}
        <span className="flex-1" />
        {showNext && <Link to={`/block/${nextNum}`} className="text-teal-400 hover:text-teal-300">Block {nextNum} →</Link>}
      </div>
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
