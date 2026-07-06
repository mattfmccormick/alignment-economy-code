import { useState } from 'react';
import { unlockWallet } from '../lib/keys';

// Shown at boot when the wallet is encrypted at rest and not yet unlocked this
// session. Decrypts in memory on the correct passphrase, then hands control
// back to the app. A wrong passphrase never destroys anything — the user can
// always fall back to their recovery phrase from the onboarding import flow.
export function UnlockGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    const ok = await unlockWallet(passphrase);
    setBusy(false);
    if (ok) onUnlocked();
    else setError('Incorrect passphrase. Try again.');
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6 bg-navy-dark text-center">
      <div className="w-14 h-14 rounded-2xl bg-teal/20 flex items-center justify-center mb-5">
        <span className="text-2xl text-teal">&#128274;</span>
      </div>
      <h1 className="text-2xl font-serif text-white mb-2">Wallet locked</h1>
      <p className="text-gray-400 text-sm mb-6 max-w-xs">
        Enter your passphrase to unlock this wallet. It never leaves this device.
      </p>

      <input
        type="password"
        autoFocus
        value={passphrase}
        onChange={(e) => { setPassphrase(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="Passphrase"
        className="w-full max-w-xs bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:border-teal focus:outline-none mb-3"
      />

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <button
        onClick={submit}
        disabled={busy || !passphrase}
        className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-4"
      >
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>

      <p className="text-[11px] text-gray-500 max-w-xs">
        Forgot it? Reinstall or clear the app and restore from your 12-word recovery phrase.
      </p>
    </div>
  );
}
