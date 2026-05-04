import { displayPoints } from '../../lib/formatting';

interface Props {
  earnedBalance: string;
  lockedBalance: string;
}

export function BalanceCard({ earnedBalance, lockedBalance }: Props) {
  return (
    <div className="bg-navy rounded-xl p-4 mx-4 border border-navy-light">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-2xl font-serif text-white tabular-nums">
            {displayPoints(earnedBalance)}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">earned points</p>
        </div>
        {BigInt(lockedBalance) > 0n && (
          <div className="text-right">
            <p className="text-sm text-gray-300 tabular-nums">{displayPoints(lockedBalance)}</p>
            <p className="text-xs text-gray-500">locked</p>
          </div>
        )}
      </div>
    </div>
  );
}
