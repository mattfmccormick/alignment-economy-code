import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../core/errors.js';

// Central API error handler.
//
// Every error that can legitimately reach a route is an AppError (see
// core/errors.ts), which carries its own httpStatus and code. That is
// authoritative and its message is safe to return.
//
// Anything that is not an AppError is an unexpected internal fault (an invariant
// violation, a bug, a storage error). It becomes a generic 500 and its message
// is NEVER returned to the client — it could leak internal detail. The full
// error is logged server-side instead.
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }

  console.error('Unhandled API error:', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' },
  });
}
