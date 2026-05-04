interface TierBadgeProps {
  tier: 1 | 2;
  compact?: boolean;
}

const tierConfig = {
  1: {
    label: 'TIER 1 NODE',
    color: 'text-muted',
    bg: 'bg-muted/10',
    border: 'border-muted/30',
    requirements: [
      { label: 'Running node software', met: true },
      { label: 'Staked 1,000+ points', met: true },
      { label: '24h minimum uptime', met: true },
    ],
  },
  2: {
    label: 'TIER 2 VALIDATOR',
    color: 'text-teal',
    bg: 'bg-teal/10',
    border: 'border-teal/30',
    requirements: [
      { label: 'Running node software', met: true },
      { label: 'Staked 10,000+ points', met: true },
      { label: '99%+ uptime (30d)', met: true },
      { label: '95%+ accuracy score', met: true },
      { label: 'Completed 100+ verifications', met: true },
      { label: 'Community vouched (5+)', met: false },
    ],
  },
};

export default function TierBadge({ tier, compact }: TierBadgeProps) {
  const config = tierConfig[tier];

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-bold tracking-wider ${config.bg} ${config.color} border ${config.border}`}>
        <span className={`w-2 h-2 rounded-full ${tier === 2 ? 'bg-teal' : 'bg-muted'}`} />
        {config.label}
      </span>
    );
  }

  return (
    <div className={`rounded-lg border ${config.border} ${config.bg} p-4`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-3 h-3 rounded-full ${tier === 2 ? 'bg-teal' : 'bg-muted'}`} />
        <span className={`text-sm font-bold tracking-wider ${config.color}`}>
          {config.label}
        </span>
      </div>
      <div className="space-y-2">
        {config.requirements.map((req, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            {req.met ? (
              <svg className="w-3.5 h-3.5 text-teal flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 text-muted/50 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <circle cx="12" cy="12" r="9" />
              </svg>
            )}
            <span className={req.met ? 'text-muted' : 'text-muted/50'}>
              {req.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
