import { mnemonicToKeypair } from './crypto';
import { loadPlatformSession, clearPlatformSession } from './platform';
import { encryptSecret, decryptSecret, isKeystoreEnvelope } from './keystore';

const STORAGE_KEY = 'ae_wallet';
const LEGACY_KEY = 'ae_wallet_legacy';

// D2: when the self-custody wallet is passphrase-encrypted, the ciphertext
// lives in localStorage and the DECRYPTED wallet JSON is held here in memory
// only after a successful unlock. `loadWallet()` stays synchronous by reading
// from this instead of decrypting on every call. Cleared on lock / logout /
// tab close (it's a module variable, never persisted).
let unlockedSecret: string | null = null;

interface StoredWalletV2 {
  version: 2;
  accountId: string;
  publicKey: string;
  /** BIP39 mnemonic — the source of truth. Private key is derived on demand. */
  mnemonic: string;
}

/** Legacy wallet (pre-mnemonic), kept readable so existing users don't lose access. */
interface StoredWalletV1 {
  accountId: string;
  publicKey: string;
  privateKey: string;
}

interface LoadedWallet {
  accountId: string;
  publicKey: string;
  privateKey: string;
  /** BIP39 mnemonic. Only set on self-custody V2 wallets. */
  mnemonic?: string;
  /** Which onboarding track this wallet came in through. Defaults to
   *  'self-custody' for legacy wallets and founder/joiner keystores. */
  track: 'self-custody' | 'platform';
  /** Platform-track only: the email the user signed up with. */
  email?: string;
  /** Platform-track only: server session token for platform-server API calls. */
  sessionToken?: string;
}

export function saveWalletFromMnemonic(accountId: string, publicKey: string, mnemonic: string): void {
  const wallet: StoredWalletV2 = { version: 2, accountId, publicKey, mnemonic };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  localStorage.removeItem(LEGACY_KEY);
  unlockedSecret = null; // fresh plaintext wallet; drop any prior unlocked session
}

/** Legacy save path: persist a raw private key for accounts that pre-date mnemonic backup. */
export function saveWalletLegacy(wallet: StoredWalletV1): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  unlockedSecret = null;
}

/** Turn a stored self-custody wallet JSON string into a LoadedWallet. */
function parseStoredWallet(json: string): LoadedWallet | null {
  try {
    const data = JSON.parse(json);
    if (data.version === 2 && data.mnemonic) {
      const kp = mnemonicToKeypair(data.mnemonic);
      return {
        accountId: data.accountId,
        publicKey: data.publicKey || kp.publicKey,
        privateKey: kp.privateKey,
        mnemonic: data.mnemonic,
        track: 'self-custody',
      };
    }
    // V1 fallback: mnemonic-less wallets keep working until the user re-creates.
    if (data.privateKey) {
      return {
        accountId: data.accountId,
        publicKey: data.publicKey || '',
        privateKey: data.privateKey,
        track: 'self-custody',
      };
    }
  } catch {
    // not parseable — caller falls through
  }
  return null;
}

export function loadWallet(): LoadedWallet | null {
  // Self-custody track is checked first so an existing self-custody wallet
  // wins over an accidentally-stale platform session. Platform-track users
  // who installed before the SDK lookup landed don't have ae_wallet set
  // and fall through to the platform branch.
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }

    if (isKeystoreEnvelope(parsed)) {
      // Encrypted at rest. Only readable once unlocked this session; while
      // locked we report "no wallet" and the UnlockGate prompts. We do NOT
      // fall through to the platform branch — this IS the wallet.
      return unlockedSecret ? parseStoredWallet(unlockedSecret) : null;
    }

    const w = parseStoredWallet(raw);
    if (w) return w;
  }

  // Platform track. The wallet is signed in if a session exists locally.
  // (We don't re-validate the session against the platform-server on
  // every load; if it's expired or revoked, the next /me or signed API
  // call will get 401 and the AppShell's error banner will tell the
  // user to re-sign-in. That's good enough for v1.)
  const platform = loadPlatformSession();
  if (platform) {
    return {
      accountId: platform.accountId,
      publicKey: platform.publicKey,
      privateKey: platform.privateKey,
      track: 'platform',
      email: platform.email,
      sessionToken: platform.sessionToken,
    };
  }

  return null;
}

export function clearWallet(): void {
  localStorage.removeItem(STORAGE_KEY);
  clearPlatformSession();
  unlockedSecret = null;
}

