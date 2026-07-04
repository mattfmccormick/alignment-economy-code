import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../core/errors.js';
import { logger } from '../../node/logger.js';

// Central API error handler.
//
// Every error that can legitimately reach a route is an AppError (see
// core/errors.ts), which carries its own httpStatus and code. That is
// authoritative and its message is safe to return.
//
// Anything that is not an AppError is an unexpected internal fault (an invariant
// violation, a bug, a storage error). It becomes a generic 500 and its message
// is NEVER returned to the client — it could leak internal detail. The full
// error is logged server-side, stamped with the request id so the operator can
// find it from the id the client received.
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    res.status(err.httpStatus).json({
      success: false,
      error: { code: err.code, message: err.message, requestId },
    });
    return;
  }

  log.error('api', 'unhandled API error', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', requestId },
  });
}
