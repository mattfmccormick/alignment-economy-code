import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { loadWallet } from '../lib/keys';
import { api } from '../lib/api';
import { displayPercent } from '../lib/formatting';
import type { SharePoint } from '../lib/types';

// The "12.50% of participants" figure on the home screen, but as a line chart
// across every day the account has existed. Reached by tapping that figure.
export function ShareHistory() {
  const wallet = loadWallet();
  const navigate = useNavigate();
  const [points, setPoints] = useState<SharePoint[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!wallet?.accountId) return;
    api.getShareHistory(wallet.accountId).then((r) => {
      if (r.success) setPoints(r.data.points);
      else setError(r.error?.message || 'Could not load history');
    }).catch((e) => setError(e instanceof Error ? e.message : 'Could not load history'));
  }, [wallet?.accountId]);

  if (!wallet?.accountId) return null;

  const current = points && points.length ? points[points.length - 1].percentOfEconomy : null;
  const first = points && points.length ? points[0].percentOfEconomy : null;
  const change = current !== null && first !== null ? current - first : null;

  // Friendly short date (e.g. "Jul 29") for axis + tooltip.
  const shortDate = (iso: string) => {
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  return (
    <div className="p-4 space-y-5">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="text-gray-400 hover:text-white text-sm"
          aria-label="Back"
        >
          ← Back
        </button>
        <h2 className="text-xl font-serif text-white">Your Share of the Economy</h2>
      </div>

      <p className="text-sm text-gray-400">
        Your slice of everyone's saveable points, tracked from the day you joined.
        It shifts as you and others earn, spend, and as new people arrive.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!points && !error && (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {points && (
        <>
          <div className="bg-navy border border-navy-light rounded-2xl p-5 text-center">
            <p className="text-4xl font-serif text-gold tabular-nums tracking-tight">
              {current !== null ? displayPercent(current) : '--'}
            </p>
            <p className="text-xs text-gray-400 mt-1">today</p>
            {change !== null && points.length > 1 && (
              <p className={`text-xs mt-2 ${change >= 0 ? 'text-teal' : 'text-red-400'}`}>
                {change >= 0 ? '▲' : '▼'} {displayPercent(Math.abs(change))} since {shortDate(points[0].date)}
              </p>
            )}
          </div>

          {points.length > 1 ? (
            <div className="bg-navy border border-navy-light rounded-2xl p-4 pr-2">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={points} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    stroke="#64748b"
                    fontSize={11}
                    tickMargin={8}
                    minTickGap={24}
                  />
                  <YAxis
                    stroke="#64748b"
                    fontSize={11}
                    width={44}
                    tickFormatter={(v: number) => `${v}%`}
                    domain={['auto', 'auto']}
                  />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, fontSize: 12 }}
                    labelStyle={{ color: '#94a3b8' }}
                    labelFormatter={(iso) => shortDate(String(iso))}
                    formatter={(v) => [displayPercent(Number(v)), 'Share']}
                  />
                  <Line
                    type="monotone"
                    dataKey="percentOfEconomy"
                    stroke="#eab308"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: '#eab308' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="bg-navy border border-navy-light rounded-2xl p-8 text-center">
              <p className="text-sm text-gray-400">
                Just one day of history so far. Check back tomorrow to watch your
                share move.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
