const PRECISION = 100_000_000;

export function displayPoints(raw: string | bigint | number): string {
  const n = typeof raw === 'string' ? Number(raw) : Number(raw);
  const display = n / PRECISION;
  if (display >= 1_000_000) return (display / 1_000_000).toFixed(2) + 'M';
  if (display >= 1_000) return display.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return display.toFixed(2);
}

const PRECISION_BIG = BigInt(PRECISION);
const DECIMALS = 8;

/**
 * Exact, machine-readable rendering of a base-unit balance as points.
 *
 * Distinct from displayPoints, which is for HUMANS and is lossy on purpose: it
 * abbreviates ("1.23M"), inserts thousands separators, and rounds to two
 * decimals. Feeding that back into an input box is how the MAX button used to
 * produce amounts you could not send — above a million points it emitted
 * "1.23M", which Number() reads as NaN and toBaseUnits rejects outright, and
 * below that it rounded, which could round UP past the balance and come back
 * as "insufficient balance" on a button whose entire promise is "all of it".
 *
 * This one truncates rather than rounds (you can never end up asking for more
 * than you hold), emits no separators or suffixes, and does the arithmetic in
 * bigint so balances above 2^53 base units stay exact.
 */
export function baseUnitsToExactDisplay(raw: string | bigint): string {
  const units = typeof raw === 'bigint' ? raw : BigInt(raw || '0');
  if (units <= 0n) return '0';
  const whole = units / PRECISION_BIG;
  const frac = units % PRECISION_BIG;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Convert a display amount (points, may be fractional) into the canonical
 * base-unit integer string (10^8 per point) that the protocol signs and stores.
 * This is the single place the wallet turns a user-entered amount into money;
 * it matches the server's base-unit contract (see the transaction route).
 *
 * Plain decimal strings are parsed digit by digit in bigint rather than through
 * a float. `Math.round(n * 1e8)` is exact only while `n * 1e8` stays under
 * 2^53, i.e. about 90 million points — beyond that it silently rounds someone's
 * balance. Digits past 8 decimal places are truncated, never rounded up, so a
 * conversion can never produce more money than the user typed.
 */
export function toBaseUnits(displayAmount: string | number): string {
  const asText = typeof displayAmount === 'string' ? displayAmount.trim() : String(displayAmount);

  // Plain decimal: exact bigint path. Anything else (exponential notation from
  // String(1e-7), stray characters) falls through to the numeric path below,
  // which validates and rejects.
  const m = /^(\d+)(?:\.(\d*))?$/.exec(asText);
  if (m) {
    const whole = BigInt(m[1]);
    const fracDigits = (m[2] ?? '').slice(0, DECIMALS).padEnd(DECIMALS, '0');
    return (whole * PRECISION_BIG + BigInt(fracDigits)).toString();
  }

  const n = typeof displayAmount === 'string' ? Number(displayAmount) : displayAmount;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid amount: ${displayAmount}`);
  }
  return BigInt(Math.round(n * PRECISION)).toString();
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
