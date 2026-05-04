import { Routes, Route, Navigate } from 'react-router-dom';
import { hasMinerWallet } from './lib/keys';
import DashboardShell from './components/layout/DashboardShell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Verify from './pages/Verify';
import Court from './pages/Court';
import CaseDetail from './pages/CaseDetail';
import Audit from './pages/Audit';
import Income from './pages/Income';
import Network from './pages/Network';
import Vouch from './pages/Vouch';

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!hasMinerWallet()) {
    return <Navigate to="/login" replace />;
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
        <Route path="/vouch" element={<Vouch />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/income" element={<Income />} />
        <Route path="/network" element={<Network />} />
      </Route>
    </Routes>
  );
}
