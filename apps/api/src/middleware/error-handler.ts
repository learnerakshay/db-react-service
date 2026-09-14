import type { ApiErrorBody } from '@cadentor/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import {
  AppError,
  NotFoundError,
  PayloadTooLargeError,
  SAFE_ERROR_MESSAGES,
  ValidationError,
} from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

/** Map anything thrown into an AppError. Unknown errors become INTERNAL_ERROR. */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  // express.json() (body-parser) failures carry a string `type`.
  const type = typeof err === 'object' && err !== null && 'type' in err ? err.type : undefined;
  if (type === 'entity.parse.failed') return new ValidationError('Malformed JSON body', [], err);
  if (type === 'entity.too.large') return new PayloadTooLargeError();
  if (typeof type === 'string' && type.startsWith('encoding.')) {
    return new ValidationError('Unsupported request body encoding', [], err);
  }
  if (type === 'charset.unsupported') {
    return new ValidationError('Unsupported request body charset', [], err);
  }

  return new AppError('INTERNAL_ERROR', 500, 'Unhandled error', { cause: err });
}

/**
 * Last middleware in the chain. Produces the shared ApiErrorBody and never
 * leaks internal messages, stack traces, or database/provider detail.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = normalizeError(err);

  // pino-http attaches `res.err` to the completion log line (with stack).
  if (appError.httpStatus >= 500) {
    res.err = err instanceof Error ? err : appError;
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : SAFE_ERROR_MESSAGES[appError.code],
    },
  };
  if (typeof req.id === 'string') {
    body.error.requestId = req.id;
  }
  if (appError instanceof ValidationError && appError.issues.length > 0) {
    body.error.issues = appError.issues;
  }

  res.status(appError.httpStatus).json(body);
};
