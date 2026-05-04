interface UptimeGaugeProps {
  percent: number;
  size?: number;
}

export default function UptimeGauge({ percent, size = 120 }: UptimeGaugeProps) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (percent / 100) * circumference;
  const center = size / 2;

  const color = percent >= 99 ? '#0D9488' : percent >= 95 ? '#D4A843' : '#EF4444';

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#2A3F6A"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={circumference - filled}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-2xl font-bold" style={{ color }}>
          {percent.toFixed(1)}%
        </span>
        <span className="text-xs text-muted">uptime</span>
      </div>
    </div>
  );
}
