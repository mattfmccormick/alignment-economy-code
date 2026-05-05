// Formatting helpers shared by every page. The SDK returns balances
// as base-10 strings of bigints in fixed-precision (PRECISION = 10^8);
// the explorer almost always wants the human-readable display number.

const PRECISION = 100_000_000n;

export function pointsDisplay(baseUnits: string | bigint, fractionDigits = 2): string {
  const bi = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits);
  const whole = bi / PRECISION;
  const frac = bi % PRECISION;
  // pad to 8 digits then trim to requested precision
  const fracStr = frac.toString().padStart(8, '0').slice(0, fractionDigits);
  return `${whole.toLocaleString()}.${fracStr}`;
}

export function truncateId(id: string, head = 8, tail = 6): string {
  if (id.length <= head + tail + 3) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function formatTimestamp(unixSec: number): string {
  if (!unixSec) return '';
  return new Date(unixSec * 1000).toLocaleString();
}
