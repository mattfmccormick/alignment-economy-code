// Default port 3001 because the miner's bundled ae-node lives there (the
// wallet's bundled node uses 3000; both apps installed = two independent
// nodes, no port collision). Override with VITE_API_URL when running
// against an external ae-node (e.g. `VITE_API_URL=http://localhost:3000/api/v1
// npm run dev` to hit a manually-started node).
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { timestamp: number };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  // Some routes return the standard { success, data } envelope; others return
  // the payload directly. Wrap the bare ones so every callsite can `.success`
  // and `.data` without per-route casing.
  if (json && typeof json === 'object' && typeof (json as any).success === 'boolean') {
    return json as T;
  }
  return { success: true, data: json } as T;
}

// --- Type definitions ---

export interface MinerStatus {
  isMiner: boolean;
  miner: {
    id: string;
    account_id: string;
    tier: number;
    is_active: boolean;
    registered_at: string;
  } | null;
}

export interface Account {
  id: string;
  type: string;
  publicKey?: string;
  percentHuman: number;
  balances: {
    active: string;
    supportive: string;
    ambient: string;
    earned: string;
    locked: string;
  };
  created_at?: string;
}

export interface NetworkStatus {
  participantCount: number;
  blockHeight: number;
  currentDay: number;
  activeMinerCount?: number;
  totalMiners?: number;
  feePool?: string;
}

export interface NodeStatus {
  chain: {
    blockHeight: number;
    currentDay: number;
  };
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  cycle: {
    phase: string;
    lastCycleAt: number;
  };
}

export interface EvidenceScore {
  score: number;
  vouchCount: number;
}

export interface Vouch {
  id: string;
  voucherId: string;
  vouchedId: string;
  stakeAmount: string;       // bigint serialized as string
  stakedPercentage: number;
  isActive: boolean;
  createdAt: number;
  withdrawnAt: number | null;
}

export interface VouchData {
  received: Vouch[];
  given: Vouch[];
}

export interface VouchRequest {
  id: string;
  fromId: string;
  toId: string;
  message: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
  respondedAt: number | null;
}

export interface VouchRequests {
  incoming: VouchRequest[];
  outgoing: VouchRequest[];
}

export interface CourtCase {
  id: string;
  type: string;
  challenger_id: string;
  defendant_id: string;
  status: string;
  evidence_count: number;
  jury_size: number;
  deadline: string;
  created_at: string;
}

export interface HealthCheck {
  status: string;
  timestamp: number;
}

// --- API functions ---

export const api = {
  // Health
  health: () =>
    request<HealthCheck>('GET', '/health'),

  // Node status
  nodeStatus: () =>
    request<NodeStatus>('GET', '/status'),

  // Accounts
  getAccount: (id: string) =>
    request<ApiResponse<Account>>('GET', `/accounts/${id}`),

  // Pass `publicKey` for client-custody mode (mnemonic-derived keys never
  // touch the server). Omit it for the legacy server-generated path.
  createAccount: (type: 'individual' | 'company' | 'government' | 'ai_bot' = 'individual', publicKey?: string) =>
    request<ApiResponse<{ account: Account; publicKey: string; privateKey?: string }>>(
      'POST', '/accounts', publicKey ? { type, publicKey } : { type },
    ),

  // Miner
  getMinerStatus: (accountId: string) =>
    request<ApiResponse<MinerStatus>>('GET', `/miners/status/${accountId}`),

  registerMiner: (accountId: string) =>
    request<ApiResponse<{ miner: MinerStatus['miner'] }>>('POST', '/miners/register', { accountId }),

  // Verification panels (miner-facing).
  // Get the FIFO-assigned panels for a miner account. Public: the assignment
  // record is on-chain; only the score-submit action is auth-protected.
  getAssignedPanels: (minerAccountId: string) =>
    request<ApiResponse<{ minerRegistered: boolean; assignments: any[] }>>('GET', `/verification/miners/${minerAccountId}/assignments`),

  // Public: full panel detail with evidence, prior reviews, live auto-score.
  getPanel: (panelId: string) =>
    request<ApiResponse<{ panel: any; evidence: any[]; reviews: any[]; assignedMiners: any[]; liveScore: any }>>('GET', `/verification/panels/${panelId}`),

  // Submit my %Human score for an assigned panel. (Signed.)
  submitPanelScore: (panelId: string, signedBody: unknown) =>
    request<ApiResponse<{ recorded: boolean; panelComplete: boolean; medianScore: number | null }>>(
      'POST', `/verification/panels/${panelId}/score`, signedBody,
    ),

  // Court — challenge + jury duty
  getActiveCases: () =>
    request<ApiResponse<{ cases: any[] }>>('GET', '/court/cases'),

  // Get full case detail. Includes the argument log alongside the jury panel.
  getCase: (caseId: string) =>
    request<ApiResponse<{ case: any; jury: any[]; votesRevealed: boolean; arguments: any[] }>>('GET', `/court/cases/${caseId}`),

  // Submit an argument or rebuttal on a case (signed; backend gates submitter
  // to challenger or defendant — jurors and onlookers cannot post).
  submitCaseArgument: (caseId: string, signedBody: unknown) =>
    request<ApiResponse<{ argument: any }>>('POST', `/court/cases/${caseId}/arguments`, signedBody),

  fileChallenge: (signedBody: unknown) =>
    request<ApiResponse<{ case: any }>>('POST', '/court/challenges', signedBody),

  // Cases assigned to this miner as a juror.
  getJuryDuty: (accountId: string) =>
    request<ApiResponse<{ assignments: any[] }>>('GET', `/court/jury-duty/${accountId}`),

  // Submit a sealed vote on an assigned case (signed).
  submitVote: (caseId: string, signedBody: unknown) =>
    request<ApiResponse<{ recorded: boolean; verdict: string | null }>>(
      'POST', `/court/cases/${caseId}/vote`, signedBody,
    ),

  submitEvidence: (accountId: string, evidenceTypeId: string, evidenceHash: string) =>
    request<ApiResponse<unknown>>('POST', '/miners/evidence', { accountId, evidenceTypeId, evidenceHash }),

  getEvidenceScore: (accountId: string) =>
    request<ApiResponse<EvidenceScore>>('GET', `/miners/evidence/score/${accountId}`),

  // Vouches
  submitVouch: (voucherId: string, vouchedId: string, stakeAmount: number) =>
    request<ApiResponse<unknown>>('POST', '/miners/vouches', { voucherId, vouchedId, stakeAmount }),

  getVouches: (accountId: string) =>
    request<ApiResponse<VouchData>>('GET', `/miners/vouches/${accountId}`),

  // Vouch Requests
  sendVouchRequest: (fromId: string, toId: string, message: string) =>
    request<ApiResponse<unknown>>('POST', '/miners/vouch-requests', { fromId, toId, message }),

  getVouchRequests: (accountId: string) =>
    request<ApiResponse<VouchRequests>>('GET', `/miners/vouch-requests/${accountId}`),

  updateVouchRequest: (id: string, status: string) =>
    request<ApiResponse<unknown>>('PUT', `/miners/vouch-requests/${id}`, { status }),

  // Network
  getNetworkStatus: () =>
    request<ApiResponse<NetworkStatus>>('GET', '/network/status'),

  // Court (future endpoints, graceful failure)
  getCourtCases: (accountId: string) =>
    request<ApiResponse<{ cases: CourtCase[] }>>('GET', `/court/cases/${accountId}`).catch(() => ({ success: false, data: { cases: [] } })),
};
