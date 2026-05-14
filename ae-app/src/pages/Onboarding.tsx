import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { saveWalletFromMnemonic, saveFounderWallet, saveJoinerWallet, saveJoinedNetwork } from '../lib/keys';
import { newMnemonic, mnemonicToKeypair, isValidMnemonic } from '../lib/crypto';
import { truncateId } from '../lib/formatting';
import { encodeInviteLink, decodeInviteLink } from '../lib/invite';

type Flow =
  | 'welcome'
  | 'what-is-ae'
  | 'network-mode'
  | 'start-new-form'
  | 'start-new-generating'
  | 'start-new-result'
  | 'join-existing-form'
  | 'restart-to-apply'
  | 'creating'
  | 'learn-recovery'
  | 'show-key'
  | 'confirm-key'
  | 'how-balance'
  | 'get-verified'
  | 'login';

interface GeneratedGenesis {
  spec: unknown;
  specHash: string;
  keystores: Array<{
    name: string;
    accountId: string;
    publicKey: string;
    secretKey: string;
    account: { publicKey: string; privateKey: string };
    vrf: { publicKey: string; secretKey: string };
  }>;
}

// Trigger a browser download of a JSON object as a file.
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// First-launch network mode. Captured before account creation so future
// launches know which protocol mode to boot ae-node into:
//   - solo:  authority single-validator. Today's default. No peers.
//   - start: this user is founding a new network; they'll run the genesis
//            ceremony and share the spec with people they invite.
//   - join:  this user is joining someone else's existing network; they
//            paste a genesis hash + bootstrap address (or scan an invite
//            link) and ae-node boots in validator mode.
//
// Only `solo` is fully wired in this turn. The other two paths land their
// real implementations in the next two milestone tasks. Stub screens here
// keep the UX visible while the wiring lands.
type NetworkMode = 'solo' | 'start' | 'join';
const NETWORK_MODE_KEY = 'ae_network_mode';

