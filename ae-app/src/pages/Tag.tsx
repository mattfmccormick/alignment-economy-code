import { useEffect, useState } from 'react';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import {
  signPayload,
  signTagProductRegister,
  signTagSpaceRegister,
  signTagSupportiveSubmit,
  signTagAmbientSubmit,
} from '../lib/crypto';
import { displayPoints } from '../lib/formatting';

const DAILY_SUPPORTIVE = '14400000000';   // 144.00 supportive points (raw units)
const DAILY_AMBIENT = '1440000000';        // 14.40 ambient points (raw units)
const MAX_MINUTES_PER_DAY = 1440;
// The daily cap shown to the user, in POINTS. Internally we still track a
// minute allocation per item (that's the granular control and what the backend
// distributes by share); the summary bar just expresses the day's total in the
// points the user actually earns — 144 supportive, 14.4 ambient.
const SUPPORTIVE_POINTS = 144;
const AMBIENT_POINTS = 14.4;
// How long after the last edit we auto-save (no Save button anymore).
const AUTOSAVE_MS = 800;

const PRODUCT_CATEGORIES = [
  'furniture', 'electronics', 'clothing', 'footwear', 'kitchen',
  'tools', 'vehicle', 'appliance', 'instrument', 'other',
];

const SPACE_TYPES = [
  'room', 'building', 'park', 'road', 'transit', 'city', 'state', 'nation', 'custom',
];

interface Product {
  id: string;
  name: string;
  category: string;
  manufacturerId: string | null;
  createdBy: string;
}

interface Space {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  entityId: string | null;
  collectionRate: number;
}

interface SupportiveTagRow {
  productId: string;
  minutesUsed: number;
}

interface AmbientTagRow {
  spaceId: string;
  minutesOccupied: number;
}

