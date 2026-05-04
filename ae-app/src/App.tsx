import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { hasWallet } from './lib/keys';
import { AppShell } from './components/layout/AppShell';
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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!hasWallet()) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
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
          <Route path="/send" element={<Send />} />
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
    </BrowserRouter>
  );
}
