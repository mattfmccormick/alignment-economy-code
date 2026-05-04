import { displayPercent } from '../../lib/formatting';

interface Props {
  percentOfEconomy: number;
  participantCount: number;
}

export function ShareDisplay({ percentOfEconomy, participantCount }: Props) {
  return (
    <div className="text-center py-8">
      <p className="text-5xl font-serif text-gold tabular-nums tracking-tight">
        {displayPercent(percentOfEconomy)}
      </p>
      <p className="text-sm text-gray-400 mt-2">
        of {participantCount.toLocaleString()} participants
      </p>
    </div>
  );
}
