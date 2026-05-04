import { mnemonicToKeypair } from './crypto';

const STORAGE_KEY = 'ae_miner_wallet';

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
}

/** Legacy save path: persist a raw private key for accounts that pre-date mnemonic backup. */
export function saveMinerWallet(wallet: { accountId: string; publicKey: string; privateKey: string }): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
}

export function loadMinerWallet(): LoadedMinerWallet | null {
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

export function clearMinerWallet(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasMinerWallet(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}
