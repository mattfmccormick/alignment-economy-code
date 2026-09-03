import { Request, Response, NextFunction } from 'express';

interface RateEntry {
  count: number;
  windowStart: number;
}

// Retained for resetRateLimits (tests) and the future post-auth limiter; not
// consulted in the request path today.
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

    // The per-account limiter that used to live here was a denial-of-service
    // vector, not a protection (audit #24). It keyed on
    // req.body.accountId || req.params.id - both attacker-supplied and, because
    // this middleware runs app-wide BEFORE authMiddleware, unauthenticated.
    // Anyone could send WRITE_LIMIT writes carrying a victim accountId and lock
    // that victim out of every write for the window, from one IP, with no
    // signature. The key cannot be trusted pre-auth, so keeping it bought
    // nothing; the IP limiter above is the real pre-auth defence. A genuine
    // per-account limit belongs AFTER auth sets req.accountId, as router-level
    // middleware - that is the follow-up.
    void isWrite;

        next();
  };
}

export function resetRateLimits(): void {
  accountLimits.clear();
  ipLimits.clear();
}
