import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { saveMinerWalletFromMnemonic, saveMinerWallet } from '../lib/keys';
import { newMnemonic, mnemonicToKeypair, isValidMnemonic, signPayload } from '../lib/crypto';

type Mode = 'signin' | 'create';
type Step =
  | 'enter_id'
  | 'checking'
  | 'not_miner'
  | 'registering'
  | 'learn_recovery'
  | 'show_key'
  | 'creating'
  | 'error';

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('signin');
  const [accountId, setAccountId] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [publicKey, setPublicKey] = useState('');
  // Held in-memory only between Create and Register; never persisted as raw.
  // Used to sign the /miners/register handshake.
  const [_privateKey, setPrivateKey] = useState('');
  const [step, setStep] = useState<Step>('enter_id');
  const [error, setError] = useState('');
  const [keyAcknowledged, setKeyAcknowledged] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setStep('enter_id');
    setError('');
    setAccountId('');
    setMnemonic('');
    setPrivateKey('');
    setPublicKey('');
    setKeyAcknowledged(false);
  }

  async function handleLogin() {
    if (!accountId.trim() || !mnemonic.trim()) {
      setError('Enter your Account ID and 12-word recovery phrase');
      return;
    }
    if (!isValidMnemonic(mnemonic.trim())) {
      setError('Invalid recovery phrase. Check spelling and word count (12 words).');
      return;
    }
    setError('');
    setStep('checking');

    try {
      const accountRes = await api.getAccount(accountId.trim());
      if (!accountRes.success) {
        setError('Account not found. Make sure you have a valid AE account.');
        setStep('enter_id');
        return;
      }

      // Derive keypair locally and verify it matches the account on file.
      const kp = mnemonicToKeypair(mnemonic.trim());
      if (accountRes.data.publicKey && accountRes.data.publicKey !== kp.publicKey) {
        setError('Recovery phrase does not match this Account ID.');
        setStep('enter_id');
        return;
      }

      const minerRes = await api.getMinerStatus(accountId.trim());
      if (minerRes.success && minerRes.data.isMiner) {
        saveMinerWalletFromMnemonic(accountId.trim(), kp.publicKey, mnemonic.trim());
        navigate('/');
        return;
      }

      // Hold onto the derived keys so the register step doesn't need to redo it.
      setPublicKey(kp.publicKey);
      setPrivateKey(kp.privateKey);
      setStep('not_miner');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to node. Is it running?');
      setStep('enter_id');
    }
  }

  // Create new account → generate mnemonic locally → register as miner
  async function handleCreate() {
    setError('');
    setStep('creating');

    try {
      // Client custody: never let the private key cross the network.
      const phrase = newMnemonic();
      const kp = mnemonicToKeypair(phrase);

      const res = await api.createAccount('individual', kp.publicKey);
      if (!res.success) {
        setError(res.error?.message || 'Account creation failed');
        setStep('enter_id');
        return;
      }
      setAccountId(res.data.account.id);
      setPublicKey(kp.publicKey);
      setPrivateKey(kp.privateKey);
      setMnemonic(phrase);
      // Route through the recovery-phrase explainer first instead of
      // dropping the user straight onto 12 words. Same pattern the
      // wallet uses on first-launch onboarding (Onboarding.tsx
      // 'learn-recovery'). Most non-technical users have never seen
      // a BIP-39 phrase before.
      setStep('learn_recovery');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to node. Is it running?');
      setStep('enter_id');
    }
  }

  /**
   * Sign in with a genesis validator keystore.
   *
   * Genesis keystores hold a raw ML-DSA keypair produced by generateKeyPair(),
   * with no BIP39 mnemonic anywhere in the file, so the accountId + phrase form
   * can never accept one — no phrase reproduces that public key. Validators
   * were locked out of the miner entirely as a result.
   *
   * The file's top-level publicKey/secretKey are the Ed25519 NODE identity used
   * for P2P. The ML-DSA ACCOUNT keypair the API signs with lives under
   * `account`, which is what we persist. Getting those two confused would
   * produce a wallet that looks fine and fails every signed request.
   */
  async function handleKeystoreSignIn(file: File): Promise<void> {
    setError('');
    setStep('checking');
    try {
      const parsed = JSON.parse(await file.text());
      const id: unknown = parsed?.accountId;
      const pub: unknown = parsed?.account?.publicKey;
      const priv: unknown = parsed?.account?.privateKey;

      if (typeof id !== 'string' || typeof pub !== 'string' || typeof priv !== 'string') {
        throw new Error(
          "That file doesn't look like a validator keystore. Expected accountId plus account.publicKey and account.privateKey.",
        );
      }

      // Confirm the node actually knows this account before persisting, and
      // that the key matches. Otherwise a keystore from a different network
      // yields a wallet that signs perfectly and is rejected by every route.
      const res = await api.getAccount(id);
      if (!res.success || !res.data) {
        throw new Error(
          `This node has no account ${id.slice(0, 12)}…. Check the keystore is for this network.`,
        );
      }
      if (res.data.publicKey && res.data.publicKey !== pub) {
        throw new Error('This keystore does not match that account on this node.');
      }

      saveMinerWallet({ accountId: id, publicKey: pub, privateKey: priv });
      setAccountId(id);
      setPublicKey(pub);
      setPrivateKey(priv);

      // Same branch the phrase path takes: already a miner goes straight in,
      // otherwise offer registration.
      const status = await api.getMinerStatus(id);
      if (status.success && status.data?.isMiner) {
        navigate('/');
        return;
      }
      setStep('not_miner');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that keystore.');
      setStep('enter_id');
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
  function explainRegisterFailure(code?: string, raw?: string): string {
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

  async function handleRegister() {
    setStep('registering');
    setError('');

    // Save the wallet locally and head to the dashboard. Used both on a fresh
    // miners/register success and when the backend says we're already a miner
    // (409). In either case the on-chain state is valid; we just need the
    // local wallet persisted so the dashboard can sign requests.
    const persistAndEnter = () => {
      // Two custody shapes reach here. Mnemonic accounts store the phrase and
      // re-derive keys on load. Validator keystores have no phrase at all, so
      // they take the raw-key path — storing them as a v2 wallet with an empty
      // mnemonic would write a record that parseStoredWallet cannot read back
      // (it needs either a mnemonic or a privateKey), locking the user out
      // immediately after a successful registration.
      if (mnemonic) {
        saveMinerWalletFromMnemonic(accountId.trim(), publicKey, mnemonic);
      } else {
        saveMinerWallet({ accountId: accountId.trim(), publicKey, privateKey: _privateKey });
      }
      navigate('/');
    };

    try {
      // /miners/register is now auth-required: the registrant signs an
      // empty payload with their private key to prove key possession.
      // _privateKey is in state from the create-account or sign-in flow.
      const ts = Math.floor(Date.now() / 1000);
      const payload = {};
      const signature = signPayload(payload, ts, _privateKey);
      const res = await api.registerMiner({
        accountId: accountId.trim(),
        timestamp: ts,
        signature,
        payload,
      });
      if (res.success) {
        persistAndEnter();
      } else {
        setError(explainRegisterFailure(res.error?.code, res.error?.message));
        setStep('not_miner');
      }
    } catch (err) {
      // The API client throws on non-2xx responses. The 409 case is benign:
      // the account is already a registered miner (e.g. user reinstalled, or
      // hit register twice). Treat it as success — same destination state.
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409') && msg.toLowerCase().includes('already registered')) {
        persistAndEnter();
        return;
      }
      setError(explainRegisterFailure(undefined, msg));
      setStep('not_miner');
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-teal/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-9 h-9 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">AE Miner</h1>
          <p className="text-sm text-muted mt-1">Proof of Human Verification Network</p>
        </div>

        {/* Card */}
        <div className="bg-panel border border-border rounded-xl p-6">
          {/* Mode tabs — visible during the entry step only */}
          {step === 'enter_id' && (
            <div className="flex gap-1 mb-6 p-1 bg-bg rounded-lg border border-border">
              <button
                onClick={() => switchMode('signin')}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  mode === 'signin' ? 'bg-teal/20 text-teal' : 'text-muted hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                onClick={() => switchMode('create')}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  mode === 'create' ? 'bg-teal/20 text-teal' : 'text-muted hover:text-white'
                }`}
              >
                Create Account
              </button>
            </div>
          )}

          {/* SIGN IN */}
          {(step === 'enter_id' || step === 'checking') && mode === 'signin' && (
            <>
              <h2 className="text-lg font-semibold mb-1">Sign In</h2>
              <p className="text-sm text-muted mb-6">
                Enter your Account ID and 12-word recovery phrase. We&apos;ll derive your keys locally; the phrase never leaves this device.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Account ID</label>
                  <input
                    type="text"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    placeholder="e.g. acc_a1b2c3d4..."
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-muted/40 focus:outline-none focus:border-teal transition-colors"
                    disabled={step === 'checking'}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Recovery Phrase (12 words)</label>
                  <textarea
                    value={mnemonic}
                    onChange={(e) => setMnemonic(e.target.value)}
                    placeholder="word1 word2 word3 ..."
                    rows={3}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-muted/40 focus:outline-none focus:border-teal transition-colors resize-none"
                    disabled={step === 'checking'}
                  />
                  <p className="text-[10px] text-muted/60 mt-1">Stays on this device. Server only sees the derived public key.</p>
                </div>
              </div>

              {error && (
                <div className="mt-4 p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>
              )}

              <button
                onClick={handleLogin}
                disabled={step === 'checking'}
                className="w-full mt-6 py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {step === 'checking' ? 'Checking...' : 'Sign In'}
              </button>

              {/* Validator keystore sign-in.
                  Genesis keystores hold a raw ML-DSA keypair from
                  generateKeyPair() and have no BIP39 mnemonic, so no phrase can
                  ever reproduce their public key and the form above can never
                  accept one. That left every genesis validator unable to sign
                  into the miner at all: their account exists on-chain, funded
                  and at 100% human, and the app had no door for it.

                  The raw-key persistence path (saveMinerWallet) already
                  existed and parseStoredWallet already handled the resulting
                  shape — the only thing missing was a way to reach them. */}
              <div className="mt-6 pt-5 border-t border-border">
                <p className="text-xs font-medium text-muted mb-1.5">
                  Running a validator? Use your keystore
                </p>
                <p className="text-[10px] text-muted/60 mb-2.5 leading-relaxed">
                  The private <span className="font-mono">.json</span> file from the genesis
                  ceremony. Validator accounts have no recovery phrase, so this is how
                  they sign in. It stays on this device.
                </p>
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleKeystoreSignIn(f);
                    e.target.value = '';
                  }}
                  disabled={step === 'checking'}
                  className="w-full text-xs text-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-teal/20 file:text-teal hover:file:bg-teal/30 file:cursor-pointer"
                />
              </div>
            </>
          )}

          {/* CREATE ACCOUNT */}
          {step === 'enter_id' && mode === 'create' && (
            <>
              <h2 className="text-lg font-semibold mb-1">Create a Miner Account</h2>
              <p className="text-sm text-muted mb-6">
                We&apos;ll generate a new AE account, show you its private key, and register it as a miner so you can start verifying.
              </p>

              <div className="bg-bg rounded-lg border border-border p-4 mb-6">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">What miners do</h3>
                <ul className="space-y-2 text-sm text-muted">
                  <li className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-teal mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Verify that accounts belong to real humans
                  </li>
                  <li className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-teal mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Serve on juries for dispute resolution
                  </li>
                  <li className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-teal mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Earn points from verification fees and the lottery
                  </li>
                </ul>
              </div>

              {error && (
                <div className="mb-4 p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>
              )}

              <button
                onClick={handleCreate}
                className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors"
              >
                Create Account
              </button>
            </>
          )}

          {/* CREATING (spinner) */}
          {step === 'creating' && (
            <div className="text-center py-8">
              <svg className="w-8 h-8 animate-spin text-teal mx-auto mb-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm text-muted">Generating your account...</p>
            </div>
          )}

          {/* LEARN RECOVERY (educational gate before the 12 words appear).
              Mirrors the wallet's onboarding 'learn-recovery' screen so
              first-time miners get the same four warnings before they
              see the phrase. */}
          {step === 'learn_recovery' && (
            <>
              <div className="text-center mb-6">
                <div className="w-12 h-12 rounded-full bg-gold/15 flex items-center justify-center mx-auto mb-3">
                  <span className="text-xl text-gold font-semibold">!</span>
                </div>
                <h2 className="text-lg font-semibold">Before you see your phrase</h2>
                <p className="text-sm text-muted mt-1">
                  We&apos;re about to show you 12 words. They&apos;re the most important part of using this miner. Read this first.
                </p>
              </div>

              <div className="space-y-2.5 mb-5">
                <div className="bg-bg border border-border rounded-lg p-3">
                  <p className="text-sm font-medium text-white mb-0.5">It&apos;s the only key to your account</p>
                  <p className="text-xs text-muted leading-relaxed">
                    The 12 words ARE your account. Anyone with these words can move your funds and impersonate your verifications. Treat them like cash, not a password.
                  </p>
                </div>
                <div className="bg-bg border border-border rounded-lg p-3">
                  <p className="text-sm font-medium text-white mb-0.5">No one can reset it</p>
                  <p className="text-xs text-muted leading-relaxed">
                    We don&apos;t have your phrase. No support team, no company, no Anthropic, no Anyone. If you lose it, the account is gone forever and your miner reputation goes with it.
                  </p>
                </div>
                <div className="bg-bg border border-border rounded-lg p-3">
                  <p className="text-sm font-medium text-white mb-0.5">Write it on paper</p>
                  <p className="text-xs text-muted leading-relaxed">
                    Pen and paper. Two copies in different places. Don&apos;t take a screenshot, don&apos;t email it to yourself, don&apos;t save it in your notes app. If a phone or laptop gets stolen, the words go with it.
                  </p>
                </div>
                <div className="bg-bg border border-border rounded-lg p-3">
                  <p className="text-sm font-medium text-white mb-0.5">You&apos;ll need it on a new device</p>
                  <p className="text-xs text-muted leading-relaxed">
                    Switching laptops or reinstalling? These 12 words plus your Account ID are how you get back in. Without them, you start over.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setStep('show_key')}
                className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors"
              >
                I&apos;m ready, show me the words
              </button>

              <p className="text-[11px] text-muted/70 mt-3 text-center">
                Find a pen and paper before you continue.
              </p>

              <button
                onClick={() => setStep('enter_id')}
                className="w-full text-center text-sm text-muted hover:text-white mt-3"
              >
                Back
              </button>
            </>
          )}

          {/* SHOW KEY (one-time reveal) */}
          {step === 'show_key' && (
            <>
              <div className="text-center mb-6">
                <div className="w-12 h-12 rounded-full bg-red/10 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold">Save Your Recovery Phrase</h2>
                <p className="text-sm text-muted mt-1">
                  These 12 words are the only way to recover your account. Write them on paper.
                </p>
              </div>

              <div className="space-y-3 mb-5">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-muted">Account ID</label>
                    <button onClick={() => copyToClipboard(accountId)} className="text-xs text-teal hover:underline">Copy</button>
                  </div>
                  <div className="bg-bg border border-border rounded-lg px-3 py-2 text-xs font-mono text-white break-all">
                    {accountId}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-muted">Recovery Phrase (12 words)</label>
                    <button onClick={() => copyToClipboard(mnemonic)} className="text-xs text-teal hover:underline">Copy</button>
                  </div>
                  <div className="bg-bg border border-red/30 rounded-lg p-2 grid grid-cols-3 gap-1.5">
                    {mnemonic.split(' ').map((w, i) => (
                      <div key={i} className="bg-panel/50 rounded px-1.5 py-1 text-left">
                        <span className="text-[10px] text-muted mr-1">{i + 1}.</span>
                        <span className="text-xs font-mono text-white">{w}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-red/80 mt-1">Anyone with these 12 words can move your funds. Store offline.</p>
                </div>
              </div>

              <label className="flex items-start gap-2 mb-5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={keyAcknowledged}
                  onChange={(e) => setKeyAcknowledged(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-xs text-muted">
                  I&apos;ve written down my 12-word phrase somewhere safe. I understand it can&apos;t be recovered.
                </span>
              </label>

              {error && (
                <div className="mb-4 p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>
              )}

              <button
                onClick={handleRegister}
                disabled={!keyAcknowledged}
                className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Register as Miner
              </button>

              <button
                onClick={() => setStep('learn_recovery')}
                className="w-full text-center text-sm text-muted hover:text-white mt-3"
              >
                Back
              </button>
            </>
          )}

          {/* NOT_MINER (existing account, needs miner registration) */}
          {(step === 'not_miner' || step === 'registering') && (
            <>
              <div className="text-center mb-6">
                <div className="w-12 h-12 rounded-full bg-gold/10 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold">Not a Miner Yet</h2>
                <p className="text-sm text-muted mt-1">
                  Account <span className="font-mono text-xs text-white">{accountId.slice(0, 12)}...</span> exists but is not registered as a miner.
                </p>
              </div>

              {error && (
                <div className="mb-4 p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => { setStep('enter_id'); setError(''); }}
                  className="flex-1 py-2.5 bg-white/5 text-muted border border-border rounded-lg text-sm font-medium hover:text-white transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleRegister}
                  disabled={step === 'registering'}
                  className="flex-1 py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
                >
                  {step === 'registering' ? 'Registering...' : 'Register as Miner'}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted/50 mt-6">
          Alignment Economy Protocol v0.9
        </p>
      </div>
    </div>
  );
}
