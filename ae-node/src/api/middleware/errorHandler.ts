import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../core/errors.js';

// Central API error handler.
//
// Preferred path: the error is an AppError (see core/errors.ts), which carries
// its own httpStatus and code. That is authoritative.
//
// Legacy fallback: some modules still `throw new Error(...)`. Until they are
// migrated to typed errors, we keep the old substring mapping so their status
// codes don't regress. New code should throw an AppError instead of relying on
// this block.
//
// Anything that matches neither is an unexpected internal fault: it becomes a
// generic 500 and its message is NEVER returned to the client (it could leak
// internal detail). The full error is still logged server-side.
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }

  // --- legacy substring mapping (to be removed once all throws are typed) ---
  const message = err.message ?? '';
  let code: string | null = null;
  let status = 0;

  if (message.includes('not found') || message.includes('Not found')) {
    code = 'NOT_FOUND';
    status = 404;
  } else if (message.includes('Insufficient')) {
    code = 'INSUFFICIENT_BALANCE';
    status = 400;
  } else if (message.includes('Invalid')) {
    code = 'INVALID_REQUEST';
    status = 400;
  } else if (message.includes('already') || message.includes('duplicate')) {
    code = 'CONFLICT';
    status = 409;
  } else if (message.includes('protection window') || message.includes('Active case')) {
    code = 'FORBIDDEN';
    status = 403;
  }

  if (code !== null) {
    res.status(status).json({ success: false, error: { code, message } });
    return;
  }

  // Unexpected: log server-side, return a generic body with no internal detail.
  console.error('Unhandled API error:', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' },
  });
}
