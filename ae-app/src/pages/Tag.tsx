import { useEffect, useState } from 'react';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { signPayload } from '../lib/crypto';
import { displayPoints } from '../lib/formatting';

const DAILY_SUPPORTIVE = '14400000000';   // 144.00 supportive points (raw units)
const DAILY_AMBIENT = '1440000000';        // 14.40 ambient points (raw units)
const MAX_MINUTES_PER_DAY = 1440;

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

  const refresh = async () => {
    const ps = await api.getProducts();
    if (ps.success) setProducts(ps.data.products);
    if (day !== null) {
      const ts = await api.getSupportiveTags(accountId, day);
      if (ts.success) {
        setTagRows(ts.data.tags.map((t: any) => ({
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
    const ts = Math.floor(Date.now() / 1000);
    const payload = { day, tags: submit.map((t) => ({ productId: t.productId, minutesUsed: t.minutesUsed })) };
    const signature = signPayload(payload, ts, w.privateKey);
    const r = await api.submitSupportiveTags({
      accountId,
      timestamp: ts,
      signature,
      payload,
    });
    setSaving(false);
    if (r.success) {
      setSavedAt(Date.now());
      refresh();
    } else {
      setError(r.error?.message || 'Failed to save');
    }
  };

  const taggedProducts = tagRows.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Tag the durable goods you use today. Your {displayPoints(DAILY_SUPPORTIVE)} Supportive
        points split by minute share, then flow to manufacturers at the day rebase.
      </p>

      <MinutesBar total={totalMinutes} cap={MAX_MINUTES_PER_DAY} overCap={overCap} />

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
            onCreated={() => { setShowAdd(false); refresh(); }}
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

      <SaveBar
        saving={saving}
        overCap={overCap}
        savedAt={savedAt}
        error={error}
        canSave={day !== null}
        onSave={save}
      />
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
    const ts = Math.floor(Date.now() / 1000);
    const payload = {
      name: name.trim(),
      category,
      manufacturerId: manufacturerId.trim() || undefined,
    };
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

  const refresh = async () => {
    const ss = await api.getSpaces();
    if (ss.success) setSpaces(ss.data.spaces);
    if (day !== null) {
      const ts = await api.getAmbientTags(accountId, day);
      if (ts.success) {
        setTagRows(ts.data.tags.map((t: any) => ({
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
    const ts = Math.floor(Date.now() / 1000);
    const payload = { day, tags: submit.map((t) => ({ spaceId: t.spaceId, minutesOccupied: t.minutesOccupied })) };
    const signature = signPayload(payload, ts, w.privateKey);
    const r = await api.submitAmbientTags({
      accountId,
      timestamp: ts,
      signature,
      payload,
    });
    setSaving(false);
    if (r.success) {
      setSavedAt(Date.now());
      refresh();
    } else {
      setError(r.error?.message || 'Failed to save');
    }
  };

  const tagged = tagRows.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Tag the spaces you spend time in today. Your {displayPoints(DAILY_AMBIENT)} Ambient
        points flow to space entities at the day rebase.
      </p>

      <MinutesBar total={totalMinutes} cap={MAX_MINUTES_PER_DAY} overCap={overCap} />

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
          <AddSpaceForm onCreated={() => { setShowAdd(false); refresh(); }} />
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

      <SaveBar
        saving={saving}
        overCap={overCap}
        savedAt={savedAt}
        error={error}
        canSave={day !== null}
        onSave={save}
      />
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
    const ts = Math.floor(Date.now() / 1000);
    const payload = {
      name: name.trim(),
      type,
      entityId: entityId.trim() || undefined,
    };
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

function MinutesBar({ total, cap, overCap }: { total: number; cap: number; overCap: boolean }) {
  const pct = Math.min(100, (total / cap) * 100);
  return (
    <div>
      <div className="flex justify-between items-center text-xs mb-1">
        <span className="text-gray-400">Tagged minutes today</span>
        <span className={`tabular-nums ${overCap ? 'text-red-400' : 'text-white'}`}>
          {total} / {cap} min
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
          Total exceeds the 1,440-minute daily cap — reduce some allocations to save.
        </p>
      )}
    </div>
  );
}

function SaveBar({
  saving, overCap, savedAt, error, canSave, onSave,
}: {
  saving: boolean; overCap: boolean; savedAt: number | null;
  error: string | null; canSave: boolean; onSave: () => void;
}) {
  const justSaved = savedAt !== null && Date.now() - savedAt < 4000;
  return (
    <div className="sticky bottom-20 left-0 right-0 pt-2">
      {error && <p className="text-xs text-red-400 mb-2 text-center">{error}</p>}
      <button
        onClick={onSave}
        disabled={!canSave || saving || overCap}
        className="w-full bg-gold hover:bg-gold-dark text-navy-dark font-medium text-sm py-3 rounded-xl shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save today\'s tags'}
      </button>
    </div>
  );
}
