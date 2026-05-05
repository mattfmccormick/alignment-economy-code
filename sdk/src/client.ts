// Typed HTTP client for the ae-node API. Wraps `fetch` so consumers can
// just call `client.getAccount(id)` and get back a typed Account without
// hand-rolling URL construction or response unwrapping.
//
// Conventions:
//   - Bigints round-trip as base-10 strings on the wire (matches ae-node's
//     own JSON encoding).
//   - Display amounts (what humans see in a UI) are converted to base
//     units (PRECISION = 10^8) before signing. The signing helpers in
//     this module take bigints directly — callers can use BigInt(Math.round(...)).
//   - Each method returns the parsed `data` field from the API's
//     {success, data, error} envelope. On failure we throw so callers
//     get exception-style flow instead of having to check success on
//     every call.

import { signPayload } from './crypto.js';
import type {
  Account,
  ApiResponse,
  Block,
  NetworkStatus,
  Transaction,
  TransactionPayload,
} from './types.js';

export interface ClientOptions {
  /** Base URL pointing at the API root, e.g. http://localhost:3000/api/v1 */
  baseUrl: string;
  /** Optional fetch override for non-browser environments / testing. */
  fetch?: typeof globalThis.fetch;
}

export class AlignmentEconomyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, init);
    let parsed: ApiResponse<T> | T;
    try {
      parsed = (await res.json()) as ApiResponse<T> | T;
    } catch {
      throw new SDKError(`Server returned non-JSON (${res.status})`, 'PARSE_ERROR', res.status);
    }
    if (typeof parsed === 'object' && parsed !== null && 'success' in parsed && 'data' in parsed) {
      const wrapped = parsed as ApiResponse<T>;
      if (!wrapped.success) {
        const err = wrapped.error;
        throw new SDKError(err?.message ?? 'API request failed', err?.code ?? 'API_ERROR', res.status, err?.details);
      }
      return wrapped.data;
    }
    if (!res.ok) {
      throw new SDKError(`HTTP ${res.status}`, 'HTTP_ERROR', res.status);
    }
    return parsed as T;
  }

  // ─── Health ─────────────────────────────────────────────────────────

  async getHealth(): Promise<{ status: string; timestamp: number }> {
    return this.request('GET', '/health');
  }

  // ─── Accounts ───────────────────────────────────────────────────────

  /**
   * Create a new account. Pass `publicKey` for client-custody mode
   * (recommended; private key never reaches the server). Omit it for
   * legacy server-generated keys (test setups only).
   */
  async createAccount(type: Account['type'], publicKey?: string): Promise<{ account: Account; publicKey: string; privateKey?: string }> {
    return this.request('POST', '/accounts', publicKey ? { type, publicKey } : { type });
  }

  async getAccount(id: string): Promise<Account> {
    return this.request('GET', `/accounts/${encodeURIComponent(id)}`);
  }

  async getTransactions(
    id: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 50;
    return this.request('GET', `/accounts/${encodeURIComponent(id)}/transactions?page=${page}&limit=${limit}`);
  }

  // ─── Transactions ───────────────────────────────────────────────────

  /**
   * Submit a signed transaction. Caller is responsible for building +
   * signing the payload with their account's private key. See
   * `signTransaction` below for the canonical helper.
   */
  async submitTransaction(opts: {
    accountId: string;
    timestamp: number;
    signature: string;
    payload: TransactionPayload;
  }): Promise<{ transaction: Transaction; fee: string; netAmount: string }> {
    return this.request('POST', '/transactions', opts);
  }

  /**
   * Look up a single transaction by id. Returns the full Transaction
   * (incl. receiverSignature on in-person txs and blockNumber once
   * committed). Throws SDKError with code='NOT_FOUND' (httpStatus=404)
   * for unknown ids.
   */
  async getTransaction(id: string): Promise<Transaction> {
    return this.request('GET', `/transactions/${encodeURIComponent(id)}`);
  }

  // ─── Network ────────────────────────────────────────────────────────

  async getNetworkStatus(): Promise<NetworkStatus> {
    return this.request('GET', '/network/status');
  }

  async getBlocks(opts: { page?: number; limit?: number } = {}): Promise<{ blocks: Block[]; total: number; page: number; limit: number }> {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 20;
    return this.request('GET', `/network/blocks?page=${page}&limit=${limit}`);
  }

  // ─── Founder ────────────────────────────────────────────────────────

  /**
   * Run a genesis ceremony from the API. Returns the spec + per-validator
   * keystores + spec hash. The spec is public; keystores must be sent to
   * each named operator privately (one keystore per recipient, never
   * share).
   */
  async generateGenesis(opts: {
    networkId: string;
    validatorCount?: number;
    names?: string[];
    initialEarnedDisplay?: number;
    stakeDisplay?: number;
    genesisTimestamp?: number;
  }): Promise<{
    spec: { networkId: string; accounts: Array<{ publicKey: string; validator?: unknown }> };
    keystores: Array<{ name: string; accountId: string; account: { publicKey: string; privateKey: string } }>;
    specHash: string;
  }> {
    return this.request('POST', '/founder/generate-genesis', opts);
  }
}

export class SDKError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SDKError';
  }
}

/**
 * Helper: build the canonical signing payload + sign it with the user's
 * private key. Returns `{ timestamp, signature }` ready to be passed to
 * `submitTransaction`. The receiver-side countersignature for in-person
 * transactions has to be obtained out-of-band (see whitepaper §6.3).
 */
export function signTransaction(opts: {
  from: string;
  to: string;
  amountBaseUnits: bigint;
  pointType: TransactionPayload['pointType'];
  isInPerson?: boolean;
  memo?: string;
  privateKey: string;
}): { timestamp: number; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    from: opts.from,
    to: opts.to,
    amount: opts.amountBaseUnits.toString(),
    pointType: opts.pointType,
    isInPerson: opts.isInPerson ?? false,
    memo: opts.memo ?? '',
  };
  const signature = signPayload(payload, timestamp, opts.privateKey);
  return { timestamp, signature };
}
