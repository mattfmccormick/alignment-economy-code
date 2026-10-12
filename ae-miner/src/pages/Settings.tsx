import { useState } from 'react';
import { getTheme, setTheme } from '../lib/theme';
import { loadMinerWallet } from '../lib/keys';
import { PassphraseProtection } from '../components/PassphraseProtection';

export default function Settings() {
  const wallet = loadMinerWallet();
  const [currentTheme, setCurrentTheme] = useState(getTheme());
  const [copied, setCopied] = useState(false);

  function toggleTheme() {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setCurrentTheme(next);
  }

  function copyAccountId() {
    if (!wallet) return;
    navigator.clipboard?.writeText(wallet.accountId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold text-white mb-1">Account ID</h3>
        <p className="text-xs text-muted mb-3">
          This plus your 12 words is how you sign in on another computer. The ID is safe to share. The words are not.
        </p>
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-xs font-mono text-white break-all">
            {wallet?.accountId ?? 'Not signed in'}
          </div>
          <button
            onClick={copyAccountId}
            className="px-3 py-2 bg-teal/15 text-teal rounded-lg text-xs font-medium hover:bg-teal/25 transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <PassphraseProtection />

      <div className="bg-panel border border-border rounded-lg p-5 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Appearance</h3>
          <p className="text-xs text-muted mt-0.5">Currently {currentTheme === 'dark' ? 'dark' : 'light'}.</p>
        </div>
        <button
          onClick={toggleTheme}
          className="px-4 py-2 bg-bg text-muted border border-border rounded-lg text-sm hover:text-white transition-colors"
        >
          Switch to {currentTheme === 'dark' ? 'light' : 'dark'}
        </button>
      </div>
    </div>
  );
}
