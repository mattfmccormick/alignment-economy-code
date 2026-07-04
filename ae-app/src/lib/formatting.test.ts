import { describe, it, expect } from 'vitest';
import { displayPoints, toBaseUnits, displayPercent, truncateId, countdown } from './formatting';

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
