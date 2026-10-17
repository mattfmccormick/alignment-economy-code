import type { TransactionRow } from '../core/stores/ITransactionStore.js';

/**
 * A transaction as exposed over the API: everything a client legitimately
 * needs, minus the two signature fields.
 *
 * A transaction signature is a valid ML-DSA signature over the sender's
 * payload, and the auth scheme signs the same way. Publishing it handed anyone
 * a replayable transaction AND, within the 5-minute auth window, a usable login
 * token for the signer (audit #2/#3). The chain keeps the signatures; no client
 * ever needs to re-read them. Every route that returns a transaction goes
 * through here.
 */
export function publicTx(tx: TransactionRow): Record<string, unknown> {
  const { signature: _s, receiverSignature: _r, ...rest } = tx;
  void _s;
  void _r;
  return rest;
}
