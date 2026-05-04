import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { api } from '../../lib/api';
import { loadWallet } from '../../lib/keys';
import { wsClient } from '../../lib/websocket';

export function AppShell() {
  const [currentDay, setCurrentDay] = useState<number | null>(null);

  useEffect(() => {
    api.getNetworkStatus().then((r) => {
      if (r.success && r.data) {
        setCurrentDay(r.data.currentDay ?? r.data.day ?? null);
      }
    }).catch(() => {});
  }, []);

  // Open the realtime connection for this logged-in wallet so balances,
  // transactions, and day-change events push live instead of requiring a refresh.
  useEffect(() => {
    const wallet = loadWallet();
    if (!wallet?.accountId) return;
    wsClient.connect(wallet.accountId);
    const offDay = wsClient.on('network:day-change', (data: { day: number }) => {
      if (typeof data?.day === 'number') setCurrentDay(data.day);
    });
    return () => {
      offDay();
      wsClient.disconnect();
    };
  }, []);

  return (
    <div className="flex flex-col min-h-dvh bg-navy-dark">
      <header className="px-4 py-3 flex items-center justify-between border-b border-navy-light">
        <h1 className="text-base font-serif text-white tracking-wide">Alignment Economy</h1>
        <span className="text-xs text-gray-400 tabular-nums">
          {currentDay !== null ? `Day ${currentDay}` : '...'}
        </span>
      </header>

      <main className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </main>

      <BottomNav />
    </div>
  );
}
