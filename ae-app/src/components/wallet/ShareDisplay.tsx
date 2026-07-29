import { useNavigate } from 'react-router-dom';
import { displayPercent } from '../../lib/formatting';

interface Props {
  percentOfEconomy: number;
  participantCount: number;
}

export function ShareDisplay({ percentOfEconomy, participantCount }: Props) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/share')}
      className="w-full text-center py-8 group focus:outline-none"
      aria-label="View how your share of the economy has changed over time"
    >
      <p className="text-5xl font-serif text-gold tabular-nums tracking-tight group-hover:opacity-90 transition-opacity">
        {displayPercent(percentOfEconomy)}
      </p>
      <p className="text-sm text-gray-400 mt-2">
        of {participantCount.toLocaleString()} participants
      </p>
      <p className="text-[11px] text-teal mt-2 opacity-80 group-hover:opacity-100">
        View history →
      </p>
    </button>
  );
}
