import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { api, getNodeStatus, subscribeNodeStatus } from '../../lib/api';
import { loadWallet } from '../../lib/keys';
import { wsClient } from '../../lib/websocket';

export function AppShell() {
  const [currentDay, setCurrentDay] = useState<number | null>(null);
  const [nodeStatus, setNodeStatusState] = useState(getNodeStatus());

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

  // Surface a top-of-window banner whenever the local node stops responding.
  // Subscribes to the api module's status (changes whenever a request fails
  // or recovers) so the banner reflects reality without polling.
  useEffect(() => {
    return subscribeNodeStatus(setNodeStatusState);
  }, []);

  return (
    <div className="flex flex-col min-h-dvh bg-navy-dark">
      {nodeStatus === 'offline' && (
        <div className="bg-red-900/40 border-b border-red-900/60 px-4 py-2 text-xs text-red-200 text-center">
          You&apos;re offline. The wallet will retry once your connection is back.
        </div>
      )}
      {nodeStatus === 'node-down' && (
        <div className="bg-red-900/40 border-b border-red-900/60 px-4 py-2 text-xs text-red-200 text-center">
          Can&apos;t reach the local node. Try restarting the app. If this just started, give it a few seconds.
        </div>
      )}
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
