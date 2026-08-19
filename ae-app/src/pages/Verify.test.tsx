import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Verify } from './Verify';
import { api } from '../lib/api';
import type { ScoreBreakdownData } from '../lib/types';

// The Verify page lets a participant ask a friend to vouch for their humanity.
// This flow test guards the request path: the app must POST the recipient's
// account id and the message the user typed (signed as the requester), and it
// must surface a rejected request instead of showing a false "sent".

vi.mock('../lib/keys', () => ({
  loadWallet: () => ({ accountId: 'me', privateKey: 'priv', publicKey: 'pub' }),
}));

vi.mock('../hooks/useAccount', () => ({
  useAccount: () => ({
    account: {
      percentHuman: 0,
      activeBalance: '0',
      // Non-zero so the stake preview and the server-side minimum are
      // exercised: a vouch stakes a percentage of total holdings.
      earnedBalance: '100000000000',
      lockedBalance: '0',
      isEscrowed: false,
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

vi.mock('../lib/crypto', () => ({ signPayload: () => 'test-signature' }));
vi.mock('../lib/hash', () => ({ hashFileSHA256: vi.fn() }));
vi.mock('../lib/websocket', () => ({ wsClient: { on: vi.fn(() => () => {}) } }));

vi.mock('../lib/api', () => ({
  api: {
    getAccountPanels: vi.fn(),
    getVouches: vi.fn(),
    getVouchRequests: vi.fn(),
    getEvidenceScore: vi.fn(),
    createVouchRequest: vi.fn(),
    createVouch: vi.fn(),
    updateVouchRequest: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const emptyScore: ScoreBreakdownData = {
  totalScore: 0,
  breakdown: { tierA: 0, tierB: 0, tierC: 0 },
  evidenceDetails: [],
  decayApplied: false,
  nextDecayDate: null,
};

function openRequestModalAndFill(toId: string, message: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Request Vouch from Friends' }));
  fireEvent.change(screen.getByPlaceholderText('Paste their account ID'), {
    target: { value: toId },
  });
  fireEvent.change(screen.getByPlaceholderText('Hey, can you vouch for me?'), {
    target: { value: message },
  });
}

describe('Verify vouch-request flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getAccountPanels.mockResolvedValue({ success: true, data: { panels: [] } });
    mockApi.getVouches.mockResolvedValue({ success: true, data: { received: [], given: [] } });
    mockApi.getVouchRequests.mockResolvedValue({
      success: true,
      data: { incoming: [], outgoing: [] },
    });
    mockApi.getEvidenceScore.mockResolvedValue({
      success: true,
      data: { score: emptyScore, vouchCount: 0 },
    });
  });

  afterEach(() => cleanup());

  it('sends the recipient id and typed message as a signed request', async () => {
    mockApi.createVouchRequest.mockResolvedValue({
      success: true,
      data: { id: 'r1', fromId: 'me', toId: 'friend-123', status: 'pending' },
    });

    render(<Verify />);
    openRequestModalAndFill('friend-123', 'please vouch for me');
    fireEvent.click(screen.getByRole('button', { name: 'Send Request' }));

    await waitFor(() => expect(mockApi.createVouchRequest).toHaveBeenCalledTimes(1));

    const arg = mockApi.createVouchRequest.mock.calls[0][0];
    expect(arg.payload).toEqual({ toId: 'friend-123', message: 'please vouch for me' });
    expect(arg.accountId).toBe('me');
    expect(arg.signature).toBe('test-signature');

    expect(await screen.findByText('Vouch request sent!')).toBeTruthy();
  });

  it('surfaces the error when the request is rejected', async () => {
    mockApi.createVouchRequest.mockResolvedValue({
      success: false,
      data: { id: '', fromId: '', toId: '', status: '' },
      error: { code: 'DUPLICATE', message: 'You already requested a vouch from this account' },
    });

    render(<Verify />);
    openRequestModalAndFill('friend-123', 'please vouch for me');
    fireEvent.click(screen.getByRole('button', { name: 'Send Request' }));

    expect(
      await screen.findByText('You already requested a vouch from this account'),
    ).toBeTruthy();
  });
});

// Accepting a vouch request must LOCK A STAKE, not just flip a flag.
//
// The wallet used to fire a single PUT marking the request 'accepted'. No stake
// was locked, no vouch row was created, and the friend who asked got nothing —
// while the request disappeared from both inboxes forever, because the server
// only returns rows with status='pending'. Silent and unrecoverable.
//
// The old code would pass any test that only asserted "the button did
// something", so these assert the ORDER and the payload specifically.
describe('Verify incoming vouch requests', () => {
  const incoming = {
    id: 'req-1',
    fromId: 'friend-abc',
    toId: 'me',
    status: 'pending',
    message: 'please vouch for me',
    createdAt: 0,
    respondedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getAccountPanels.mockResolvedValue({ success: true, data: { panels: [] } });
    mockApi.getVouches.mockResolvedValue({ success: true, data: { received: [], given: [] } });
    mockApi.getVouchRequests.mockResolvedValue({
      success: true,
      data: { incoming: [incoming], outgoing: [] },
    });
    mockApi.getEvidenceScore.mockResolvedValue({
      success: true,
      data: { score: emptyScore, vouchCount: 0 },
    });
  });

  afterEach(() => cleanup());

  it('locks a stake before marking the request accepted', async () => {
    mockApi.createVouch.mockResolvedValue({ success: true, data: { vouch: {} } });
    mockApi.updateVouchRequest.mockResolvedValue({ success: true, data: {} });

    render(<Verify />);
    const accept = await screen.findByRole('button', { name: /Accept & stake/ });
    fireEvent.click(accept);

    await waitFor(() => expect(mockApi.createVouch).toHaveBeenCalledTimes(1));

    // The vouch is for the person who ASKED, staking at least the minimum.
    const arg = mockApi.createVouch.mock.calls[0][0];
    expect(arg.payload.vouchedId).toBe('friend-abc');
    expect(arg.payload.stakePercent).toBeGreaterThanOrEqual(5);
    expect(arg.accountId).toBe('me');

    // And only then is the request marked handled.
    await waitFor(() => expect(mockApi.updateVouchRequest).toHaveBeenCalledTimes(1));
    expect(mockApi.updateVouchRequest.mock.calls[0][1].payload).toEqual({ status: 'accepted' });
  });

  it('leaves the request pending when the stake is rejected', async () => {
    mockApi.createVouch.mockResolvedValue({
      success: false,
      data: { vouch: {} },
      error: { code: 'STAKE_TOO_SMALL', message: 'stakePercent 1% below minimum 5%' },
    });

    render(<Verify />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept & stake/ }));

    await waitFor(() => expect(mockApi.createVouch).toHaveBeenCalledTimes(1));

    // The critical assertion: a failed stake must NOT mark the request handled,
    // or it vanishes from the inbox with nothing staked — the original bug.
    expect(mockApi.updateVouchRequest).not.toHaveBeenCalled();
    expect(await screen.findByText(/below minimum/)).toBeTruthy();
  });

  it('declines without staking anything', async () => {
    mockApi.updateVouchRequest.mockResolvedValue({ success: true, data: {} });

    render(<Verify />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(mockApi.updateVouchRequest).toHaveBeenCalledTimes(1));
    expect(mockApi.updateVouchRequest.mock.calls[0][1].payload).toEqual({ status: 'declined' });
    expect(mockApi.createVouch).not.toHaveBeenCalled();
  });
});