export function hasWallet(): boolean {
  return (
    localStorage.getItem(STORAGE_KEY) !== null ||
    loadPlatformSession() !== null
  );
}

// ─── D2: passphrase protection ────────────────────────────────────────────

/** True iff the self-custody wallet is stored as an encrypted envelope. */
export function isWalletEncrypted(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try { return isKeystoreEnvelope(JSON.parse(raw)); } catch { return false; }
}

/**
 * True when the wallet is readable right now: a plaintext wallet is always
 * "unlocked"; an encrypted one only after a successful `unlockWallet`.
 */
export function isWalletUnlocked(): boolean {
  return !isWalletEncrypted() || unlockedSecret !== null;
}

/**
 * Decrypt the stored wallet with `passphrase` and hold it in memory for this
 * session. Returns false on a wrong passphrase (no throw, so callers can show
 * a friendly "incorrect passphrase" message). No-op-true if not encrypted.
 */
export async function unlockWallet(passphrase: string): Promise<boolean> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  let env: unknown;
  try { env = JSON.parse(raw); } catch { return false; }
  if (!isKeystoreEnvelope(env)) return true; // already plaintext
  try {
    unlockedSecret = await decryptSecret(env, passphrase);
    return true;
  } catch {
    unlockedSecret = null;
    return false;
  }
}

/** Drop the in-memory decrypted wallet (re-lock without touching storage). */
export function lockWallet(): void {
  unlockedSecret = null;
}

/**
 * Encrypt the current plaintext wallet under `passphrase` and persist the
 * envelope. The wallet stays unlocked for the rest of this session. Throws if
 * there's no wallet; a no-op if it's already encrypted.
 */
export async function protectWallet(passphrase: string): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('No wallet to protect');
  try { if (isKeystoreEnvelope(JSON.parse(raw))) return; } catch { /* not an envelope; proceed */ }
  const env = await encryptSecret(raw, passphrase);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  unlockedSecret = raw; // remain usable this session
}

/**
 * Remove passphrase protection: verify `passphrase`, then store the wallet as
 * plaintext again. Throws on a wrong passphrase; a no-op if already plaintext.
 */
export async function removeWalletPassphrase(passphrase: string): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('No wallet');
  let env: unknown;
  try { env = JSON.parse(raw); } catch { throw new Error('No wallet'); }
  if (!isKeystoreEnvelope(env)) return; // already plaintext
  const secret = await decryptSecret(env, passphrase); // throws on wrong passphrase
  localStorage.setItem(STORAGE_KEY, secret);
  unlockedSecret = null;
}

// Back-compat alias: existing code calls saveWallet({...privateKey}) for legacy login.
export function saveWallet(wallet: { accountId: string; publicKey: string; privateKey: string }): void {
  saveWalletLegacy(wallet);
}

/**
 * Save the founder's wallet from a genesis keystore. Founder accounts come
 * out of the genesis ceremony as raw ML-DSA keypairs (no BIP39 derivation),
 * so we persist them in the same shape as a V1 legacy wallet. The keystore
 * file the founder downloaded IS the recovery artifact for this account;
 * losing it loses the account, just like losing a mnemonic loses a V2.
 */
export function saveFounderWallet(keystore: { accountId: string; account: { publicKey: string; privateKey: string } }): void {
  const wallet: StoredWalletV1 = {
    accountId: keystore.accountId,
    publicKey: keystore.account.publicKey,
    privateKey: keystore.account.privateKey,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  localStorage.removeItem(LEGACY_KEY);
  unlockedSecret = null;
}

// Joiner-side persistence. A joiner has the same wallet shape as a founder
// (raw ML-DSA keypair, no mnemonic) — they just got their keystore from the
// founder instead of generating it inline. Same save function, different
// name at call sites for readability.
export const saveJoinerWallet = saveFounderWallet;

const JOINED_NETWORK_KEY = 'ae_joined_network';

/**
 * Persist the genesis spec the user joined. Stored alongside the wallet so
 * a future ae-node spawn knows which network to boot into. The Electron
 * main process will read this on next launch (forthcoming "wire main.cjs"
 * milestone task) to set AE_GENESIS_CONFIG_PATH and friends.
 */
export function saveJoinedNetwork(spec: unknown): void {
  localStorage.setItem(JOINED_NETWORK_KEY, JSON.stringify(spec));
}

export function loadJoinedNetwork(): unknown | null {
  const raw = localStorage.getItem(JOINED_NETWORK_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
