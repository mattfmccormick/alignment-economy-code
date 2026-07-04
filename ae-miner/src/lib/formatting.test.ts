import { describe, it, expect } from 'vitest';
import { displayPoints, displayPercent, truncateId, countdown, formatNumber } from './formatting';

describe('displayPoints', () => {
  it('renders base units (10^8) as display points', () => {
    expect(displayPoints('100000000')).toBe('1.00');
    expect(displayPoints('5000000000')).toBe('50.00');
  });

  it('abbreviates thousands and millions', () => {
    expect(displayPoints('250000000000')).toBe('2,500');
    expect(displayPoints('300000000000000')).toBe('3.00M');
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
    expect(truncateId('a'.repeat(40), 8)).toBe('aaaaaaaa...aaaaaaaa');
  });
});

describe('countdown', () => {
  it('formats hours/minutes and expiry', () => {
    expect(countdown(0)).toBe('Expired');
    expect(countdown(90)).toBe('1m');
    expect(countdown(3720)).toBe('1h 2m');
  });
});

describe('formatNumber', () => {
  it('abbreviates with K/M suffixes and formats small numbers plainly', () => {
    expect(formatNumber(500)).toBe('500');
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(2_300_000)).toBe('2.3M');
  });
});
