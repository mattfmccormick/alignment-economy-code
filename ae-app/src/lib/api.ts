// Pick the right backend URL for the current runtime:
//   - Vite dev server: same-origin '/api/v1' (proxied to localhost:3000 by vite.config)
//   - Production browser at app.alignmenteconomy.org: relative '/api/v1' served by reverse proxy
//   - Electron desktop (file:// origin): absolute http://localhost:3000/api/v1 unless VITE_API_URL is set at build time
const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  (typeof window !== 'undefined' && window.location.protocol === 'file:'
    ? 'http://localhost:3000/api/v1'
    : '/api/v1');

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { timestamp: number };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, opts);
  } catch {
    return { success: false, data: {} as T, error: { code: 'NETWORK_ERROR', message: 'Network error' } };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return { success: false, data: {} as T, error: { code: 'PARSE_ERROR', message: `Server returned ${res.status}` } };
  }

  // Some newer routes return plain JSON without success wrapper
  if (typeof json.success === 'boolean') {
    return json;
  }
  // Wrap plain responses in standard format
  return { success: res.ok, data: json as T };
}

export const api = {
  // Accounts
  // Pass `publicKey` for client-custody mode (mnemonic-derived keys never
  // touch the server). Omit it for the legacy server-generated path.
  createAccount: (type: string, publicKey?: string) =>
    request<{ account: any; publicKey: string; privateKey?: string }>('POST', '/accounts', publicKey ? { type, publicKey } : { type }),

  getAccount: (id: string) =>
    request<any>('GET', `/accounts/${id}`),

  getTransactions: (id: string, page = 1, limit = 50) =>
    request<{ transactions: any[]; total: number }>('GET', `/accounts/${id}/transactions?page=${page}&limit=${limit}`),

  // Transactions
  sendTransaction: (body: unknown) =>
    request<any>('POST', '/transactions', body),

  // Contacts
  getContacts: (ownerId: string) =>
    request<{ contacts: any[] }>('GET', `/contacts/${ownerId}`),

  addContact: (ownerId: string, contactAccountId: string, nickname: string) =>
    request<any>('POST', '/contacts', { ownerId, contactAccountId, nickname }),

  updateContact: (id: string, nickname: string) =>
    request<any>('PUT', `/contacts/${id}`, { nickname }),

  toggleFavorite: (id: string, isFavorite: boolean) =>
    request<any>('PUT', `/contacts/${id}/favorite`, { isFavorite }),

  deleteContact: (id: string) =>
    request<any>('DELETE', `/contacts/${id}`),

  searchAccounts: (query: string) =>
    request<{ accounts: any[] }>('GET', `/contacts/search/accounts?q=${encodeURIComponent(query)}`),

  // Recurring Transfers
  getRecurring: (accountId: string) =>
    request<{ transfers: any[] }>('GET', `/recurring/${accountId}`),

  createRecurring: (body: { fromId: string; toId: string; amount: number; pointType: string; schedule: string }) =>
    request<any>('POST', '/recurring', body),

  updateRecurring: (id: string, body: { amount?: number; pointType?: string; schedule?: string; isActive?: boolean }) =>
    request<any>('PUT', `/recurring/${id}`, body),

  deleteRecurring: (id: string) =>
    request<any>('DELETE', `/recurring/${id}`),

  // Miners
  registerMiner: (accountId: string) =>
    request<any>('POST', '/miners/register', { accountId }),

  getMinerStatus: (accountId: string) =>
    request<{ isMiner: boolean; miner: any }>('GET', `/miners/status/${accountId}`),

  submitEvidence: (accountId: string, evidenceTypeId: string, evidenceHash: string) =>
    request<any>('POST', '/miners/evidence', { accountId, evidenceTypeId, evidenceHash }),

  getEvidenceScore: (accountId: string) =>
    request<{ score: number; vouchCount: number }>('GET', `/miners/evidence/score/${accountId}`),

  // Vouches
  createVouch: (voucherId: string, vouchedId: string, stakeAmount: number) =>
    request<any>('POST', '/miners/vouches', { voucherId, vouchedId, stakeAmount }),

  getVouches: (accountId: string) =>
    request<{ received: any[]; given: any[] }>('GET', `/miners/vouches/${accountId}`),

  // Vouch Requests
  createVouchRequest: (fromId: string, toId: string, message: string) =>
    request<any>('POST', '/miners/vouch-requests', { fromId, toId, message }),

  getVouchRequests: (accountId: string) =>
    request<{ incoming: any[]; outgoing: any[] }>('GET', `/miners/vouch-requests/${accountId}`),

  updateVouchRequest: (id: string, status: 'accepted' | 'declined') =>
    request<any>('PUT', `/miners/vouch-requests/${id}`, { status }),

  // Verification panels (the real proof-of-human flow)
  // Participant requests a panel for their own account (signed).
  requestPanel: (signedBody: unknown) =>
    request<{ panel: any; assignedMinerCount: number }>('POST', '/verification/panels', signedBody),

  // Submit verification evidence on the participant's own account (signed).
  submitVerificationEvidence: (signedBody: unknown) =>
    request<{ evidence: any }>('POST', '/verification/evidence', signedBody),

  // Public: get full panel detail (evidence + reviews + assigned miners + live score).
  getPanel: (panelId: string) =>
    request<any>('GET', `/verification/panels/${panelId}`),

  // Public: list all panels filed for an account (history).
  getAccountPanels: (accountId: string) =>
    request<{ panels: any[] }>('GET', `/verification/accounts/${accountId}/panels`),

  // Court — disputes and verdicts
  // List active cases on the network (public).
  getActiveCases: () =>
    request<{ cases: any[] }>('GET', '/court/cases'),

  // Get full case detail (public). Includes the argument log alongside the
  // jury panel and the case header.
  getCase: (caseId: string) =>
    request<{ case: any; jury: any[]; votesRevealed: boolean; arguments: any[] }>('GET', `/court/cases/${caseId}`),

  // Submit an argument or rebuttal on a case (signed; backend gates submitter
  // to challenger or defendant).
  submitCaseArgument: (caseId: string, signedBody: unknown) =>
    request<{ argument: any }>('POST', `/court/cases/${caseId}/arguments`, signedBody),

  // Cases involving this account (defendant or challenger). Public.
  getMyCases: (accountId: string) =>
    request<{ cases: any[] }>('GET', `/court/my-cases/${accountId}`),

  // File a challenge against another account (signed; miner only on backend).
  fileChallenge: (signedBody: unknown) =>
    request<{ case: any }>('POST', '/court/challenges', signedBody),

  // Escalate a case from arbitration to full court (signed; only the original challenger).
  escalateCase: (caseId: string, signedBody: unknown) =>
    request<{ case: any; juryMinerIds: string[] }>('POST', `/court/cases/${caseId}/escalate`, signedBody),

  // Network
  getNetworkStatus: () =>
    request<any>('GET', '/network/status'),

  getFeePool: () =>
    request<any>('GET', '/network/fee-pool'),

  // Admin
  advanceDay: () =>
    request<any>('POST', '/admin/advance-day'),

  // Tags — the durable goods (products) and physical spaces a user occupies.
  // Submitting a tag set replaces today's set for that account; rebases at the
  // 4am EST cycle boundary distribute the supportive/ambient mints to
  // manufacturers and space entities by minute share.
  getProducts: () =>
    request<{ products: any[] }>('GET', '/tags/products'),

  getMyProducts: (ownerId: string) =>
    request<{ products: any[] }>('GET', `/tags/products/mine/${ownerId}`),

  registerProduct: (body: { name: string; category: string; createdBy: string; manufacturerId?: string }) =>
    request<{ product: any }>('POST', '/tags/products', body),

  getSpaces: () =>
    request<{ spaces: any[] }>('GET', '/tags/spaces'),

  registerSpace: (body: { name: string; type: string; parentId?: string; entityId?: string; collectionRate?: number }) =>
    request<{ space: any }>('POST', '/tags/spaces', body),

  getSupportiveTags: (accountId: string, day: number) =>
    request<{ tags: any[] }>('GET', `/tags/supportive/${accountId}/${day}`),

  submitSupportiveTags: (body: { accountId: string; day: number; tags: Array<{ productId: string; minutesUsed: number }> }) =>
    request<{ tags: any[] }>('POST', '/tags/supportive', body),

  getAmbientTags: (accountId: string, day: number) =>
    request<{ tags: any[] }>('GET', `/tags/ambient/${accountId}/${day}`),

  submitAmbientTags: (body: { accountId: string; day: number; tags: Array<{ spaceId: string; minutesOccupied: number }> }) =>
    request<{ tags: any[] }>('POST', '/tags/ambient', body),

  getTodayDay: () =>
    request<{ day: number; cyclePhase: string }>('GET', '/tags/today'),
};