export function Tag() {
  const wallet = loadWallet();
  const [tab, setTab] = useState<'products' | 'spaces'>('products');
  const [day, setDay] = useState<number | null>(null);

  useEffect(() => {
    api.getTodayDay().then((r) => { if (r.success) setDay(r.data.day); });
  }, []);

  if (!wallet) return null;

  return (
    <div className="p-4 space-y-4">
      <div>
        <h2 className="text-xl font-serif text-white">Tag Your World</h2>
        <p className="text-xs text-gray-500 mt-1">
          {day !== null ? `Day ${day} — allocations reset at 4am EST.` : 'Loading…'}
        </p>
      </div>

      <div className="flex bg-navy rounded-lg p-1 border border-navy-light">
        {(['products', 'spaces'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm rounded-md transition-colors capitalize ${
              tab === t ? 'bg-teal text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t === 'products' ? 'Products (Supportive)' : 'Spaces (Ambient)'}
          </button>
        ))}
      </div>

      {tab === 'products' ? (
        <ProductsTab accountId={wallet.accountId} day={day} />
      ) : (
        <SpacesTab accountId={wallet.accountId} day={day} />
      )}
    </div>
  );
}

// ---------- Products tab (Supportive) ----------

function ProductsTab({ accountId, day }: { accountId: string; day: number | null }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [tagRows, setTagRows] = useState<SupportiveTagRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false); // true after a user edit, drives autosave

  const refresh = async () => {
    const ps = await api.getProducts();
    if (ps.success) setProducts(ps.data.products);
    if (day !== null) {
      const ts = await api.getSupportiveTags(accountId, day);
      if (ts.success) {
        setTagRows(ts.data.tags.map((t) => ({
          productId: t.productId,
          minutesUsed: t.minutesUsed,
        })));
      }
    }
  };

  useEffect(() => { refresh(); }, [accountId, day]);

  const totalMinutes = tagRows.reduce((s, r) => s + (r.minutesUsed || 0), 0);
  const overCap = totalMinutes > MAX_MINUTES_PER_DAY;

  const setMinutes = (productId: string, minutes: number) => {
    setDirty(true);
    setTagRows((rows) => {
      const idx = rows.findIndex((r) => r.productId === productId);
      const cleanMins = Math.max(0, Math.floor(minutes || 0));
      if (idx === -1) {
        if (cleanMins === 0) return rows;
        return [...rows, { productId, minutesUsed: cleanMins }];
      }
      const next = rows.slice();
      if (cleanMins === 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { ...next[idx], minutesUsed: cleanMins };
      }
      return next;
    });
  };

  const save = async () => {
    if (day === null) return;
    setSaving(true); setError(null);
    const submit = tagRows.filter((r) => r.minutesUsed > 0);
    // Sign with the wallet's private key. The backend reads accountId
    // from the signature, not the body, so a third party can't redirect
    // the signer's daily supportive flow.
    const w = loadWallet();
    if (!w) { setSaving(false); setError('No wallet loaded'); return; }
    try {
      // Tagging rides the chain now (audit #16): sign a supportive_tag_submit op
      // and send { op }. The auth envelope signs the same { op } payload.
      const ts = Math.floor(Date.now() / 1000);
      const op = signTagSupportiveSubmit(
        accountId,
        day,
        submit.map((t) => ({ productId: t.productId, minutesUsed: t.minutesUsed })),
        ts,
        w.privateKey,
      );
      const payload = { op };
      const signature = signPayload(payload, ts, w.privateKey);
      const r = await api.submitSupportiveTags({
        accountId,
        timestamp: ts,
        signature,
        payload,
      });
      if (r.success) {
        setSavedAt(Date.now());
        setDirty(false);
        // Do NOT refresh() here: the op is pending until the next block commits,
        // so a GET would return the stale/empty server set and wipe the user's
        // just-entered minutes. Local tagRows stay the source of truth (with the
        // live pointsAllocated preview) until the block lands.
      } else {
        setError(r.error?.message || 'Failed to save');
      }
    } catch {
      setError("Couldn't reach the node. Your tags weren't saved, try again.");
    } finally {
      setSaving(false);
    }
  };

  // Auto-save: after the user stops editing for a beat, save silently.
  // Guarded on `dirty` so loading/refresh never triggers a save loop, and on
  // overCap so we never push an invalid allocation.
  useEffect(() => {
    if (!dirty || day === null || overCap) return;
    const t = setTimeout(() => { save(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagRows, dirty, day, overCap]);

  const taggedProducts = tagRows.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Tag durable goods you're using &amp; see your auto-tagged durable goods
        below. You can tag up to 144 points a day.
      </p>

      <PointsBar total={totalMinutes} cap={MAX_MINUTES_PER_DAY} dailyPoints={SUPPORTIVE_POINTS} overCap={overCap} />
      <SaveStatus saving={saving} savedAt={savedAt} error={error} />

      {/* Tagged items */}
      {taggedProducts > 0 && (
        <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
          {tagRows.map((row) => {
            const product = products.find((p) => p.id === row.productId);
            const share = totalMinutes > 0 ? row.minutesUsed / totalMinutes : 0;
            const allocated = share * Number(DAILY_SUPPORTIVE);
            return (
              <div key={row.productId} className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{product?.name ?? 'Unknown product'}</p>
                  <p className="text-xs text-gray-500">
                    {product?.category} · {displayPoints(allocated)} pts
                  </p>
                </div>
                <input
                  type="number"
                  min={0}
                  max={MAX_MINUTES_PER_DAY}
                  value={row.minutesUsed}
                  onChange={(e) => setMinutes(row.productId, Number(e.target.value))}
                  className="w-20 bg-navy-dark border border-navy-light rounded px-2 py-1 text-sm text-white tabular-nums text-right"
                />
                <span className="text-xs text-gray-500">min</span>
                <button
                  onClick={() => setMinutes(row.productId, 0)}
                  className="text-gray-500 hover:text-red-400 text-sm"
                  aria-label="Remove tag"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Available items */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Catalog</h3>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="text-sm text-teal hover:text-teal-dark"
          >
            {showAdd ? 'Cancel' : '+ New product'}
          </button>
        </div>

        {showAdd && (
          <AddProductForm
            accountId={accountId}
            onCreated={() => {
              setShowAdd(false);
              // Registration is chain-ordered now: the product row appears only
              // once its block commits, so an immediate refresh won't show it.
              // Poll a few times over the next block interval so it lands without
              // a manual reload (and the user doesn't re-register thinking it failed).
              refresh();
              setTimeout(refresh, 4000);
              setTimeout(refresh, 11000);
            }}
          />
        )}

        {products.length === 0 && !showAdd ? (
          <div className="bg-navy rounded-xl p-4 border border-navy-light text-center">
            <p className="text-gray-500 text-sm">No products yet. Add the things you use daily.</p>
          </div>
        ) : (
          <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
            {products.map((p) => {
              const tagged = tagRows.find((r) => r.productId === p.id);
              return (
                <div key={p.id} className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{p.name}</p>
                    <p className="text-xs text-gray-500">
                      {p.category}{p.manufacturerId ? ' · linked manufacturer' : ' · no manufacturer'}
                    </p>
                  </div>
                  {tagged ? (
                    <span className="text-xs text-teal">tagged · {tagged.minutesUsed}m</span>
                  ) : (
                    <button
                      onClick={() => setMinutes(p.id, 60)}
                      className="text-sm text-teal hover:text-teal-dark"
                    >
                      + Tag
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AddProductForm({ accountId, onCreated }: { accountId: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState(PRODUCT_CATEGORIES[0]);
  const [manufacturerId, setManufacturerId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true); setErr(null);
    const w = loadWallet();
    if (!w) { setSubmitting(false); setErr('No wallet loaded'); return; }
    // Registration rides the chain now (audit #16): sign a product_register op
    // and send { op }. The product appears in the catalog once the block commits.
    const ts = Math.floor(Date.now() / 1000);
    const op = signTagProductRegister(
      accountId,
      name.trim(),
      category,
      manufacturerId.trim() || null,
      ts,
      w.privateKey,
    );
    const payload = { op };
    const signature = signPayload(payload, ts, w.privateKey);
    const r = await api.registerProduct({ accountId, timestamp: ts, signature, payload });
    setSubmitting(false);
    if (r.success) {
      setName(''); setManufacturerId('');
      onCreated();
    } else {
      setErr(r.error?.message || 'Failed to register');
    }
  };

  return (
    <div className="bg-navy rounded-xl p-3 border border-navy-light space-y-2 mb-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Product name (e.g., Standing desk)"
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-sm text-white placeholder-gray-600"
      />
      <div className="flex gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="flex-1 bg-navy-dark border border-navy-light rounded px-3 py-2 text-sm text-white"
        >
          {PRODUCT_CATEGORIES.map((c) => (
            <option key={c} value={c} className="capitalize">{c}</option>
          ))}
        </select>
      </div>
      <input
        value={manufacturerId}
        onChange={(e) => setManufacturerId(e.target.value)}
        placeholder="Manufacturer account ID (optional)"
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-xs text-white placeholder-gray-600 font-mono"
      />
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button
        onClick={submit}
        disabled={!name.trim() || submitting}
        className="w-full bg-teal hover:bg-teal-dark text-white text-sm py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Registering…' : 'Register product'}
      </button>
    </div>
  );
}

// ---------- Spaces tab (Ambient) ----------

function SpacesTab({ accountId, day }: { accountId: string; day: number | null }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [tagRows, setTagRows] = useState<AmbientTagRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false); // true after a user edit, drives autosave

  const refresh = async () => {
    const ss = await api.getSpaces();
    if (ss.success) setSpaces(ss.data.spaces);
    if (day !== null) {
      const ts = await api.getAmbientTags(accountId, day);
      if (ts.success) {
        setTagRows(ts.data.tags.map((t) => ({
          spaceId: t.spaceId,
          minutesOccupied: t.minutesOccupied,
        })));
      }
    }
  };

  useEffect(() => { refresh(); }, [accountId, day]);

  const totalMinutes = tagRows.reduce((s, r) => s + (r.minutesOccupied || 0), 0);
  const overCap = totalMinutes > MAX_MINUTES_PER_DAY;

  const setMinutes = (spaceId: string, minutes: number) => {
    setDirty(true);
    setTagRows((rows) => {
      const idx = rows.findIndex((r) => r.spaceId === spaceId);
      const cleanMins = Math.max(0, Math.floor(minutes || 0));
      if (idx === -1) {
        if (cleanMins === 0) return rows;
        return [...rows, { spaceId, minutesOccupied: cleanMins }];
      }
      const next = rows.slice();
      if (cleanMins === 0) {
        next.splice(idx, 1);
      } else {
        next[idx] = { ...next[idx], minutesOccupied: cleanMins };
      }
      return next;
    });
  };

  const save = async () => {
    if (day === null) return;
    setSaving(true); setError(null);
    const submit = tagRows.filter((r) => r.minutesOccupied > 0);
    // Sign with the wallet's private key. Same reason as supportive:
    // backend reads accountId from the signature.
    const w = loadWallet();
    if (!w) { setSaving(false); setError('No wallet loaded'); return; }
    try {
      // Chain-ordered (audit #16): sign an ambient_tag_submit op, send { op }.
      const ts = Math.floor(Date.now() / 1000);
      const op = signTagAmbientSubmit(
        accountId,
        day,
        submit.map((t) => ({ spaceId: t.spaceId, minutesOccupied: t.minutesOccupied })),
        ts,
        w.privateKey,
      );
      const payload = { op };
      const signature = signPayload(payload, ts, w.privateKey);
      const r = await api.submitAmbientTags({
        accountId,
        timestamp: ts,
        signature,
        payload,
      });
      if (r.success) {
        setSavedAt(Date.now());
        setDirty(false);
        // Pending until the next block; keep local tagRows (see supportive save).
      } else {
        setError(r.error?.message || 'Failed to save');
      }
    } catch {
      setError("Couldn't reach the node. Your tags weren't saved, try again.");
    } finally {
      setSaving(false);
    }
  };

  // Auto-save: mirror the products tab — debounced, guarded on dirty + cap.
  useEffect(() => {
    if (!dirty || day === null || overCap) return;
    const t = setTimeout(() => { save(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagRows, dirty, day, overCap]);

  const tagged = tagRows.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Tag spaces you're in &amp; see your auto-tagged spaces below. You can tag
        up to 14.4 points a day.
      </p>

      <PointsBar total={totalMinutes} cap={MAX_MINUTES_PER_DAY} dailyPoints={AMBIENT_POINTS} overCap={overCap} />
      <SaveStatus saving={saving} savedAt={savedAt} error={error} />

      {tagged > 0 && (
        <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
          {tagRows.map((row) => {
            const space = spaces.find((s) => s.id === row.spaceId);
            const share = totalMinutes > 0 ? row.minutesOccupied / totalMinutes : 0;
            const allocated = share * Number(DAILY_AMBIENT);
            return (
              <div key={row.spaceId} className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{space?.name ?? 'Unknown space'}</p>
                  <p className="text-xs text-gray-500">
                    {space?.type} · {displayPoints(allocated)} pts
                  </p>
                </div>
                <input
                  type="number"
                  min={0}
                  max={MAX_MINUTES_PER_DAY}
                  value={row.minutesOccupied}
                  onChange={(e) => setMinutes(row.spaceId, Number(e.target.value))}
                  className="w-20 bg-navy-dark border border-navy-light rounded px-2 py-1 text-sm text-white tabular-nums text-right"
                />
                <span className="text-xs text-gray-500">min</span>
                <button
                  onClick={() => setMinutes(row.spaceId, 0)}
                  className="text-gray-500 hover:text-red-400 text-sm"
                  aria-label="Remove tag"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Catalog</h3>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="text-sm text-teal hover:text-teal-dark"
          >
            {showAdd ? 'Cancel' : '+ New space'}
          </button>
        </div>

        {showAdd && (
          <AddSpaceForm onCreated={() => {
            setShowAdd(false);
            // Chain-ordered registration; the space row appears once its block
            // commits. Poll over the next block interval (see products above).
            refresh();
            setTimeout(refresh, 4000);
            setTimeout(refresh, 11000);
          }} />
        )}

        {spaces.length === 0 && !showAdd ? (
          <div className="bg-navy rounded-xl p-4 border border-navy-light text-center">
            <p className="text-gray-500 text-sm">No spaces yet. Add the places you spend time.</p>
          </div>
        ) : (
          <div className="bg-navy rounded-xl border border-navy-light divide-y divide-navy-light">
            {spaces.map((s) => {
              const t = tagRows.find((r) => r.spaceId === s.id);
              return (
                <div key={s.id} className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{s.name}</p>
                    <p className="text-xs text-gray-500">
                      {s.type}{s.entityId ? ' · linked entity' : ' · no entity'}
                    </p>
                  </div>
                  {t ? (
                    <span className="text-xs text-teal">tagged · {t.minutesOccupied}m</span>
                  ) : (
                    <button
                      onClick={() => setMinutes(s.id, 60)}
                      className="text-sm text-teal hover:text-teal-dark"
                    >
                      + Tag
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AddSpaceForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState(SPACE_TYPES[0]);
  const [entityId, setEntityId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true); setErr(null);
    const w = loadWallet();
    if (!w) { setSubmitting(false); setErr('No wallet loaded'); return; }
    // Chain-ordered (audit #16): sign a space_register op, send { op }. parentId
    // and collectionRate are supported by the op but not surfaced in this form
    // yet, so they default to null / 0 (a top-level space with no parent levy).
    const ts = Math.floor(Date.now() / 1000);
    const op = signTagSpaceRegister(
      w.accountId,
      name.trim(),
      type,
      null,
      entityId.trim() || null,
      0,
      ts,
      w.privateKey,
    );
    const payload = { op };
    const signature = signPayload(payload, ts, w.privateKey);
    const r = await api.registerSpace({ accountId: w.accountId, timestamp: ts, signature, payload });
    setSubmitting(false);
    if (r.success) {
      setName(''); setEntityId('');
      onCreated();
    } else {
      setErr(r.error?.message || 'Failed to register');
    }
  };

  return (
    <div className="bg-navy rounded-xl p-3 border border-navy-light space-y-2 mb-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Space name (e.g., Home office)"
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-sm text-white placeholder-gray-600"
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-sm text-white"
      >
        {SPACE_TYPES.map((t) => (
          <option key={t} value={t} className="capitalize">{t}</option>
        ))}
      </select>
      <input
        value={entityId}
        onChange={(e) => setEntityId(e.target.value)}
        placeholder="Entity account ID (optional)"
        className="w-full bg-navy-dark border border-navy-light rounded px-3 py-2 text-xs text-white placeholder-gray-600 font-mono"
      />
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button
        onClick={submit}
        disabled={!name.trim() || submitting}
        className="w-full bg-teal hover:bg-teal-dark text-white text-sm py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Registering…' : 'Register space'}
      </button>
    </div>
  );
}

// ---------- Shared bits ----------

function PointsBar({
  total, cap, dailyPoints, overCap,
}: { total: number; cap: number; dailyPoints: number; overCap: boolean }) {
  const pct = Math.min(100, (total / cap) * 100);
  // Express the minute allocation as the points the user earns for the day.
  const pts = (total / cap) * dailyPoints;
  const isWhole = Number.isInteger(dailyPoints);
  const fmt = (n: number) => (isWhole ? Math.round(n).toString() : n.toFixed(1));
  return (
    <div>
      <div className="flex justify-between items-center text-xs mb-1">
        <span className="text-gray-400">Tagged today</span>
        <span className={`tabular-nums ${overCap ? 'text-red-400' : 'text-white'}`}>
          {fmt(pts)} / {fmt(dailyPoints)} pts
        </span>
      </div>
      <div className="h-2 bg-navy-dark rounded-full overflow-hidden border border-navy-light">
        <div
          className={`h-full transition-all ${overCap ? 'bg-red-500' : 'bg-teal'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {overCap && (
        <p className="text-xs text-red-400 mt-1">
          Total exceeds your {fmt(dailyPoints)}-point daily cap — reduce some allocations.
        </p>
      )}
    </div>
  );
}

// Quiet auto-save feedback (there is no Save button anymore). Shows "Saving…"
// while a write is in flight, then "Saved ✓" for a few seconds, then nothing.
function SaveStatus({
  saving, savedAt, error,
}: { saving: boolean; savedAt: number | null; error: string | null }) {
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (savedAt === null) return;
    setJustSaved(true);
    const timer = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [savedAt]);
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (saving) return <p className="text-xs text-gray-500">Saving…</p>;
  if (justSaved) return <p className="text-xs text-teal">Saved ✓</p>;
  return <p className="text-xs text-gray-600">Changes save automatically.</p>;
}
