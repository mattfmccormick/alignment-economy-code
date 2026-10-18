import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CaseDetail from './CaseDetail';
import { api, type CaseArgument, type CaseHeader, type JurorRow } from '../lib/api';

// The miner's court page: the wallet's case page from the challenger's and the
// juror's seats. A juror votes from the Vote step with both sides in view; a
// challenger can withdraw from the Respond step; any step can be opened ahead.

const ME = 'miner-me-000000000000000000000000000000000';
const OTHER = 'challenger-0000000000000000000000000000000';
const DEFENDANT = 'defendant-00000000000000000000000000000000';

let me = ME;
vi.mock('../lib/keys', () => ({
  loadMinerWallet: () => ({ accountId: me, privateKey: 'priv', publicKey: 'pub' }),
}));
vi.mock('../lib/crypto', () => ({ signPayload: () => 'sig' }));
vi.mock('../lib/hash', () => ({ hashFileSHA256: vi.fn(async () => 'b'.repeat(64)) }));
vi.mock('../lib/websocket', () => ({ wsClient: { on: vi.fn(() => () => {}) } }));
vi.mock('../lib/api', () => ({
  api: {
    getCase: vi.fn(),
    submitVote: vi.fn(),
    withdrawCase: vi.fn(),
    appealCase: vi.fn(),
    submitCaseArgument: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

function header(over: Partial<CaseHeader>): CaseHeader {
  return {
    id: 'case-1', type: 'not_human', level: 'court', status: 'court_voting',
    challengerId: OTHER, defendantId: DEFENDANT, challengerStake: '500000000000', challengerStakePercent: 5,
    verdict: null, appealOf: null, arbitrationDeadline: 0, votingDeadline: Math.floor(Date.now() / 1000) + 5 * 86400,
    createdAt: 0, resolvedAt: null,
    ...over,
  };
}

const evidence: CaseArgument = {
  id: 'a1', caseId: 'case-1', submitterId: OTHER, role: 'challenger', text: 'Stock photo selfie.',
  attachmentHash: null, attachments: [{ name: 'search.png', hash: 'c'.repeat(64) }], offers: [], createdAt: 1,
};

const jurors: JurorRow[] = [
  { minerId: 'm1', jurorAccountId: ME, stakeAmount: '17800000000', vote: null, votedAt: null },
  { minerId: 'm2', jurorAccountId: 'juror-2', stakeAmount: '17800000000', vote: 'sealed', votedAt: 1 },
  { minerId: 'm3', jurorAccountId: 'juror-3', stakeAmount: '17800000000', vote: null, votedAt: null },
];

function renderCase() {
  return render(
    <MemoryRouter initialEntries={['/court/case-1']}>
      <Routes>
        <Route path="/court/:id" element={<CaseDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CaseDetail (miner)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    me = ME;
  });
  afterEach(() => cleanup());

  it('lets a juror vote from the Vote step, with the evidence in view', async () => {
    mockApi.getCase.mockResolvedValue({
      success: true,
      data: { case: header({}), jury: jurors, votesRevealed: false, arguments: [evidence] },
    });
    mockApi.submitVote.mockResolvedValue({ success: true, data: { recorded: true, verdict: null } });
    renderCase();

    expect(await screen.findByText("You're on the jury")).toBeTruthy();
    expect(screen.getByText('Your vote')).toBeTruthy();
    expect(screen.getByText(/search\.png/)).toBeTruthy();
    expect(screen.getByText(OTHER)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Not human' }));
    await waitFor(() => expect(mockApi.submitVote).toHaveBeenCalledTimes(1));
    expect(mockApi.submitVote.mock.calls[0][0]).toBe('case-1');
    expect((mockApi.submitVote.mock.calls[0][1] as { payload: unknown }).payload).toEqual({ vote: 'not_human' });
  });

  it('shows the error when a vote is rejected', async () => {
    mockApi.getCase.mockResolvedValue({
      success: true,
      data: { case: header({}), jury: jurors, votesRevealed: false, arguments: [] },
    });
    mockApi.submitVote.mockResolvedValue({
      success: false,
      data: { recorded: false, verdict: null },
      error: { code: 'NOT_VOTING', message: 'Case is not in voting' },
    });
    renderCase();
    fireEvent.click(await screen.findByRole('button', { name: 'Human' }));
    expect(await screen.findByText('Case is not in voting')).toBeTruthy();
  });

  it('lets the challenger withdraw during arbitration and preview later steps', async () => {
    me = OTHER;
    mockApi.getCase.mockResolvedValue({
      success: true,
      data: {
        case: header({ status: 'arbitration_open', level: 'arbitration', challengerStake: '144000000000' }),
        jury: [],
        votesRevealed: false,
        arguments: [evidence],
      },
    });
    mockApi.withdrawCase.mockResolvedValue({ success: true, data: { case: header({ status: 'withdrawn' }) } });
    renderCase();

    expect(await screen.findByText('You filed this')).toBeTruthy();
    expect(screen.getByText(/the 1,440 minimum/)).toBeTruthy();
    expect(screen.getByText('Your evidence')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Step 6: Case settled' }));
    expect(screen.getByText(/You lose your 1,440 points/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Step 2: The defendant answers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw the case' }));
    await waitFor(() => expect(mockApi.withdrawCase).toHaveBeenCalledTimes(1));
  });
});
