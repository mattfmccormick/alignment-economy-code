import { mnemonicToKeypair } from './crypto';

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
  mnemonic?: string;
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
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data.version === 2 && data.mnemonic) {
      const kp = mnemonicToKeypair(data.mnemonic);
      return {
        accountId: data.accountId,
        publicKey: data.publicKey || kp.publicKey,
        privateKey: kp.privateKey,
        mnemonic: data.mnemonic,
      };
    }
    // V1 fallback: mnemonic-less wallets keep working until the user re-creates.
    if (data.privateKey) {
      return {
        accountId: data.accountId,
        publicKey: data.publicKey || '',
        privateKey: data.privateKey,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearWallet(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasWallet(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
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
