// Phase 62: networkId in the genesis spec + handshake.
//
// Locks in:
//   1. GenesisSpec.networkId is required and validated.
//   2. networkId is folded into genesisSpecHash, so two networks with
//      identical accounts but different IDs (mainnet vs testnet) get
//      different genesis hashes.
//   3. The PeerManager handshake includes networkId in the signed bytes.
//   4. A peer on a different network is rejected with a friendly error
//      ("you're on testnet, I'm on mainnet") BEFORE we fall back to the
//      cryptographic genesisHash check.
//
// Why this exists: pre-Phase-62, two operators could accidentally point
// nodes at the wrong genesis spec and the rejection log read
// "genesis hash 0xabc != 0xdef" — useless for diagnosis. After Phase 62
// the message reads "network mismatch: peer is on ae-testnet, we are on
// ae-mainnet" which any operator can act on immediately.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGenesisSpec,
  genesisSpecHash,
  NETWORK_ID_REGEX,
  type GenesisSpec,
} from '../src/node/genesis-config.js';
import { buildGenesisSet } from '../src/node/genesis-init.js';
import { buildHandshake, verifyHandshake, canonicalHandshakeBytes } from '../src/network/messages.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';

describe('Phase 62: networkId in genesis + handshake', () => {
  // ─── Spec validation ────────────────────────────────────────────────

  it('validates networkId against the canonical regex', () => {
    assert.match('ae-mainnet-1', NETWORK_ID_REGEX);
    assert.match('ae-testnet', NETWORK_ID_REGEX);
    assert.match('ae-devnet-matt', NETWORK_ID_REGEX);
    assert.match('ae123-x', NETWORK_ID_REGEX);

    assert.doesNotMatch('AE-MAINNET', NETWORK_ID_REGEX);  // uppercase
    assert.doesNotMatch('ae mainnet', NETWORK_ID_REGEX);  // space
    assert.doesNotMatch('ae_mainnet', NETWORK_ID_REGEX);  // underscore
    assert.doesNotMatch('ab', NETWORK_ID_REGEX);          // too short
    assert.doesNotMatch('-ae-mainnet', NETWORK_ID_REGEX); // leading hyphen
    assert.doesNotMatch('ae-mainnet-', NETWORK_ID_REGEX); // trailing hyphen
  });

  it('genesisSpecHash differs between two networks with identical accounts', () => {
    const mainnet = buildGenesisSet({ networkId: 'ae-mainnet-1', validatorCount: 2, genesisTimestamp: 1000 });
    const testnet: GenesisSpec = { ...mainnet.spec, networkId: 'ae-testnet-1' };

    const mainnetHash = genesisSpecHash(mainnet.spec);
    const testnetHash = genesisSpecHash(testnet);

    assert.notEqual(mainnetHash, testnetHash, 'networkId must change the spec hash');
  });

  it('genesisSpecHash is stable for the same spec', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 2, genesisTimestamp: 2000 });
    const a = genesisSpecHash(set.spec);
    const b = genesisSpecHash(JSON.parse(JSON.stringify(set.spec)));
    assert.equal(a, b);
  });

  it('buildGenesisSet rejects missing or malformed networkId', () => {
    // @ts-expect-error intentionally missing required field
    assert.throws(() => buildGenesisSet({ validatorCount: 1 }), /networkId is required/);
    assert.throws(
      () => buildGenesisSet({ networkId: 'AE-MAIN', validatorCount: 1 }),
      /networkId is required/,
    );
    assert.throws(
      () => buildGenesisSet({ networkId: '', validatorCount: 1 }),
      /networkId is required/,
    );
  });

  it('validateGenesisSpec round-trips a real spec produced by buildGenesisSet', () => {
    const set = buildGenesisSet({ networkId: 'ae-test', validatorCount: 2, genesisTimestamp: 3000 });
    const json = JSON.parse(JSON.stringify(set.spec));
    const out = validateGenesisSpec(json);
    assert.equal(out.networkId, 'ae-test');
    assert.equal(out.version, 2);
  });

  // ─── Handshake ──────────────────────────────────────────────────────

  it('canonicalHandshakeBytes folds networkId into the signed payload', () => {
    const idA = generateNodeIdentity();
    const baseFields = {
      nodeId: 'n', publicKey: idA.publicKey, version: '0.1.0',
      blockHeight: 0, genesisHash: 'g', timestamp: 1000, nonce: 'n0',
    };
    const onMainnet = canonicalHandshakeBytes({ ...baseFields, networkId: 'ae-mainnet' });
    const onTestnet = canonicalHandshakeBytes({ ...baseFields, networkId: 'ae-testnet' });
    assert.notEqual(onMainnet, onTestnet, 'networkId must alter the canonical bytes');
    assert.ok(onMainnet.includes('ae-mainnet'));
    assert.ok(onTestnet.includes('ae-testnet'));
  });

  it('buildHandshake + verifyHandshake round-trip with networkId', () => {
    const id = generateNodeIdentity();
    const hs = buildHandshake(id, {
      nodeId: 'matt', version: '0.1.0', blockHeight: 5,
      networkId: 'ae-mainnet-1', genesisHash: 'abc', nonce: 'xyz',
    });
    assert.equal(hs.networkId, 'ae-mainnet-1');
    assert.ok(verifyHandshake(hs));
  });

  it('verifyHandshake rejects a tampered networkId', () => {
    const id = generateNodeIdentity();
    const hs = buildHandshake(id, {
      nodeId: 'matt', version: '0.1.0', blockHeight: 0,
      networkId: 'ae-mainnet-1', genesisHash: 'abc', nonce: 'xyz',
    });
    // Attacker swaps networkId after signing — signature should now fail.
    const tampered = { ...hs, networkId: 'ae-testnet-1' };
    assert.equal(verifyHandshake(tampered), false);
  });
});
