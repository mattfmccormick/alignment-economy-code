// Wallet-side shapes for the API responses the wallet consumes. These mirror
// the ae-node serializers: camelCase fields, with bigint balances serialized as
// base-unit strings (formatting helpers accept string | bigint | number).
//
// Part of the D5 burn-down: replacing `any` in the API client with real types,
// starting with the account (the money-critical entity most pages read).

export interface AccountData {
  id: string;
  type: string;
  publicKey: string;
  earnedBalance: string;
  activeBalance: string;
  supportiveBalance: string;
  ambientBalance: string;
  lockedBalance: string;
  percentHuman: number;
  joinedDay: number;
  isActive: boolean;
  isEscrowed: boolean;
  protectionWindowEnd: number | null;
  createdAt: number;
}

/**
 * What `GET /accounts/:id` returns: the serialized account plus the derived
 * `percentOfEconomy` (the account's share of the total Earned pool), which the
 * route computes on the fly. `createAccount` returns the plain `AccountData`.
 */
export interface AccountDetail extends AccountData {
  percentOfEconomy: number;
}

/**
 * A settled transaction as returned by `GET /accounts/:id/transactions`
 * (ae-node's `rowToTransaction`). CamelCase; amounts are base-unit strings.
 * Note: this is the transaction record, distinct from the snake_case
 * `transaction_log` audit rows the ledger endpoint returns.
 */
export interface TransactionData {
  id: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  netAmount: string;
  pointType: string;
  isInPerson: boolean;
  recipientIsHuman: boolean;
  memo: string;
  signature: string;
  receiverSignature: string | null;
  timestamp: number;
  blockNumber: number | null;
}
