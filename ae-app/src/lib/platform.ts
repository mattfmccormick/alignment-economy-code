// Wallet-side glue for the platform track.
//
// Holds a singleton PlatformClient pointed at the configured platform
// server URL, plus the localStorage helpers that persist a platform-track
// session (account id, email, session token, expiry, in-memory keys).
//
// The custody track is the alternative; both share the same wallet UI
// once an account exists. Track-specific concerns are owned here so
// callers don't need to think about which path the user took.

import { PlatformClient, type PlatformSession } from '@alignmenteconomy/sdk';

// Where the platform server lives. Local dev default; replace at build
// time for installer packaging. Future Phase 7 turns this into a baked-in
// production URL.
const DEFAULT_PLATFORM_URL =
  (import.meta.env?.VITE_PLATFORM_URL as string | undefined) ?? 'http://localhost:3500/api/v1';

// Whether to OFFER the email + password track at all.
//
// It is only a real product when a hosted account service exists, which is a
// deployment decision: the team that stands one up sets VITE_PLATFORM_URL at
// build time and the option appears. Without that, the only thing answering is
// (at best) a copy of the service on the user's own machine, where email +
// password cannot sign in from a second device or recover a lost computer.
// Offering it there by default made the simplest-looking button the one with
// the worst failure mode, and in a source checkout it just errored. The
// 12-word path needs nothing but a node and works everywhere, so it is the
// default and, until a hosted service exists, the only path shown.
export const PLATFORM_ENABLED = Boolean(import.meta.env?.VITE_PLATFORM_URL);

let _client: PlatformClient | null = null;

export function platformClient(): PlatformClient {
  if (!_client) {
    _client = new PlatformClient({ baseUrl: DEFAULT_PLATFORM_URL });
  }
  return _client;
}

// ── Stored session ──────────────────────────────────────────────────────

const STORAGE_KEY = 'ae_platform_session';

export interface StoredPlatformSession {
  track: 'platform';
  email: string;
  accountId: string;
  sessionToken: string;
  expiresAt: number;
  /** AE private key (hex). Held locally so the wallet can sign without
   *  re-prompting for the password every transaction. Same exposure
   *  surface as the self-custody track which persists this too. */
  privateKey: string;
  /** AE public key (hex). May be empty when restored from /signin (the
   *  server doesn't return it; the wallet can derive on demand). */
  publicKey: string;
}

export function savePlatformSession(s: StoredPlatformSession): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private-mode fallthrough */ }
}

export function loadPlatformSession(): StoredPlatformSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPlatformSession;
    if (parsed?.track !== 'platform' || !parsed.accountId || !parsed.sessionToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPlatformSession(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}

/** True if the stored session is missing or its expiresAt is in the past.
 *  Lets callers short-circuit before hitting the network when we already
 *  know the token won't work. The server is still the source of truth on
 *  expiry; this is purely a UX hint to skip the 401 round-trip. */
export function isSessionExpired(s: StoredPlatformSession | null): boolean {
  if (!s) return true;
  const now = Math.floor(Date.now() / 1000);
  // Treat a session about to expire (< 5s remaining) as expired so we
  // don't race the clock and get a 401 mid-request.
  return s.expiresAt <= now + 5;
}

/** Build a StoredPlatformSession from a fresh signup/signin result. */
export function sessionFromSdk(email: string, s: PlatformSession): StoredPlatformSession {
  return {
    track: 'platform',
    email,
    accountId: s.accountId,
    sessionToken: s.sessionToken,
    expiresAt: s.expiresAt,
    privateKey: s.privateKey,
    publicKey: s.publicKey,
  };
}
