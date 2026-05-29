import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { api, type NetworkStatus, type NodeStatus } from '../../lib/api';

export default function DashboardShell() {
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [nodeStatus, setNodeStatus] = useState<NodeStatus | null>(null);
  const [nodeHealthy, setNodeHealthy] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    async function fetchHeader() {
      try {
        const [networkRes, statusRes] = await Promise.allSettled([
          api.getNetworkStatus(),
          api.nodeStatus(),
        ]);

        if (networkRes.status === 'fulfilled' && networkRes.value.success) {
          setNetwork(networkRes.value.data);
        }
        if (statusRes.status === 'fulfilled') {
          setNodeStatus(statusRes.value);
        }
        setNodeHealthy(true);
      } catch {
        setNodeHealthy(false);
      }
    }

    fetchHeader();
    const interval = setInterval(fetchHeader, 15000);
    return () => clearInterval(interval);
  }, []);

  const blockHeight = network?.blockHeight ?? nodeStatus?.chain?.blockHeight;
  const currentDay = network?.currentDay ?? nodeStatus?.chain?.currentDay;

  return (
    <div className="flex min-h-screen">
      {/* Mobile drawer backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header bar */}
        <header className="h-14 border-b border-border bg-panel/50 flex items-center justify-between px-4 sm:px-6 flex-shrink-0">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden text-muted hover:text-white -ml-1 p-1 flex-shrink-0"
              aria-label="Open menu"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
            <h1 className="text-sm font-semibold text-white whitespace-nowrap">Miner Dashboard</h1>
            <span className="text-xs text-muted hidden sm:inline">Alignment Economy Protocol v0.9</span>
          </div>
          <div className="flex items-center gap-4">
            {/* Heartbeat indicator */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${
              nodeHealthy === true
                ? 'bg-teal/10 border-teal/20'
                : nodeHealthy === false
                  ? 'bg-red/10 border-red/20'
                  : 'bg-muted/10 border-muted/20'
            }`}>
              <span className="relative flex h-2.5 w-2.5">
                {nodeHealthy === true && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal opacity-75"></span>
                )}
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                  nodeHealthy === true ? 'bg-teal' : nodeHealthy === false ? 'bg-red' : 'bg-muted'
                }`}></span>
              </span>
              <span className={`text-xs font-medium ${
                nodeHealthy === true ? 'text-teal' : nodeHealthy === false ? 'text-red' : 'text-muted'
              }`}>
                {nodeHealthy === true ? 'Node Active' : nodeHealthy === false ? 'Node Offline' : 'Checking...'}
              </span>
            </div>

            {/* Block height */}
            {blockHeight !== undefined && (
              <div className="text-xs text-muted hidden sm:block">
                Block <span className="text-white font-mono">#{blockHeight.toLocaleString()}</span>
              </div>
            )}

            {/* Current Day */}
            {currentDay !== undefined && (
              <div className="text-xs text-muted hidden sm:block">
                Day <span className="text-gold font-mono">{currentDay}</span>
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
