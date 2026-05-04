import { Request, Response, NextFunction } from 'express';

interface RateEntry {
  count: number;
  windowStart: number;
}

const accountLimits = new Map<string, RateEntry>();
const ipLimits = new Map<string, RateEntry>();

const WINDOW_MS = 60_000;
const READ_LIMIT = 100;
const WRITE_LIMIT = 20;
const IP_LIMIT = 200;

function checkLimit(
  map: Map<string, RateEntry>,
  key: string,
  limit: number,
  now: number,
): { allowed: boolean; retryAfter: number } {
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    map.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0 };
  }
  entry.count++;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true, retryAfter: 0 };
}

export function rateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const isWrite = req.method !== 'GET';

    // IP limit
    const ipCheck = checkLimit(ipLimits, ip, IP_LIMIT, now);
    if (!ipCheck.allowed) {
      res.set('Retry-After', String(ipCheck.retryAfter));
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfter: ipCheck.retryAfter } },
      });
      return;
    }

    // Account limit (if authenticated)
    const accountId = req.body?.accountId || req.params?.id;
    if (accountId) {
      const limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
      const key = `${accountId}:${isWrite ? 'write' : 'read'}`;
      const acctCheck = checkLimit(accountLimits, key, limit, now);
      if (!acctCheck.allowed) {
        res.set('Retry-After', String(acctCheck.retryAfter));
        res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests', details: { retryAfter: acctCheck.retryAfter } },
        });
        return;
      }
    }

    next();
  };
}

export function resetRateLimits(): void {
  accountLimits.clear();
  ipLimits.clear();
}
