import { displayPoints } from '../../lib/formatting';

interface Props {
  label: string;
  total: string;
  remaining: string;
  color?: string;
}

export function AllocationBar({ label, total, remaining, color = 'bg-teal' }: Props) {
  const totalNum = Number(total);
  const remainingNum = Number(remaining);

  // Show what is LEFT, not what has been spent.
  //
  // This rendered `total - remaining`, so someone holding their full untouched
  // daily allocation saw "0.00 / 1,440" beside an empty bar. Every reader takes
  // that to mean they have nothing. It is the exact opposite of the truth, and
  // it stopped a real tester from attempting a send they had ample balance for.
  //
  // The section is headed "Daily Allocations" next to an "Expires in 14h"
  // countdown, so the number beside it has to be the balance that is about to
  // expire — not the amount already gone.
  const percentLeft = totalNum > 0 ? (remainingNum / totalNum) * 100 : 0;

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-400 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-navy-light rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-500`}
          style={{ width: `${Math.min(Math.max(percentLeft, 0), 100)}%` }}
        />
      </div>
      <span className="text-xs text-gray-300 tabular-nums w-24 text-right shrink-0">
        {displayPoints(remaining)} / {displayPoints(total)}
      </span>
    </div>
  );
}
