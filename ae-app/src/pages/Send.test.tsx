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

// useAccount supplies the balance + percentHuman shown in the form. Held in a
// hoisted mutable ref so individual tests can vary percentHuman/type.
const mockAccount = vi.hoisted(() => ({
  current: {
    type: 'individual',
    percentHuman: 100,
    activeBalance: '10000000',
    earnedBalance: '0',
    isEscrowed: false,
  } as Record<string, unknown>,
}));
vi.mock('../hooks/useAccount', () => ({
  useAccount: () => ({
    account: mockAccount.current,
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

// Deterministic signature so we can assert the envelope without real crypto.
// A spy rather than a bare arrow so tests can inspect the payload that was
// actually signed — see the canonical-shape test below.
const mockSignPayload = vi.hoisted(() =>
  vi.fn((_payload: object, _timestamp: number, _privateKey: string) => 'test-signature'),
);
vi.mock('../lib/crypto', () => ({
  signPayload: mockSignPayload,
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
    // Reset to a fully-verified account; the gross-up test opts into <100%.
    mockAccount.current = {
      type: 'individual', percentHuman: 100,
      activeBalance: '10000000', earnedBalance: '0', isEscrowed: false,
    };
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

  // Regression guard for the August 16 2026 signature bug.
  //
  // signPayload/verifyPayload on both sides hash a raw JSON.stringify with no
  // key canonicalization, so the signed bytes depend on the exact key SET and
  // INSERTION ORDER. This page previously omitted `recipientIsHuman`, which
  // ae-node's processTransaction includes when it rebuilds the payload to
  // verify (ae-node/src/core/transaction.ts). The byte strings differed and
  // ML-DSA verification returned false, so every single send came back
  // 400 INVALID_SIGNATURE.
  //
  // Nothing caught it: the node's own tests build the correct payload
  // themselves, and this file mocks the API client. Asserting the key order
  // here is the cheap guard. If ae-node ever changes its verification payload,
  // this test must change with it, in lockstep.
  it('signs the exact payload shape and key order ae-node verifies', async () => {
    mockApi.sendTransaction.mockResolvedValue({
      success: true,
      data: { transaction: fakeTx, newBalance: '0' },
    });

    render(<Send />);
    selectRecipientAndEnterAmount('recipient-xyz', '12.50');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockSignPayload).toHaveBeenCalled());

    const signed = mockSignPayload.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(signed)).toEqual([
      'from',
      'to',
      'amount',
      'pointType',
      'isInPerson',
      'recipientIsHuman',
      'memo',
    ]);
    expect(signed.recipientIsHuman).toBe(false);
    expect(signed.from).toBe('me');
    expect(signed.to).toBe('recipient-xyz');
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

  it('shows the verification burn and grosses up an active spend below 100% human', async () => {
    // A 90%-human individual: an active spend of 20 delivers 20×0.9 − fee.
    mockAccount.current = {
      type: 'individual', percentHuman: 90,
      activeBalance: '10000000', earnedBalance: '0', isEscrowed: false,
    };
    mockApi.sendTransaction.mockResolvedValue({
      success: true,
      data: { transaction: fakeTx, newBalance: '0' },
    });

    render(<Send />);
    selectRecipientAndEnterAmount('recipient-xyz', '20.00');

    // The preview must tell the truth: 2 pts burn to verification, recipient
    // gets 20×0.9 − 0.5% fee = 17.91, not the old (wrong) 19.90.
    expect(await screen.findByText('-2.00 pts')).toBeTruthy();
    expect(screen.getByText('17.91 pts')).toBeTruthy();

    // The gross-up control raises the amount to 20 ÷ 0.9 = 22.22 so the
    // recipient receives the full intended value.
    fireEvent.click(screen.getByText(/receive the full/));
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('22.22');
  });
});
