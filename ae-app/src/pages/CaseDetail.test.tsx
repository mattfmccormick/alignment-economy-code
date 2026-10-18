import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CaseDetail } from './CaseDetail';
import { api } from '../lib/api';
import { caseProgress } from '../lib/courtSteps';
import type { CaseArgumentData, CourtCaseData } from '../lib/types';

// The defendant's court page: who says what, a tracker of the six steps where
// any step can be opened to see what it looks like, the evidence against them,
// and a response that can carry files and an offer to meet.

vi.mock('../lib/keys', () => ({
  loadWallet: () => ({ accountId: 'defendant-account-0000000000000000000000', privateKey: 'priv', publicKey: 'pub' }),
}));
vi.mock('../lib/crypto', () => ({ signPayload: () => 'test-signature' }));
vi.mock('../lib/hash', () => ({ hashFileSHA256: vi.fn(async () => 'b'.repeat(64)) }));
vi.mock('../lib/websocket', () => ({ wsClient: { on: vi.fn(() => () => {}) } }));
vi.mock('../lib/api', () => ({
  api: {
    getCase: vi.fn(),
    submitCaseArgument: vi.fn(),
    demandTrial: vi.fn(),
    appealCase: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const CHALLENGER = 'challenger-account-00000000000000000000000';
const DEFENDANT = 'defendant-account-0000000000000000000000';

const baseCase: CourtCaseData = {
  id: 'case-1',
  type: 'not_human',
  level: 'arbitration',
  challengerId: CHALLENGER,
  defendantId: DEFENDANT,
  challengerStake: '500000000000',
  challengerStakePercent: 5,
  status: 'arbitration_open',
  arbitrationDeadline: Math.floor(Date.now() / 1000) + 6 * 86400,
  votingDeadline: 0,
  verdict: null,
  appealOf: null,
  createdAt: Math.floor(Date.now() / 1000) - 3600,
  resolvedAt: null,
};

const evidence: CaseArgumentData = {
  id: 'a1',
  caseId: 'case-1',
  submitterId: CHALLENGER,
  role: 'challenger',
  text: 'The selfie is a stock photo.',
  attachmentHash: null,
  attachments: [{ name: 'reverse-image-search.png', hash: 'c'.repeat(64) }],
  offers: [],
  createdAt: 1,
};

function renderCase() {
  return render(
    <MemoryRouter initialEntries={['/court/case-1']}>
      <Routes>
        <Route path="/court/:id" element={<CaseDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('caseProgress', () => {
  it('maps every status to a step', () => {
    expect(caseProgress('arbitration_open')).toEqual({ current: 'respond', endedEarly: null });
    expect(caseProgress('court_waiting_jury').current).toBe('jury');
    expect(caseProgress('court_voting').current).toBe('vote');
    expect(caseProgress('verdict_pending').current).toBe('verdict');
    expect(caseProgress('court_verdict').current).toBe('final');
    expect(caseProgress('withdrawn')).toEqual({ current: 'respond', endedEarly: 'withdrawn' });
    expect(caseProgress('dismissed')).toEqual({ current: 'jury', endedEarly: 'dismissed' });
  });
});

describe('CaseDetail (defendant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getCase.mockResolvedValue({
      success: true,
      data: { case: baseCase, jury: [], votesRevealed: false, arguments: [evidence] },
    });
  });
  afterEach(() => cleanup());

  it('shows full account ids and the evidence against you with its files', async () => {
    renderCase();
    expect(await screen.findByText(CHALLENGER)).toBeTruthy();
    expect(screen.getByText(DEFENDANT)).toBeTruthy();
    expect(screen.getByText('Evidence against you')).toBeTruthy();
    expect(screen.getByText(/reverse-image-search\.png/)).toBeTruthy();
    expect(screen.getByText('You are here')).toBeTruthy();
    expect(screen.getByText('Tell your side')).toBeTruthy();
  });

  it('opens a later step as an example when tapped', async () => {
    renderCase();
    fireEvent.click(await screen.findByRole('button', { name: 'Step 4: The jury votes' }));
    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(screen.getByText(/Example\. This is what this step looks like/)).toBeTruthy();
    expect(screen.getByText(/2 of 3 jurors have voted/)).toBeTruthy();
  });

  it('posts a response with a file and an offer to meet', async () => {
    mockApi.submitCaseArgument.mockResolvedValue({ success: true, data: { argument: evidence } });
    renderCase();
    await screen.findByText('Post your response');

    fireEvent.change(screen.getByPlaceholderText(/Tell your side/), { target: { value: 'That selfie is me.' } });
    const file = new File(['bytes'], 'my-selfie.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } });
    await screen.findByText('Ready');
    fireEvent.click(screen.getByRole('button', { name: 'I can meet in person' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post response' }));

    await waitFor(() => expect(mockApi.submitCaseArgument).toHaveBeenCalledTimes(1));
    const [caseId, body] = mockApi.submitCaseArgument.mock.calls[0] as [string, { payload: unknown }];
    expect(caseId).toBe('case-1');
    expect(body.payload).toEqual({
      text: 'That selfie is me.',
      attachments: [{ name: 'my-selfie.jpg', hash: 'b'.repeat(64) }],
      offers: ['in_person'],
    });
  });

  it('shows the error and keeps the draft when the post is rejected', async () => {
    mockApi.submitCaseArgument.mockResolvedValue({
      success: false,
      data: {} as never,
      error: { code: 'CASE_NOT_OPEN', message: 'Case is no longer open for arguments' },
    });
    renderCase();
    await screen.findByText('Post your response');
    fireEvent.change(screen.getByPlaceholderText(/Tell your side/), { target: { value: 'Too late?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post response' }));

    expect(await screen.findByText('Case is no longer open for arguments')).toBeTruthy();
    expect((screen.getByPlaceholderText(/Tell your side/) as HTMLTextAreaElement).value).toBe('Too late?');
  });
});
