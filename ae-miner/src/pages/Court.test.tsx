import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import Court from './Court';
import { api } from '../lib/api';
import type { CaseHeader } from '../lib/api';

// Filing a challenge stakes the miner's own Earned points on the claim that an
// account isn't a real human. This flow test guards the request: the app must
// send the defendant id, case type, stake percentage, and (when provided) the
// opening argument, signed as the challenger — and surface a rejected filing
// instead of silently swallowing it.

vi.mock('../lib/keys', () => ({
  loadMinerWallet: () => ({ accountId: 'me', privateKey: 'priv', publicKey: 'pub' }),
}));

vi.mock('../lib/crypto', () => ({ signPayload: () => 'sig' }));
vi.mock('../lib/websocket', () => ({ wsClient: { on: vi.fn(() => () => {}) } }));

vi.mock('../lib/api', () => ({
  api: {
    getJuryDuty: vi.fn(),
    getActiveCases: vi.fn(),
    fileChallenge: vi.fn(),
    submitVote: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const fakeCase: CaseHeader = {
  id: 'case1', type: 'not_human', level: 'arbitration', status: 'arbitration_open',
  challengerId: 'me', defendantId: 'acc_bad', challengerStake: '100', challengerStakePercent: 5,
  verdict: null, appealOf: null, arbitrationDeadline: 0, votingDeadline: null,
  createdAt: 0, resolvedAt: null,
};

async function openFileTabAndFill(defendant: string, argument: string) {
  // Data loads on mount; wait for the tab bar, then switch to File Challenge.
  fireEvent.click(await screen.findByRole('button', { name: 'File Challenge' }));
  fireEvent.change(screen.getByPlaceholderText('acc_...'), { target: { value: defendant } });
  fireEvent.change(screen.getByPlaceholderText(/Lay out your evidence/), {
    target: { value: argument },
  });
}

describe('Court file-challenge flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getJuryDuty.mockResolvedValue({ success: true, data: { assignments: [] } });
    mockApi.getActiveCases.mockResolvedValue({ success: true, data: { cases: [] } });
  });

  afterEach(() => cleanup());

  it('files with the defendant, case type, stake percent, and opening argument', async () => {
    mockApi.fileChallenge.mockResolvedValue({ success: true, data: { case: fakeCase } });

    render(<Court />);
    await openFileTabAndFill('acc_bad', 'clearly a bot: posts every 3 seconds, 24/7');
    fireEvent.click(screen.getByRole('button', { name: /File Challenge with 5% Stake/ }));

    await waitFor(() => expect(mockApi.fileChallenge).toHaveBeenCalledTimes(1));

    expect(mockApi.fileChallenge.mock.calls[0][0]).toMatchObject({
      accountId: 'me',
      signature: 'sig',
      payload: {
        defendantAccountId: 'acc_bad',
        caseType: 'not_human',
        stakePercent: 5,
        openingArgument: 'clearly a bot: posts every 3 seconds, 24/7',
      },
    });
  });

  it('surfaces the error when a filing is rejected', async () => {
    mockApi.fileChallenge.mockResolvedValue({
      success: false,
      data: { case: fakeCase },
      error: { code: 'SELF_CHALLENGE', message: 'You cannot challenge your own account' },
    });

    render(<Court />);
    await openFileTabAndFill('acc_bad', 'suspicious');
    fireEvent.click(screen.getByRole('button', { name: /File Challenge with 5% Stake/ }));

    expect(await screen.findByText('You cannot challenge your own account')).toBeTruthy();
  });
});
