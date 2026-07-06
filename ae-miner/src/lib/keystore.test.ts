// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isKeystoreEnvelope } from './keystore';

const SECRET = JSON.stringify({ version: 2, mnemonic: 'abandon abandon ... ability', accountId: 'me' });

describe('keystore encrypt/decrypt', () => {
  it('round-trips a secret with the correct passphrase', async () => {
    const env = await encryptSecret(SECRET, 'correct horse battery staple');
    expect(isKeystoreEnvelope(env)).toBe(true);
    // The ciphertext must not contain the plaintext.
    expect(JSON.stringify(env)).not.toContain('mnemonic');
    const out = await decryptSecret(env, 'correct horse battery staple');
    expect(out).toBe(SECRET);
  });

  it('rejects a wrong passphrase', async () => {
    const env = await encryptSecret(SECRET, 'right-pass');
    await expect(decryptSecret(env, 'wrong-pass')).rejects.toThrow(/passphrase|corrupted/i);
  });

  it('rejects a tampered ciphertext', async () => {
    const env = await encryptSecret(SECRET, 'pass');
    // Flip a character in the ciphertext; AES-GCM auth must fail.
    const tampered = { ...env, ct: env.ct.slice(0, -2) + (env.ct.endsWith('A') ? 'BB' : 'AA') };
    await expect(decryptSecret(tampered, 'pass')).rejects.toThrow(/passphrase|corrupted/i);
  });

  it('produces a fresh salt and IV each time (no reuse)', async () => {
    const a = await encryptSecret(SECRET, 'pass');
    const b = await encryptSecret(SECRET, 'pass');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct); // different IV ⇒ different ciphertext for same input
  });

  it('requires a non-empty passphrase to encrypt', async () => {
    await expect(encryptSecret(SECRET, '')).rejects.toThrow(/passphrase/i);
  });

  it('isKeystoreEnvelope distinguishes envelopes from plaintext wallets', () => {
    expect(isKeystoreEnvelope({ version: 2, mnemonic: 'x', accountId: 'y' })).toBe(false);
    expect(isKeystoreEnvelope(null)).toBe(false);
    expect(isKeystoreEnvelope('string')).toBe(false);
  });
});
