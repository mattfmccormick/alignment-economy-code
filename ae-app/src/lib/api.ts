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

// Track the last failure mode so the UI can decide whether to show a
// banner ("Local node not running") vs an inline error. Updated on every
// request; consumers can subscribe via subscribeNodeStatus() below.
type NodeStatus = 'ok' | 'offline' | 'node-down' | 'unknown';
let lastNodeStatus: NodeStatus = 'unknown';
const nodeStatusListeners = new Set<(s: NodeStatus) => void>();

function setNodeStatus(s: NodeStatus): void {
  if (s === lastNodeStatus) return;
  lastNodeStatus = s;
  for (const cb of nodeStatusListeners) {
    try { cb(s); } catch { /* listener should not break the request */ }
  }
}

export function getNodeStatus(): NodeStatus {
  return lastNodeStatus;
}

export function subscribeNodeStatus(cb: (s: NodeStatus) => void): () => void {
  nodeStatusListeners.add(cb);
  return () => nodeStatusListeners.delete(cb);
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
    // Distinguish "your machine is offline" from "the local ae-node we're
    // trying to talk to isn't responding." navigator.onLine is a coarse
    // signal but it's the only one available to a sandboxed renderer.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) {
      setNodeStatus('offline');
      return { success: false, data: {} as T, error: { code: 'OFFLINE', message: "You're offline. Check your internet connection." } };
    }
    setNodeStatus('node-down');
    return {
      success: false,
      data: {} as T,
      error: {
        code: 'NODE_UNREACHABLE',
        message: 'Could not reach the local node. If you just restarted the app, give it a few seconds. If this keeps happening, the bundled node may have failed to start.',
      },
    };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    setNodeStatus('node-down');
    return { success: false, data: {} as T, error: { code: 'PARSE_ERROR', message: `Server returned ${res.status}` } };
  }

  // Reaching here means the node responded with parseable JSON, regardless
  // of the wrapped success value. Treat that as "node alive".
  setNodeStatus('ok');

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

  // Vouches.
  // Authenticated: the voucher (caller) signs `{ vouchedId, stakeAmount }`
  // with their own private key. The route reads voucherId from the
  // signature, not the body, so a third party can't stake someone
  // else's balance.
  createVouch: (envelope: { accountId: string; timestamp: number; signature: string; payload: { vouchedId: string; stakeAmount: number } }) =>
    request<any>('POST', '/miners/vouches', envelope),

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

  // Founder: generate a fresh genesis ceremony from inside the wallet.
  // The response includes the public spec, one keystore per validator
  // (the founder's is the first), and the spec hash for out-of-band
  // confirmation across operators. The wallet UI is responsible for
  // letting the user save/share these.
  generateGenesis: (body: {
    networkId: string;
    validatorCount?: number;
    names?: string[];
    initialEarnedDisplay?: number;
    stakeDisplay?: number;
    genesisTimestamp?: number;
  }) =>
    request<{ spec: any; keystores: any[]; specHash: string }>('POST', '/founder/generate-genesis', body),
};
