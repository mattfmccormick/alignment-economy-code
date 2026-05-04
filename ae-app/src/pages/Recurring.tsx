import { useState, useEffect } from 'react';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { truncateId } from '../lib/formatting';

interface RecurringTransfer {
  id: string;
  fromId: string;
  toId: string;
  amount: number;
  pointType: string;
  schedule: string;
  isActive: boolean;
  toNickname?: string;
}

interface Contact {
  id: string;
  contactAccountId: string;
  nickname: string;
}

export function Recurring() {
  const wallet = loadWallet();
  const [transfers, setTransfers] = useState<RecurringTransfer[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newToId, setNewToId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newPointType, setNewPointType] = useState<'active' | 'earned'>('earned');
  const [newSchedule, setNewSchedule] = useState('daily');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editSchedule, setEditSchedule] = useState('daily');

  useEffect(() => {
    loadData();
  }, [wallet?.accountId]);

  async function loadData() {
    if (!wallet?.accountId) return;
    setLoading(true);
    try {
      const [recurRes, contactRes] = await Promise.all([
        api.getRecurring(wallet.accountId),
        api.getContacts(wallet.accountId),
      ]);
      if (recurRes.success && recurRes.data) {
        const list = recurRes.data.transfers || (recurRes.data as any) || [];
        setTransfers(Array.isArray(list) ? list : []);
      }
      if (contactRes.success && contactRes.data) {
        const list = contactRes.data.contacts || (contactRes.data as any) || [];
        setContacts(Array.isArray(list) ? list : []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function handleCreate() {
    if (!wallet?.accountId || !newToId.trim() || !newAmount) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const res = await api.createRecurring({
        fromId: wallet.accountId,
        toId: newToId.trim(),
        amount: Number(newAmount),
        pointType: newPointType,
        schedule: newSchedule,
      });
      if (res.success) {
        setShowCreate(false);
        setNewToId('');
        setNewAmount('');
        loadData();
      } else {
        setCreateError(res.error?.message || 'Failed to create');
      }
    } catch {
      setCreateError('Network error');
    }
    setCreateLoading(false);
  }

  async function handleToggleActive(transfer: RecurringTransfer) {
    try {
      await api.updateRecurring(transfer.id, { isActive: !transfer.isActive });
      setTransfers(prev => prev.map(t => t.id === transfer.id ? { ...t, isActive: !t.isActive } : t));
    } catch { /* ignore */ }
  }

  async function handleSaveEdit(id: string) {
    try {
      await api.updateRecurring(id, { amount: Number(editAmount), schedule: editSchedule });
      setTransfers(prev => prev.map(t => t.id === id ? { ...t, amount: Number(editAmount), schedule: editSchedule } : t));
      setEditingId(null);
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteRecurring(id);
      setTransfers(prev => prev.filter(t => t.id !== id));
    } catch { /* ignore */ }
  }

  function getContactName(accountId: string): string {
    const c = contacts.find(c => c.contactAccountId === accountId);
    return c?.nickname || truncateId(accountId);
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-serif text-white">Recurring Transfers</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="text-sm text-teal hover:text-teal-dark transition-colors"
        >
          {showCreate ? 'Cancel' : '+ New'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Recipient</label>
            {contacts.length > 0 ? (
              <select
                value={newToId}
                onChange={(e) => setNewToId(e.target.value)}
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm focus:border-teal focus:outline-none"
              >
                <option value="">Select a contact...</option>
                {contacts.map(c => (
                  <option key={c.id} value={c.contactAccountId}>{c.nickname}</option>
                ))}
              </select>
            ) : (
              <input
                value={newToId}
                onChange={(e) => setNewToId(e.target.value)}
                placeholder="Account ID"
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
              />
            )}
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-400 block mb-1">Amount</label>
              <input
                type="number"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:border-teal focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 block mb-1">Point Type</label>
              <select
                value={newPointType}
                onChange={(e) => setNewPointType(e.target.value as 'active' | 'earned')}
                className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm focus:border-teal focus:outline-none"
              >
                <option value="active">Active</option>
                <option value="earned">Earned</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">Schedule</label>
            <select
              value={newSchedule}
              onChange={(e) => setNewSchedule(e.target.value)}
              className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm focus:border-teal focus:outline-none"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          {createError && <p className="text-xs text-red-400">{createError}</p>}

          <button
            onClick={handleCreate}
            disabled={createLoading || !newToId.trim() || !newAmount}
            className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
          >
            {createLoading ? 'Creating...' : 'Create Recurring Transfer'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin" />
        </div>
      ) : transfers.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm mb-1">No recurring transfers</p>
          <p className="text-gray-600 text-xs">Set up automatic transfers to contacts</p>
        </div>
      ) : (
        <div className="space-y-2">
          {transfers.map(t => (
            <div key={t.id} className="bg-navy rounded-xl p-4 border border-navy-light">
              {editingId === t.id ? (
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-gray-400 block mb-1">Amount</label>
                      <input
                        type="number"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm focus:border-teal focus:outline-none"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-400 block mb-1">Schedule</label>
                      <select
                        value={editSchedule}
                        onChange={(e) => setEditSchedule(e.target.value)}
                        className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm focus:border-teal focus:outline-none"
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => handleSaveEdit(t.id)} className="text-xs text-teal px-3 py-1.5">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 px-3 py-1.5">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="text-sm text-white font-medium">{getContactName(t.toId)}</p>
                      <p className="text-xs text-gray-500 font-mono">{truncateId(t.toId)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-white tabular-nums">{t.amount.toFixed(2)} pts</p>
                      <p className="text-xs text-gray-500 capitalize">{t.pointType} / {t.schedule}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pt-2 border-t border-navy-light">
                    <button
                      onClick={() => handleToggleActive(t)}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        t.isActive
                          ? 'bg-teal/20 text-teal hover:bg-teal/30'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {t.isActive ? 'Active' : 'Paused'}
                    </button>
                    <button
                      onClick={() => { setEditingId(t.id); setEditAmount(String(t.amount)); setEditSchedule(t.schedule); }}
                      className="text-xs text-gray-400 hover:text-white px-2 py-1.5"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1.5 ml-auto"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
