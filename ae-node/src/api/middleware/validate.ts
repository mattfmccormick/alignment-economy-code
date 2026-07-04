import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors.js';

// Body-validation middleware for write routes.
//
// Request bodies follow the envelope pattern `{ accountId, timestamp,
// signature, payload: {...} }` — the auth middleware verifies the envelope, so
// this validates the inner `payload` (falling back to the top-level body for
// callers that don't wrap). On failure it forwards a ValidationError, which the
// error handler turns into a 400 with a helpful message, before the route
// handler runs any business logic.
//
// Schemas here are intentionally permissive about unknown keys (plain
// z.object strips them) so they gate on the fields the handler needs without
// rejecting forward-compatible extras.
export function validateBody(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const source =
      req.body && typeof req.body === 'object' && 'payload' in req.body
        ? req.body.payload
        : req.body;

    const result = schema.safeParse(source ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.join('.');
      next(new ValidationError(`${path ? `${path}: ` : ''}${issue.message}`, 'VALIDATION'));
      return;
    }
    next();
  };
}
