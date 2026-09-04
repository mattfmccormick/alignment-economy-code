import { describe, it, expect } from 'vitest';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
  newMnemonic,
  isValidMnemonic,
  mnemonicToKeypair,
  signPayload,
  deriveAccountId,
  signTagProductRegister,
  signTagSpaceRegister,
  signTagSupportiveSubmit,
  signTagAmbientSubmit,
  hexToBytes,
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

// The tagging signers' canonical bytes MUST match ae-node's tagging-operation.ts
// canonicalBytesFor byte-for-byte, or every signature fails verify. The encoding
// is a JSON positional array (NOT a pipe-join) so free-text names and the tag
// array are unambiguous. These reconstruct the exact expected string, confirm
// the op's signature verifies against it, and pin the wire format against drift.
describe('tagging operation signers (audit #16 canonical bytes)', () => {
  const { publicKey, privateKey } = mnemonicToKeypair(PHRASE);
  const accountId = deriveAccountId(publicKey);
  const TS = 1_700_000_000;
  const verifies = (sigHex: string, canonical: string) =>
    ml_dsa65.verify(hexToBytes(sigHex), new TextEncoder().encode(canonical), hexToBytes(publicKey));

  it('product_register: signature verifies against the JSON positional-array bytes', () => {
    const op = signTagProductRegister(accountId, 'Oak Chair', 'furniture', null, TS, privateKey);
    const canonical = JSON.stringify(['product_register', accountId, 'Oak Chair', 'furniture', null, TS]);
    expect(verifies(op.signature, canonical)).toBe(true);
    expect(op.manufacturerId).toBe(null);
  });

  it('product name containing a pipe and quotes is unambiguous (the reason for JSON, not pipe-join)', () => {
    const op = signTagProductRegister(accountId, 'A|B "x"', 'c', 'mfg1', TS, privateKey);
    const canonical = JSON.stringify(['product_register', accountId, 'A|B "x"', 'c', 'mfg1', TS]);
    expect(verifies(op.signature, canonical)).toBe(true);
  });

  it('space_register: signature verifies against the JSON positional-array bytes', () => {
    const op = signTagSpaceRegister(accountId, 'Room 1', 'room', 'parent1', 'ent1', 5, TS, privateKey);
    const canonical = JSON.stringify(['space_register', accountId, 'Room 1', 'room', 'parent1', 'ent1', 5, TS]);
    expect(verifies(op.signature, canonical)).toBe(true);
  });

  it('supportive_tag_submit: nested tag array is serialized in signed order', () => {
    const tags = [{ productId: 'p1', minutesUsed: 60 }, { productId: 'p2', minutesUsed: 120 }];
    const op = signTagSupportiveSubmit(accountId, 3, tags, TS, privateKey);
    const canonical = JSON.stringify(['supportive_tag_submit', accountId, 3, [['p1', 60], ['p2', 120]], TS]);
    expect(verifies(op.signature, canonical)).toBe(true);
  });

  it('ambient_tag_submit: nested tag array is serialized in signed order', () => {
    const tags = [{ spaceId: 's1', minutesOccupied: 200 }];
    const op = signTagAmbientSubmit(accountId, 3, tags, TS, privateKey);
    const canonical = JSON.stringify(['ambient_tag_submit', accountId, 3, [['s1', 200]], TS]);
    expect(verifies(op.signature, canonical)).toBe(true);
  });
});
