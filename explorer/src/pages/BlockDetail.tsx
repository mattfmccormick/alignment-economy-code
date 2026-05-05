import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { client } from '../sdk';
import type { Block } from '@alignmenteconomy/sdk';
import { Loading, ErrorBox } from '../components/Loading';
import { formatTimestamp, truncateId } from '../lib/format';

export function BlockDetail() {
  const { number } = useParams<{ number: string }>();
  const [block, setBlock] = useState<Block | null>(null);
  const [siblings, setSiblings] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        // No GET /blocks/:n endpoint exists yet on ae-node. Fall back to
        // fetching the page that contains the requested block, then
        // pluck it out. limit=100 covers any block within the most
        // recent 100; older blocks will need a paginated walk.
        const r = await client.getBlocks({ limit: 100 });
        if (!active) return;
        const target = (r.blocks ?? []).find((b) => String(b.number) === number);
        if (!target) {
          setError(`Block ${number} not in the latest 100. Older blocks need a different lookup (TODO: ae-node /blocks/:n endpoint).`);
          return;
        }
        setBlock(target);
        setSiblings(r.blocks ?? []);
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

  const prev = siblings.find((b) => b.number === block.number - 1);
  const next = siblings.find((b) => b.number === block.number + 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif">Block {block.number}</h1>
        <div className="text-sm text-slate-400 mt-1">{formatTimestamp(block.timestamp)} — Day {block.day}</div>
      </div>

      <Field label="Hash" value={block.hash} mono />
      <Field label="Parent hash" value={block.parentHash} mono link={prev ? `/block/${prev.number}` : undefined} />
      <Field label="Authority" value={block.authorityNodeId} mono />
      <Field label="Authority signature" value={truncateId(block.authoritySignature ?? '', 12, 12)} mono />

      <div className="flex gap-3 pt-4 border-t border-slate-800 text-sm">
        {prev && <Link to={`/block/${prev.number}`} className="text-teal-400 hover:text-teal-300">← Block {prev.number}</Link>}
        <span className="flex-1" />
        {next && <Link to={`/block/${next.number}`} className="text-teal-400 hover:text-teal-300">Block {next.number} →</Link>}
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
