import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { hasMinerWallet, isMinerWalletEncrypted, isMinerWalletUnlocked } from './lib/keys';
import { UnlockGate } from './components/UnlockGate';
import DashboardShell from './components/layout/DashboardShell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Verify from './pages/Verify';
import Court from './pages/Court';
import CaseDetail from './pages/CaseDetail';
import Income from './pages/Income';
import Settings from './pages/Settings';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [, force] = useState(0);
  if (!hasMinerWallet()) {
    return <Navigate to="/login" replace />;
  }
  if (isMinerWalletEncrypted() && !isMinerWalletUnlocked()) {
    return <UnlockGate onUnlocked={() => force((n) => n + 1)} />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <DashboardShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/court" element={<Court />} />
        <Route path="/court/:id" element={<CaseDetail />} />
        <Route path="/income" element={<Income />} />
        <Route path="/settings" element={<Settings />} />
        {/* Vouch, Audit and Network were removed: vouching belongs to people in
            the wallet, and the other two repeated the Dashboard and Income.
            Old bookmarks land on the Dashboard instead of a blank page. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
