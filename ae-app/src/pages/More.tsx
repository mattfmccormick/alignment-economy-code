import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { loadWallet, clearWallet } from '../lib/keys';
import { truncateId } from '../lib/formatting';
import { getTheme, setTheme } from '../lib/theme';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';

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

  useEffect(() => {
    if (wallet?.accountId) {
      api.getMinerStatus(wallet.accountId).then(res => {
        if (res.success && res.data) {
          setMinerStatus(res.data);
        }
      }).catch(() => {});
    }
  }, [wallet?.accountId]);

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

      {/* Recovery phrase export. Mnemonic-derived V2 wallets only. V1 wallets
          predate mnemonics and would need re-creation to back up. */}
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
        ) : (
          <p className="text-xs text-gray-500">
            This wallet predates the recovery-phrase format. Recovery export isn't available. To enable it, log out and create a new account.
          </p>
        )}
      </div>

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
