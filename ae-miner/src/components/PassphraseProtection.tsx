import { useState } from 'react';
import { isMinerWalletEncrypted, protectMinerWallet, removeMinerWalletPassphrase } from '../lib/keys';

// Dashboard card: turn passphrase-encryption of the miner wallet at rest on/off.
export function PassphraseProtection() {
  const [encrypted, setEncrypted] = useState(isMinerWalletEncrypted());
  const [mode, setMode] = useState<'idle' | 'add' | 'remove'>('idle');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() { setMode('idle'); setP1(''); setP2(''); setErr(null); }

  async function add() {
    if (p1.length < 8) { setErr('Use at least 8 characters.'); return; }
    if (p1 !== p2) { setErr('Passphrases do not match.'); return; }
    setBusy(true); setErr(null);
    try { await protectMinerWallet(p1); setEncrypted(true); reset(); }
    catch { setErr('Could not set the passphrase.'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!p1) return;
    setBusy(true); setErr(null);
    try { await removeMinerWalletPassphrase(p1); setEncrypted(false); reset(); }
    catch { setErr('Incorrect passphrase.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-panel border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-white">Passphrase Protection</h3>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${encrypted ? 'bg-teal/15 text-teal' : 'bg-bg text-muted'}`}>
          {encrypted ? 'On' : 'Off'}
        </span>
      </div>

      {mode === 'idle' && (
        <>
          <p className="text-xs text-muted mb-3">
            {encrypted
              ? 'Your node keys are encrypted on this device. You unlock with your passphrase each time you open the app.'
              : 'Encrypt your node keys on this device with a passphrase. Keep your recovery phrase as backup — a lost passphrase can only be recovered from it.'}
          </p>
          <button
            onClick={() => { setMode(encrypted ? 'remove' : 'add'); setErr(null); }}
            className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${
              encrypted ? 'bg-bg text-muted hover:text-white' : 'bg-teal/15 text-teal hover:bg-teal/25'
            }`}
          >
            {encrypted ? 'Remove passphrase' : 'Add a passphrase'}
          </button>
        </>
      )}

      {mode === 'add' && (
        <div className="space-y-2">
          <input
            type="password" autoFocus value={p1}
            onChange={(e) => { setP1(e.target.value); setErr(null); }}
            placeholder="New passphrase (8+ characters)"
            className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-white text-sm placeholder-muted/50 focus:border-teal focus:outline-none"
          />
          <input
            type="password" value={p2}
            onChange={(e) => { setP2(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            placeholder="Confirm passphrase"
            className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-white text-sm placeholder-muted/50 focus:border-teal focus:outline-none"
          />
          {err && <p className="text-xs text-red">{err}</p>}
          <div className="flex gap-2">
            <button onClick={reset} className="flex-1 py-2 bg-bg text-muted rounded-lg text-sm hover:text-white transition-colors">Cancel</button>
            <button onClick={add} disabled={busy} className="flex-1 py-2 bg-teal text-white rounded-lg text-sm hover:bg-teal/90 transition-colors disabled:opacity-50">
              {busy ? 'Encrypting...' : 'Encrypt'}
            </button>
          </div>
        </div>
      )}

      {mode === 'remove' && (
        <div className="space-y-2">
          <input
            type="password" autoFocus value={p1}
            onChange={(e) => { setP1(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') remove(); }}
            placeholder="Current passphrase"
            className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-white text-sm placeholder-muted/50 focus:border-teal focus:outline-none"
          />
          {err && <p className="text-xs text-red">{err}</p>}
          <div className="flex gap-2">
            <button onClick={reset} className="flex-1 py-2 bg-bg text-muted rounded-lg text-sm hover:text-white transition-colors">Cancel</button>
            <button onClick={remove} disabled={busy || !p1} className="flex-1 py-2 bg-red/15 text-red rounded-lg text-sm hover:bg-red/25 transition-colors disabled:opacity-50">
              {busy ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
