// Typed application errors.
//
// Every error that can legitimately reach an Express route handler should be
// one of these. The API error handler (api/middleware/errorHandler.ts) reads
// `httpStatus` and `code` off an AppError to build the response, instead of
// sniffing `err.message` for substrings like "not found". Anything that is NOT
// an AppError is treated as an unexpected internal fault: it becomes a generic
// 500 and its message is never sent to the client.
//
// Each subclass has a sensible default `code`, but the constructor accepts an
// override so a call site can carry a specific domain code (e.g. a validation
// failure that wants 'STAKE_TOO_SMALL' rather than the generic 'VALIDATION').

export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 400 - the request was malformed or violated a business rule. */
export class ValidationError extends AppError {
  readonly httpStatus = 400;
  constructor(message: string, code = 'VALIDATION') {
    super(message, code);
  }
}

/** 400 - the sender does not have enough of the requested point type. */
export class InsufficientBalanceError extends AppError {
  readonly httpStatus = 400;
  constructor(message: string, code = 'INSUFFICIENT_BALANCE') {
    super(message, code);
  }
}

/** 401 - authentication is missing, expired, or invalid. */
export class AuthError extends AppError {
  readonly httpStatus = 401;
  constructor(message: string, code = 'AUTH_INVALID') {
    super(message, code);
  }
}

/** 403 - authenticated but not permitted to do this. */
export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  constructor(message: string, code = 'FORBIDDEN') {
    super(message, code);
  }
}

/** 404 - the referenced entity does not exist. */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, code);
  }
}

/** 409 - the request conflicts with current state (duplicate, already exists). */
export class ConflictError extends AppError {
  readonly httpStatus = 409;
  constructor(message: string, code = 'CONFLICT') {
    super(message, code);
  }
}
