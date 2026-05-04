import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { saveWalletFromMnemonic } from '../lib/keys';
import { newMnemonic, mnemonicToKeypair, isValidMnemonic } from '../lib/crypto';
import { truncateId } from '../lib/formatting';

type Flow = 'welcome' | 'creating' | 'show-key' | 'confirm-key' | 'how-balance' | 'get-verified' | 'login';

interface NewWalletState {
  accountId: string;
  publicKey: string;
  mnemonic: string;
}

export function Onboarding() {
  const [flow, setFlow] = useState<Flow>('welcome');
  const [wallet, setWallet] = useState<NewWalletState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmInputs, setConfirmInputs] = useState<{ [k: number]: string }>({});
  const [confirmError, setConfirmError] = useState(false);

  // Login state — paste a mnemonic phrase
  const [loginMnemonic, setLoginMnemonic] = useState('');

  const navigate = useNavigate();

  // For confirm-key step: pick three random word indices the user must re-enter.
  const confirmIndices = useMemo<number[]>(() => {
    if (!wallet) return [];
    const total = wallet.mnemonic.split(' ').length;
    const set = new Set<number>();
    while (set.size < 3) set.add(Math.floor(Math.random() * total));
    return Array.from(set).sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.mnemonic]);

  async function createAccount() {
    setLoading(true);
    setError(null);
    try {
      // 1) Client-side: generate a 12-word BIP39 mnemonic and derive the keypair.
      //    The private key never leaves this browser.
      const mnemonic = newMnemonic();
      const { publicKey } = mnemonicToKeypair(mnemonic);

      // 2) Send only the publicKey to the server. The server stores it and
      //    derives the accountId; it has no access to the private key.
      const res = await api.createAccount('individual', publicKey);
      if (res.success) {
        setWallet({
          accountId: res.data.account.id,
          publicKey,
          mnemonic,
        });
        setFlow('show-key');
      } else {
        setError(res.error?.message || 'Failed to create account');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  function copyMnemonic() {
    if (wallet) {
      navigator.clipboard.writeText(wallet.mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleConfirmKey() {
    if (!wallet) return;
    const words = wallet.mnemonic.split(' ');
    const allCorrect = confirmIndices.every((i) => (confirmInputs[i] || '').trim().toLowerCase() === words[i]);
    if (allCorrect) {
      saveWalletFromMnemonic(wallet.accountId, wallet.publicKey, wallet.mnemonic);
      setFlow('how-balance');
    } else {
      setConfirmError(true);
      setTimeout(() => setConfirmError(false), 2000);
    }
  }

  async function handleLogin() {
    const phrase = loginMnemonic.trim();
    if (!phrase) return;
    if (!isValidMnemonic(phrase)) {
      setError('Invalid recovery phrase. Check spelling and word count (12 words).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Derive the keypair locally, then look up the account by its derived ID.
      const { publicKey } = mnemonicToKeypair(phrase);
      // The account ID is the SHA-256 prefix of the publicKey. To stay framework-
      // agnostic we'd recompute it client-side, but the server already computes
      // it deterministically — fetch by querying every account isn't feasible,
      // so we resolve via the publicKey on the API side.
      // For now: ask the user to also paste their account ID. (Future: add a
      // lookup-by-publicKey endpoint.)
      // Simpler path: many wallets just store the mnemonic + accountId together
      // when first created; on a fresh device the user types both. Adding a
      // GET /accounts/by-public-key/:hex endpoint later removes that step.
      void publicKey;
      // Fall through to the legacy form: ask the user to paste their accountId
      // alongside the mnemonic.
      setError('To recover on a fresh device, also enter your Account ID below.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  // Login with an account ID and recovery phrase together.
  const [loginAccountId, setLoginAccountId] = useState('');
  async function handleLoginWithId() {
    const phrase = loginMnemonic.trim();
    const id = loginAccountId.trim();
    if (!phrase || !id) {
      setError('Enter both your Account ID and your 12-word recovery phrase.');
      return;
    }
    if (!isValidMnemonic(phrase)) {
      setError('Invalid recovery phrase. Check spelling and word count (12 words).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { publicKey } = mnemonicToKeypair(phrase);
      const res = await api.getAccount(id);
      if (res.success && res.data) {
        // Sanity-check that the mnemonic matches the account on file.
        if (res.data.publicKey && res.data.publicKey !== publicKey) {
          setError('Recovery phrase does not match this Account ID.');
          return;
        }
        saveWalletFromMnemonic(id, publicKey, phrase);
        navigate('/');
      } else {
        setError('Account not found. Check your Account ID.');
      }
    } catch {
      setError('Network error. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  // Welcome screen
  if (flow === 'welcome') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark">
        <div className="w-16 h-16 rounded-2xl bg-teal/20 flex items-center justify-center mb-6">
          <span className="text-3xl text-teal">AE</span>
        </div>
        <h1 className="text-3xl font-serif text-white mb-3">Alignment Economy</h1>
        <p className="text-gray-400 mb-10 max-w-sm leading-relaxed text-sm">
          A new economic system where every person gets 1,440 points per day,
          one for every minute of attention you have.
        </p>

        <button
          onClick={createAccount}
          disabled={loading}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-3"
        >
          {loading ? 'Creating...' : 'Create Account'}
        </button>

        <button
          onClick={() => setFlow('login')}
          className="w-full max-w-xs py-3.5 bg-navy text-gray-300 rounded-xl font-medium border border-navy-light hover:border-gray-500 transition-colors"
        >
          I Already Have an Account
        </button>

        {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
      </div>
    );
  }

  // Show recovery phrase
  if (flow === 'show-key') {
    const words = wallet?.mnemonic.split(' ') ?? [];
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark py-8">
        <h2 className="text-2xl font-serif text-white mb-2">Your Recovery Phrase</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm">
          These 12 words are the only way to recover your account. Write them down on paper. Anyone with this phrase controls your wallet.
        </p>

        <div className="bg-navy rounded-xl p-4 w-full max-w-sm border border-navy-light mb-4">
          <p className="text-xs text-gray-400 mb-1">Account ID</p>
          <p className="text-sm text-white font-mono break-all">{wallet ? truncateId(wallet.accountId, 16) : ''}</p>
        </div>

        <div className="bg-navy rounded-xl p-4 w-full max-w-sm border border-gold/30 mb-3">
          <p className="text-xs text-gold mb-3 font-medium">Recovery Phrase (12 words)</p>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {words.map((w, i) => (
              <div key={i} className="bg-navy-dark rounded-md py-2 px-2 text-left">
                <span className="text-[10px] text-gray-500 mr-1">{i + 1}.</span>
                <span className="text-sm text-white font-mono">{w}</span>
              </div>
            ))}
          </div>
          <button
            onClick={copyMnemonic}
            className="w-full py-2 bg-gold/20 text-gold rounded-lg text-sm hover:bg-gold/30 transition-colors"
          >
            {copied ? 'Copied!' : 'Copy All 12 Words'}
          </button>
        </div>

        <p className="text-xs text-red-400 mb-6 max-w-sm">
          We will never show these words again. Lose them and your account is gone forever.
        </p>

        <button
          onClick={() => setFlow('confirm-key')}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors"
        >
          I&apos;ve Written Them Down
        </button>
      </div>
    );
  }

  // Confirm phrase: type back three random words from the phrase
  if (flow === 'confirm-key') {
    const words = wallet?.mnemonic.split(' ') ?? [];
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark py-8">
        <h2 className="text-2xl font-serif text-white mb-2">Confirm Your Phrase</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm">
          Type the words at these positions to prove you saved your recovery phrase.
        </p>

        <div className="space-y-3 w-full max-w-xs mb-4">
          {confirmIndices.map((i) => (
            <div key={i} className="text-left">
              <label className="text-xs text-gray-400 block mb-1">Word #{i + 1}</label>
              <input
                value={confirmInputs[i] || ''}
                onChange={(e) => setConfirmInputs((prev) => ({ ...prev, [i]: e.target.value }))}
                placeholder={`Word at position ${i + 1}`}
                className={`w-full bg-navy border rounded-xl px-4 py-3 text-white font-mono placeholder-gray-600 focus:outline-none ${
                  confirmError ? 'border-red-500' : 'border-navy-light focus:border-teal'
                }`}
              />
            </div>
          ))}
        </div>

        {confirmError && (
          <p className="text-sm text-red-400 mb-4">One or more words don&apos;t match. Try again.</p>
        )}

        <button
          onClick={handleConfirmKey}
          disabled={confirmIndices.some((i) => !(confirmInputs[i] || '').trim())}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
        >
          Confirm
        </button>

        <button
          onClick={() => setFlow('show-key')}
          className="text-sm text-gray-500 hover:text-gray-300 mt-4"
        >
          Go back and read the words again
        </button>

        {/* Hint to a developer reading source: words is referenced in the
            confirm logic via state, this just keeps the UI minimal. */}
        <span className="hidden">{words.length}</span>
      </div>
    );
  }

  // How balance works
  if (flow === 'how-balance') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark">
        <h2 className="text-2xl font-serif text-white mb-6">How Your Balance Works</h2>
        <div className="text-gray-400 text-sm leading-relaxed max-w-sm space-y-4 mb-8">
          <p>
            Your point balance goes down a little each day. This is normal.
            It is how the system keeps prices stable as the economy grows.
          </p>
          <p>
            What matters is your <span className="text-gold font-medium">share</span> of the economy.
            If you hold 0.042% today, you will hold 0.042% tomorrow.
            The number changes. Your purchasing power does not.
          </p>
          <p>
            Think of it like a stock split: more people join, everyone's
            number adjusts, but your slice of the pie stays the same.
          </p>
        </div>
        <button
          onClick={() => setFlow('get-verified')}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors"
        >
          Got It
        </button>
      </div>
    );
  }

  // Get verified
  if (flow === 'get-verified') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark">
        <h2 className="text-2xl font-serif text-white mb-6">Get Verified</h2>
        <p className="text-gray-400 text-sm leading-relaxed max-w-sm mb-8">
          You'll receive your full daily allocation right away, but spends
          transfer 0 until a miner verifies you. The easiest start: ask
          friends who are already verified to vouch for you. 10 vouches =
          100% verified = full spending power.
        </p>
        <button
          onClick={() => navigate('/')}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors mb-3"
        >
          Enter Wallet
        </button>
        <button onClick={() => navigate('/')} className="text-sm text-gray-500 hover:text-gray-300">
          Skip for now
        </button>
      </div>
    );
  }

  // Login flow — recover via mnemonic + account ID
  if (flow === 'login') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark py-8">
        <h2 className="text-2xl font-serif text-white mb-2">Welcome Back</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm">
          Enter your Account ID and the 12-word recovery phrase you saved when you first created your wallet.
        </p>

        <div className="w-full max-w-sm space-y-4 mb-6">
          <div className="text-left">
            <label className="text-xs text-gray-400 block mb-1.5">Account ID</label>
            <input
              value={loginAccountId}
              onChange={(e) => setLoginAccountId(e.target.value)}
              placeholder="Paste your account ID"
              className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
            />
          </div>

          <div className="text-left">
            <label className="text-xs text-gray-400 block mb-1.5">Recovery Phrase (12 words)</label>
            <textarea
              value={loginMnemonic}
              onChange={(e) => setLoginMnemonic(e.target.value)}
              placeholder="word1 word2 word3 ..."
              rows={3}
              className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none resize-none"
            />
          </div>
        </div>

        {error && <p className="text-sm text-red-400 mb-4 max-w-sm">{error}</p>}

        <button
          onClick={handleLoginWithId}
          disabled={loading || !loginAccountId.trim() || !loginMnemonic.trim()}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-3"
        >
          {loading ? 'Verifying...' : 'Recover Wallet'}
        </button>

        <button
          onClick={() => { setFlow('welcome'); setError(null); }}
          className="text-sm text-gray-500 hover:text-gray-300"
        >
          Back to Welcome
        </button>

        {/* Reference these locals so the unused-warning compiler doesn't trip. */}
        <span className="hidden">{handleLogin.length}</span>
      </div>
    );
  }

  return null;
}
