import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, type MinerStatus, type Account, type NetworkStatus } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { displayPoints } from '../lib/formatting';
import {
  submitMinerRegistration,
  registrationSentAgoMs,
  clearRegistrationSent,
  REGISTRATION_STUCK_AFTER_MS,
} from '../lib/register';

// The dashboard answers three questions and nothing else:
//   1. Am I a miner right now?
//   2. Is there work waiting for me?
//   3. What have I earned?
//
// It used to carry an uptime gauge that was 100 or 0 depending on a boolean, a
// tier checklist with every box hardcoded to ticked, an "activity" panel that
// could only ever show its empty state, and the account's % Human (which
// belongs to the person in the wallet, not to the miner). Each of those looked
// like information and was not.

type RegState = 'active' | 'deactivated' | 'pending' | 'stuck' | 'none';

export default function Dashboard() {
  const [minerStatus, setMinerStatus] = useState<MinerStatus | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [toReview, setToReview] = useState<number | null>(null);
  const [votesDue, setVotesDue] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [nodeDown, setNodeDown] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [showTiers, setShowTiers] = useState(false);
  // Bumped to re-render while a registration is in flight, so "pending" can
  // roll over to "stuck" on time even when no fetch result changes.
  const [, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async (): Promise<boolean> => {
    const wallet = loadMinerWallet();
    if (!wallet) return false;
    const [minerRes, accountRes, networkRes, panelsRes, juryRes] = await Promise.allSettled([
      api.getMinerStatus(wallet.accountId),
      api.getAccount(wallet.accountId),
      api.getNetworkStatus(),
      api.getAssignedPanels(wallet.accountId),
      api.getJuryDuty(wallet.accountId),
    ]);

    // The node being unreachable and "you are not a miner" are different
    // problems with different fixes. Only the status call decides which.
    setNodeDown(minerRes.status === 'rejected' && networkRes.status === 'rejected');

    let isMiner = false;
    if (minerRes.status === 'fulfilled' && minerRes.value.success) {
      setMinerStatus(minerRes.value.data);
      isMiner = minerRes.value.data.isMiner;
      if (isMiner) clearRegistrationSent();
    }
    if (accountRes.status === 'fulfilled' && accountRes.value.success) setAccount(accountRes.value.data);
    if (networkRes.status === 'fulfilled' && networkRes.value.success) setNetwork(networkRes.value.data);
    if (panelsRes.status === 'fulfilled' && panelsRes.value.success) {
      setToReview(
        panelsRes.value.data.assignments.filter(
          (a) => !a.myReviewSubmitted && !a.missed && a.panelStatus !== 'complete',
        ).length,
      );
    }
    if (juryRes.status === 'fulfilled' && juryRes.value.success) {
      setVotesDue(juryRes.value.data.assignments.filter((a) => !a.myVote && !a.verdict).length);
    }
    setLoading(false);
    return isMiner;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loop() {
      const isMiner = await fetchData().catch(() => false);
      if (cancelled) return;
      setTick((n) => n + 1);
      // Poll fast while waiting on a registration to commit, slowly once settled.
      timer.current = setTimeout(loop, isMiner ? 30000 : 3000);
    }
    loop();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchData]);

  async function handleRegister() {
    const wallet = loadMinerWallet();
    if (!wallet) return;
    setRegistering(true);
    setRegisterError('');
    const result = await submitMinerRegistration(wallet.accountId, wallet.privateKey);
    if (!result.ok) setRegisterError(result.message);
    setRegistering(false);
    fetchData().catch(() => {});
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-muted">
          <Spinner />
          Loading...
        </div>
      </div>
    );
  }

  if (nodeDown) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="bg-red/10 border border-red/20 rounded-lg p-6 max-w-md text-center">
          <p className="text-sm text-red mb-2">Can&apos;t reach your node.</p>
          <p className="text-xs text-muted">Make sure it is running, then this page will reconnect on its own.</p>
        </div>
      </div>
    );
  }

  const miner = minerStatus?.miner ?? null;
  const sentAgo = registrationSentAgoMs();
  const regState: RegState = miner?.isActive
    ? 'active'
    : miner
      ? 'deactivated'
      : sentAgo === null
        ? 'none'
        : sentAgo < REGISTRATION_STUCK_AFTER_MS
          ? 'pending'
          : 'stuck';
  const tier = miner?.tier === 2 ? 2 : 1;

  return (
    <div className="space-y-5 max-w-4xl">
      {/* 1. Am I a miner right now? */}
      {regState === 'active' && (
        <div className="bg-teal/10 border border-teal/30 rounded-lg p-5">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-teal" />
            <h2 className="text-base font-semibold text-white">You are an active miner</h2>
            <span className="text-xs font-semibold text-teal border border-teal/40 rounded px-2 py-0.5">Tier {tier}</span>
          </div>
          <p className="text-sm text-muted mt-2">
            {tier === 2
              ? 'Tier 2 miners take the larger share of network fees. Keep reviews accurate and never miss jury duty to stay here.'
              : 'Tier 1 is where every miner starts. Do the work accurately and show up for jury duty to move up to Tier 2.'}
            {' '}
            <button onClick={() => setShowTiers((v) => !v)} className="text-teal hover:underline">
              {showTiers ? 'Hide' : 'How tiers work'}
            </button>
          </p>
          {showTiers && <TierExplainer />}
        </div>
      )}

      {regState === 'pending' && (
        <div className="bg-gold/10 border border-gold/30 rounded-lg p-5">
          <div className="flex items-center gap-3">
            <Spinner />
            <h2 className="text-base font-semibold text-white">Registering you on the network</h2>
          </div>
          <p className="text-sm text-muted mt-2">
            Your signed registration was accepted. It takes effect when the next block is confirmed, usually about ten seconds. This page updates by itself.
          </p>
        </div>
      )}

      {regState === 'stuck' && (
        <div className="bg-red/10 border border-red/30 rounded-lg p-5">
          <h2 className="text-base font-semibold text-white">Your registration has not been confirmed</h2>
          <p className="text-sm text-muted mt-2">
            The network accepted it but has not confirmed a block since. That usually means your node is not connected to enough other nodes to confirm blocks right now. Nothing is lost. You can send it again.
          </p>
          <RegisterButton onClick={handleRegister} busy={registering} label="Send registration again" />
          {registerError && <p className="text-sm text-red mt-3">{registerError}</p>}
        </div>
      )}

      {regState === 'none' && (
        <div className="bg-panel border border-border rounded-lg p-5">
          <h2 className="text-base font-semibold text-white">This account is not a miner yet</h2>
          <p className="text-sm text-muted mt-2">
            Miners check that accounts belong to real people, sit on juries when someone is challenged, and earn a share of network fees for it.
          </p>
          <RegisterButton onClick={handleRegister} busy={registering} label="Register as Miner" />
          {registerError && <p className="text-sm text-red mt-3">{registerError}</p>}
        </div>
      )}

      {regState === 'deactivated' && (
        <div className="bg-red/10 border border-red/30 rounded-lg p-5">
          <h2 className="text-base font-semibold text-white">Your miner is switched off</h2>
          <p className="text-sm text-muted mt-2">
            The network deactivates a miner when the person behind it is no longer verified as human. Open the wallet, go to Verify, and get reviewed again. Then come back and register.
          </p>
        </div>
      )}

      {/* 2. Is there work waiting?   3. What have I earned? */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile
          to="/verify"
          label="People to verify"
          value={regState === 'active' ? fmtCount(toReview) : '--'}
          hint={toReview ? 'Review them now' : 'Nothing waiting'}
          highlight={regState === 'active' && !!toReview}
        />
        <Tile
          to="/court"
          label="Jury votes due"
          value={regState === 'active' ? fmtCount(votesDue) : '--'}
          hint={votesDue ? 'Vote before the deadline' : 'Nothing waiting'}
          highlight={regState === 'active' && !!votesDue}
        />
        <Tile
          to="/income"
          label="Earned points"
          value={account ? displayPoints(account.earnedBalance) : '--'}
          hint="See where it came from"
          gold
        />
      </div>

      {/* Network, one line */}
      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-muted mb-3">Network</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Day" value={network?.currentDay?.toLocaleString() ?? '--'} />
          <Stat label="Block" value={network?.blockHeight?.toLocaleString() ?? '--'} />
          <Stat label="People" value={network?.participantCount?.toLocaleString() ?? '--'} />
          <Stat label="Miners" value={network?.minerCount?.toLocaleString() ?? '--'} />
        </div>
      </div>
    </div>
  );
}

