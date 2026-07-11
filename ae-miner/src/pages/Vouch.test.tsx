import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import Vouch from './Vouch';
import { api } from '../lib/api';

// The vouch inbox is verification-critical: accepting a request must lock the
// stake FIRST (submitVouch), then mark the request accepted (updateVouchRequest)
// — never the reverse, or a failed stake would leave a stale "accepted" record
// with no points behind it. These flow tests guard that ordering and payload.

vi.mock('../lib/keys', () => ({
  loadMinerWallet: () => ({ accountId: 'me', privateKey: 'priv', publicKey: 'pub' }),
}));

vi.mock('../lib/crypto', () => ({
  signPayload: () => 'sig',
}));

vi.mock('../lib/api', () => ({
  api: {
    getAccount: vi.fn(),
    getVouches: vi.fn(),
    getVouchRequests: vi.fn(),
    submitVouch: vi.fn(),
    updateVouchRequest: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const fakeAccount = {
  id: 'me',
  type: 'individual',
  percentHuman: 100,
  activeBalance: '0', supportiveBalance: '0', ambientBalance: '0',
  earnedBalance: '1000000', lockedBalance: '0',
};

const incomingRequest = {
  id: 'req1',
  fromId: 'friend',
  toId: 'me',
  message: 'please vouch for me',
  status: 'pending' as const,
  createdAt: 1700000000,
  respondedAt: null,
};

describe('Vouch accept flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getAccount.mockResolvedValue({ success: true, data: fakeAccount });
    mockApi.getVouches.mockResolvedValue({ success: true, data: { received: [], given: [] } });
    mockApi.getVouchRequests.mockResolvedValue({
      success: true,
      data: { incoming: [incomingRequest], outgoing: [] },
    });
  });

  afterEach(() => cleanup());

  it('locks the stake before marking the request accepted', async () => {
    mockApi.submitVouch.mockResolvedValue({ success: true, data: {} });
    mockApi.updateVouchRequest.mockResolvedValue({ success: true, data: {} });

    render(<Vouch />);
    // Wait for the incoming request to render (data loads on mount).
    const acceptBtn = await screen.findByRole('button', { name: 'Accept' });
    fireEvent.click(acceptBtn);

    await waitFor(() => expect(mockApi.updateVouchRequest).toHaveBeenCalledTimes(1));

    // Stake locked with the default 5% policy minimum, vouching for the requester.
    expect(mockApi.submitVouch).toHaveBeenCalledTimes(1);
    expect(mockApi.submitVouch.mock.calls[0][0].payload).toEqual({
      vouchedId: 'friend',
      stakePercent: 5,
    });
    // And the request is only then marked accepted.
    expect(mockApi.updateVouchRequest.mock.calls[0][0]).toBe('req1');
    expect(mockApi.updateVouchRequest.mock.calls[0][1].payload).toEqual({ status: 'accepted' });

    // Ordering invariant: stake first, accept second.
    expect(mockApi.submitVouch.mock.invocationCallOrder[0])
      .toBeLessThan(mockApi.updateVouchRequest.mock.invocationCallOrder[0]);
  });

  it('does not mark the request accepted if the stake fails to lock', async () => {
    mockApi.submitVouch.mockResolvedValue({
      success: false,
      data: {},
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' },
    });

    render(<Vouch />);
    const acceptBtn = await screen.findByRole('button', { name: 'Accept' });
    fireEvent.click(acceptBtn);

    // The failure must surface and NOT leave a stale accepted record.
    expect(await screen.findByText('Insufficient balance')).toBeTruthy();
    expect(mockApi.updateVouchRequest).not.toHaveBeenCalled();
  });
});