function persistNetworkMode(mode: NetworkMode): void {
  try {
    localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    // localStorage can throw in private-browsing contexts. Non-fatal: the
    // user can still create an account; they'll just re-pick on next launch.
  }
}

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

  // Founder flow state.
  const [founderNetworkId, setFounderNetworkId] = useState('');
  const [founderValidatorCount, setFounderValidatorCount] = useState(2);
  const [founderNames, setFounderNames] = useState<string[]>(['founder', 'invitee-1']);
  const [genesis, setGenesis] = useState<GeneratedGenesis | null>(null);

  // Joiner flow state. The user feeds in two files received from the
  // founder: genesis.json (public, the network spec) and their personal
  // keystore.json (private, contains their account/node/VRF keys). We
  // validate that the keystore is one of the validators listed in the
  // genesis spec — otherwise the keystore is for some other network or
  // got mismatched with this spec.
  // Genesis spec shape (per ae-node/src/node/genesis-config.ts): top-level
  // accounts[] each with optional `validator` field. A validator entry IS
  // an account whose `validator` is set; the joiner's keystore matches by
  // `account.publicKey === acc.publicKey`.
  interface SpecAccount { publicKey: string; validator?: unknown }
  interface SpecShape { networkId?: string; accounts?: SpecAccount[] }
  const [joinSpec, setJoinSpec] = useState<SpecShape | null>(null);
  const [joinSpecFilename, setJoinSpecFilename] = useState<string | null>(null);
  const [joinKeystore, setJoinKeystore] = useState<{ accountId: string; name?: string; account?: { publicKey: string; privateKey: string } } | null>(null);
  const [joinKeystoreFilename, setJoinKeystoreFilename] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Summary card shown on the restart-to-apply screen — the network ID +
  // accountId the user just committed to, regardless of which onboarding
  // path they took.
  const [pendingNetworkSummary, setPendingNetworkSummary] = useState<{ networkId: string; accountId: string } | null>(null);
  const [relaunching, setRelaunching] = useState(false);

  // Invite-link UI state.
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteInput, setInviteInput] = useState('');
  const [inviteParseError, setInviteParseError] = useState<string | null>(null);

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

  async function runGenesisCeremony() {
    setLoading(true);
    setError(null);
    setFlow('start-new-generating');
    try {
      const res = await api.generateGenesis({
        networkId: founderNetworkId.trim(),
        validatorCount: founderValidatorCount,
        names: founderNames.map((n) => n.trim()).filter((n) => n.length > 0),
      });
      if (res.success && res.data) {
        setGenesis(res.data as GeneratedGenesis);
        setFlow('start-new-result');
      } else {
        setError(res.error?.message || 'Failed to generate genesis');
        setFlow('start-new-form');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error. Is the backend running?');
      setFlow('start-new-form');
    } finally {
      setLoading(false);
    }
  }

  async function continueAsFounder() {
    if (!genesis || genesis.keystores.length === 0) return;
    // The first keystore is the founder's. Subsequent keystores are for the
    // invitees and remain the founder's responsibility to deliver.
    const founderKeystore = genesis.keystores[0];
    saveFounderWallet(founderKeystore);
    saveJoinedNetwork(genesis.spec);
    let savedToDisk = false;
    if (window.aeNetwork) {
      try {
        await window.aeNetwork.saveConfig({ mode: 'bft', spec: genesis.spec, keystore: founderKeystore });
        savedToDisk = true;
      } catch { /* non-fatal; localStorage is still set */ }
    }
    // After the spec is on disk, the running ae-node is still in solo mode
    // until a relaunch picks up the new spawn env. Surface that explicitly
    // so the founder doesn't expect peering to start without a restart.
    // In plain browser dev (no Electron), there's nothing to relaunch and
    // ae-node config-on-disk doesn't exist, so we skip straight to /.
    if (savedToDisk) {
      const specWithId = genesis.spec as { networkId?: string };
      setPendingNetworkSummary({
        networkId: specWithId.networkId ?? '(unknown)',
        accountId: founderKeystore.accountId,
      });
      setFlow('restart-to-apply');
    } else {
      navigate('/');
    }
  }

  // Joiner: file pickers parse JSON and stash the parsed object in state.
  // Errors are surfaced inline so the user knows immediately if they
  // grabbed the wrong file (e.g. uploaded keystore as the genesis slot).
  async function handleSpecFile(file: File): Promise<void> {
    setJoinError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.networkId !== 'string' || !Array.isArray(parsed.accounts)) {
        throw new Error("This file doesn't look like a genesis spec. Expected networkId + accounts[].");
      }
      const validatorCount = parsed.accounts.filter((a: SpecAccount) => a.validator).length;
      if (validatorCount === 0) {
        throw new Error('Genesis spec has no validators. Pick a different file.');
      }
      setJoinSpec(parsed);
      setJoinSpecFilename(file.name);
    } catch (e) {
      setJoinSpec(null);
      setJoinSpecFilename(null);
      setJoinError(e instanceof Error ? e.message : 'Could not read file');
    }
  }

  async function handleKeystoreFile(file: File): Promise<void> {
    setJoinError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.accountId !== 'string' || !parsed.account?.publicKey || !parsed.account?.privateKey) {
        throw new Error("This file doesn't look like a keystore. Expected accountId + account.publicKey + account.privateKey.");
      }
      setJoinKeystore(parsed);
      setJoinKeystoreFilename(file.name);
    } catch (e) {
      setJoinKeystore(null);
      setJoinKeystoreFilename(null);
      setJoinError(e instanceof Error ? e.message : 'Could not read file');
    }
  }

  function keystoreMatchesValidator(spec: SpecShape, ks: { account?: { publicKey: string } }): boolean {
    if (!spec.accounts || !ks.account) return false;
    return spec.accounts.some((a) => a.validator && a.publicKey === ks.account!.publicKey);
  }

  async function joinNetworkAsValidator(): Promise<void> {
    if (!joinSpec || !joinKeystore) return;
    // Final sanity check before persisting: the keystore must correspond to
    // one of the validators in the spec, otherwise this keystore is for
    // some other network or got crossed in the mail.
    if (!keystoreMatchesValidator(joinSpec, joinKeystore)) {
      setJoinError("This keystore isn't a validator on this network. Double-check that the genesis.json and keystore came from the same founder, for the same network.");
      return;
    }
    if (!joinKeystore.account) {
      setJoinError('Keystore is missing the account keypair.');
      return;
    }
    saveJoinerWallet({ accountId: joinKeystore.accountId, account: joinKeystore.account });
    saveJoinedNetwork(joinSpec);
    let savedToDisk = false;
    if (window.aeNetwork) {
      try {
        await window.aeNetwork.saveConfig({ mode: 'bft', spec: joinSpec, keystore: joinKeystore });
        savedToDisk = true;
      } catch { /* non-fatal; localStorage is still set */ }
    }
    if (savedToDisk) {
      setPendingNetworkSummary({
        networkId: joinSpec.networkId ?? '(unknown)',
        accountId: joinKeystore.accountId,
      });
      setFlow('restart-to-apply');
    } else {
      navigate('/');
    }
  }

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
        // Route through the recovery-phrase explainer first instead of
        // dropping the user straight onto 12 words. Most non-technical
        // users have never seen a BIP-39 phrase before; they need to
        // know what it is, why it can't be reset, and how to store it
        // before they're shown the actual words.
        setFlow('learn-recovery');
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
        {/* AE mark: an A with two horizontal crossbars that extend past
            the diagonals — same geometry as the official website logo
            (alignment-economy-website/src/app/icon.svg, scaled 32→512).
            The bars + diagonals together read like a $. */}
        <div className="w-16 h-16 rounded-2xl bg-teal/20 flex items-center justify-center mb-6">
          <svg viewBox="0 0 512 512" className="w-12 h-12" aria-hidden="true">
            <path d="M256 64 L80 448" stroke="#0d9488" strokeWidth="45" strokeLinecap="round" fill="none" />
            <path d="M256 64 L432 448" stroke="#0d9488" strokeWidth="45" strokeLinecap="round" fill="none" />
            <path d="M112 288 L400 288" stroke="#0d9488" strokeWidth="32" strokeLinecap="round" fill="none" />
            <path d="M88 368 L424 368" stroke="#0d9488" strokeWidth="32" strokeLinecap="round" fill="none" />
          </svg>
        </div>
        <h1 className="text-3xl font-serif text-white mb-3">Alignment Economy</h1>
        <p className="text-gray-400 mb-10 max-w-sm leading-relaxed text-sm">
          A new economic system where every person gets 1,440 points per day,
          one for every minute of attention you have.
        </p>

        <button
          onClick={() => { persistNetworkMode('solo'); createAccount(); }}
          disabled={loading}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-3"
        >
          {loading ? 'Creating...' : 'Create Account'}
        </button>

        <button
          onClick={() => setFlow('login')}
          className="w-full max-w-xs py-3.5 bg-navy text-gray-300 rounded-xl font-medium border border-navy-light hover:border-gray-500 transition-colors"
        >
          Sign In
        </button>

        {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
      </div>
    );
  }

  // "What is this?" explainer. Optional, opt-in from the welcome screen.
  // Plain language for someone who has never used a wallet, never heard
  // of crypto, has no idea what a "point" is in this context. The whole
  // point is to give a non-technical user enough context that the rest
  // of the flow makes sense.
  if (flow === 'what-is-ae') {
    return (
      <div className="flex flex-col items-center justify-start min-h-dvh px-6 bg-navy-dark py-10 overflow-y-auto">
        <h2 className="text-2xl font-serif text-white mb-2 text-center">What is the Alignment Economy?</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm text-center leading-relaxed">
          The 60-second version.
        </p>

        <div className="w-full max-w-sm space-y-3 mb-8">
          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-teal font-medium mb-1">Everyone gets points daily</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              Every person on the network gets the same daily allocation. No one buys their way in. No one mines them with electricity. They just arrive, every day, for being a person.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-teal font-medium mb-1">Most points expire daily</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              You get 1,440 active points each day, one for every minute. Spend them or they disappear at 4 AM. This kills hoarding and keeps points moving.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-teal font-medium mb-1">Earned points last forever</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              When someone pays you for work, care, or anything else, those points become yours to keep. This is how teaching, caregiving, and community work finally show up in the economy.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-teal font-medium mb-1">Real humans only</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              Each account has a percent-human score. You start at 0%. You gain percentage by getting verified or having other verified humans vouch for you. Until you're verified, you can receive points but not spend them at full value.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-gold/30">
            <p className="text-sm text-gold font-medium mb-1">No bank, no company runs this</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              You hold your own keys. Nobody can freeze, take, or block your account. The trade-off: if you lose your recovery phrase, no one can recover it for you. Save it carefully.
            </p>
          </div>
        </div>

        <button
          onClick={() => setFlow('welcome')}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors mb-3"
        >
          Got it, take me back
        </button>
      </div>
    );
  }

  // Network mode picker. Comes between Welcome and account creation so
  // every new wallet is born into a known protocol mode (solo / new
  // network / joining a network). Today only "solo" is fully wired
  // through to a working ae-node config; the other two land in the
  // following milestone tasks.
  if (flow === 'network-mode') {
    return (
      <div className="flex flex-col items-center justify-start min-h-dvh px-6 bg-navy-dark py-10 overflow-y-auto">
        <h2 className="text-2xl font-serif text-white mb-2 text-center">Pick a Network</h2>
        <p className="text-gray-400 text-sm mb-8 max-w-sm text-center">
          The Alignment Economy is a network of nodes. Pick how you want yours to run. You can change later by re-installing.
        </p>

        <div className="w-full max-w-sm space-y-3 mb-6">
          <button
            onClick={() => { persistNetworkMode('solo'); createAccount(); }}
            disabled={loading}
            className="w-full text-left bg-navy border border-teal/40 hover:border-teal rounded-xl p-4 transition-colors disabled:opacity-50"
          >
            <div className="flex items-start justify-between mb-1">
              <span className="text-white font-medium">Solo</span>
              <span className="text-[10px] text-teal bg-teal/15 px-2 py-0.5 rounded-full">Recommended for now</span>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Run by yourself. Your wallet is its own one-person economy. Good for trying the AE without inviting anyone.
            </p>
          </button>

          <button
            onClick={() => { persistNetworkMode('start'); setFlow('start-new-form'); }}
            disabled={loading}
            className="w-full text-left bg-navy border border-navy-light hover:border-gold/60 rounded-xl p-4 transition-colors disabled:opacity-50"
          >
            <div className="flex items-start justify-between mb-1">
              <span className="text-white font-medium">Start a new network</span>
              <span className="text-[10px] text-gold bg-gold/15 px-2 py-0.5 rounded-full">Founder</span>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Found a network and invite people to join. You run the genesis ceremony, share a network spec with friends, and they connect to you.
            </p>
          </button>

          <button
            onClick={() => { persistNetworkMode('join'); setFlow('join-existing-form'); }}
            disabled={loading}
            className="w-full text-left bg-navy border border-navy-light hover:border-gold/60 rounded-xl p-4 transition-colors disabled:opacity-50"
          >
            <div className="flex items-start justify-between mb-1">
              <span className="text-white font-medium">Join an existing network</span>
              <span className="text-[10px] text-gold bg-gold/15 px-2 py-0.5 rounded-full">Validator</span>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Someone shared a network spec with you (or sent you an invite link). Join their network and become a validator on it.
            </p>
          </button>
        </div>

        <button
          onClick={() => setFlow('welcome')}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Back
        </button>

        {error && <p className="text-sm text-red-400 mt-4 max-w-sm text-center">{error}</p>}
      </div>
    );
  }

  // "Start a new network" — step 1: collect inputs.
  if (flow === 'start-new-form') {
    const networkIdValid = /^[a-z0-9-]{3,32}$/.test(founderNetworkId.trim());
    return (
      <div className="flex flex-col items-center justify-start min-h-dvh px-6 bg-navy-dark py-10 overflow-y-auto">
        <div className="w-12 h-12 rounded-full bg-gold/20 flex items-center justify-center mb-4">
          <span className="text-xl text-gold">+</span>
        </div>
        <h2 className="text-2xl font-serif text-white mb-2 text-center">Start a new network</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm text-center">
          Set up the genesis ceremony. You'll get a network spec to share with everyone, plus one keystore per validator (yours and the people you invite).
        </p>

        <div className="w-full max-w-sm space-y-4 mb-6">
          <div className="text-left">
            <label className="text-xs text-gray-400 block mb-1.5">Network ID</label>
            <input
              value={founderNetworkId}
              onChange={(e) => setFounderNetworkId(e.target.value.toLowerCase())}
              placeholder="ae-devnet-matt"
              className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
            />
            <p className="text-[11px] text-gray-500 mt-1">Lowercase letters, numbers, hyphens. 3 to 32 characters.</p>
          </div>

          <div className="text-left">
            <label className="text-xs text-gray-400 block mb-1.5">Number of validators</label>
            <input
              type="number"
              min={1}
              max={50}
              value={founderValidatorCount}
              onChange={(e) => {
                const n = Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1));
                setFounderValidatorCount(n);
                // Resize the names list to match.
                setFounderNames((prev) => {
                  const next = [...prev];
                  while (next.length < n) next.push(`invitee-${next.length}`);
                  return next.slice(0, n);
                });
              }}
              className="w-full bg-navy border border-navy-light rounded-xl px-4 py-3 text-white text-sm font-mono focus:border-teal focus:outline-none"
            />
            <p className="text-[11px] text-gray-500 mt-1">Includes you. So 3 = you + 2 invitees.</p>
          </div>

          <div className="text-left">
            <label className="text-xs text-gray-400 block mb-1.5">Validator names</label>
            <div className="space-y-2">
              {founderNames.map((name, i) => (
                <input
                  key={i}
                  value={name}
                  onChange={(e) => setFounderNames((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))}
                  placeholder={i === 0 ? 'You (founder)' : `Invitee ${i}`}
                  className="w-full bg-navy border border-navy-light rounded-xl px-4 py-2.5 text-white text-sm font-mono focus:border-teal focus:outline-none"
                />
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">First name is yours. The rest label each invitee's keystore so you don't mix them up.</p>
          </div>
        </div>

        {error && <p className="text-sm text-red-400 mb-4 max-w-sm text-center">{error}</p>}

        <button
          onClick={runGenesisCeremony}
          disabled={loading || !networkIdValid}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-3"
        >
          {loading ? 'Generating...' : 'Generate genesis'}
        </button>

        <button
          onClick={() => { setFlow('network-mode'); setError(null); }}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Back to Network Choice
        </button>
      </div>
    );
  }

  // "Start a new network" — step 2: working state while ae-node generates.
  // buildGenesisSet is fast (key generation + spec assembly), so this is a
  // brief flicker most of the time. Showing it explicitly avoids a blank
  // moment if the API is slow.
  if (flow === 'start-new-generating') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark">
        <div className="w-12 h-12 rounded-full bg-gold/20 flex items-center justify-center mb-4 animate-pulse">
          <span className="text-xl text-gold">⋯</span>
        </div>
        <h2 className="text-xl font-serif text-white mb-2">Generating genesis</h2>
        <p className="text-gray-400 text-sm max-w-sm">
          Creating validator keystores and the shared network spec.
        </p>
      </div>
    );
  }

  // "Start a new network" — step 3: result. Show the spec hash, let the
  // founder download the public spec and each private keystore, then
  // continue to the wallet using their own keystore as the wallet identity.
  if (flow === 'start-new-result' && genesis) {
    return (
      <div className="flex flex-col items-center justify-start min-h-dvh px-6 bg-navy-dark py-10 overflow-y-auto">
        <h2 className="text-2xl font-serif text-white mb-2 text-center">Network ready</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm text-center">
          Save these files. The genesis spec is public; each keystore is private to one validator only.
        </p>

        <div className="w-full max-w-sm bg-navy rounded-xl p-4 border border-gold/30 mb-4">
          <p className="text-xs text-gold mb-1 font-medium">Genesis spec hash</p>
          <p className="text-xs text-white font-mono break-all">{genesis.specHash}</p>
          <p className="text-[11px] text-gray-500 mt-2">Compare this with every operator out-of-band before you try to peer. If their hash matches yours, you're on the same network.</p>
        </div>

        <div className="w-full max-w-sm space-y-3 mb-6">
          <div className="bg-navy rounded-xl p-3 border border-teal/30">
            <p className="text-xs text-teal mb-2 font-medium">Invite link</p>
            <p className="text-[10px] text-gray-400 break-all font-mono mb-3 leading-relaxed">
              {encodeInviteLink(genesis.spec)}
            </p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(encodeInviteLink(genesis.spec));
                setInviteCopied(true);
                setTimeout(() => setInviteCopied(false), 2000);
              }}
              className="w-full bg-teal/15 text-teal rounded-lg py-2 text-xs font-medium hover:bg-teal/25 transition-colors"
            >
              {inviteCopied ? 'Copied!' : 'Copy invite link'}
            </button>
            <p className="text-[10px] text-gray-500 mt-2">
              Send this to invitees alongside their personal keystore. The link contains the public spec; pasting it into their wallet pre-fills the join form.
            </p>
          </div>

          <button
            onClick={() => downloadJson('genesis.json', genesis.spec)}
            className="w-full bg-teal/20 text-teal rounded-xl py-3 text-sm font-medium hover:bg-teal/30 transition-colors"
          >
            Download genesis.json (public)
          </button>

          <div className="bg-navy rounded-xl p-3 border border-navy-light">
            <p className="text-xs text-gray-400 mb-2">Validator keystores (private)</p>
            <div className="space-y-2">
              {genesis.keystores.map((ks, i) => (
                <div key={ks.accountId} className="flex items-center justify-between gap-2 bg-navy-dark rounded-lg p-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">
                      {ks.name}
                      {i === 0 && <span className="text-[10px] text-teal ml-2">(yours)</span>}
                    </p>
                    <p className="text-[10px] text-gray-500 font-mono truncate">{truncateId(ks.accountId, 12)}</p>
                  </div>
                  <button
                    onClick={() => downloadJson(`${ks.name}.keystore.json`, ks)}
                    className="text-xs bg-gold/15 text-gold px-3 py-1.5 rounded-lg hover:bg-gold/25 transition-colors shrink-0"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          </div>

          <p className="text-[11px] text-red-400 leading-relaxed">
            Send each keystore privately to its named operator only (DM, encrypted email). Anyone with a keystore controls that validator. Share the genesis.json publicly.
          </p>
        </div>

        <button
          onClick={continueAsFounder}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors mb-3"
        >
          I&apos;ve saved everything, continue
        </button>

        <button
          onClick={() => setFlow('start-new-form')}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Generate again
        </button>
      </div>
    );
  }

  // "Join an existing network." The user has been pre-allocated as a
  // validator by the founder of some network. They received two files
  // privately: the public genesis spec and their own keystore. We load
  // both, sanity-check that the keystore is in the spec's validator set,
  // and persist them as the wallet identity + network choice.
  //
  // Note: this does NOT yet boot ae-node against the chosen genesis. That
  // wiring is the next milestone task ("wire main.cjs to honor network
  // choice"). For now the wallet has the right identity and the right
  // spec stashed; the bundled node is still in solo authority mode under
  // the hood until that piece lands.
  if (flow === 'join-existing-form') {
    const validatorAccounts = joinSpec?.accounts?.filter((a) => a.validator) ?? [];
    const keystoreInSpec = !!(
      joinSpec && joinKeystore &&
      keystoreMatchesValidator(joinSpec, joinKeystore)
    );
    const ready = keystoreInSpec;

    return (
      <div className="flex flex-col items-center justify-start min-h-dvh px-6 bg-navy-dark py-10 overflow-y-auto">
        <div className="w-12 h-12 rounded-full bg-gold/20 flex items-center justify-center mb-4">
          <span className="text-xl text-gold">→</span>
        </div>
        <h2 className="text-2xl font-serif text-white mb-2 text-center">Join an existing network</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm text-center">
          Paste the invite link from the founder (or upload genesis.json if they sent the file). Then upload your private keystore.
        </p>

        <div className="w-full max-w-sm bg-navy rounded-xl p-4 border border-navy-light mb-3">
          <p className="text-xs text-white font-medium mb-1">Invite link</p>
          <p className="text-[11px] text-gray-500 mb-2">Quickest way in. Replaces the genesis.json file upload below.</p>
          <textarea
            value={inviteInput}
            onChange={(e) => {
              const v = e.target.value;
              setInviteInput(v);
              setInviteParseError(null);
              if (!v.trim()) return;
              const parsed = decodeInviteLink(v);
              if (parsed) {
                setJoinSpec(parsed.spec as SpecShape);
                setJoinSpecFilename('(from invite link)');
                setJoinError(null);
              } else if (v.trim().length > 8) {
                setInviteParseError("That doesn't look like a valid AE invite link.");
              }
            }}
            placeholder="https://invite.alignmenteconomy.org/v1#..."
            rows={2}
            className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-xs text-white font-mono focus:border-teal focus:outline-none resize-none placeholder-gray-600"
          />
          {inviteParseError && <p className="text-[11px] text-red-400 mt-1">{inviteParseError}</p>}
        </div>

        <div className="w-full max-w-sm space-y-3 mb-4">
          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="text-sm text-white font-medium">genesis.json</p>
                <p className="text-[11px] text-gray-500">The shared network spec. Public. Or use the invite link above.</p>
              </div>
              {joinSpecFilename && <span className="text-[10px] text-teal bg-teal/15 px-2 py-1 rounded-full shrink-0">Loaded</span>}
            </div>
            <label className="block">
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleSpecFile(f);
                }}
                className="block w-full text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-teal/15 file:text-teal hover:file:bg-teal/25 file:cursor-pointer"
              />
            </label>
            {joinSpecFilename && joinSpec?.networkId && (
              <p className="text-[11px] text-gray-400 mt-2">
                <span className="text-gray-500">Network:</span> <span className="font-mono text-white">{joinSpec.networkId}</span>
                {' · '}
                <span className="text-gray-500">{validatorAccounts.length} validators</span>
              </p>
            )}
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="text-sm text-white font-medium">Your keystore</p>
                <p className="text-[11px] text-gray-500">Private. Holds your validator + account keys.</p>
              </div>
              {joinKeystoreFilename && <span className="text-[10px] text-teal bg-teal/15 px-2 py-1 rounded-full shrink-0">Loaded</span>}
            </div>
            <label className="block">
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleKeystoreFile(f);
                }}
                className="block w-full text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-gold/15 file:text-gold hover:file:bg-gold/25 file:cursor-pointer"
              />
            </label>
            {joinKeystoreFilename && joinKeystore?.accountId && (
              <p className="text-[11px] text-gray-400 mt-2">
                <span className="text-gray-500">Account:</span> <span className="font-mono text-white">{truncateId(joinKeystore.accountId, 16)}</span>
                {joinKeystore.name && <> · <span className="text-gray-500">{joinKeystore.name}</span></>}
              </p>
            )}
          </div>
        </div>

        {joinSpec && joinKeystore && (
          keystoreInSpec ? (
            <div className="w-full max-w-sm bg-teal/10 border border-teal/30 rounded-xl p-3 mb-4">
              <p className="text-xs text-teal font-medium mb-1">Match confirmed</p>
              <p className="text-[11px] text-gray-300">
                You&apos;re joining <span className="font-mono text-white">{joinSpec.networkId}</span> as <span className="font-mono text-white">{joinKeystore?.accountId ? truncateId(joinKeystore.accountId, 12) : ''}</span>{joinKeystore?.name ? <> ({joinKeystore.name})</> : null}.
              </p>
            </div>
          ) : (
            <div className="w-full max-w-sm bg-red-900/20 border border-red-900/40 rounded-xl p-3 mb-4">
              <p className="text-xs text-red-400 font-medium mb-1">Keystore not in this network</p>
              <p className="text-[11px] text-gray-300">
                The keystore&apos;s account is not listed as a validator in this genesis spec. Check that both files came from the same founder for the same network.
              </p>
            </div>
          )
        )}

        {joinError && <p className="text-sm text-red-400 mb-4 max-w-sm text-center">{joinError}</p>}

        <button
          onClick={joinNetworkAsValidator}
          disabled={!ready}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-3"
        >
          Join network
        </button>

        <button
          onClick={() => { setFlow('network-mode'); setJoinError(null); }}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Back to Network Choice
        </button>
      </div>
    );
  }

  // Restart-to-apply gate. Shown after Start-new or Join-existing has
  // pushed a fresh network config to disk. The currently running ae-node
  // child still has its old (solo-mode) spawn env, so the network choice
  // doesn't actually take effect until the Electron app relaunches. Two
  // explicit options: relaunch now (recommended), or continue without
  // relaunching (the wallet works against the old solo node until the
  // user quits + reopens manually). We only land here when
  // window.aeNetwork is present, so the relaunch button is always wired.
  if (flow === 'restart-to-apply' && pendingNetworkSummary) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center bg-navy-dark py-8">
        <div className="w-12 h-12 rounded-full bg-teal/20 flex items-center justify-center mb-4">
          <span className="text-xl text-teal">✓</span>
        </div>
        <h2 className="text-2xl font-serif text-white mb-2">Network saved</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm leading-relaxed">
          Your network config is on disk. Restart the app to start running on it.
        </p>

        <div className="bg-navy rounded-xl p-4 w-full max-w-sm border border-navy-light mb-6">
          <div className="mb-2">
            <p className="text-[11px] text-gray-500 mb-0.5">Network</p>
            <p className="text-sm text-white font-mono">{pendingNetworkSummary.networkId}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 mb-0.5">Your validator</p>
            <p className="text-sm text-white font-mono">{truncateId(pendingNetworkSummary.accountId, 16)}</p>
          </div>
        </div>

        <p className="text-[11px] text-gray-500 mb-4 max-w-sm">
          Until you restart, the wallet runs against the previous local node. Validators won&apos;t peer up.
        </p>

        <button
          onClick={async () => {
            if (!window.aeNetwork) return;
            setRelaunching(true);
            try {
              await window.aeNetwork.relaunch();
            } catch {
              setRelaunching(false);
            }
          }}
          disabled={relaunching}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors disabled:opacity-50 mb-3"
        >
          {relaunching ? 'Relaunching...' : 'Apply now (restart app)'}
        </button>

        <button
          onClick={() => navigate('/')}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Continue without restarting
        </button>
      </div>
    );
  }

  // Recovery-phrase education. Shown immediately after the account is
  // created but BEFORE the 12 words are revealed. Most non-technical
  // users have never seen a BIP-39 phrase before; without this screen,
  // the show-key step is just 12 random words and a "Copy" button. This
  // explains what they're about to see and what to do with it. The four
  // points below come from real failure modes we've watched users hit:
  // (1) treating the phrase like a normal password they can reset,
  // (2) screenshotting it into a cloud-synced photo album, (3) not
  // realizing nobody can help them get it back, (4) thinking the phrase
  // and the Account ID are the same thing.
  if (flow === 'learn-recovery') {
    return (
      <div className="flex flex-col items-center justify-start min-h-dvh px-6 bg-navy-dark py-10 overflow-y-auto">
        <div className="w-12 h-12 rounded-full bg-gold/20 flex items-center justify-center mb-4">
          <span className="text-xl text-gold">!</span>
        </div>
        <h2 className="text-2xl font-serif text-white mb-2 text-center">Before you see your phrase</h2>
        <p className="text-gray-400 text-sm mb-6 max-w-sm text-center leading-relaxed">
          On the next screen we'll show you 12 words. This is the most important part of using the wallet. Read this first.
        </p>

        <div className="w-full max-w-sm space-y-3 mb-6">
          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-white font-medium mb-1">It's the only key to your account</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              The 12 words ARE your account. Anyone with these words can spend everything you own. Treat them like cash, not a password.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-white font-medium mb-1">No one can reset it</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              We don't have your phrase. No support team has it. No company has it. If you lose it, the account is gone forever. Nobody can help.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-white font-medium mb-1">Write it on paper</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              Pen and paper. Two copies in different places. Don't take a screenshot, don't email it to yourself, don't save it in your notes app. If a phone or laptop gets stolen or hacked, the words go with it.
            </p>
          </div>

          <div className="bg-navy rounded-xl p-4 border border-navy-light">
            <p className="text-sm text-white font-medium mb-1">You'll need it on a new device</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              If you ever switch phones or computers, these 12 words plus your Account ID are how you get your wallet back. Without them, you start over.
            </p>
          </div>
        </div>

        <button
          onClick={() => setFlow('show-key')}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors mb-3"
        >
          I'm ready, show me the words
        </button>

        <p className="text-[11px] text-gray-500 max-w-sm text-center leading-relaxed">
          Find a pen and paper before you continue.
        </p>
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
            Your point balance goes down a little each day as new people
            join the network. This is normal and not a loss.
          </p>
          <p>
            What matters is your <span className="text-gold font-medium">share</span> of the whole economy.
            If you hold 0.042% today, you will hold 0.042% tomorrow,
            even if the absolute number goes down.
          </p>
          <p>
            Picture a pie. As more people join, the pie grows. Your slice
            of the pie keeps the same proportion, even as the total gets
            bigger. The point count next to your name is just the size of
            your slice in raw numbers, which the system adjusts so the
            proportion stays right.
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
          onClick={() => navigate('/verify')}
          className="w-full max-w-xs py-3.5 bg-teal text-white rounded-xl font-medium hover:bg-teal-dark transition-colors mb-3"
        >
          Add Proof of Human
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
          {loading ? 'Signing in...' : 'Sign In'}
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
