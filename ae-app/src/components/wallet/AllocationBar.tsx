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
  const spent = totalNum - remainingNum;
  const percent = totalNum > 0 ? (spent / totalNum) * 100 : 0;

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-400 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-navy-light rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-500`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <span className="text-xs text-gray-300 tabular-nums w-24 text-right shrink-0">
        {displayPoints(String(spent))} / {displayPoints(total)}
      </span>
    </div>
  );
}
