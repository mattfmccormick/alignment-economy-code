import { mnemonicToKeypair } from './crypto';
import { encryptSecret, decryptSecret, isKeystoreEnvelope } from './keystore';

const STORAGE_KEY = 'ae_miner_wallet';

// D2: decrypted wallet held in memory only after a successful unlock, so
// loadMinerWallet() stays synchronous. Never persisted; cleared on lock/logout.
let unlockedSecret: string | null = null;

interface StoredMinerWalletV2 {
  version: 2;
  accountId: string;
  publicKey: string;
  /** BIP39 mnemonic — source of truth. Private key derived on demand. */
  mnemonic: string;
}

interface LoadedMinerWallet {
  accountId: string;
  publicKey: string;
  privateKey: string;
  mnemonic?: string;
}

export function saveMinerWalletFromMnemonic(accountId: string, publicKey: string, mnemonic: string): void {
  const wallet: StoredMinerWalletV2 = { version: 2, accountId, publicKey, mnemonic };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  unlockedSecret = null;
}

/** Legacy save path: persist a raw private key for accounts that pre-date mnemonic backup. */
export function saveMinerWallet(wallet: { accountId: string; publicKey: string; privateKey: string }): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  unlockedSecret = null;
}

/** Turn a stored wallet JSON string into a LoadedMinerWallet. */
function parseStoredWallet(json: string): LoadedMinerWallet | null {
  try {
    const data = JSON.parse(json);
    if (data.version === 2 && data.mnemonic) {
      const kp = mnemonicToKeypair(data.mnemonic);
      return {
        accountId: data.accountId,
        publicKey: data.publicKey || kp.publicKey,
        privateKey: kp.privateKey,
        mnemonic: data.mnemonic,
      };
    }
    if (data.privateKey) {
      return {
        accountId: data.accountId,
        publicKey: data.publicKey || '',
        privateKey: data.privateKey,
      };
    }
  } catch {
    // not parseable
  }
  return null;
}

export function loadMinerWallet(): LoadedMinerWallet | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }

  // Encrypted at rest: readable only once unlocked this session. While locked
  // we return null and the UnlockGate prompts.
  if (isKeystoreEnvelope(parsed)) {
    return unlockedSecret ? parseStoredWallet(unlockedSecret) : null;
  }
  return parseStoredWallet(raw);
}

export function clearMinerWallet(): void {
  localStorage.removeItem(STORAGE_KEY);
  unlockedSecret = null;
}

export function hasMinerWallet(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

// ─── D2: passphrase protection ────────────────────────────────────────────

export function isMinerWalletEncrypted(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try { return isKeystoreEnvelope(JSON.parse(raw)); } catch { return false; }
}

export function isMinerWalletUnlocked(): boolean {
  return !isMinerWalletEncrypted() || unlockedSecret !== null;
}

export async function unlockMinerWallet(passphrase: string): Promise<boolean> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  let env: unknown;
  try { env = JSON.parse(raw); } catch { return false; }
  if (!isKeystoreEnvelope(env)) return true;
  try {
    unlockedSecret = await decryptSecret(env, passphrase);
    return true;
  } catch {
    unlockedSecret = null;
    return false;
  }
}

export function lockMinerWallet(): void {
  unlockedSecret = null;
}

export async function protectMinerWallet(passphrase: string): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('No wallet to protect');
  try { if (isKeystoreEnvelope(JSON.parse(raw))) return; } catch { /* proceed */ }
  const env = await encryptSecret(raw, passphrase);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  unlockedSecret = raw;
}

export async function removeMinerWalletPassphrase(passphrase: string): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('No wallet');
  let env: unknown;
  try { env = JSON.parse(raw); } catch { throw new Error('No wallet'); }
  if (!isKeystoreEnvelope(env)) return;
  const secret = await decryptSecret(env, passphrase);
  localStorage.setItem(STORAGE_KEY, secret);
  unlockedSecret = null;
}
