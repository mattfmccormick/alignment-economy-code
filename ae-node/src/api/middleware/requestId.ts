import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { logger, type Logger } from '../../node/logger.js';

declare global {
  // Merged with the augmentation in auth.ts. Every request carries a stable id
  // and a logger that stamps it, so a single request can be traced across log
  // lines and quoted back to a user in an error response.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      log?: Logger;
    }
  }
}

// Assigns (or accepts) a request id, exposes it on the response header, and
// attaches a request-scoped child logger. Runs first so every later middleware
// and handler can log with the id.
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[\w-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);
  next();
}
