// Resolution order (mirrors src/lib/websocket.ts):
//   1. VITE_API_URL — explicit override, wins everywhere.
//   2. file:// origin (packaged Electron) — the miner's bundled ae-node on
//      3001 (the wallet's bundled node uses 3000; both installed = two
//      independent nodes, no port collision).
//   3. Browser dev — same-origin '/api/v1' so Vite's proxy forwards to the
//      dev node on 3000. (Hardcoding 3001 here made every dev API call
//      connection-refused and left the proxy config dead.)
const API_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.protocol === 'file:' ? 'http://localhost:3001/api/v1' : '/api/v1');

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
  if (json && typeof json === 'object' && typeof (json as { success?: unknown }).success === 'boolean') {
    return json as T;
  }
  return { success: true, data: json } as T;
}

// --- Type definitions ---

export interface MinerStatus {
  isMiner: boolean;
  // Backend sends the Miner row camelCase; registeredAt is unix SECONDS.
  // (This was once declared snake_case, which silently rendered every miner
  // as "Inactive / Registered --" — the shape is now pinned by ae-node's
  // api-shape-contract.test.ts.)
  miner: {
    id: string;
    accountId: string;
    tier: number;
    isActive: boolean;
    registeredAt: number;
    deactivatedAt: number | null;
  } | null;
}

export interface Account {
  id: string;
  type: string;
  publicKey?: string;
  percentHuman: number;
  isEscrowed?: boolean;
  // GET /accounts/:id returns FLAT balance fields (base-unit strings), not a
  // nested `balances` object. The Dashboard/Income screens previously read
  // `account.balances.active`, which is undefined here and crashed the page.
  activeBalance: string;
  supportiveBalance: string;
  ambientBalance: string;
  earnedBalance: string;
  lockedBalance: string;
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

// The /evidence/score route returns `score` as the full breakdown object (not
// a bare number). Rendering `score` directly crashes React ("objects are not
// valid as a child") — read `score.totalScore`.
export interface ScoreBreakdown {
  totalScore: number;
  breakdown: { tierA: number; tierB: number; tierC: number };
  evidenceDetails?: Array<{ typeId: string; value: number }>;
  decayApplied?: boolean;
  nextDecayDate?: number | null;
}
export interface EvidenceScore {
  score: ScoreBreakdown;
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

// One row of the transaction_log audit trail (every balance change).
export interface LedgerEntry {
  id: string;
  account_id: string;
  change_type: string;   // tx_receive, fee_distribution, bounty, mint, burn_*, vouch_*, etc.
  point_type: string;
  amount: string;        // bigint serialized as string (base units)
  balance_before: string;
  balance_after: string;
  reference_id: string;
  timestamp: number;     // unix seconds
}

// A miner's verification-queue row (one applicant panel assigned to them).
export interface PanelAssignment {
  panelId: string;
  applicantAccountId: string;
  panelStatus: 'pending' | 'in_progress' | 'complete';
  panelCreatedAt: number;
  panelCompletedAt: number | null;
  medianScore: number | null;
  assignedAt: number;
  deadline: number;
  myReviewSubmitted: boolean;
  missed: boolean;
}

// Full detail for one verification panel (evidence + prior reviews + live score).
export interface PanelDetail {
  panel: {
    id: string;
    accountId: string;
    status: string;
    createdAt: number;
    completedAt: number | null;
    medianScore: number | null;
  };
  evidence: Array<{ id: string; evidenceTypeId: string; evidenceHash: string; submittedAt: number }>;
  reviews: Array<{ id: string; minerId: string; score: number; submittedAt: number }>;
  assignedMiners: Array<{ miner_id: string; completed: number; missed: number }>;
  liveScore: { totalScore: number; breakdown: { tierA: number; tierB: number; tierC: number } };
}

// Court — a dispute case header (serializeCase; camelCase).
export interface CaseHeader {
  id: string;
  type: string;
  level: string;
  status: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  challengerStakePercent: number;
  verdict: string | null;
  appealOf: string | null;
  arbitrationDeadline: number | null;
  votingDeadline: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

// One entry in a case's append-only argument log.
export interface CaseArgument {
  id: string;
  caseId: string;
  submitterId: string;
  role: 'challenger' | 'defendant';
  text: string;
  attachmentHash: string | null;
  createdAt: number;
}

// A juror row on a case's panel. `vote` is 'sealed' until all have voted.
export interface JurorRow {
  minerId: string;
  jurorAccountId: string;
  stakeAmount: string;
  vote: string | null;
  votedAt: number | null;
}

// A case assigned to this miner as a juror (jury-duty queue row).
export interface JuryAssignment {
  caseId: string;
  caseType: string;
  caseLevel: string;
  caseStatus: string;
  challengerId: string;
  defendantId: string;
  votingDeadline: number | null;
  verdict: string | null;
  stakeAmount: string;
  myVote: string | null;
  votedAt: number | null;
}

// A row in the active-cases list (a subset of the case header).
export interface ActiveCaseSummary {
  id: string;
  type: string;
  status: string;
  challengerId: string;
  defendantId: string;
  challengerStake: string;
  verdict: string | null;
  createdAt: number;
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

  // The account's transaction_log (every balance change, newest first).
  // Powers the Income and Audit pages. Paginated.
  getLedger: (accountId: string, page = 1, limit = 50) =>
    request<ApiResponse<{ entries: LedgerEntry[]; total: number; page: number; limit: number }>>(
      'GET', `/accounts/${accountId}/ledger?page=${page}&limit=${limit}`,
    ),

