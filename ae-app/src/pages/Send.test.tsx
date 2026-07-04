import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Send } from './Send';
import { api } from '../lib/api';
import { toBaseUnits } from '../lib/formatting';
import type { TransactionData } from '../lib/types';

// A complete TransactionData so the mocked sendTransaction return satisfies the
// strict typed response. The test never reads these fields; it asserts on the
// request the app sends, not the settled row.
const fakeTx: TransactionData = {
  id: 'tx1', from: 'me', to: 'recipient-xyz', amount: '0', fee: '0', netAmount: '0',
  pointType: 'active', isInPerson: false, recipientIsHuman: true, memo: '',
  signature: 'sig', receiverSignature: null, timestamp: 0, blockNumber: null,
};

// The Send page is the money-critical path: a human types a display amount
// ("12.50") and the app must sign AND transmit the canonical base-unit integer
// string — never the float. These flow tests guard that conversion and the
// payload shape, plus the failure path where a rejected send must surface the
// error to the user instead of silently looking successful.

// loadWallet backs `wallet` (from/accountId + signing key). A fixed fake.
vi.mock('../lib/keys', () => ({
  loadWallet: () => ({ accountId: 'me', privateKey: 'priv', publicKey: 'pub' }),
}));

// useAccount supplies the balance shown in the form. Give plenty of active.
vi.mock('../hooks/useAccount', () => ({
  useAccount: () => ({
    account: {
      activeBalance: '10000000',
      earnedBalance: '0',
      isEscrowed: false,
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

// Deterministic signature so we can assert the envelope without real crypto.
vi.mock('../lib/crypto', () => ({
  signPayload: () => 'test-signature',
}));

// Mock the whole API client. NOTE: formatting.ts is intentionally NOT mocked —
// the real toBaseUnits must run so the test exercises the actual conversion.
vi.mock('../lib/api', () => ({
  api: {
    getContacts: vi.fn(),
    getTransactions: vi.fn(),
    searchAccounts: vi.fn(),
    sendTransaction: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

// Walk the recipient-selection screen to the send form via the deterministic
// "enter an account ID directly" path (no async list loading to wait on).
function selectRecipientAndEnterAmount(accountId: string, amount: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.change(screen.getByPlaceholderText('Paste account ID'), {
    target: { value: accountId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } });
}

describe('Send flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getContacts.mockResolvedValue({ success: true, data: { contacts: [] } });
    mockApi.getTransactions.mockResolvedValue({
      success: true,
      data: { transactions: [], total: 0, page: 1, limit: 20 },
    });
    mockApi.searchAccounts.mockResolvedValue({ success: true, data: { accounts: [] } });
  });

  // Without vitest `globals`, RTL doesn't register its own afterEach cleanup,
  // so unmount between tests explicitly or rendered DOM stacks up.
  afterEach(() => cleanup());

  it('signs and transmits the amount as a base-unit string, not a float', async () => {
    mockApi.sendTransaction.mockResolvedValue({
      success: true,
      data: { transaction: fakeTx, newBalance: '0' },
    });

    render(<Send />);
    selectRecipientAndEnterAmount('recipient-xyz', '12.50');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockApi.sendTransaction).toHaveBeenCalledTimes(1));

    const arg = mockApi.sendTransaction.mock.calls[0][0] as {
      accountId: string;
      signature: string;
      payload: { to: string; amount: string; pointType: string; isInPerson: boolean };
    };
    // The wire amount is the canonical base-unit integer string for 12.50 —
    // e.g. "1250" — and critically a string, never the JS number 12.5.
    expect(arg.payload.amount).toBe(toBaseUnits(12.5));
    expect(typeof arg.payload.amount).toBe('string');
    expect(arg.payload.to).toBe('recipient-xyz');
    expect(arg.payload.pointType).toBe('active');
    expect(arg.payload.isInPerson).toBe(false);
    expect(arg.accountId).toBe('me');
    expect(arg.signature).toBe('test-signature');
  });

  it('surfaces the error message when the send is rejected', async () => {
    mockApi.sendTransaction.mockResolvedValue({
      success: false,
      data: { transaction: fakeTx, newBalance: '0' },
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' },
    });

    render(<Send />);
    selectRecipientAndEnterAmount('recipient-xyz', '999.00');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The user must see the failure, not a false success.
    expect(await screen.findByText('Insufficient balance')).toBeTruthy();
  });
});
