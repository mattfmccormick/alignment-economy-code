import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveMinerWallet, loadMinerWallet, isMinerWalletEncrypted, isMinerWalletUnlocked,
  protectMinerWallet, unlockMinerWallet, lockMinerWallet, removeMinerWalletPassphrase,
} from './keys';

const WALLET = { accountId: 'me', publicKey: 'pub', privateKey: 'priv-secret' };

describe('D2: passphrase-protected miner wallet session', () => {
  beforeEach(() => {
    localStorage.clear();
    lockMinerWallet();
  });

  it('a plaintext wallet loads and counts as unlocked', () => {
    saveMinerWallet(WALLET);
    expect(isMinerWalletEncrypted()).toBe(false);
    expect(isMinerWalletUnlocked()).toBe(true);
    expect(loadMinerWallet()?.privateKey).toBe('priv-secret');
  });

  it('protect encrypts at rest but stays usable this session', async () => {
    saveMinerWallet(WALLET);
    await protectMinerWallet('hunter2');
    expect(localStorage.getItem('ae_miner_wallet')!).not.toContain('priv-secret');
    expect(isMinerWalletEncrypted()).toBe(true);
    expect(loadMinerWallet()?.privateKey).toBe('priv-secret');
  });

  it('locks to null and unlocks with the right passphrase only', async () => {
    saveMinerWallet(WALLET);
    await protectMinerWallet('hunter2');

    lockMinerWallet();
    expect(loadMinerWallet()).toBe(null);
    expect(await unlockMinerWallet('wrong')).toBe(false);
    expect(loadMinerWallet()).toBe(null);
    expect(await unlockMinerWallet('hunter2')).toBe(true);
    expect(loadMinerWallet()?.privateKey).toBe('priv-secret');
  });

  it('remove restores plaintext after verifying the passphrase', async () => {
    saveMinerWallet(WALLET);
    await protectMinerWallet('hunter2');
    await expect(removeMinerWalletPassphrase('wrong')).rejects.toThrow();
    await removeMinerWalletPassphrase('hunter2');
    expect(isMinerWalletEncrypted()).toBe(false);
    expect(loadMinerWallet()?.privateKey).toBe('priv-secret');
  });
});
