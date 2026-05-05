import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Single search bar that routes by input shape:
//   - 40-char hex   -> account or block-hash; we hit /account/:id (the
//                       account route can show "not found" if it's a hash)
//   - all-digit     -> /block/:number
//   - UUIDish       -> /tx/:id
//   - anything else -> tries account by default
export function Search() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  function go(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    if (/^\d+$/.test(v)) {
      navigate(`/block/${v}`);
    } else if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
      navigate(`/tx/${v}`);
    } else {
      navigate(`/account/${v}`);
    }
  }

  return (
    <form onSubmit={go} className="flex gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by account id, block number, or transaction id"
        className="flex-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-sm placeholder-slate-500 focus:outline-none focus:border-teal-500"
      />
      <button type="submit" className="bg-teal-600 hover:bg-teal-500 text-white px-4 py-1.5 rounded-md text-sm">Search</button>
    </form>
  );
}