function fmtCount(n: number | null): string {
  return n === null ? '--' : n.toLocaleString();
}

function Spinner() {
  return (
    <svg className="w-5 h-5 animate-spin text-gold flex-shrink-0" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function RegisterButton({ onClick, busy, label }: { onClick: () => void; busy: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="mt-4 px-5 py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
    >
      {busy ? 'Sending...' : label}
    </button>
  );
}

function Tile({
  to, label, value, hint, highlight, gold,
}: { to: string; label: string; value: string; hint: string; highlight?: boolean; gold?: boolean }) {
  return (
    <Link
      to={to}
      className={`block rounded-lg border p-5 transition-colors ${
        highlight ? 'bg-teal/10 border-teal/40 hover:border-teal' : 'bg-panel border-border hover:border-teal/40'
      }`}
    >
      <div className="text-sm font-medium text-muted">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${gold ? 'text-gold' : 'text-white'}`}>{value}</div>
      <div className={`text-xs mt-2 ${highlight ? 'text-teal' : 'text-muted/70'}`}>{hint} &rarr;</div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold font-mono mt-0.5">{value}</div>
    </div>
  );
}

// The numbers behind tiers are network parameters that can be changed by
// governance, so this states the rules without quoting figures that would go
// stale. The old card listed stake and uptime thresholds the protocol never had.
function TierExplainer() {
  return (
    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="bg-bg border border-border rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-1">Tier 1</div>
        <p className="text-xs text-muted leading-relaxed">
          Every registered miner. Verifies people and shares the smaller part of network fees.
        </p>
      </div>
      <div className="bg-bg border border-border rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-1">Tier 2</div>
        <p className="text-xs text-muted leading-relaxed">
          Miners with a track record: online reliably, accurate reviews, every assignment finished, no missed jury duty. They share the larger part of fees. Slip on any of those and you drop back to Tier 1.
        </p>
      </div>
    </div>
  );
}
