import type { ApiErrorIssue, ErrorCode } from '@cadentor/shared';
import type { ZodError } from 'zod';

interface AppErrorOptions {
  /** True when `message` is safe to return to API clients. */
  expose?: boolean;
  cause?: unknown;
}

/**
 * Base for every error the application raises on purpose. Anything that is not
 * an AppError reaching the error middleware is treated as an unexpected 500.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly expose: boolean;

  constructor(code: ErrorCode, httpStatus: number, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.expose = options.expose ?? false;
  }
}

export class ValidationError extends AppError {
  readonly issues: ApiErrorIssue[];

  constructor(message: string, issues: ApiErrorIssue[] = [], cause?: unknown) {
    super('VALIDATION_ERROR', 400, message, { expose: true, cause });
    this.issues = issues;
  }

  static fromZod(error: ZodError, message = 'Request validation failed'): ValidationError {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return new ValidationError(message, issues, error);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', 404, message, { expose: true });
  }
}

/** Request authenticity could not be established (e.g. bad webhook signature). */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', 403, message, { expose: true });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('CONFLICT', 409, message, { expose: true, cause });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super('PAYLOAD_TOO_LARGE', 413, 'Request body is too large', { expose: true });
  }
}

/** An external provider failed. Detail is logged, never returned to clients. */
export class ProviderError extends AppError {
  readonly provider: string;

  constructor(provider: string, message: string, cause?: unknown) {
    super('PROVIDER_ERROR', 502, message, { cause });
    this.provider = provider;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('CONFIGURATION_ERROR', 500, message, { cause });
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('DATABASE_ERROR', 503, message, { cause });
  }
}

/** Client-facing messages for errors whose own message is not exposed. */
export const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Request validation failed',
  NOT_FOUND: 'Resource not found',
  FORBIDDEN: 'Forbidden',
  CONFLICT: 'Request conflicts with current state',
  PAYLOAD_TOO_LARGE: 'Request body is too large',
  PROVIDER_ERROR: 'An upstream service failed',
  CONFIGURATION_ERROR: 'Service is misconfigured',
  DATABASE_ERROR: 'Database is unavailable',
  INTERNAL_ERROR: 'Internal server error',
};
