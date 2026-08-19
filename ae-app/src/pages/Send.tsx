import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { loadWallet } from '../lib/keys';
import { useAccount } from '../hooks/useAccount';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { displayPoints, truncateId, toBaseUnits } from '../lib/formatting';
import type { AccountSearchResult } from '../lib/types';

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
  const [tab, setTab] = useState<Tab>('recent');
  const [pointType, setPointType] = useState<'active' | 'earned'>('active');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  // Optional attestation that the recipient is a real person. Rides in the
  // signed transaction payload and feeds the human-tag credits that offset
  // percentHuman decay for the recipient. Defaults to false — an attestation
  // nobody consciously made is worth nothing.
  const [recipientIsHuman, setRecipientIsHuman] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  // Post-send offer to save the recipient as a contact. Holds their account id
  // while the prompt is showing, null when there is nothing to offer.
  const [offerSaveContact, setOfferSaveContact] = useState<string | null>(null);
  const [contactNickname, setContactNickname] = useState('');
  const [savingContact, setSavingContact] = useState(false);

  // Contact list
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AccountSearchResult[]>([]);
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
        // Map the route's snake_case rows to the camelCase shape the UI uses.
        setContacts(
          (res.data.contacts ?? []).map((c) => ({
            id: c.id,
            contactAccountId: c.contact_account_id,
            nickname: c.nickname,
            isFavorite: c.is_favorite === 1,
          })),
        );
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
        setSearchResults(res.data.accounts ?? []);
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

  // percentHuman discount (WP §7): daily-point (active) spends by an individual
  // are multiplied by percentHuman/100; the remainder burns to verification.
  // The sender is always debited the full amount they type. Earned spends and
  // non-individual accounts pass through at full value.
  const percentHuman = account?.percentHuman ?? 100;
  const isDiscounted = pointType === 'active' && account?.type === 'individual' && percentHuman < 100;
  const effective = isDiscounted ? amountNum * (percentHuman / 100) : amountNum;
  const verificationBurn = amountNum - effective;
  const fee = effective * 0.005;
  const net = effective - fee;
  // Gross-up target: the amount to type so the recipient receives what the user
  // originally intended (before fee), i.e. amount ÷ (percentHuman/100).
  const grossedUp = isDiscounted && percentHuman > 0 ? amountNum / (percentHuman / 100) : amountNum;

  async function handleSend() {
    if (!wallet || !recipient || !amount || amountNum <= 0) return;
    setSending(true);
    setResult(null);

    try {
      const from = wallet.accountId;
      const to = recipient.accountId;
      // Canonical base-unit string: the one value we sign AND send on the wire.
      const storageAmount = toBaseUnits(amountNum);
      const timestamp = Math.floor(Date.now() / 1000);

      // Build payload for signing (must match backend verification format).
      // Key order and key set both matter: signPayload/verifyPayload hash a raw
      // JSON.stringify with no canonicalization, so a missing or reordered key
      // changes the bytes and the signature fails. The node verifies
      // { from, to, amount, pointType, isInPerson, recipientIsHuman, memo }
      // (core/transaction.ts).
      //
      // recipientIsHuman MUST appear in both objects below with the same value.
      // The node reads it off the wire payload and verifies the signature over
      // its own reconstruction, so signing one value and sending another —
      // including sending nothing, which defaults to false — produces
      // INVALID_SIGNATURE on every send. That exact mismatch broke sending
      // entirely once already.
      const internalPayload = {
        from,
        to,
        amount: storageAmount,
        pointType,
        isInPerson: false,
        recipientIsHuman,
        memo: memo || '',
      };

      const signature = signPayload(internalPayload, timestamp, wallet.privateKey);

      // Send the base-unit integer string on the wire — the same canonical
      // value we just signed. Money never crosses the boundary as a float.
      const res = await api.sendTransaction({
        payload: {
          to,
          amount: storageAmount,
          pointType,
          isInPerson: false,
          recipientIsHuman,
          memo: memo || '',
        },
        accountId: from,
        timestamp,
        signature,
      });

      if (res.success) {
        // Don't claim it has landed when it hasn't. With commit-time execution
        // the node accepts the transaction but no balance moves until the block
        // carrying it commits, a few seconds later. Saying "Sent" over an
        // unchanged balance reads as a bug, and the correction arrives on its
        // own when the balance:updated event fires at commit.
        const amountText = `${amountNum.toFixed(2)} ${pointType} points to ${truncateId(to)}`;
        setResult({
          success: true,
          message: res.data.pending
            ? `Sending ${amountText}. It confirms when the next block commits, usually a few seconds.`
            : `Sent ${amountText}`,
        });
        // Offer to save them, unless they are already a contact. Sending is
        // the moment you know you want to keep an address — asking later means
        // retyping a 40-character hex id from memory.
        if (!contacts.some((c) => c.contactAccountId === to)) {
          setOfferSaveContact(to);
          setContactNickname('');
        }
        setAmount('');
        setMemo('');
        setRecipient(null);
      } else {
        setResult({ success: false, message: res.error?.message || 'Transaction failed' });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Network error';
      setResult({ success: false, message });
    } finally {
      setSending(false);
    }
  }

  async function saveAsContact() {
    if (!wallet?.accountId || !wallet.privateKey || !offerSaveContact) return;
    setSavingContact(true);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = {
        contactAccountId: offerSaveContact,
        // A nickname is the entire point — an unnamed contact is just the hex
        // id again. Falls back to a short label rather than an empty string so
        // the contacts list never shows a blank row.
        nickname: contactNickname.trim() || `Saved ${truncateId(offerSaveContact)}`,
      };
      const res = await api.addContact({
        accountId: wallet.accountId,
        timestamp: ts,
        signature: signPayload(payload, ts, wallet.privateKey),
        payload,
      });
      if (res.success) {
        setOfferSaveContact(null);
        // Reload so a second send to the same person does not re-offer.
        const list = await api.getContacts(wallet.accountId);
        if (list.success) setContacts(list.data.contacts as unknown as Contact[]);
      }
    } catch {
      // Saving a contact is a convenience on top of a payment that already
      // succeeded. Failing quietly is right — do not stain a successful send
      // with an error about an address book.
      setOfferSaveContact(null);
    } finally {
      setSavingContact(false);
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

        {account?.isEscrowed && pointType === 'earned' && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-300">
            Your earned-point transfers are escrowed due to a pending court case. This send will be rejected.
          </div>
        )}

        {/* Amount */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">Amount</label>
          {/* No MAX button. Emptying an account in one tap is the wrong thing
              to make effortless, and it invited a class of bug all of its own:
              the amount it filled in had to be exact, truncated and
              separator-free, because the human formatter abbreviates above a
              million ("1.23M", unparseable here) and rounds below it, which
              could round UP past the balance and get the send rejected. Typing
              the amount removes both the footgun and the special case. */}
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-lg tabular-nums placeholder-gray-600 focus:border-teal focus:outline-none"
          />
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

        {/* Human attestation. Optional and off by default — the value of the
            signal is that someone chose to make it. Folded into the signed
            payload, so it is an attestation the sender cannot later deny, and
            it credits the recipient against percentHuman decay.

            A checkbox rather than a type dropdown on purpose: the protocol
            field is boolean, and asking a sender to classify someone as
            human/business/bot is more work and invites a wrong answer on a
            screen whose job is sending money. */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={recipientIsHuman}
              onChange={(e) => setRecipientIsHuman(e.target.checked)}
              className="w-4 h-4 rounded border-navy-light bg-navy text-teal focus:ring-teal focus:ring-offset-0"
            />
            <span className="text-xs text-gray-400">
              This account is a human (optional)
            </span>
          </label>
        </div>

        {/* Fee preview */}
        {amountNum > 0 && (
          <div className="bg-navy rounded-xl p-3 border border-navy-light text-sm space-y-1">
            <div className="flex justify-between text-gray-400">
              <span>You spend</span>
              <span className="tabular-nums">{amountNum.toFixed(2)} pts</span>
            </div>
            {isDiscounted && (
              <div className="flex justify-between text-amber-400/90">
                <span>Verification burn ({percentHuman}% human)</span>
                <span className="tabular-nums">-{verificationBurn.toFixed(2)} pts</span>
              </div>
            )}
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

        {/* At 0% verified there is no amount that delivers anything — the whole
            payment burns. The gross-up maths divides by percentHuman, so it
            fell back to the typed amount and the button read "tap to send 50.00
            so they receive the full 50.00" while the preview directly above
            correctly said the recipient gets 0.00. Tapping was a no-op. That is
            the state EVERY new joiner is in on day one, so it needs to be a
            blocker, not a nudge. */}
        {pointType === 'active' && percentHuman === 0 && amountNum > 0 && (
          <div className="w-full text-xs bg-red-900/20 border border-red-500/40 rounded-lg py-2 px-3 text-red-300">
            You're not verified yet, so none of this reaches them — every point
            burns.{' '}
            <Link to="/verify" className="underline">
              Get verified first
            </Link>
            .
          </div>
        )}

        {/* Gross-up nudge, only where grossing up actually works: partially
            verified. Part of an active spend burns, so offer to raise the
            amount until the recipient gets what was intended. */}
        {isDiscounted && percentHuman > 0 && amountNum > 0 && (
          <button
            onClick={() => setAmount(grossedUp.toFixed(2))}
            className="w-full text-xs text-teal bg-teal/10 rounded-lg py-2 px-3 hover:bg-teal/20 transition-colors text-left"
          >
            At {percentHuman}% human, {verificationBurn.toFixed(2)} pts burn. Tap to send{' '}
            <span className="font-medium tabular-nums">{grossedUp.toFixed(2)}</span> so they receive the full {amountNum.toFixed(2)}.
          </button>
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

        {/* Save-the-recipient prompt, shown only after a successful send to
            someone not already saved. Sending is the moment a person knows they
            want to keep an address; asking later means retyping 40 hex
            characters they no longer have in front of them. */}
        {offerSaveContact && (
          <div className="bg-navy rounded-xl p-3 border border-navy-light space-y-2">
            <p className="text-xs text-gray-300">
              Save {truncateId(offerSaveContact)} to contacts?
            </p>
            <input
              value={contactNickname}
              onChange={(e) => setContactNickname(e.target.value)}
              placeholder="Name (optional)"
              className="w-full bg-navy-light border border-navy-light rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-teal focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setOfferSaveContact(null)}
                className="flex-1 py-2 rounded-lg border border-navy-light text-xs text-gray-400"
              >
                Not now
              </button>
              <button
                onClick={saveAsContact}
                disabled={savingContact}
                className="flex-1 py-2 rounded-lg bg-teal/20 text-teal text-xs disabled:opacity-50"
              >
                {savingContact ? 'Saving…' : 'Save contact'}
              </button>
            </div>
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
          { key: 'recent' as Tab, label: 'Recent' },
          { key: 'contacts' as Tab, label: 'Contacts' },
          { key: 'search' as Tab, label: 'Search' },
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
          {searchResults.map((acc) => (
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
                <p className="text-xs text-gray-500">{acc.percent_human ?? 0}% human</p>
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
