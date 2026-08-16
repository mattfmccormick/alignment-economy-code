import { describe, it, expect } from 'vitest';
import {
  displayPoints,
  toBaseUnits,
  baseUnitsToExactDisplay,
  displayPercent,
  truncateId,
  countdown,
} from './formatting';

describe('toBaseUnits', () => {
  it('scales whole points to base units (10^8)', () => {
    expect(toBaseUnits(1)).toBe('100000000');
    expect(toBaseUnits(100)).toBe('10000000000');
    expect(toBaseUnits('50')).toBe('5000000000');
  });

  it('handles fractional points to 8 decimals', () => {
    expect(toBaseUnits(0.5)).toBe('50000000');
    expect(toBaseUnits(1.23456789)).toBe('123456789');
  });

  it('rejects negative, NaN, and infinite amounts', () => {
    expect(() => toBaseUnits(-1)).toThrow();
    expect(() => toBaseUnits(NaN)).toThrow();
    expect(() => toBaseUnits(Infinity)).toThrow();
    expect(() => toBaseUnits('abc')).toThrow();
  });
});

describe('displayPoints', () => {
  it('renders base units back as display points', () => {
    expect(displayPoints('100000000')).toBe('1.00');
    expect(displayPoints('5000000000')).toBe('50.00');
  });

  it('abbreviates thousands and millions', () => {
    expect(displayPoints(toBaseUnits(2500))).toBe('2,500');
    expect(displayPoints(toBaseUnits(3_000_000))).toBe('3.00M');
  });

  it('round-trips a whole-point amount through toBaseUnits', () => {
    // The wallet's write (toBaseUnits) and read (displayPoints) agree.
    for (const pts of [1, 42, 999]) {
      expect(displayPoints(toBaseUnits(pts))).toBe(pts.toFixed(2));
    }
  });
});

// The MAX button used to feed displayPoints back into the amount field.
// displayPoints is the HUMAN formatter and is lossy on purpose, so MAX could
// produce an amount that was either unparseable or larger than the balance —
// on the one button whose whole promise is "all of it".
describe('baseUnitsToExactDisplay (what MAX puts in the box)', () => {
  it('never abbreviates, so large balances stay parseable', () => {
    const big = toBaseUnits(3_000_000);
    expect(displayPoints(big)).toBe('3.00M');           // fine for a human
    expect(() => toBaseUnits(displayPoints(big))).toThrow(); // unusable as input
    expect(baseUnitsToExactDisplay(big)).toBe('3000000');
    expect(toBaseUnits(baseUnitsToExactDisplay(big))).toBe(big);
  });

  it('never inserts thousands separators', () => {
    const raw = toBaseUnits(2500);
    expect(displayPoints(raw)).toBe('2,500');
    expect(baseUnitsToExactDisplay(raw)).toBe('2500');
  });

  it('truncates rather than rounds, so MAX can never exceed the balance', () => {
    // 12.999999999 points. Rounding to 2dp gives "13.00", which is MORE than
    // the account holds and comes back as insufficient balance.
    const raw = '1299999999';
    expect(displayPoints(raw)).toBe('13.00');
    expect(BigInt(toBaseUnits(baseUnitsToExactDisplay(raw)))).toBeLessThanOrEqual(BigInt(raw));
  });

  it('round-trips exactly for a spread of balances', () => {
    for (const raw of ['0', '1', '100000000', '1299999999', '5000000000', '300000000000000']) {
      expect(toBaseUnits(baseUnitsToExactDisplay(raw))).toBe(BigInt(raw).toString());
    }
  });

  it('stays exact above 2^53 base units', () => {
    // Beyond ~90 million points, Math.round(n * 1e8) silently loses precision.
    // Both directions must stay in bigint.
    const raw = '9007199254740993'; // 2^53 + 1
    expect(toBaseUnits(baseUnitsToExactDisplay(raw))).toBe(raw);
  });

  it('handles zero and negatives without emitting junk', () => {
    expect(baseUnitsToExactDisplay('0')).toBe('0');
    expect(baseUnitsToExactDisplay(-5n)).toBe('0');
  });
});

describe('displayPercent', () => {
  it('uses more precision for smaller shares', () => {
    expect(displayPercent(5)).toBe('5.00%');
    expect(displayPercent(0.05)).toBe('0.0500%');
    expect(displayPercent(0.0005)).toBe('0.000500%');
  });
});

describe('truncateId', () => {
  it('leaves short ids untouched and abbreviates long ones', () => {
    expect(truncateId('short')).toBe('short');
    const long = 'a'.repeat(40);
    const out = truncateId(long, 8);
    expect(out).toBe('aaaaaaaa...aaaaaaaa');
    expect(out).toContain('...');
  });
});

describe('countdown', () => {
  it('formats hours/minutes and expiry', () => {
    expect(countdown(0)).toBe('Expired');
    expect(countdown(90)).toBe('1m');
    expect(countdown(3720)).toBe('1h 2m');
  });
});
