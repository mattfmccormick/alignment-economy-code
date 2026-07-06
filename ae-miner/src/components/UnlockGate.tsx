import { useState } from 'react';
import { unlockMinerWallet } from '../lib/keys';

// Shown at boot when the miner wallet is encrypted at rest and not yet unlocked
// this session. A wrong passphrase never destroys anything — the operator can
// restore from their recovery phrase.
export function UnlockGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    const ok = await unlockMinerWallet(passphrase);
    setBusy(false);
    if (ok) onUnlocked();
    else setError('Incorrect passphrase. Try again.');
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-bg">
      <div className="w-14 h-14 rounded-2xl bg-teal/15 flex items-center justify-center mb-5">
        <span className="text-2xl">&#128274;</span>
      </div>
      <h1 className="text-2xl font-bold text-white mb-2">Node locked</h1>
      <p className="text-muted text-sm mb-6 max-w-xs">
        Enter your passphrase to unlock this miner wallet. It never leaves this device.
      </p>

      <input
        type="password" autoFocus value={passphrase}
        onChange={(e) => { setPassphrase(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="Passphrase"
        className="w-full max-w-xs bg-panel border border-border rounded-lg px-4 py-3 text-white text-sm placeholder-muted/50 focus:border-teal focus:outline-none mb-3"
      />

      {error && <p className="text-sm text-red mb-3">{error}</p>}

      <button
        onClick={submit}
        disabled={busy || !passphrase}
        className="w-full max-w-xs py-3 bg-teal text-white rounded-lg font-medium hover:bg-teal/90 transition-colors disabled:opacity-50 mb-4"
      >
        {busy ? 'Unlocking...' : 'Unlock'}
      </button>

      <p className="text-[11px] text-muted max-w-xs">
        Forgot it? Clear the app and restore from your 12-word recovery phrase.
      </p>
    </div>
  );
}
