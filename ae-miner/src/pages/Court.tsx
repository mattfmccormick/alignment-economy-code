// Court (miner side). A miner meets the court in two seats: as a juror drawn
// to decide a case, and as a challenger who filed one. Each card carries the
// case's tracker, full account IDs and the claim in plain words; voting,
// evidence and withdrawing all happen on the case page, where both sides'
// evidence is in view.

import { useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type JuryAssignment, type MyCase } from '../lib/api';
import { loadMinerWallet } from '../lib/keys';
import { signPayload } from '../lib/crypto';
import { displayPoints } from '../lib/formatting';
import { hashFileSHA256 } from '../lib/hash';
import { wsClient } from '../lib/websocket';
import { caseProgress, claimText, stakeNote, whereLabel } from '../lib/courtSteps';
import { CaseTracker } from '../components/court/CaseTracker';

type Tab = 'jury' | 'cases' | 'file';
type PendingFile = { key: string; name: string; hash: string | null };

function shortDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function Court() {
  const [tab, setTab] = useState<Tab>('jury');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assignments, setAssignments] = useState<JuryAssignment[]>([]);
  const [myCases, setMyCases] = useState<MyCase[]>([]);

  // File-challenge form state
  const [defendantId, setDefendantId] = useState('');
  const [caseType, setCaseType] = useState<'not_human' | 'duplicate_account'>('not_human');
  const [counterpartId, setCounterpartId] = useState('');
  const [stakePercent, setStakePercent] = useState(5);
  const [openingArgument, setOpeningArgument] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [filing, setFiling] = useState(false);

  const load = useCallback(async () => {
    const wallet = loadMinerWallet();
    if (!wallet?.accountId) {
      setLoading(false);
      return;
    }
    try {
      const [juryRes, casesRes] = await Promise.all([api.getJuryDuty(wallet.accountId), api.getMyCases(wallet.accountId)]);
      if (juryRes.success) setAssignments(juryRes.data.assignments);
      if (casesRes.success) setMyCases(casesRes.data.cases.filter((c) => c.isChallenger));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load court data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const offs = ['jury:called', 'court:verdict', 'court:argument', 'court:trial-demanded', 'court:appeal'].map((evt) =>
      wsClient.on(evt, () => load()),
    );
    return () => { for (const off of offs) off(); };
  }, [load]);

  async function addFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of picked) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setFiles((fs) => [...fs, { key, name: file.name, hash: null }]);
      try {
        const hash = await hashFileSHA256(file);
        setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, hash } : f)));
      } catch {
        setFiles((fs) => fs.filter((f) => f.key !== key));
        setError(`Could not read ${file.name}`);
      }
    }
  }

  async function fileChallenge() {
    const wallet = loadMinerWallet();
    if (!wallet?.privateKey) return;
    if (!defendantId.trim()) {
      setError("Enter the defendant's account ID");
      return;
    }
    if (caseType === 'duplicate_account' && !counterpartId.trim()) {
      setError('Name the earlier account this one duplicates');
      return;
    }
    setFiling(true);
    setError('');
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        defendantAccountId: defendantId.trim(), caseType, stakePercent,
      };
      if (caseType === 'duplicate_account') payload.counterpartAccountId = counterpartId.trim();
      const trimmedArg = openingArgument.trim();
      if (trimmedArg) payload.openingArgument = trimmedArg;
      const ready = files.filter((f) => f.hash !== null);
      if (ready.length > 0) payload.attachments = ready.map((f) => ({ name: f.name, hash: f.hash }));
      const sig = signPayload(payload, ts, wallet.privateKey);
      const res = await api.fileChallenge({
        accountId: wallet.accountId,
        timestamp: ts,
        signature: sig,
        payload,
      });
      if (res.success) {
        setDefendantId('');
        setCounterpartId('');
        setOpeningArgument('');
        setFiles([]);
        await load();
        setTab('cases');
      } else {
        setError(res.error?.message || 'Failed to file challenge');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setFiling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted">Loading court data…</p>
      </div>
    );
  }

  const votesNeeded = assignments.filter((a) => a.myVote === null && a.verdict === null).length;
  const hashing = files.some((f) => f.hash === null);

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <h1 className="text-2xl font-bold text-white">Court</h1>

      <div className="flex gap-1 bg-panel border border-border rounded-lg p-1">
        {(['jury', 'cases', 'file'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setError(''); }}
            className={`flex-1 px-4 py-2.5 rounded-md text-sm font-medium transition-colors ${
              tab === t ? 'bg-teal/10 text-teal' : 'text-muted hover:text-white'
            }`}
          >
            {t === 'jury' ? `Jury Duty (${votesNeeded})` : t === 'cases' ? `Your Cases (${myCases.length})` : 'File Challenge'}
          </button>
        ))}
      </div>

      {error && <div className="p-3 bg-red/10 border border-red/20 rounded-lg text-sm text-red">{error}</div>}

      {tab === 'jury' &&
        (assignments.length === 0 ? (
          <div className="bg-panel border border-border rounded-lg p-8 text-center space-y-1">
            <p className="text-sm text-white">No jury duty right now.</p>
            <p className="text-xs text-muted">
              Jurors are drawn at random from people who are at least 90% human. When you&apos;re drawn, the case shows up here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {assignments.map((a) => (
              <Link
                key={a.caseId}
                to={`/court/${a.caseId}`}
                className="block bg-panel border border-border rounded-lg p-4 space-y-3 hover:border-teal/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gold uppercase tracking-wider">You&apos;re on the jury</span>
                  <span className="text-[11px] text-teal">{whereLabel(a.caseStatus)}</span>
                </div>
                <p className="text-sm text-white">The challenger {claimText(a.caseType)}</p>
                <div className="text-xs">
                  <div className="text-muted mb-0.5">Defendant</div>
                  <div className="font-mono text-white break-all">{a.defendantId}</div>
                </div>
                <CaseTracker progress={caseProgress(a.caseStatus)} compact />
                <p className="text-xs text-muted">Your juror stake: {displayPoints(a.stakeAmount)} pts</p>
                {a.verdict ? (
                  <p className={`text-sm font-medium ${a.verdict === 'guilty' ? 'text-red' : 'text-teal'}`}>
                    The jury says: {a.verdict === 'guilty' ? 'not human' : 'human'}
                  </p>
                ) : a.myVote ? (
                  <p className="text-xs text-teal">You voted. Sealed until every juror has voted.</p>
                ) : (
                  <p className="text-xs text-gold">
                    Your vote is needed{a.votingDeadline ? ` by ${shortDate(a.votingDeadline)}` : ''}.
                  </p>
                )}
                <p className="text-xs text-teal">{a.myVote || a.verdict ? 'See the case →' : 'Read both sides and vote →'}</p>
              </Link>
            ))}
          </div>
        ))}

      {tab === 'cases' &&
        (myCases.length === 0 ? (
          <div className="bg-panel border border-border rounded-lg p-8 text-center space-y-1">
            <p className="text-sm text-white">You haven&apos;t filed any cases.</p>
            <p className="text-xs text-muted">If you think an account isn&apos;t a real, unique person, file a challenge.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {myCases.map((c) => (
              <Link
                key={c.id}
                to={`/court/${c.id}`}
                className="block bg-panel border border-border rounded-lg p-4 space-y-3 hover:border-teal/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gold uppercase tracking-wider">You filed this</span>
                  <span className="text-[11px] text-teal">{whereLabel(c.status)}</span>
                </div>
                <p className="text-sm text-white">You say {claimText(c.type).replace(/^says /, '')}</p>
                <div className="text-xs">
                  <div className="text-muted mb-0.5">Defendant</div>
                  <div className="font-mono text-white break-all">{c.defendantId}</div>
                </div>
                <CaseTracker progress={caseProgress(c.status)} compact />
                <p className="text-xs text-muted">
                  You staked {displayPoints(c.challengerStake)} pts {stakeNote(c.challengerStake, c.challengerStakePercent)}
                </p>
                {c.verdict && (
                  <p className={`text-sm font-medium ${c.verdict === 'guilty' ? 'text-red' : 'text-teal'}`}>
                    The jury says: {c.verdict === 'guilty' ? 'not human' : 'human'}
                  </p>
                )}
                <p className="text-xs text-teal">See the evidence and their side →</p>
              </Link>
            ))}
          </div>
        ))}

      {tab === 'file' && (
        <div className="bg-panel border border-border rounded-lg p-6 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-white">File a challenge</h3>
            <p className="text-xs text-muted mt-1 leading-relaxed">
              You stake your own earned points that this account isn&apos;t a real, unique person. Win and you get your stake back plus
              20% of their savings. Lose and you lose your stake: half goes to them, the rest is burned.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Defendant&apos;s account ID</label>
            <input
              value={defendantId}
              onChange={(e) => setDefendantId(e.target.value)}
              placeholder="Their full account ID"
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-muted/40 focus:outline-none focus:border-teal"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">What are you claiming?</label>
            <select
              value={caseType}
              onChange={(e) => setCaseType(e.target.value as 'not_human' | 'duplicate_account')}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-teal"
            >
              <option value="not_human">No real person is behind it (bot or AI)</option>
              <option value="duplicate_account">It&apos;s a second account of someone who already has one</option>
            </select>
          </div>
          {caseType === 'duplicate_account' && (
            <div>
              <label className="block text-xs text-muted mb-1.5">
                Their earlier account <span className="text-muted/70">(the one that stays open)</span>
              </label>
              <input
                value={counterpartId}
                onChange={(e) => setCounterpartId(e.target.value)}
                placeholder="Full account ID (must have joined before the defendant)"
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-muted/40 focus:outline-none focus:border-teal"
              />
            </div>
          )}
          <div>
            <label className="block text-xs text-muted mb-1.5">Stake: {stakePercent}% of your earned points</label>
            <input type="range" min={1} max={50} value={stakePercent} onChange={(e) => setStakePercent(parseInt(e.target.value))} className="w-full" />
            <p className="text-[11px] text-muted mt-1">Never less than 1,440 points. A higher stake tells the jury you&apos;re more confident.</p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">
              Your evidence <span className="text-muted/70">(the defendant and the jury read this)</span>
            </label>
            <textarea
              value={openingArgument}
              onChange={(e) => setOpeningArgument(e.target.value)}
              placeholder="Lay out your evidence: what makes you think this account isn't a real human? Specific behaviors, timing patterns, anything the defendant and the jury should weigh."
              rows={4}
              maxLength={5000}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder-muted/40 focus:outline-none focus:border-teal"
            />
            <div className="text-[11px] text-muted mt-1">{openingArgument.length} / 5,000</div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center justify-center gap-2 w-full bg-bg border border-dashed border-border rounded-lg px-4 py-3 text-sm text-white/80 cursor-pointer hover:border-teal transition-colors">
              <span>📎</span>
              <span>Attach screenshots, logs or documents</span>
              <input type="file" multiple onChange={addFiles} className="hidden" aria-label="Attach files" />
            </label>
            {files.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-2 bg-bg rounded px-2.5 py-1.5">
                <span className="text-xs text-white truncate">{f.name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-muted">{f.hash ? 'Ready' : 'Reading…'}</span>
                  <button
                    onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                    className="text-muted hover:text-white text-sm leading-none"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
            <p className="text-[11px] text-muted">Files stay on this device. The case records each file&apos;s name and fingerprint.</p>
          </div>
          <button
            onClick={fileChallenge}
            disabled={filing || hashing || !defendantId.trim() || (caseType === 'duplicate_account' && !counterpartId.trim())}
            className="w-full py-2.5 bg-red text-white rounded-lg text-sm font-medium hover:bg-red/80 transition-colors disabled:opacity-50"
          >
            {filing ? 'Filing…' : `File challenge with a ${stakePercent}% stake`}
          </button>
        </div>
      )}
    </div>
  );
}
