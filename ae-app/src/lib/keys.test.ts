import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveWalletLegacy, loadWallet, isWalletEncrypted, isWalletUnlocked,
  protectWallet, unlockWallet, lockWallet, removeWalletPassphrase,
} from './keys';

// Uses a V1 (private-key) wallet so loadWallet doesn't run ML-DSA key
// derivation; the D2 session model is identical for V2 mnemonic wallets.
const WALLET = { accountId: 'me', publicKey: 'pub', privateKey: 'priv-secret' };

describe('D2: passphrase-protected wallet session', () => {
  beforeEach(() => {
    localStorage.clear();
    lockWallet();
  });

  it('a plaintext wallet loads and counts as unlocked', () => {
    saveWalletLegacy(WALLET);
    expect(isWalletEncrypted()).toBe(false);
    expect(isWalletUnlocked()).toBe(true);
    expect(loadWallet()?.privateKey).toBe('priv-secret');
  });

  it('protectWallet encrypts at rest but stays usable this session', async () => {
    saveWalletLegacy(WALLET);
    await protectWallet('hunter2');

    // Stored blob is now ciphertext — the private key must not be in it.
    const raw = localStorage.getItem('ae_wallet')!;
    expect(raw).not.toContain('priv-secret');
    expect(isWalletEncrypted()).toBe(true);

    // Still readable in-session (protect leaves it unlocked).
    expect(isWalletUnlocked()).toBe(true);
    expect(loadWallet()?.privateKey).toBe('priv-secret');
  });

  it('locks to null and unlocks with the right passphrase only', async () => {
    saveWalletLegacy(WALLET);
    await protectWallet('hunter2');

    lockWallet();
    expect(isWalletUnlocked()).toBe(false);
    expect(loadWallet()).toBe(null); // locked ⇒ UnlockGate will prompt

    expect(await unlockWallet('wrong')).toBe(false);
    expect(loadWallet()).toBe(null);

    expect(await unlockWallet('hunter2')).toBe(true);
    expect(isWalletUnlocked()).toBe(true);
    expect(loadWallet()?.privateKey).toBe('priv-secret');
  });

  it('removeWalletPassphrase restores plaintext after verifying the passphrase', async () => {
    saveWalletLegacy(WALLET);
    await protectWallet('hunter2');

    await expect(removeWalletPassphrase('wrong')).rejects.toThrow();
    expect(isWalletEncrypted()).toBe(true);

    await removeWalletPassphrase('hunter2');
    expect(isWalletEncrypted()).toBe(false);
    expect(localStorage.getItem('ae_wallet')).toContain('priv-secret');
    expect(loadWallet()?.privateKey).toBe('priv-secret');
  });
});
