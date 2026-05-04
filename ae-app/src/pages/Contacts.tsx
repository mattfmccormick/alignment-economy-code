import { useState, useEffect } from 'react';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { truncateId } from '../lib/formatting';

interface Contact {
  id: string;
  contactAccountId: string;
  nickname: string;
  isFavorite: boolean;
}

export function Contacts() {
  const wallet = loadWallet();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  // Add contact form
  const [showAdd, setShowAdd] = useState(false);
  const [addAccountId, setAddAccountId] = useState('');
  const [addNickname, setAddNickname] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNickname, setEditNickname] = useState('');

  useEffect(() => {
    loadContacts();
  }, [wallet?.accountId]);

  async function loadContacts() {
    if (!wallet?.accountId) return;
    setLoading(true);
    try {
      const res = await api.getContacts(wallet.accountId);
      if (res.success && res.data) {
        const list = res.data.contacts || (res.data as any) || [];
        setContacts(Array.isArray(list) ? list : []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function handleAdd() {
    if (!wallet?.accountId || !addAccountId.trim()) return;
    setAddLoading(true);
    setAddError(null);
    try {
      const res = await api.addContact(wallet.accountId, addAccountId.trim(), addNickname.trim() || addAccountId.trim().slice(0, 8));
      if (res.success) {
        setShowAdd(false);
        setAddAccountId('');
        setAddNickname('');
        loadContacts();
      } else {
        setAddError(res.error?.message || 'Failed to add contact');
      }
    } catch {
      setAddError('Network error');
    }
    setAddLoading(false);
  }

  async function handleToggleFavorite(contact: Contact) {
    try {
      await api.toggleFavorite(contact.id, !contact.isFavorite);
      setContacts(prev => prev.map(c => c.id === contact.id ? { ...c, isFavorite: !c.isFavorite } : c));
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteContact(id);
      setContacts(prev => prev.filter(c => c.id !== id));
    } catch { /* ignore */ }
  }

  async function handleSaveEdit(id: string) {
    if (!editNickname.trim()) return;
    try {
      await api.updateContact(id, editNickname.trim());
      setContacts(prev => prev.map(c => c.id === id ? { ...c, nickname: editNickname.trim() } : c));
      setEditingId(null);
    } catch { /* ignore */ }
  }

  const favorites = contacts.filter(c => c.isFavorite);
  const others = contacts.filter(c => !c.isFavorite);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-serif text-white">Contacts</h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-sm text-teal hover:text-teal-dark transition-colors"
        >
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {/* Add contact form */}
      {showAdd && (
        <div className="bg-navy rounded-xl p-4 border border-navy-light space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Account ID</label>
            <input
              value={addAccountId}
              onChange={(e) => setAddAccountId(e.target.value)}
              placeholder="Paste account ID"
              className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:border-teal focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Nickname</label>
            <input
              value={addNickname}
              onChange={(e) => setAddNickname(e.target.value)}
              placeholder="e.g. Sarah"
              className="w-full bg-navy-dark border border-navy-light rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:border-teal focus:outline-none"
            />
          </div>
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          <button
            onClick={handleAdd}
            disabled={addLoading || !addAccountId.trim()}
            className="w-full py-2.5 bg-teal text-white rounded-lg text-sm font-medium hover:bg-teal-dark transition-colors disabled:opacity-50"
          >
            {addLoading ? 'Adding...' : 'Add Contact'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin" />
        </div>
      ) : contacts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm mb-1">No contacts yet</p>
          <p className="text-gray-600 text-xs">Add a contact by their account ID</p>
        </div>
      ) : (
        <>
          {favorites.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Favorites</p>
              <div className="space-y-2">
                {favorites.map(c => (
                  <ContactItem
                    key={c.id}
                    contact={c}
                    editing={editingId === c.id}
                    editNickname={editNickname}
                    onEditNicknameChange={setEditNickname}
                    onStartEdit={() => { setEditingId(c.id); setEditNickname(c.nickname); }}
                    onSaveEdit={() => handleSaveEdit(c.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onToggleFavorite={() => handleToggleFavorite(c)}
                    onDelete={() => handleDelete(c.id)}
                  />
                ))}
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div>
              {favorites.length > 0 && <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider mt-4">All Contacts</p>}
              <div className="space-y-2">
                {others.map(c => (
                  <ContactItem
                    key={c.id}
                    contact={c}
                    editing={editingId === c.id}
                    editNickname={editNickname}
                    onEditNicknameChange={setEditNickname}
                    onStartEdit={() => { setEditingId(c.id); setEditNickname(c.nickname); }}
                    onSaveEdit={() => handleSaveEdit(c.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onToggleFavorite={() => handleToggleFavorite(c)}
                    onDelete={() => handleDelete(c.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ContactItem({
  contact,
  editing,
  editNickname,
  onEditNicknameChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggleFavorite,
  onDelete,
}: {
  contact: Contact;
  editing: boolean;
  editNickname: string;
  onEditNicknameChange: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}) {
  const [showActions, setShowActions] = useState(false);

  if (editing) {
    return (
      <div className="bg-navy rounded-xl p-3 border border-teal/50">
        <div className="flex items-center gap-2">
          <input
            value={editNickname}
            onChange={(e) => onEditNicknameChange(e.target.value)}
            className="flex-1 bg-navy-dark border border-navy-light rounded-lg px-3 py-2 text-white text-sm focus:border-teal focus:outline-none"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') onSaveEdit(); if (e.key === 'Escape') onCancelEdit(); }}
          />
          <button onClick={onSaveEdit} className="text-xs text-teal px-2 py-2">Save</button>
          <button onClick={onCancelEdit} className="text-xs text-gray-500 px-2 py-2">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-navy rounded-xl p-3 border border-navy-light">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-teal/20 flex items-center justify-center text-teal font-medium shrink-0">
          {contact.nickname.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-white font-medium">{contact.nickname}</p>
            {contact.isFavorite && <span className="text-gold text-xs">&#9733;</span>}
          </div>
          <p className="text-xs text-gray-500 font-mono truncate">{truncateId(contact.contactAccountId)}</p>
        </div>
        <button
          onClick={() => setShowActions(!showActions)}
          className="text-gray-500 hover:text-gray-300 text-lg px-1"
        >
          &#8943;
        </button>
      </div>

      {showActions && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-navy-light">
          <button onClick={onStartEdit} className="text-xs text-gray-400 hover:text-white px-2 py-1">Edit</button>
          <button onClick={onToggleFavorite} className="text-xs text-gold hover:text-gold-dim px-2 py-1">
            {contact.isFavorite ? 'Unfavorite' : 'Favorite'}
          </button>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 ml-auto">Delete</button>
        </div>
      )}
    </div>
  );
}
