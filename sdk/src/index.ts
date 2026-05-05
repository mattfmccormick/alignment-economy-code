// @alignmenteconomy/sdk public surface.
//
// Two layers consumers usually want:
//   - `AlignmentEconomyClient` for HTTP calls against ae-node
//   - `signPayload` / `mnemonicToKeypair` / `signTransaction` for client-side
//     custody so the private key never touches a server
//
// Example:
//
//   import { AlignmentEconomyClient, mnemonicToKeypair, signTransaction } from '@alignmenteconomy/sdk';
//
//   const client = new AlignmentEconomyClient({ baseUrl: 'http://localhost:3000/api/v1' });
//   const { publicKey, privateKey } = mnemonicToKeypair('twelve word recovery phrase ...');
//   const me = await client.getAccount('<accountId>');
//
//   const { timestamp, signature } = signTransaction({
//     from: me.id,
//     to: '<recipient-id>',
//     amountBaseUnits: 100_00000000n, // 100.00 points (PRECISION = 10^8)
//     pointType: 'earned',
//     privateKey,
//   });
//   await client.submitTransaction({
//     accountId: me.id,
//     timestamp,
//     signature,
//     payload: { to: '<recipient-id>', amount: 100, pointType: 'earned' },
//   });

export { AlignmentEconomyClient, SDKError, signTransaction } from './client.js';
export type { ClientOptions } from './client.js';

export {
  generateKeyPair,
  deriveAccountId,
  signPayload,
  verifyPayload,
  newMnemonic,
  isValidMnemonic,
  mnemonicToKeypair,
  hexToBytes,
  bytesToHex,
} from './crypto.js';
export type { KeyPair } from './crypto.js';

export type {
  Account,
  AccountType,
  ApiResponse,
  Block,
  NetworkStatus,
  PointType,
  Transaction,
  TransactionPayload,
} from './types.js';
