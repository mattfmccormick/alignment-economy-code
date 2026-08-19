import { api } from './api';
import { signPayload } from './crypto';
import type { RecurringTransferData } from './types';

/**
 * Execute any recurring transfers that are due today.
 *
 * WHY THIS LIVES IN THE WALLET AND NOT THE NODE
 *
 * A recurring transfer moves the user's money, and every transaction on this
 * network carries an ML-DSA signature made with the user's private key. The
 * node does not hold that key and must never hold it, so a server-side
 * scheduler could only move funds by either forging an unsigned transfer or
 * storing the user's key — both unacceptable.
 *
 * There is a second reason. `recurring_transfers` rows are created through the
 * API and are not replicated between nodes. A node-side executor would move
 * balances from state its peers cannot see, and the two nodes would disagree
 * about who owns what — the same divergence the state root already warns about.
 *
 * So the wallet does it, with the user's key, producing ordinary signed
 * transactions that flow through the normal path and replicate like any other.
 *
 * THE COST, STATED PLAINLY: transfers only fire while the wallet is open. A
 * user who does not open the app that day does not send. For daily points that
 * expire in 24 hours this is a real limitation, not a detail. Closing it needs
 * a signed standing mandate the node can replay — a protocol feature, not a
 * scheduling one.
 */
export interface RecurringRunResult {
  executed: number;
  failed: Array<{ id: string; reason: string }>;
}

export async function runDueRecurringTransfers(
  accountId: string,
  privateKey: string,
  currentDay: number,
): Promise<RecurringRunResult> {
  const result: RecurringRunResult = { executed: 0, failed: [] };

  const listRes = await api.getRecurring(accountId);
  if (!listRes.success) return result;

  const due = (listRes.data.transfers ?? []).filter(
    (t: RecurringTransferData) =>
      t.is_active === 1 && (t.last_executed_day == null || t.last_executed_day < currentDay),
  );

  for (const t of due) {
    try {
      // CLAIM THE DAY FIRST.
      //
      // If this is done after the send, a reload between the two — or a second
      // device opening the app the same morning — sends twice. Claiming first
      // can instead lose a day when the send fails, and that is the better
      // failure: a missed transfer is recoverable by sending manually, a
      // duplicate payment is not.
      const claimTs = Math.floor(Date.now() / 1000);
      const claimPayload = { lastExecutedDay: currentDay };
      const claim = await api.updateRecurring(t.id, {
        accountId,
        timestamp: claimTs,
        signature: signPayload(claimPayload, claimTs, privateKey),
        payload: claimPayload,
      });
      if (!claim.success) {
        result.failed.push({ id: t.id, reason: claim.error?.message ?? 'could not claim the day' });
        continue;
      }

      // `amount` is stored in BASE UNITS (10^8 per point), matching every other
      // money value that crosses this boundary. Rows written before the column
      // had a defined unit hold display units, which read as a negligibly small
      // base-unit amount — harmless. The reverse reading would have been
      // catastrophic, which is why base units is the safe direction to settle on.
      const amount = t.amount;
      const ts = Math.floor(Date.now() / 1000);
      const internalPayload = {
        from: accountId,
        to: t.to_id,
        amount,
        pointType: t.point_type,
        isInPerson: false,
        recipientIsHuman: false,
        memo: 'Scheduled transfer',
      };
      const send = await api.sendTransaction({
        payload: {
          to: t.to_id,
          amount,
          pointType: t.point_type,
          isInPerson: false,
          recipientIsHuman: false,
          memo: 'Scheduled transfer',
        },
        accountId,
        timestamp: ts,
        signature: signPayload(internalPayload, ts, privateKey),
      });

      if (send.success) {
        result.executed += 1;
      } else {
        result.failed.push({ id: t.id, reason: send.error?.message ?? 'send rejected' });
      }
    } catch (e) {
      result.failed.push({ id: t.id, reason: e instanceof Error ? e.message : 'network error' });
    }
  }

  return result;
}
