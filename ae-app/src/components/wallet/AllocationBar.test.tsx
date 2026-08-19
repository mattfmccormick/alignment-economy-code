// The daily-allocation row must show what you have LEFT.
//
// It rendered `total - remaining`, so a full untouched allocation displayed
// "0.00 / 1,440" next to an empty bar. A real tester read that as "I have no
// points" and did not attempt a send they had ample balance for. The heading
// is "Daily Allocations" beside an "Expires in Nh" countdown, so the figure has
// to be the balance about to expire.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AllocationBar } from './AllocationBar';

const FULL_ACTIVE = String(144_000_000_000); // 1,440.00 at 8 decimals

describe('AllocationBar', () => {
  afterEach(() => cleanup());

  it('shows the full amount when nothing has been spent', () => {
    render(<AllocationBar label="Active" total={FULL_ACTIVE} remaining={FULL_ACTIVE} />);
    // Not "0.00 / 1,440" — that was the bug.
    expect(screen.getByText('1,440 / 1,440')).toBeTruthy();
  });

  it('shows zero only when the allocation is actually spent', () => {
    render(<AllocationBar label="Active" total={FULL_ACTIVE} remaining="0" />);
    expect(screen.getByText('0.00 / 1,440')).toBeTruthy();
  });

  it('shows the remainder after a partial spend', () => {
    // Spent a quarter, so three quarters remain.
    render(<AllocationBar label="Active" total={FULL_ACTIVE} remaining={String(108_000_000_000)} />);
    expect(screen.getByText('1,080 / 1,440')).toBeTruthy();
  });

  it('fills the bar in proportion to what is left, not what is gone', () => {
    const { container } = render(
      <AllocationBar label="Active" total={FULL_ACTIVE} remaining={FULL_ACTIVE} />,
    );
    const fill = container.querySelector('.bg-teal') as HTMLElement;
    // A full allocation draws a full bar. Previously this was width: 0%.
    expect(fill.style.width).toBe('100%');
  });
});
