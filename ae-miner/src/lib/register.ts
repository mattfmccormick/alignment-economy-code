import { api } from './api';
import { signMinerRegister, signPayload } from './crypto';

// Miner registration rides the chain: the node accepts the signed operation,
// queues it, and it takes effect when the next block commits (about ten
// seconds on a healthy network). Between "accepted" and "committed" the node
// honestly answers isMiner: false, so the UI needs to remember that a
// registration is in flight or it tells someone who just signed up that they
// are not registered.
const SENT_AT_KEY = 'ae_miner_registration_sent_at';

/** How long a registration may sit before we stop calling it "in progress". */
export const REGISTRATION_STUCK_AFTER_MS = 90_000;

export function markRegistrationSent(): void {
  try { sessionStorage.setItem(SENT_AT_KEY, String(Date.now())); } catch { /* private mode */ }
}

export function clearRegistrationSent(): void {
  try { sessionStorage.removeItem(SENT_AT_KEY); } catch { /* private mode */ }
}

/** Milliseconds since a registration was sent this session, or null if none was. */
export function registrationSentAgoMs(): number | null {
  try {
    const raw = sessionStorage.getItem(SENT_AT_KEY);
    if (!raw) return null;
    const sentAt = Number(raw);
    return Number.isFinite(sentAt) ? Date.now() - sentAt : null;
  } catch {
    return null;
  }
}

/**
 * Turn a register failure into something a person can act on.
 *
 * The raw API string was going straight to the screen, so the single most
 * likely failure for the second person to join a network — being below the
 * percentHuman floor — surfaced as "percentHuman 0 is below the minimum of
 * 50...", which reads as a defect rather than a next step.
 */
export function explainRegisterFailure(code?: string, raw?: string): string {
  if (code === 'PERCENT_HUMAN_TOO_LOW' || (raw ?? '').includes('percentHuman')) {
    return (
      'You need to be verified before you can mine. This network already has ' +
      'enough miners that new ones have to be reviewed first. Open the wallet, ' +
      'go to Verify, and request a review. Once a panel sets your score above ' +
      '50%, come back here and register.'
    );
  }
  if (code === 'NOT_INDIVIDUAL') {
    return 'Only individual accounts can mine. This account is registered as an organisation.';
  }
  if (code === 'NOT_FOUND') {
    return 'That account ID does not exist on this node yet. Check the ID, or create the account in the wallet first.';
  }
  return raw || 'Registration failed.';
}

export type RegisterResult = { ok: true } | { ok: false; message: string };

/**
 * Sign a miner_register operation and hand it to the node.
 *
 * `ok: true` means the node accepted it (or the account is already a miner),
 * NOT that it has committed. Callers show a waiting state until
 * GET /miners/status reports isMiner.
 */
export async function submitMinerRegistration(accountId: string, privateKey: string): Promise<RegisterResult> {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const op = signMinerRegister(accountId, ts, privateKey);
    const payload = { op };
    const signature = signPayload(payload, ts, privateKey);
    const res = await api.registerMiner({ accountId, timestamp: ts, signature, payload });
    if (!res.success) {
      return { ok: false, message: explainRegisterFailure(res.error?.code, res.error?.message) };
    }
    markRegistrationSent();
    return { ok: true };
  } catch (err) {
    // The API client throws on non-2xx. 409 is benign: the account is already
    // a registered miner (reinstall, or register pressed twice).
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('409') && msg.toLowerCase().includes('already registered')) {
      return { ok: true };
    }
    return { ok: false, message: explainRegisterFailure(undefined, msg) };
  }
}
