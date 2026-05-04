import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('API Error:', err.message);

  // Map known error patterns to codes
  let code = 'INTERNAL_ERROR';
  let status = 500;

  if (err.message.includes('not found') || err.message.includes('Not found')) {
    code = 'NOT_FOUND';
    status = 404;
  } else if (err.message.includes('Insufficient')) {
    code = 'INSUFFICIENT_BALANCE';
    status = 400;
  } else if (err.message.includes('Invalid')) {
    code = 'INVALID_REQUEST';
    status = 400;
  } else if (err.message.includes('already') || err.message.includes('duplicate')) {
    code = 'CONFLICT';
    status = 409;
  } else if (err.message.includes('protection window') || err.message.includes('Active case')) {
    code = 'FORBIDDEN';
    status = 403;
  }

  res.status(status).json({
    success: false,
    error: { code, message: err.message },
  });
}
