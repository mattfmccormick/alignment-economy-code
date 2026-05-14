import { mnemonicToKeypair } from './crypto';
import { loadPlatformSession, clearPlatformSession } from './platform';

const STORAGE_KEY = 'ae_wallet';
const LEGACY_KEY = 'ae_wallet_legacy';

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
}

/** Legacy save path: persist a raw private key for accounts that pre-date mnemonic backup. */
export function saveWalletLegacy(wallet: StoredWalletV1): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
}

export function loadWallet(): LoadedWallet | null {
  // Self-custody track is checked first so an existing self-custody wallet
  // wins over an accidentally-stale platform session. Platform-track users
  // who installed before the SDK lookup landed don't have ae_wallet set
  // and fall through to the platform branch.
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const data = JSON.parse(raw);
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
      // fall through to platform check
    }
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
}

export function hasWallet(): boolean {
  return (
    localStorage.getItem(STORAGE_KEY) !== null ||
    loadPlatformSession() !== null
  );
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