  // Pass `publicKey` for client-custody mode (mnemonic-derived keys never
  // touch the server). Omit it for the legacy server-generated path.
  createAccount: (type: 'individual' | 'company' | 'government' | 'ai_bot' = 'individual', publicKey?: string) =>
    request<ApiResponse<{ account: Account; publicKey: string; privateKey?: string }>>(
      'POST', '/accounts', publicKey ? { type, publicKey } : { type },
    ),

  // Miner
  getMinerStatus: (accountId: string) =>
    request<ApiResponse<MinerStatus>>('GET', `/miners/status/${accountId}`),

  // Auth-required: only the account being registered can register itself.
  registerMiner: (envelope: { accountId: string; timestamp: number; signature: string; payload: Record<string, never> }) =>
    request<ApiResponse<{ miner: MinerStatus['miner'] }>>('POST', '/miners/register', envelope),

  // Verification panels (miner-facing).
  // Get the FIFO-assigned panels for a miner account. Public: the assignment
  // record is on-chain; only the score-submit action is auth-protected.
  getAssignedPanels: (minerAccountId: string) =>
    request<ApiResponse<{ minerRegistered: boolean; assignments: PanelAssignment[] }>>('GET', `/verification/miners/${minerAccountId}/assignments`),

  // Public: full panel detail with evidence, prior reviews, live auto-score.
  getPanel: (panelId: string) =>
    request<ApiResponse<PanelDetail>>('GET', `/verification/panels/${panelId}`),

  // Submit my %Human score for an assigned panel. (Signed.)
  submitPanelScore: (panelId: string, signedBody: unknown) =>
    request<ApiResponse<{ recorded: boolean; panelComplete: boolean; medianScore: number | null }>>(
      'POST', `/verification/panels/${panelId}/score`, signedBody,
    ),

  // Court — challenge + jury duty
  getActiveCases: () =>
    request<ApiResponse<{ cases: ActiveCaseSummary[] }>>('GET', '/court/cases'),

  // Get full case detail. Includes the argument log alongside the jury panel.
  getCase: (caseId: string) =>
    request<ApiResponse<{ case: CaseHeader; jury: JurorRow[]; votesRevealed: boolean; arguments: CaseArgument[] }>>('GET', `/court/cases/${caseId}`),

  // Submit an argument or rebuttal on a case (signed; backend gates submitter
  // to challenger or defendant — jurors and onlookers cannot post).
  submitCaseArgument: (caseId: string, signedBody: unknown) =>
    request<ApiResponse<{ argument: CaseArgument }>>('POST', `/court/cases/${caseId}/arguments`, signedBody),

  fileChallenge: (signedBody: unknown) =>
    request<ApiResponse<{ case: CaseHeader }>>('POST', '/court/challenges', signedBody),

  // Cases assigned to this miner as a juror.
  getJuryDuty: (accountId: string) =>
    request<ApiResponse<{ assignments: JuryAssignment[] }>>('GET', `/court/jury-duty/${accountId}`),

  // Submit a sealed vote on an assigned case (signed).
  submitVote: (caseId: string, signedBody: unknown) =>
    request<ApiResponse<{ recorded: boolean; verdict: string | null }>>(
      'POST', `/court/cases/${caseId}/vote`, signedBody,
    ),

  // Auth-required: only the account being verified can submit its own evidence.
  submitEvidence: (envelope: { accountId: string; timestamp: number; signature: string; payload: { evidenceTypeId: string; evidenceHash: string } }) =>
    request<ApiResponse<unknown>>('POST', '/miners/evidence', envelope),

  getEvidenceScore: (accountId: string) =>
    request<ApiResponse<EvidenceScore>>('GET', `/miners/evidence/score/${accountId}`),

  // Vouches (WP v2: percentage-based).
  // The voucher signs `{ vouchedId, stakePercent }` — the backend computes
  // the actual locked amount from the voucher's total holdings.
  submitVouch: (envelope: { accountId: string; timestamp: number; signature: string; payload: { vouchedId: string; stakePercent: number } }) =>
    request<ApiResponse<unknown>>('POST', '/miners/vouches', envelope),

  getVouches: (accountId: string) =>
    request<ApiResponse<VouchData>>('GET', `/miners/vouches/${accountId}`),

  // Vouch Requests
  // Auth-required: the requestor (signed account) is the fromId.
  sendVouchRequest: (envelope: { accountId: string; timestamp: number; signature: string; payload: { toId: string; message: string } }) =>
    request<ApiResponse<unknown>>('POST', '/miners/vouch-requests', envelope),

  getVouchRequests: (accountId: string) =>
    request<ApiResponse<VouchRequests>>('GET', `/miners/vouch-requests/${accountId}`),

  // Auth-required: only the request's recipient (toId) can respond.
  updateVouchRequest: (id: string, envelope: { accountId: string; timestamp: number; signature: string; payload: { status: 'accepted' | 'declined' } }) =>
    request<ApiResponse<unknown>>('PUT', `/miners/vouch-requests/${id}`, envelope),

  // Network
  getNetworkStatus: () =>
    request<ApiResponse<NetworkStatus>>('GET', '/network/status'),

  // Court (future endpoints, graceful failure)
  getCourtCases: (accountId: string) =>
    request<ApiResponse<{ cases: CourtCase[] }>>('GET', `/court/cases/${accountId}`).catch(() => ({ success: false, data: { cases: [] } })),
};
