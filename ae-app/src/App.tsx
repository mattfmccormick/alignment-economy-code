// HashRouter (not BrowserRouter) is critical here. In a packaged Electron
// build the app loads from file:///.../app.asar/dist/index.html. BrowserRouter
// reads window.location.pathname, which would be the absolute file path, not
// any of our configured routes — so React Router falls through to the *
// catch-all and the page renders blank. HashRouter uses #/path fragments,
// which are protocol-agnostic and work the same in dev (vite at localhost)
// and production (Electron file://).
import { useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { hasWallet, isWalletEncrypted, isWalletUnlocked } from './lib/keys';
import { AppShell } from './components/layout/AppShell';
import { UnlockGate } from './components/UnlockGate';
import { Onboarding } from './pages/Onboarding';
import { Wallet } from './pages/Wallet';
import { Send } from './pages/Send';
import { Tag } from './pages/Tag';
import { Verify } from './pages/Verify';
import { More } from './pages/More';
import { History } from './pages/History';
import { Network } from './pages/Network';
import { Court } from './pages/Court';
import { CaseDetail } from './pages/CaseDetail';
import { Contacts } from './pages/Contacts';
import { Recurring } from './pages/Recurring';
import { Receive } from './pages/Receive';
import { ShareHistory } from './pages/ShareHistory';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  // Bump on unlock so this re-renders and re-reads the (module-level) session.
  const [, force] = useState(0);
  if (!hasWallet()) return <Navigate to="/onboarding" replace />;
  if (isWalletEncrypted() && !isWalletUnlocked()) {
    return <UnlockGate onUnlocked={() => force((n) => n + 1)} />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Wallet />} />
          <Route path="/share" element={<ShareHistory />} />
          <Route path="/send" element={<Send />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/tag" element={<Tag />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/more" element={<More />} />
          <Route path="/history" element={<History />} />
          <Route path="/network" element={<Network />} />
          <Route path="/court" element={<Court />} />
          <Route path="/court/:id" element={<CaseDetail />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/recurring" element={<Recurring />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
