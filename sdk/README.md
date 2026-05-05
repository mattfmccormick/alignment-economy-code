# @alignmenteconomy/sdk

TypeScript SDK for the [Alignment Economy](https://github.com/mattfmccormick/alignment-economy-code). Wraps the `ae-node` HTTP API and gives you typed access to accounts, transactions, network state, and the founder/genesis ceremony, plus client-side crypto so private keys never leave the user's device.

> Status: v0.1.0. Stable API surface, but the underlying protocol is still on a private testnet.

## Install

```bash
npm install @alignmenteconomy/sdk
```

## Quick start

```ts
import {
  AlignmentEconomyClient,
  mnemonicToKeypair,
  signTransaction,
  newMnemonic,
} from '@alignmenteconomy/sdk';

const client = new AlignmentEconomyClient({
  baseUrl: 'http://localhost:3000/api/v1',
});

// Health check.
const h = await client.getHealth();
console.log(h.status); // "ok"

// New wallet (client-custody — private key never reaches the server).
const phrase = newMnemonic();
const { publicKey, privateKey } = mnemonicToKeypair(phrase);
const created = await client.createAccount('individual', publicKey);
const me = created.account;

// Send a transaction.
const { timestamp, signature } = signTransaction({
  from: me.id,
  to: '<recipient-account-id>',
  amountBaseUnits: 100_00000000n, // 100.00 points; PRECISION = 10^8
  pointType: 'earned',
  privateKey,
});
const submitted = await client.submitTransaction({
  accountId: me.id,
  timestamp,
  signature,
  payload: {
    to: '<recipient-account-id>',
    amount: 100,
    pointType: 'earned',
  },
});
console.log('committed', submitted.transaction.id);
```

## What's included (v0.1)

- `AlignmentEconomyClient` — typed wrapper around the public `/api/v1/*` endpoints
  - `getHealth`, `createAccount`, `getAccount`, `getTransactions`
  - `submitTransaction`
  - `getNetworkStatus`, `getBlocks`
  - `generateGenesis` (founder ceremony)
- Crypto primitives (re-exported from `@noble/post-quantum` + `@scure/bip39`):
  - `generateKeyPair`, `deriveAccountId`
  - `signPayload`, `verifyPayload`
  - `newMnemonic`, `isValidMnemonic`, `mnemonicToKeypair`
  - `hexToBytes`, `bytesToHex`
- A `signTransaction` convenience that builds the canonical signing payload
- Full TypeScript types for `Account`, `Transaction`, `Block`, `NetworkStatus`, etc.

## What's NOT in v0.1 yet

- WebSocket subscription helpers (the wallet does this directly via `ws` for now)
- In-person transactions — submitted txs work, but the receiver-countersignature handshake is up to the caller
- Court / verification / mining / vouching / tag endpoints (coming in v0.2)
- Browser-bundle build (today the SDK targets Node 20+; the wallet uses its own bundler)

## API conventions

- All API methods return the unwrapped `data` field from ae-node's `{success, data, error}` envelope. Failures throw `SDKError` with `.code` and `.httpStatus`.
- Bigints (balances, amounts, fees) round-trip as base-10 strings to survive JSON. Display amounts (what your UI shows) are smaller numbers; multiply by `10^8` to get base units before signing.
- Timestamps are unix seconds, integer.

## License

The same license the parent project ships under.
