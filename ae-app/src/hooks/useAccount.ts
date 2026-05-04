import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/websocket';

export interface AccountData {
  id: string;
  type: string;
  earnedBalance: string;
  activeBalance: string;
  supportiveBalance: string;
  ambientBalance: string;
  lockedBalance: string;
  percentHuman: number;
  isActive: boolean;
  percentOfEconomy: number;
  joinedDay: number;
}

export function useAccount(accountId: string | null) {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    try {
      setLoading(true);
      const res = await api.getAccount(accountId);
      if (res.success) {
        setAccount(res.data);
        setError(null);
      } else {
        setError(res.error?.message || 'Failed to load account');
      }
    } catch (e) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!accountId) return;
    const unsub = wsClient.on('balance:updated', (data) => {
      if (data.accountId === accountId) refresh();
    });
    return () => { unsub(); };
  }, [accountId, refresh]);

  return { account, loading, error, refresh };
}
