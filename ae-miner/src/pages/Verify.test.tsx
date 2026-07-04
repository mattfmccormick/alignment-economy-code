import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import Verify from './Verify';
import { api } from '../lib/api';
import type { PanelAssignment, PanelDetail } from '../lib/api';

// Submitting a %Human score is the miner's core action: it's the on-chain
// judgement that moves an applicant toward (or away from) full participation.
// This flow test guards that opening an assigned panel and submitting routes
// the score to the right panel, signed as the reviewing miner, and surfaces a
// rejected submission.

vi.mock('../lib/keys', () => ({
  loadMinerWallet: () => ({ accountId: 'miner-me', privateKey: 'priv', publicKey: 'pub' }),
}));

vi.mock('../lib/crypto', () => ({ signPayload: () => 'sig' }));
vi.mock('../lib/websocket', () => ({ wsClient: { on: vi.fn(() => () => {}) } }));

vi.mock('../lib/api', () => ({
  api: {
    getAssignedPanels: vi.fn(),
    getPanel: vi.fn(),
    submitPanelScore: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const assignment: PanelAssignment = {
  panelId: 'panel-1',
  applicantAccountId: 'applicant-xyz-0001',
  panelStatus: 'pending',
  panelCreatedAt: 0,
  panelCompletedAt: null,
  medianScore: null,
  assignedAt: 1700000000,
  deadline: 0,
  myReviewSubmitted: false,
  missed: false,
};

const panelDetail: PanelDetail = {
  panel: { id: 'panel-1', accountId: 'applicant-xyz-0001', status: 'pending', createdAt: 0, completedAt: null, medianScore: null },
  evidence: [],
  reviews: [],
  assignedMiners: [],
  liveScore: { totalScore: 0, breakdown: { tierA: 0, tierB: 0, tierC: 0 } },
};

async function openPanelAndReachSubmit() {
  // Data loads on mount; the queue row is a button labelled with the applicant.
  fireEvent.click(await screen.findByRole('button', { name: /applicant-xyz/ }));
  // openPanel() fetches detail; the submit button appears once it resolves.
  return screen.findByRole('button', { name: /Submit .* Human Score/ });
}

describe('Verify panel-score flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getAssignedPanels.mockResolvedValue({
      success: true,
      data: { minerRegistered: true, assignments: [assignment] },
    });
    mockApi.getPanel.mockResolvedValue({ success: true, data: panelDetail });
  });

  afterEach(() => cleanup());

  it('submits the default score to the opened panel, signed as the miner', async () => {
    mockApi.submitPanelScore.mockResolvedValue({
      success: true,
      data: { recorded: true, panelComplete: false, medianScore: null },
    });

    render(<Verify />);
    const submitBtn = await openPanelAndReachSubmit();
    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockApi.submitPanelScore).toHaveBeenCalledTimes(1));

    const [panelId, envelope] = mockApi.submitPanelScore.mock.calls[0];
    expect(panelId).toBe('panel-1');
    expect(envelope).toMatchObject({
      accountId: 'miner-me',
      signature: 'sig',
      payload: { score: 80 }, // the page's default proposed score
    });
  });

  it('surfaces the error when the score submission is rejected', async () => {
    mockApi.submitPanelScore.mockResolvedValue({
      success: false,
      data: { recorded: false, panelComplete: false, medianScore: null },
      error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this panel' },
    });

    render(<Verify />);
    const submitBtn = await openPanelAndReachSubmit();
    fireEvent.click(submitBtn);

    expect(await screen.findByText('You are not assigned to this panel')).toBeTruthy();
  });
});
