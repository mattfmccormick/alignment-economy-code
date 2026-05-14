// Modal shown when the platform-server returns 401 (session token
// expired or revoked). Re-prompts the user for their password (and a
// 6-digit TOTP code if 2FA is on) and calls /signin to refresh the
// session. On success the caller saves the fresh session and retries
// whatever it was doing.
//
// Self-custody users never see this modal — their AE private key is
// in localStorage and never expires.
//
// Why a modal instead of a route: the user is mid-task on some page
// (toggling 2FA, viewing account info). Routing them away to /signin
// and back would lose their place. The modal sits on top of the
// current screen so they pick up where they left off.

import { useState } from 'react';
import { PlatformError, type PlatformSession } from '@alignmenteconomy/sdk';
import { platformClient } from '../lib/platform';

interface Props {
  /** Email of the signed-in user. Pre-filled; not editable. */
  email: string;
  /** Called once /signin returns a fresh session. Caller should save it
   *  via `savePlatformSession(sessionFromSdk(email, s))`. */
  onSuccess: (s: PlatformSession) => void;
  /** Called when the user backs out. They might choose to keep using
   *  the wallet in read-only mode (AE protocol still works) or to
   *  fully sign out from the More page. */
  onCancel: () => void;
}

export function SessionReauthModal({ email, onSuccess, onCancel }: Props) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // The first /signin call without a code reveals whether 2FA is on
  // (server replies TOTP_REQUIRED). Once we know, we show the code
  // input and re-submit with both password + code.
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!password) {
      setErr('Enter your password.');
      return;
    }
    if (needsCode && code.length < 6) {
      setErr('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      const session = await platformClient().signin({
        email,
        password,
        code: needsCode ? code : undefined,
      });
      onSuccess(session);
    } catch (e) {
      if (e instanceof PlatformError && e.code === 'TOTP_REQUIRED') {
        // Password was right; just need the code now. Don't clear it.
        setNeedsCode(true);
        setErr(null);
      } else if (e instanceof PlatformError && e.code === 'TOTP_INVALID') {
        setErr('That code did not match. Try again.');
      } else if (e instanceof PlatformError && e.httpStatus === 401) {
        setErr('Wrong password.');
      } else {
        setErr(e instanceof Error ? e.message : 'Network error. Is the platform server reachable?');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-navy rounded-2xl p-6 max-w-sm w-full border border-navy-light shadow-xl">
        <h3 className="text-lg font-serif text-white mb-1">Sign in again</h3>
        <p className="text-xs text-gray-400 mb-4">
          Your session expired. Re-enter your password to keep managing your account.
        </p>
        <p className="text-xs text-gray-500 mb-4 truncate">Account: {email}</p>

        <div className="space-y-3">
          {!needsCode && (
            <div>
              <label className="text-xs text-gray-400 block mb-1.5">Password</label>
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="Your password"
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm focus:border-teal focus:outline-none"
              />
            </div>
          )}

          {needsCode && (
            <div>
              <p className="text-xs text-gray-400 mb-2">
                Type the 6-digit code from your authenticator app.
              </p>
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="123456"
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm font-mono tracking-widest text-center focus:border-teal focus:outline-none"
              />
            </div>
          )}

          {err && <p className="text-xs text-red-400">{err}</p>}

          <div className="flex gap-2">
            <button
              onClick={onCancel}
              disabled={busy}
              className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || (!needsCode && !password) || (needsCode && code.length < 6)}
              className="flex-1 py-2 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
            >
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
