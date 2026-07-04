import { describe, it, expect } from 'vitest';
import {
  newMnemonic,
  isValidMnemonic,
  mnemonicToKeypair,
  signPayload,
} from './crypto';

// A fixed valid BIP39 phrase so key derivation is reproducible in the test.
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('mnemonic key derivation', () => {
  it('is deterministic: the same phrase always yields the same keypair', () => {
    const a = mnemonicToKeypair(PHRASE);
    const b = mnemonicToKeypair(PHRASE);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.privateKey).toBe(b.privateKey);
    expect(a.publicKey.length).toBeGreaterThan(0);
  });

  it('different phrases yield different keys', () => {
    const a = mnemonicToKeypair(PHRASE);
    const b = mnemonicToKeypair(newMnemonic());
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('mnemonic validation', () => {
  it('accepts a freshly generated 12-word mnemonic', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('rejects garbage and tolerates surrounding whitespace', () => {
    expect(isValidMnemonic('not a real mnemonic phrase at all here now')).toBe(false);
    expect(isValidMnemonic(`  ${PHRASE}  `)).toBe(true);
  });
});

describe('signPayload', () => {
  it('produces a hex signature over the payload', () => {
    const { privateKey } = mnemonicToKeypair(PHRASE);
    const sig = signPayload({ to: 'x', amount: '100000000' }, 1_700_000_000, privateKey);
    expect(sig).toMatch(/^[0-9a-f]+$/);
    expect(sig.length).toBeGreaterThan(0);
  });
});
