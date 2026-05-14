import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { PlatformError } from '@alignmenteconomy/sdk';
import { loadWallet, clearWallet, saveWalletLegacy } from '../lib/keys';
import {
  clearPlatformSession,
  loadPlatformSession,
  platformClient,
  savePlatformSession,
  sessionFromSdk,
  isSessionExpired,
} from '../lib/platform';
import { truncateId } from '../lib/formatting';
import { getTheme, setTheme } from '../lib/theme';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { SessionReauthModal } from '../components/SessionReauthModal';

const links = [
  { to: '/contacts', label: 'Contacts', desc: 'Manage your saved contacts' },
  { to: '/recurring', label: 'Recurring Transfers', desc: 'Automatic scheduled payments' },
  { to: '/history', label: 'Transaction History', desc: 'View all past transactions' },
  { to: '/network', label: 'Network', desc: 'Block explorer and stats' },
  { to: '/court', label: 'Court Cases', desc: 'Active cases involving your account' },
];

export function More() {
  const wallet = loadWallet();
  const [currentTheme, setCurrentTheme] = useState(getTheme());
  const [minerStatus, setMinerStatus] = useState<{ isMiner: boolean; miner: any } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [copied, setCopied] = useState(false);
  // Recovery phrase export. The phrase is the source of truth for the wallet,
  // so we gate behind a confirm step and a clear shoulder-surfing warning.
  const [showPhraseConfirm, setShowPhraseConfirm] = useState(false);
  const [phraseRevealed, setPhraseRevealed] = useState(false);
  const [phraseCopied, setPhraseCopied] = useState(false);

  // Platform-track only: "Switch to self-custody" export flow.
  //   - confirm: warning step before showing the private key
  //   - revealed: private key visible, awaiting the "I've saved it" check
  //   - savedAck: the user has acknowledged saving; flip the wallet to
  //     self-custody on the next click. We then refresh the page so
  //     loadWallet() returns the self-custody copy first.
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false);
  const [switchRevealed, setSwitchRevealed] = useState(false);
  const [switchAck, setSwitchAck] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keepPlatformBackup, setKeepPlatformBackup] = useState(true);

  // ── 2FA / TOTP state ────────────────────────────────────────────────
  // The card has three modes:
  //   - hidden (not a platform user, nothing to show)
  //   - off    (platform user without 2FA, shows "Turn on" button)
  //   - on     (platform user with 2FA, shows "Disable" button)
  //
  // Enroll opens a modal flow:
  //   1. call SDK.enroll2FA -> {secret, otpauthUri}
  //   2. render the URI as a QR (with the manual base32 secret below)
  //   3. user types the 6-digit code from their authenticator
  //   4. call SDK.confirm2FA -> persisted server-side
  //
  // Disable opens a smaller flow: type a current 6-digit code, call disable.
  const [twoFaEnabled, setTwoFaEnabled] = useState<boolean | null>(null);
  const [twoFaError, setTwoFaError] = useState<string | null>(null);
  const [twoFaBusy, setTwoFaBusy] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollSecret, setEnrollSecret] = useState<string | null>(null);
  const [enrollQrUrl, setEnrollQrUrl] = useState<string | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollSecretCopied, setEnrollSecretCopied] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');

  // Session re-auth modal. Opens when the platform server rejects our
  // session token (401) or when we proactively notice the local
  // expiresAt is in the past. The modal re-runs /signin with the user's
  // password (and TOTP if needed) and writes the fresh session back.
  // The pending callback gets re-invoked after a successful refresh so
  // the user doesn't have to click the original button again.
  const [reauthOpen, setReauthOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const platformEmail = wallet?.track === 'platform' ? loadPlatformSession()?.email ?? '' : '';

  useEffect(() => {
    if (wallet?.accountId) {
      api.getMinerStatus(wallet.accountId).then(res => {
        if (res.success && res.data) {
          setMinerStatus(res.data);
        }
      }).catch(() => {});
    }
  }, [wallet?.accountId]);

  /**
   * Wrap a platform-server call with auto-reauth on 401. The wrapped
   * function takes the fresh session token. If the call throws a 401
   * (or the local session is already expired), we open the re-auth
   * modal; once the user signs in again, we re-run `fn` with the new
   * token. If the user cancels, we throw a synthetic abort.
   */
  function withSession<T>(fn: (sessionToken: string) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async (forceFresh = false) => {
        const session = loadPlatformSession();
        if (!session || (forceFresh ? true : isSessionExpired(session))) {
          // Stash the retry as a pending action; the modal will fire
          // it after a successful re-auth.
          setPendingAction(() => () => {
            const s2 = loadPlatformSession();
            if (!s2) { reject(new Error('No session after re-auth')); return; }
            fn(s2.sessionToken).then(resolve).catch(reject);
          });
          setReauthOpen(true);
          return;
        }
        try {
          const result = await fn(session.sessionToken);
          resolve(result);
        } catch (e) {
          if (e instanceof PlatformError && (e.httpStatus === 401 || e.code === 'AUTH_INVALID' || e.code === 'SESSION_EXPIRED')) {
            // Server says the token is no good. Same path as the
            // proactive check above.
            setPendingAction(() => () => {
              const s2 = loadPlatformSession();
              if (!s2) { reject(new Error('No session after re-auth')); return; }
              fn(s2.sessionToken).then(resolve).catch(reject);
            });
            setReauthOpen(true);
          } else {
            reject(e);
          }
        }
      };
      run();
    });
  }

  // Handlers wired to the SessionReauthModal.
  function handleReauthSuccess(s: import('@alignmenteconomy/sdk').PlatformSession) {
    if (!platformEmail) return;
    savePlatformSession(sessionFromSdk(platformEmail, s));
    setReauthOpen(false);
    const action = pendingAction;
    setPendingAction(null);
    if (action) action();
  }

  function handleReauthCancel() {
    setReauthOpen(false);
    setPendingAction(null);
  }

  // Read whether 2FA is on. /me carries the flag so we don't need a
  // separate endpoint. Only relevant for platform users; self-custody
  // wallets don't talk to the platform server.
  //
  // If the session is expired, withSession() opens the re-auth modal.
  // After successful re-auth the call is retried automatically so the
  // 2FA card lands with the right state without the user clicking
  // anything twice.
  useEffect(() => {
    if (wallet?.track !== 'platform') return;
    withSession(token => platformClient().me(token))
      .then(r => setTwoFaEnabled(r.twoFactorEnabled))
      .catch(() => { /* user may have cancelled re-auth; leave as null */ });
    // withSession reads loadPlatformSession() at call time; the effect
    // only needs to re-run when the track changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.track]);

  async function handleStartEnroll() {
    setTwoFaError(null);
    setTwoFaBusy(true);
    try {
      const r = await withSession(token => platformClient().enroll2FA(token));
      setEnrollSecret(r.secret);
      // toDataURL returns a base64-encoded PNG suitable for <img src=>.
      const url = await QRCode.toDataURL(r.otpauthUri, { width: 220, margin: 1 });
      setEnrollQrUrl(url);
      setEnrollCode('');
      setEnrollOpen(true);
    } catch (e) {
      if (e instanceof PlatformError && e.code === 'TOTP_ALREADY_ENABLED') {
        setTwoFaEnabled(true);
        setTwoFaError('Two-factor auth is already on.');
      } else {
        setTwoFaError(e instanceof Error ? e.message : 'Could not start 2FA enrollment.');
      }
    } finally {
      setTwoFaBusy(false);
    }
  }

  async function handleConfirmEnroll() {
    setTwoFaError(null);
    if (!enrollSecret) return;
    if (enrollCode.trim().length < 6) {
      setTwoFaError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setTwoFaBusy(true);
    try {
      await withSession(token => platformClient().confirm2FA(token, enrollSecret, enrollCode.trim()));
      setTwoFaEnabled(true);
      setEnrollOpen(false);
      setEnrollSecret(null);
      setEnrollQrUrl(null);
      setEnrollCode('');
    } catch (e) {
      if (e instanceof PlatformError && e.code === 'TOTP_INVALID') {
        setTwoFaError('That code did not match. Try again.');
      } else {
        setTwoFaError(e instanceof Error ? e.message : 'Could not confirm 2FA.');
      }
    } finally {
      setTwoFaBusy(false);
    }
  }

  function cancelEnroll() {
    setEnrollOpen(false);
    setEnrollSecret(null);
    setEnrollQrUrl(null);
    setEnrollCode('');
    setTwoFaError(null);
  }

  function copyEnrollSecret() {
    if (enrollSecret) {
      navigator.clipboard.writeText(enrollSecret);
      setEnrollSecretCopied(true);
      setTimeout(() => setEnrollSecretCopied(false), 2000);
    }
  }

  async function handleDisable2FA() {
    setTwoFaError(null);
    if (disableCode.trim().length < 6) {
      setTwoFaError('Enter your current 6-digit code to confirm.');
      return;
    }
    setTwoFaBusy(true);
    try {
      await withSession(token => platformClient().disable2FA(token, disableCode.trim()));
      setTwoFaEnabled(false);
      setDisableOpen(false);
      setDisableCode('');
    } catch (e) {
      if (e instanceof PlatformError && e.code === 'TOTP_INVALID') {
        setTwoFaError('That code did not match. Try again.');
      } else {
        setTwoFaError(e instanceof Error ? e.message : 'Could not disable 2FA.');
      }
    } finally {
      setTwoFaBusy(false);
    }
  }

  function toggleTheme() {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setCurrentTheme(next);
  }

  async function handleRegisterMiner() {
    if (!wallet?.accountId) return;
    setRegistering(true);
    try {
      // Sign an empty payload to prove key possession; the route now
      // requires an authenticated caller.
      const ts = Math.floor(Date.now() / 1000);
      const payload = {};
      const signature = signPayload(payload, ts, wallet.privateKey);
      const res = await api.registerMiner({
        accountId: wallet.accountId,
        timestamp: ts,
        signature,
        payload,
      });
      if (res.success) {
        setMinerStatus({ isMiner: true, miner: res.data });
      }
    } catch { /* ignore */ }
    setRegistering(false);
  }

  function copyAccountId() {
    if (wallet?.accountId) {
      navigator.clipboard.writeText(wallet.accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function copyRecoveryPhrase() {
    if (wallet?.mnemonic) {
      navigator.clipboard.writeText(wallet.mnemonic);
      setPhraseCopied(true);
      setTimeout(() => setPhraseCopied(false), 2000);
    }
  }

  function hidePhrase() {
    setPhraseRevealed(false);
    setShowPhraseConfirm(false);
    setPhraseCopied(false);
  }

  function copyPrivateKey() {
    if (wallet?.privateKey) {
      navigator.clipboard.writeText(wallet.privateKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    }
  }

  function hideSwitch() {
    setShowSwitchConfirm(false);
    setSwitchRevealed(false);
    setSwitchAck(false);
    setKeyCopied(false);
  }

  /**
   * Flip the wallet from platform-track to self-custody. Writes a V1
   * self-custody wallet using the same AE keypair, then optionally
   * clears the platform session. Either way the next call to
   * loadWallet() will return self-custody first (because keys.ts checks
   * STORAGE_KEY before the platform session).
   *
   * Important property: this is reversible. The AE account on chain
   * doesn't change. Even if the user later clears their self-custody
   * wallet, they can sign back into the platform with their email and
   * password (as long as the server-side vault is still there).
   */
  function completeSwitchToSelfCustody() {
    if (!wallet) return;
    saveWalletLegacy({
      accountId: wallet.accountId,
      publicKey: wallet.publicKey,
      privateKey: wallet.privateKey,
    });
    if (!keepPlatformBackup) {
      clearPlatformSession();
    }
    // Force a fresh render so the rest of the wallet picks up the new
    // track. Simpler than threading state through every component.
    window.location.href = '/';
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">More</h2>

      {/* Account info */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light">
        <p className="text-xs text-gray-400 mb-1">Account ID</p>
        <div className="flex items-center gap-2">
          <p className="text-sm text-white font-mono flex-1 truncate">{wallet ? truncateId(wallet.accountId, 16) : 'Not connected'}</p>
          <button onClick={copyAccountId} className="text-xs text-teal hover:text-teal-dark shrink-0">
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Track-specific recovery card.
          - Self-custody V2 (mnemonic-derived): existing "Export Recovery
            Phrase" flow, shows 12 words.
          - Self-custody V1 (legacy or post-platform-switch): shows the
            raw private key as the recovery artifact.
          - Platform: shows the "Switch to self-custody" CTA. The export
            writes the same AE keypair as a self-custody wallet so the
            user owns their keys directly from then on. */}
      {wallet?.track === 'platform' ? (
        <div className="bg-navy rounded-xl p-4 border border-navy-light">
          <h3 className="text-sm font-medium text-white mb-1">Switch to self-custody</h3>
          {switchRevealed ? (
            <div className="space-y-3">
              <p className="text-xs text-red-400">
                This is your AE private key. Anyone with these characters controls your account. Do not screenshot, email, or paste it anywhere online.
              </p>
              <p className="text-xs text-gray-400">
                AE uses a post-quantum signature scheme (ML-DSA), so the private key is much longer than a typical crypto key. Don't try to write it on paper. The realistic workflow is: copy it to a trusted password manager (1Password, Bitwarden, Apple Keychain), store it offline on an encrypted drive, or print it on paper and lock it up.
              </p>
              <div className="bg-navy-dark rounded-md p-3 max-h-32 overflow-y-auto break-all font-mono text-[10px] text-white">
                {wallet.privateKey}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={copyPrivateKey}
                  className="flex-1 py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors"
                >
                  {keyCopied ? 'Copied!' : 'Copy private key'}
                </button>
                <button
                  onClick={hideSwitch}
                  className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors"
                >
                  Hide
                </button>
              </div>
              <label className="flex items-start gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={switchAck}
                  onChange={(e) => setSwitchAck(e.target.checked)}
                  className="mt-0.5"
                />
                <span>I have saved my private key somewhere safe. I understand the platform can no longer help me recover this account if I lose it.</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={keepPlatformBackup}
                  onChange={(e) => setKeepPlatformBackup(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Keep my platform account as a backup. (Uncheck to fully leave the platform; you will lose the email-based recovery option.)</span>
              </label>
              <button
                onClick={completeSwitchToSelfCustody}
                disabled={!switchAck}
                className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Switch to self-custody
              </button>
            </div>
          ) : showSwitchConfirm ? (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                Right now your account is on the platform: we hold an encrypted copy and you can reset your password by email. If you switch to self-custody, you will hold the only copy of the key. Lose it, lose the account.
              </p>
              <p className="text-xs text-red-400">
                Make sure no one is looking at your screen before you continue.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSwitchConfirm(false)}
                  className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setSwitchRevealed(true)}
                  className="flex-1 py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors"
                >
                  Show private key
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-400 mb-3">
                You signed up with email and password. The platform holds an encrypted copy of your account, and you can reset your password from the sign-in screen. Switching to self-custody means you hold the only copy of the key: more control, more responsibility.
              </p>
              <button
                onClick={() => setShowSwitchConfirm(true)}
                className="w-full py-2.5 bg-gold/20 text-gold rounded-lg text-sm font-medium hover:bg-gold/30 transition-colors"
              >
                Switch to self-custody
              </button>
            </div>
          )}
        </div>
      ) : (
      <div className="bg-navy rounded-xl p-4 border border-navy-light">
        <h3 className="text-sm font-medium text-white mb-1">Recovery Phrase</h3>
        {wallet?.mnemonic ? (
          phraseRevealed ? (
            <PhraseDisplay
              mnemonic={wallet.mnemonic}
              copied={phraseCopied}
              onCopy={copyRecoveryPhrase}
              onHide={hidePhrase}
            />
          ) : showPhraseConfirm ? (
            <div className="space-y-3">
              <p className="text-xs text-red-400">
                Anyone with these 12 words controls your wallet. Make sure no one is looking at your screen, then continue.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowPhraseConfirm(false)}
                  className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setPhraseRevealed(true)}
                  className="flex-1 py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors"
                >
                  Show Phrase
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-400 mb-3">
                The 12 words from setup are the only way to recover your account on a new device. Export them now if you didn't write them down.
              </p>
              <button
                onClick={() => setShowPhraseConfirm(true)}
                className="w-full py-2.5 bg-gold/20 text-gold rounded-lg text-sm font-medium hover:bg-gold/30 transition-colors"
              >
                Export Recovery Phrase
              </button>
            </div>
          )
        ) : wallet?.privateKey ? (
          // V1 wallet (legacy or post-platform-switch). No mnemonic, so
          // the raw private key is the recovery artifact. Same export
          // pattern as the platform switch flow.
          <div>
            <p className="text-xs text-gray-400 mb-3">
              This wallet doesn't have a 12-word phrase. Your AE private key is the recovery artifact. Keep it safe.
            </p>
            <p className="text-[10px] text-gray-500 break-all font-mono bg-navy-dark rounded p-2">
              {wallet.privateKey.slice(0, 24)}…
            </p>
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            No recovery artifact available for this wallet. To enable it, log out and create a new account.
          </p>
        )}
      </div>
      )}

      {/* Two-factor auth. Platform-track only: self-custody users
          already have an unrecoverable 12-word phrase that is its own
          second factor. */}
      {wallet?.track === 'platform' && (
        <div className="bg-navy rounded-xl p-4 border border-navy-light">
          <h3 className="text-sm font-medium text-white mb-1">Two-factor auth</h3>
          {enrollOpen ? (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                Scan this QR code with Google Authenticator, 1Password, Authy, or any TOTP app. Then type the 6-digit code it shows to confirm.
              </p>
              {enrollQrUrl && (
                <div className="bg-white rounded-md p-3 flex items-center justify-center">
                  <img src={enrollQrUrl} alt="2FA QR code" className="w-44 h-44" />
                </div>
              )}
              <div>
                <p className="text-[10px] text-gray-500 mb-1">Can't scan? Type this into your app:</p>
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-[10px] font-mono text-white bg-navy-dark rounded p-2 break-all">{enrollSecret}</p>
                  <button onClick={copyEnrollSecret} className="text-xs text-teal hover:text-teal-dark shrink-0">
                    {enrollSecretCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1.5">6-digit code from your app</label>
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={enrollCode}
                  onChange={(e) => setEnrollCode(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="123456"
                  className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm font-mono tracking-widest text-center focus:border-teal focus:outline-none"
                />
              </div>
              {twoFaError && <p className="text-xs text-red-400">{twoFaError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={cancelEnroll}
                  disabled={twoFaBusy}
                  className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmEnroll}
                  disabled={twoFaBusy || enrollCode.length < 6}
                  className="flex-1 py-2 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
                >
                  {twoFaBusy ? 'Confirming...' : 'Confirm'}
                </button>
              </div>
            </div>
          ) : disableOpen ? (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                Type your current 6-digit code to turn 2FA off. After this, sign-in only needs your email and password.
              </p>
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="123456"
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm font-mono tracking-widest text-center focus:border-teal focus:outline-none"
              />
              {twoFaError && <p className="text-xs text-red-400">{twoFaError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setDisableOpen(false); setDisableCode(''); setTwoFaError(null); }}
                  disabled={twoFaBusy}
                  className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDisable2FA}
                  disabled={twoFaBusy || disableCode.length < 6}
                  className="flex-1 py-2 bg-red-900/40 text-red-300 rounded-lg text-sm hover:bg-red-900/60 transition-colors disabled:opacity-50"
                >
                  {twoFaBusy ? 'Disabling...' : 'Turn off 2FA'}
                </button>
              </div>
            </div>
          ) : twoFaEnabled === true ? (
            <div>
              <p className="text-xs text-teal mb-1">Two-factor auth is on</p>
              <p className="text-xs text-gray-400 mb-3">
                Sign-in requires a 6-digit code from your authenticator app in addition to your password.
              </p>
              {twoFaError && <p className="text-xs text-red-400 mb-2">{twoFaError}</p>}
              <button
                onClick={() => { setDisableOpen(true); setTwoFaError(null); }}
                className="w-full py-2.5 bg-red-900/30 text-red-300 rounded-lg text-sm font-medium hover:bg-red-900/50 transition-colors"
              >
                Turn off 2FA
              </button>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-400 mb-3">
                Add a second step at sign-in: a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy). Recommended but not required.
              </p>
              {twoFaError && <p className="text-xs text-red-400 mb-2">{twoFaError}</p>}
              <button
                onClick={handleStartEnroll}
                disabled={twoFaBusy || twoFaEnabled === null}
                className="w-full py-2.5 bg-teal/20 text-teal rounded-lg text-sm font-medium hover:bg-teal/30 transition-colors disabled:opacity-50"
              >
                {twoFaBusy ? 'Loading...' : 'Turn on 2FA'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Theme toggle */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light flex items-center justify-between">
        <div>
          <p className="text-sm text-white">Appearance</p>
          <p className="text-xs text-gray-500">{currentTheme === 'dark' ? 'Dark mode' : 'Light mode'}</p>
        </div>
        <button
          onClick={toggleTheme}
          className={`relative w-12 h-7 rounded-full transition-colors ${
            currentTheme === 'light' ? 'bg-teal' : 'bg-navy-light'
          }`}
        >
          <span
            className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
              currentTheme === 'light' ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Navigation links */}
      <div className="space-y-2">
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className="block bg-navy rounded-xl p-4 border border-navy-light hover:border-teal/50 transition-colors"
          >
            <p className="text-sm text-white">{link.label}</p>
            <p className="text-xs text-gray-500">{link.desc}</p>
          </Link>
        ))}
      </div>

      {/* Miner status */}
      <div className="bg-navy rounded-xl p-4 border border-navy-light">
        <h3 className="text-sm font-medium text-white mb-2">Miner Status</h3>
        {minerStatus?.isMiner ? (
          <div>
            <p className="text-xs text-teal mb-1">Registered as a miner</p>
            <p className="text-xs text-gray-500">You can verify other participants' identity to earn rewards.</p>
          </div>
        ) : (
          <div>
            <p className="text-xs text-gray-400 mb-3">
              Miners verify that each account belongs to a real, singular human.
              Register to start earning verification rewards.
            </p>
            <button
              onClick={handleRegisterMiner}
              disabled={registering}
              className="w-full py-2.5 bg-teal/20 text-teal rounded-lg text-sm font-medium hover:bg-teal/30 transition-colors disabled:opacity-50"
            >
              {registering ? 'Registering...' : 'Become a Miner'}
            </button>
          </div>
        )}
      </div>

      <button
        onClick={() => { clearWallet(); window.location.reload(); }}
        className="w-full py-3 bg-red-900/30 text-red-400 rounded-xl text-sm border border-red-900/50 hover:bg-red-900/50 transition-colors"
      >
        Log Out
      </button>

      {reauthOpen && platformEmail && (
        <SessionReauthModal
          email={platformEmail}
          onSuccess={handleReauthSuccess}
          onCancel={handleReauthCancel}
        />
      )}
    </div>
  );
}

interface PhraseDisplayProps {
  mnemonic: string;
  copied: boolean;
  onCopy: () => void;
  onHide: () => void;
}

function PhraseDisplay({ mnemonic, copied, onCopy, onHide }: PhraseDisplayProps) {
  const words = mnemonic.split(' ');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {words.map((w, i) => (
          <div key={i} className="bg-navy-dark rounded-md py-2 px-2 text-left">
            <span className="text-[10px] text-gray-500 mr-1">{i + 1}.</span>
            <span className="text-sm text-white font-mono">{w}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onHide}
          className="flex-1 py-2 bg-navy-light text-gray-300 rounded-lg text-sm hover:bg-navy-dark transition-colors"
        >
          Hide
        </button>
        <button
          onClick={onCopy}
          className="flex-1 py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy 12 Words'}
        </button>
      </div>
      <p className="text-xs text-red-400">
        These words are equivalent to your password. Never type them into a website or share them with anyone.
      </p>
    </div>
  );
}
