// Vouch page — peer-to-peer humanity attestation.
//
// Flow:
//   1. Send a request: ask another miner to vouch for you. The request lands in
//      their inbox.
//   2. Inbox: each pending request shows the asker's account ID and message,
//      with Accept (creates a real vouch by staking earned points) or Decline.
//   3. Active vouches: list of who's currently vouching for you (received) and
//      who you're staking on (given).
//
// On accept the UI does TWO API calls: POST /miners/vouches to lock the stake,
// then PUT /miners/vouch-requests/:id to mark the request 'accepted'. Decline
// is just the PUT. Order matters — we lock stake first so a failed stake (e.g.
// insufficient earned) doesn't leave a stale 'accepted' request.

import { useEffect, useState } from 'react';
import { api, type VouchData, type VouchRequests, type Account } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { displayPoints, truncateId, timeAgo } from '../lib/formatting';

const PRECISION = 100_000_000n;
const MIN_STAKE_PERCENT = 5n; // matches white-paper default vouch policy

function pointsToRaw(displayPoints: number): bigint {
  return BigInt(Math.round(displayPoints * Number(PRECISION)));
}

export default function Vouch() {
  const wallet = loadMinerWallet();
  const [account, setAccount] = useState<Account | null>(null);
  const [vouches, setVouches] = useState<VouchData | null>(null);
  const [requests, setRequests] = useState<VouchRequests | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = async () => {
    if (!wallet) return;
    try {
      const [acctRes, vouchRes, reqRes] = await Promise.allSettled([
        api.getAccount(wallet.accountId),
        api.getVouches(wallet.accountId),
        api.getVouchRequests(wallet.accountId),
      ]);
      if (acctRes.status === 'fulfilled' && acctRes.value.success) {
        setAccount(acctRes.value.data);
      }
      if (vouchRes.status === 'fulfilled' && vouchRes.value.success) {
        setVouches(vouchRes.value.data);
      }
      if (reqRes.status === 'fulfilled' && reqRes.value.success) {
        setRequests(reqRes.value.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vouch data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  if (!wallet) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-muted">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading vouch data…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="bg-red/10 border border-red/20 rounded-lg p-6 max-w-md text-center">
          <p className="text-sm text-red mb-2">{error}</p>
          <p className="text-xs text-muted">Make sure the AE node is running at localhost:3000</p>
        </div>
      </div>
    );
  }

  // Earned balance is the source of stake. Treat both string and {balances} shapes
  // safely — older API responses returned a flat earnedBalance, newer ones return
  // a nested balances object.
  const earnedRaw = BigInt(
    (account as any)?.earnedBalance ?? account?.balances?.earned ?? '0',
  );
  const minStakeRaw = (earnedRaw * MIN_STAKE_PERCENT) / 100n;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Vouch</h2>
        <p className="text-sm text-muted mt-1">
          Stake your earned points to attest someone is human. Vouches feed their
          %Human score; if they're later challenged and judged not human, your
          stake burns.
        </p>
      </div>

      {/* Stake budget summary */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          label="Your Earned"
          value={displayPoints(earnedRaw.toString()) + ' pts'}
          hint="Source of stake"
        />
        <StatCard
          label="Min Stake (5%)"
          value={displayPoints(minStakeRaw.toString()) + ' pts'}
          hint="Per vouch policy"
        />
        <StatCard
          label="Active Vouches Given"
          value={String(vouches?.given.length ?? 0)}
          hint="Stakes locked right now"
        />
      </div>

      <SendRequestCard fromId={wallet.accountId} onSent={refresh} />

      <IncomingRequestsCard
        requests={requests?.incoming ?? []}
        myAccountId={wallet.accountId}
        minStakeRaw={minStakeRaw}
        earnedRaw={earnedRaw}
        onChanged={refresh}
      />

      <OutgoingRequestsCard requests={requests?.outgoing ?? []} />

      <ActiveVouchesCard
        received={vouches?.received ?? []}
        given={vouches?.given ?? []}
      />
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-xl font-semibold mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

// ---------- Send a request ----------

function SendRequestCard({ fromId, onSent }: { fromId: string; onSent: () => void }) {
  const [toId, setToId] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [okFor, setOkFor] = useState<string | null>(null);

  const submit = async () => {
    setErr('');
    setOkFor(null);
    if (!toId.trim()) { setErr('Recipient account ID is required.'); return; }
    if (toId.trim() === fromId) { setErr('Cannot request a vouch from yourself.'); return; }
    setSubmitting(true);
    try {
      const r = await api.sendVouchRequest(fromId, toId.trim(), message.trim());
      if (r.success) {
        setOkFor(toId.trim());
        setToId(''); setMessage('');
        onSent();
      } else {
        setErr(r.error?.message ?? 'Failed to send request.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <h3 className="text-sm font-semibold mb-1">Request a vouch</h3>
      <p className="text-xs text-muted mb-4">
        Ask another miner to stake on your behalf. They'll see this in their inbox.
      </p>
      <div className="space-y-3">
        <input
          value={toId}
          onChange={(e) => setToId(e.target.value)}
          placeholder="Their account ID (40 hex chars)"
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm font-mono placeholder:text-muted/50"
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Optional message — context that helps them decide (e.g. 'we met at the Sept meetup')"
          rows={2}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm placeholder:text-muted/50"
        />
        {err && <p className="text-xs text-red">{err}</p>}
        {okFor && (
          <p className="text-xs text-teal">
            Request sent to {truncateId(okFor)}. They'll see it in their inbox.
          </p>
        )}
        <button
          onClick={submit}
          disabled={submitting || !toId.trim()}
          className="px-4 py-2 bg-teal text-white text-sm rounded hover:bg-teal/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : 'Send request'}
        </button>
      </div>
    </div>
  );
}

// ---------- Incoming requests ----------

function IncomingRequestsCard({
  requests, myAccountId, minStakeRaw, earnedRaw, onChanged,
}: {
  requests: any[];
  myAccountId: string;
  minStakeRaw: bigint;
  earnedRaw: bigint;
  onChanged: () => void;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Incoming requests</h3>
        <span className="text-xs text-muted">{requests.length} pending</span>
      </div>
      {requests.length === 0 ? (
        <div className="bg-bg border border-border/50 rounded p-4 text-center">
          <p className="text-xs text-muted">No incoming requests right now.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => (
            <IncomingRow
              key={r.id}
              request={r}
              myAccountId={myAccountId}
              minStakeRaw={minStakeRaw}
              earnedRaw={earnedRaw}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function IncomingRow({
  request, myAccountId, minStakeRaw, earnedRaw, onChanged,
}: {
  request: any;
  myAccountId: string;
  minStakeRaw: bigint;
  earnedRaw: bigint;
  onChanged: () => void;
}) {
  const minStakeDisplay = Number(minStakeRaw) / Number(PRECISION);
  const [stakeInput, setStakeInput] = useState<string>(minStakeDisplay.toFixed(2));
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [rowErr, setRowErr] = useState('');

  const accept = async () => {
    setRowErr('');
    const stakeNum = Number(stakeInput);
    if (!isFinite(stakeNum) || stakeNum <= 0) { setRowErr('Stake must be a positive number.'); return; }
    const stakeRaw = pointsToRaw(stakeNum);
    if (stakeRaw < minStakeRaw) {
      setRowErr(`Stake below minimum ${displayPoints(minStakeRaw.toString())} pts (5% of earned).`);
      return;
    }
    if (stakeRaw > earnedRaw) {
      setRowErr(`Stake exceeds your earned balance.`);
      return;
    }
    setBusy('accept');
    try {
      const v = await api.submitVouch(myAccountId, request.fromId, Number(stakeRaw));
      if (!v.success) {
        setRowErr(v.error?.message ?? 'Failed to lock stake.');
        return;
      }
      const u = await api.updateVouchRequest(request.id, 'accepted');
      if (!u.success) {
        setRowErr(u.error?.message ?? 'Stake locked but failed to mark request accepted — refreshing.');
      }
      onChanged();
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    setRowErr('');
    setBusy('decline');
    try {
      const r = await api.updateVouchRequest(request.id, 'declined');
      if (!r.success) setRowErr(r.error?.message ?? 'Failed to decline.');
      onChanged();
    } catch (e) {
      setRowErr(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="bg-bg border border-border/50 rounded p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-mono text-muted truncate">{truncateId(request.fromId)}</div>
          {request.message && <div className="text-sm mt-1">{request.message}</div>}
          <div className="text-[11px] text-muted mt-1">{timeAgo(Number(request.createdAt))}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            type="number"
            min={0}
            step={0.01}
            value={stakeInput}
            onChange={(e) => setStakeInput(e.target.value)}
            className="w-24 bg-card border border-border rounded px-2 py-1.5 text-sm text-right tabular-nums"
            disabled={busy !== null}
          />
          <span className="text-[11px] text-muted">pts</span>
          <button
            onClick={accept}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-teal text-white text-xs rounded hover:bg-teal/90 disabled:opacity-50"
          >
            {busy === 'accept' ? '…' : 'Accept'}
          </button>
          <button
            onClick={decline}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-card border border-border text-xs rounded hover:bg-white/5 disabled:opacity-50"
          >
            {busy === 'decline' ? '…' : 'Decline'}
          </button>
        </div>
      </div>
      {rowErr && <p className="text-xs text-red mt-2">{rowErr}</p>}
    </li>
  );
}

// ---------- Outgoing requests ----------

function OutgoingRequestsCard({ requests }: { requests: any[] }) {
  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Your outgoing requests</h3>
        <span className="text-xs text-muted">{requests.length} pending</span>
      </div>
      {requests.length === 0 ? (
        <p className="text-xs text-muted">You haven't asked anyone for a vouch yet.</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.id} className="bg-bg border border-border/50 rounded p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-mono text-muted truncate">→ {truncateId(r.toId)}</div>
                  {r.message && <div className="text-xs mt-1 text-muted/80">{r.message}</div>}
                </div>
                <span className="text-[11px] text-muted shrink-0">{timeAgo(Number(r.createdAt))}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Active vouches ----------

function ActiveVouchesCard({ received, given }: { received: any[]; given: any[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Vouches I've received</h3>
          <span className="text-xs text-muted">{received.length}</span>
        </div>
        {received.length === 0 ? (
          <p className="text-xs text-muted">Nobody has staked on you yet.</p>
        ) : (
          <ul className="space-y-2">
            {received.map((v) => (
              <li key={v.id} className="bg-bg border border-border/50 rounded p-3 flex items-center justify-between gap-3">
                <div className="text-xs font-mono text-muted truncate">{truncateId(v.voucherId)}</div>
                <div className="text-xs tabular-nums shrink-0">
                  {displayPoints(v.stakeAmount)} pts
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">My active stakes</h3>
          <span className="text-xs text-muted">{given.length}</span>
        </div>
        {given.length === 0 ? (
          <p className="text-xs text-muted">You aren't staking on anyone right now.</p>
        ) : (
          <ul className="space-y-2">
            {given.map((v) => (
              <li key={v.id} className="bg-bg border border-border/50 rounded p-3 flex items-center justify-between gap-3">
                <div className="text-xs font-mono text-muted truncate">→ {truncateId(v.vouchedId)}</div>
                <div className="text-xs tabular-nums shrink-0">
                  {displayPoints(v.stakeAmount)} pts locked
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
