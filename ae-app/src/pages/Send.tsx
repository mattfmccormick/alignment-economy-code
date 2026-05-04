import { useState, useEffect } from 'react';
import { loadWallet } from '../lib/keys';
import { useAccount } from '../hooks/useAccount';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { displayPoints, truncateId } from '../lib/formatting';

type Tab = 'contacts' | 'search' | 'recent';

interface Contact {
  id: string;
  contactAccountId: string;
  nickname: string;
  isFavorite: boolean;
}

interface Recipient {
  accountId: string;
  nickname?: string;
}

export function Send() {
  const wallet = loadWallet();
  const { account } = useAccount(wallet?.accountId ?? null);
  const [tab, setTab] = useState<Tab>('contacts');
  const [pointType, setPointType] = useState<'active' | 'earned'>('active');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  // Contact list
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  // Recent
  const [recentRecipients, setRecentRecipients] = useState<Recipient[]>([]);

  useEffect(() => {
    if (!wallet?.accountId) return;
    loadContacts();
    loadRecent();
  }, [wallet?.accountId]);

  async function loadContacts() {
    if (!wallet?.accountId) return;
    setLoadingContacts(true);
    try {
      const res = await api.getContacts(wallet.accountId);
      if (res.success && res.data) {
        const list = res.data.contacts || (res.data as any) || [];
        setContacts(Array.isArray(list) ? list : []);
      }
    } catch { /* ignore */ }
    setLoadingContacts(false);
  }

  async function loadRecent() {
    if (!wallet?.accountId) return;
    try {
      const res = await api.getTransactions(wallet.accountId, 1, 20);
      if (res.success && res.data?.transactions) {
        const seen = new Set<string>();
        const recents: Recipient[] = [];
        for (const tx of res.data.transactions) {
          const recipientId = tx.from === wallet.accountId ? tx.to : tx.from;
          if (recipientId && !seen.has(recipientId) && recipientId !== wallet.accountId) {
            seen.add(recipientId);
            recents.push({ accountId: recipientId });
          }
        }
        setRecentRecipients(recents.slice(0, 10));
      }
    } catch { /* ignore */ }
  }

  async function handleSearch() {
    if (searchQuery.length < 3) return;
    setSearching(true);
    try {
      const res = await api.searchAccounts(searchQuery);
      if (res.success && res.data) {
        const accounts = res.data.accounts || (res.data as any) || [];
        setSearchResults(Array.isArray(accounts) ? accounts : []);
      }
    } catch { /* ignore */ }
    setSearching(false);
  }

  useEffect(() => {
    if (searchQuery.length >= 3) {
      const timer = setTimeout(handleSearch, 300);
      return () => clearTimeout(timer);
    } else {
      setSearchResults([]);
    }
  }, [searchQuery]);

  const balance = account
    ? pointType === 'active' ? account.activeBalance : account.earnedBalance
    : '0';

  const displayBalance = displayPoints(balance);
  const amountNum = Number(amount) || 0;
  const fee = amountNum * 0.005;
  const net = amountNum - fee;

  async function handleSend() {
    if (!wallet || !recipient || !amount || amountNum <= 0) return;
    setSending(true);
    setResult(null);

    try {
      const from = wallet.accountId;
      const to = recipient.accountId;
      const storageAmount = BigInt(Math.round(amountNum * 100_000_000));
      const timestamp = Math.floor(Date.now() / 1000);

      // Build payload for signing (must match backend verification format)
      const internalPayload = {
        from,
        to,
        amount: storageAmount.toString(),
        pointType,
        isInPerson: false,
        memo: memo || '',
      };

      const signature = signPayload(internalPayload, timestamp, wallet.privateKey);

      // Send to API with display amount
      const res = await api.sendTransaction({
        payload: {
          to,
          amount: amountNum,
          pointType,
          isInPerson: false,
          memo: memo || '',
        },
        accountId: from,
        timestamp,
        signature,
      });

      if (res.success) {
        setResult({ success: true, message: `Sent ${amountNum.toFixed(2)} ${pointType} points to ${truncateId(to)}` });
        setAmount('');
        setMemo('');
        setRecipient(null);
      } else {
        setResult({ success: false, message: res.error?.message || 'Transaction failed' });
      }
    } catch (e: any) {
      setResult({ success: false, message: e.message || 'Network error' });
    } finally {
      setSending(false);
    }
  }

  function selectRecipient(r: Recipient) {
    setRecipient(r);
    setResult(null);
  }

  // If a recipient is selected, show the send form
  if (recipient) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <button onClick={() => setRecipient(null)} className="text-gray-400 hover:text-white text-lg">&larr;</button>
          <h2 className="text-xl font-serif text-white">Send Points</h2>
        </div>

        {/* Recipient display */}
        <div className="bg-navy rounded-xl p-3 border border-navy-light flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-teal/20 flex items-center justify-center text-teal font-medium">
            {(recipient.nickname || recipient.accountId).charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            {recipient.nickname && <p className="text-sm text-white font-medium">{recipient.nickname}</p>}
            <p className="text-xs text-gray-400 font-mono truncate">{truncateId(recipient.accountId)}</p>
          </div>
          <button onClick={() => setRecipient(null)} className="text-xs text-gray-500 hover:text-gray-300">Change</button>
        </div>

        {/* Point type tabs */}
        <div className="flex bg-navy rounded-lg p-1 border border-navy-light">
          {(['active', 'earned'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setPointType(t)}
              className={`flex-1 py-2 text-sm rounded-md transition-colors capitalize ${
                pointType === t ? 'bg-teal text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="text-xs text-gray-500 text-right">
          Available: {displayBalance}
        </div>

        {/* Amount */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">Amount</label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-lg tabular-nums placeholder-gray-600 focus:border-teal focus:outline-none"
            />
            <button
              onClick={() => setAmount(displayPoints(balance).replace(/,/g, ''))}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-teal bg-teal/10 px-2 py-1 rounded hover:bg-teal/20 transition-colors"
            >
              MAX
            </button>
          </div>
        </div>

        {/* Memo */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">Memo (optional)</label>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="What's this for?"
            className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:border-teal focus:outline-none"
          />
        </div>

        {/* Fee preview */}
        {amountNum > 0 && (
          <div className="bg-navy rounded-xl p-3 border border-navy-light text-sm space-y-1">
            <div className="flex justify-between text-gray-400">
              <span>Sending</span>
              <span className="tabular-nums">{amountNum.toFixed(2)} pts</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>Fee (0.5%)</span>
              <span className="tabular-nums">{fee.toFixed(2)} pts</span>
            </div>
            <div className="flex justify-between text-white font-medium border-t border-navy-light pt-1">
              <span>Recipient gets</span>
              <span className="tabular-nums">{net.toFixed(2)} pts</span>
            </div>
          </div>
        )}

        <button
          onClick={handleSend}
          disabled={!amount || amountNum <= 0 || sending}
          className="w-full py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>

        {result && (
          <div className={`text-sm text-center p-3 rounded-xl ${result.success ? 'bg-teal/10 text-teal' : 'bg-red-900/20 text-red-400'}`}>
            {result.message}
          </div>
        )}
      </div>
    );
  }

  // Recipient selection screen
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-serif text-white">Send Points</h2>

      {/* Tab bar */}
      <div className="flex bg-navy rounded-lg p-1 border border-navy-light">
        {([
          { key: 'contacts' as Tab, label: 'Contacts' },
          { key: 'search' as Tab, label: 'Search' },
          { key: 'recent' as Tab, label: 'Recent' },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-2 text-sm rounded-md transition-colors ${
              tab === t.key ? 'bg-teal text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Contacts tab */}
      {tab === 'contacts' && (
        <div className="space-y-2">
          {loadingContacts ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-500 text-sm mb-2">No contacts yet</p>
              <p className="text-gray-600 text-xs">Search for users or add contacts from the More menu</p>
            </div>
          ) : (
            <>
              {/* Favorites first */}
              {contacts.filter(c => c.isFavorite).map((c) => (
                <ContactRow key={c.id} contact={c} onSelect={() => selectRecipient({ accountId: c.contactAccountId, nickname: c.nickname })} />
              ))}
              {contacts.filter(c => !c.isFavorite).map((c) => (
                <ContactRow key={c.id} contact={c} onSelect={() => selectRecipient({ accountId: c.contactAccountId, nickname: c.nickname })} />
              ))}
            </>
          )}
        </div>
      )}

      {/* Search tab */}
      {tab === 'search' && (
        <div className="space-y-3">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by account ID (3+ characters)"
            className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:border-teal focus:outline-none"
          />
          {searching && (
            <div className="flex justify-center py-4">
              <div className="w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {searchResults.map((acc: any) => (
            <button
              key={acc.id}
              onClick={() => selectRecipient({ accountId: acc.id })}
              className="w-full bg-navy rounded-xl p-3 border border-navy-light hover:border-teal/50 transition-colors flex items-center gap-3 text-left"
            >
              <div className="w-10 h-10 rounded-full bg-navy-light flex items-center justify-center text-gray-400 text-sm font-mono">
                {acc.id.slice(0, 2)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-mono truncate">{truncateId(acc.id)}</p>
                <p className="text-xs text-gray-500">{acc.percentHuman ?? 0}% human</p>
              </div>
              <span className="text-xs text-teal">Select</span>
            </button>
          ))}
          {searchQuery.length >= 3 && !searching && searchResults.length === 0 && (
            <p className="text-gray-500 text-sm text-center py-4">No accounts found</p>
          )}

          {/* Manual entry option */}
          <div className="border-t border-navy-light pt-3">
            <p className="text-xs text-gray-500 mb-2">Or enter an account ID directly:</p>
            <div className="flex gap-2">
              <input
                id="directAccountId"
                placeholder="Paste account ID"
                className="flex-1 bg-navy border border-navy-light rounded-xl px-4 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
              />
              <button
                onClick={() => {
                  const el = document.getElementById('directAccountId') as HTMLInputElement;
                  if (el?.value.trim()) selectRecipient({ accountId: el.value.trim() });
                }}
                className="px-4 py-2.5 bg-teal text-white rounded-xl text-sm hover:bg-teal-dark transition-colors"
              >
                Go
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent tab */}
      {tab === 'recent' && (
        <div className="space-y-2">
          {recentRecipients.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">No recent transactions</p>
          ) : (
            recentRecipients.map((r) => (
              <button
                key={r.accountId}
                onClick={() => selectRecipient(r)}
                className="w-full bg-navy rounded-xl p-3 border border-navy-light hover:border-teal/50 transition-colors flex items-center gap-3 text-left"
              >
                <div className="w-10 h-10 rounded-full bg-navy-light flex items-center justify-center text-gray-400 text-sm font-mono">
                  {r.accountId.slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-mono truncate">{truncateId(r.accountId)}</p>
                </div>
                <span className="text-xs text-teal">Send</span>
              </button>
            ))
          )}
        </div>
      )}

      {result && (
        <div className={`text-sm text-center p-3 rounded-xl ${result.success ? 'bg-teal/10 text-teal' : 'bg-red-900/20 text-red-400'}`}>
          {result.message}
        </div>
      )}
    </div>
  );
}

function ContactRow({ contact, onSelect }: { contact: Contact; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="w-full bg-navy rounded-xl p-3 border border-navy-light hover:border-teal/50 transition-colors flex items-center gap-3 text-left"
    >
      <div className="w-10 h-10 rounded-full bg-teal/20 flex items-center justify-center text-teal font-medium">
        {contact.nickname.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm text-white font-medium">{contact.nickname}</p>
          {contact.isFavorite && <span className="text-gold text-xs">&#9733;</span>}
        </div>
        <p className="text-xs text-gray-500 font-mono truncate">{truncateId(contact.contactAccountId)}</p>
      </div>
      <span className="text-xs text-teal">Send</span>
    </button>
  );
}
