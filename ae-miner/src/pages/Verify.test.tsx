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

vi.mock('../lib/crypto', () => ({
  signPayload: () => 'sig',
  // The score now rides the chain as a signed panel_score op. The mock echoes
  // the score so the test can assert the op carried the value the miner set.
  signPanelScore: (accountId: string, panelId: string, score: number) => ({
    type: 'panel_score',
    accountId,
    panelId,
    score,
    timestamp: 0,
    signature: 'opsig',
  }),
}));
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

// The panel deliberately ships with NO pre-filled score. It used to default to
// 80, which let a miner seat a panel and submit a passing grade in one click
// without forming a judgement — on a proof-of-human network, the screen that
// decides whether a stranger is real should not arrive with the answer already
// typed in. This helper therefore chooses a score explicitly, exactly as a real
// miner now has to.
async function openPanelAndScore(score: number) {
  // Data loads on mount; the queue row is a button labelled with the applicant.
  fireEvent.click(await screen.findByRole('button', { name: /applicant-xyz/ }));
  // openPanel() fetches detail; the score control appears once it resolves.
  const slider = await screen.findByRole('slider');
  fireEvent.change(slider, { target: { value: String(score) } });
  return screen.findByRole('button', { name: new RegExp(`Submit ${score}% human score`) });
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

  it('submits the score the miner chose, signed as the miner', async () => {
    mockApi.submitPanelScore.mockResolvedValue({
      success: true,
      data: { status: 'pending', reviewId: 'r1' },
    });

    render(<Verify />);
    const submitBtn = await openPanelAndScore(65);
    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockApi.submitPanelScore).toHaveBeenCalledTimes(1));

    const [panelId, envelope] = mockApi.submitPanelScore.mock.calls[0];
    expect(panelId).toBe('panel-1');
    expect(envelope).toMatchObject({
      accountId: 'miner-me',
      signature: 'sig',
      // The signed panel_score op carries exactly the score the miner set —
      // there is no default. The op, not a bare { score }, is what rides now.
      payload: { op: { type: 'panel_score', panelId: 'panel-1', score: 65 } },
    });
  });

  it('surfaces the error when the score submission is rejected', async () => {
    mockApi.submitPanelScore.mockResolvedValue({
      success: false,
      data: { status: 'error', reviewId: '' },
      error: { code: 'OP_NOT_APPLICABLE', message: 'panel already complete' },
    });

    render(<Verify />);
    const submitBtn = await openPanelAndScore(65);
    fireEvent.click(submitBtn);

    expect(await screen.findByText('panel already complete')).toBeTruthy();
  });
});

// Guard against re-introducing a pre-filled verdict.
//
// The panel used to arrive with the score set to 80 and the submit button live,
// so a miner could accept a stranger as human in a single click having looked
// at nothing. That is the core screen of a proof-of-human network rewarding
// rubber-stamping, and it is the sort of "convenience" that creeps back in.
describe('Verify panel arrives with no answer pre-filled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getAssignedPanels.mockResolvedValue({
      success: true,
      data: { minerRegistered: true, assignments: [assignment] },
    });
    mockApi.getPanel.mockResolvedValue({ success: true, data: panelDetail });
  });

  afterEach(() => cleanup());

  it('cannot be submitted until the miner sets a score', async () => {
    render(<Verify />);
    fireEvent.click(await screen.findByRole('button', { name: /applicant-xyz/ }));

    const prompt = await screen.findByRole('button', { name: /Move the slider to set a score/ });
    expect((prompt as HTMLButtonElement).disabled).toBe(true);

    // No submit-with-a-number button exists yet, because no number was chosen.
    expect(screen.queryByRole('button', { name: /Submit \d+% human score/ })).toBeNull();

    fireEvent.click(prompt);
    expect(mockApi.submitPanelScore).not.toHaveBeenCalled();
  });

  it('enables submission once a score is chosen', async () => {
    render(<Verify />);
    fireEvent.click(await screen.findByRole('button', { name: /applicant-xyz/ }));
    fireEvent.change(await screen.findByRole('slider'), { target: { value: '30' } });

    const submit = await screen.findByRole('button', { name: /Submit 30% human score/ });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});
