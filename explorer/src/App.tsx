import { Link, Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { BlockDetail } from './pages/BlockDetail';
import { TransactionDetail } from './pages/TransactionDetail';
import { AccountDetail } from './pages/AccountDetail';
import { Search } from './components/Search';

export function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/40 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-6">
          <Link to="/" className="text-lg font-serif tracking-wide hover:text-teal-300">Alignment Economy Explorer</Link>
          <div className="flex-1">
            <Search />
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/block/:number" element={<BlockDetail />} />
          <Route path="/tx/:id" element={<TransactionDetail />} />
          <Route path="/account/:id" element={<AccountDetail />} />
        </Routes>
      </main>
      <footer className="border-t border-slate-800 mt-16 py-6 text-xs text-slate-500 text-center">
        Read-only chain inspection. Built on @alignmenteconomy/sdk.
      </footer>
    </div>
  );
}
