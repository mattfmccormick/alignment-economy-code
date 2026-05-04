const PRECISION = 100_000_000;

export function displayPoints(raw: string | bigint | number): string {
  const n = typeof raw === 'string' ? Number(raw) : Number(raw);
  const display = n / PRECISION;
  if (display >= 1_000_000) return (display / 1_000_000).toFixed(2) + 'M';
  if (display >= 1_000) return display.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return display.toFixed(2);
}

export function displayPercent(share: number): string {
  if (share >= 1) return share.toFixed(2) + '%';
  if (share >= 0.01) return share.toFixed(4) + '%';
  return share.toFixed(6) + '%';
}

export function truncateId(id: string, chars: number = 8): string {
  if (id.length <= chars * 2 + 3) return id;
  return id.slice(0, chars) + '...' + id.slice(-chars);
}

export function countdown(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function timeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
