interface IncomeCardProps {
  activeBalance: string;
  earnedBalance: string;
  lockedBalance: string;
  percentHuman: number;
}

export default function IncomeCard({ activeBalance, earnedBalance, lockedBalance, percentHuman }: IncomeCardProps) {
  return (
    <div className="bg-panel border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-muted">Balances</h3>
        <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>

      <div className="text-3xl font-bold text-gold mb-1">
        {earnedBalance}
      </div>
      <div className="text-xs text-muted mb-4">earned (saveable)</div>

      <div className="grid grid-cols-3 gap-3 pt-3 border-t border-border">
        <div>
          <div className="text-xs text-muted mb-0.5">Active</div>
          <div className="text-sm font-semibold text-teal">{activeBalance}</div>
        </div>
        <div>
          <div className="text-xs text-muted mb-0.5">Locked</div>
          <div className="text-sm font-semibold text-gold-dim">{lockedBalance}</div>
        </div>
        <div>
          <div className="text-xs text-muted mb-0.5">% Human</div>
          <div className="text-sm font-semibold">{percentHuman}%</div>
        </div>
      </div>
    </div>
  );
}
