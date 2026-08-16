import { describe, it, expect } from 'vitest';
import {
  newMnemonic,
  isValidMnemonic,
  mnemonicToKeypair,
  signPayload,
  deriveAccountId,
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

// A wallet's recovery story is only as strong as its weakest requirement. The
// app generates twelve words, tells the user to write them down, and calls
// them a recovery phrase. Restoring used to ALSO need a 40-character hex
// account id the app never told anyone to keep — so a user who followed the
// instructions exactly was locked out permanently. handleLogin literally
// derived the keypair, threw it away with `void publicKey`, and told them to
// go find their Account ID.
//
// deriveAccountId closes that: the id is sha256(publicKey).slice(0, 20), and
// the phrase determines the keypair, so the id is a pure offline derivation.
// These tests pin the two properties recovery depends on — determinism, and
// byte-for-byte agreement with ae-node's own deriveAccountId. If those drift,
// recovery silently starts resolving to an account that does not exist.
describe('deriveAccountId', () => {
  it('produces a 40-char lowercase hex id', () => {
    const { publicKey } = mnemonicToKeypair(PHRASE);
    expect(deriveAccountId(publicKey)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the same phrase always resolves to the same account, with no server', () => {
    const first = deriveAccountId(mnemonicToKeypair(PHRASE).publicKey);
    const second = deriveAccountId(mnemonicToKeypair(PHRASE).publicKey);
    expect(first).toBe(second);
  });

  it('different phrases resolve to different accounts', () => {
    const a = deriveAccountId(mnemonicToKeypair(PHRASE).publicKey);
    const b = deriveAccountId(mnemonicToKeypair(newMnemonic()).publicKey);
    expect(a).not.toBe(b);
  });

  it('matches ae-node byte for byte', () => {
    // Pinned against the server's own derivation, obtained by running
    // ae-node's deriveAccountId on this exact input. The server is what
    // actually assigns ids, so this is the assertion that matters: if the two
    // implementations ever diverge, every recovery resolves to a phantom
    // account and the failure looks like "account not found" rather than
    // "your wallet code is wrong".
    expect(deriveAccountId('ab'.repeat(1952))).toBe(
      'f818b47b772449955fed6b7652624ca7d298d502',
    );
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
