import type { OperatorRole } from '@cadentor/shared';
import type { Request, RequestHandler } from 'express';
import type { AppConfig } from '../config/index.js';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { FixedWindowLimiter } from '../lib/rate-limit.js';
import { authenticateOperatorToken, hasRole, type Operator } from '../modules/auth/operators.js';

const operators = new WeakMap<Request, Operator>();

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/;
const READ_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/** The authenticated operator; only valid behind `authenticateOperators`. */
export function operatorOf(req: Request): Operator {
  const operator = operators.get(req);
  if (operator === undefined) throw new UnauthorizedError();
  return operator;
}

function requestId(req: Request): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}

/**
 * Operator authentication for every protected API route.
 *  - `Authorization: Bearer <token>` matched against OPERATOR_TOKENS hashes → else 401.
 *  - Invalid tokens are counted per client IP; over the limit → 429 before any check.
 *  - State-changing requests are rate limited per operator → 429.
 * Webhooks are mounted before this middleware and use provider signatures instead.
 */
export function authenticateOperators(config: AppConfig, logger: Logger): RequestHandler {
  const failures = new FixedWindowLimiter(config.auth.failureLimit, config.auth.failureWindowMs);
  const mutations = new FixedWindowLimiter(config.auth.mutationLimit, config.auth.mutationWindowMs);

  return (req, _res, next) => {
    const client = req.ip ?? 'unknown';
    if (failures.isBlocked(client)) {
      logger.warn(
        { requestId: requestId(req), operation: 'auth.authenticate', errorCode: 'RATE_LIMITED' },
        'authentication blocked: too many invalid tokens',
      );
      throw new RateLimitedError();
    }

    const header = req.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    const operator =
      token === undefined ? null : authenticateOperatorToken(config.auth.operators, token);
    if (operator === null) {
      if (token !== undefined) failures.hit(client);
      logger.warn(
        {
          requestId: requestId(req),
          operation: 'auth.authenticate',
          errorCode: 'UNAUTHORIZED',
          reason: token === undefined ? 'missing_token' : 'invalid_token',
        },
        'authentication rejected',
      );
      throw new UnauthorizedError();
    }

    if (!READ_METHODS.includes(req.method) && !mutations.hit(operator.id)) {
      logger.warn(
        {
          requestId: requestId(req),
          operatorId: operator.id,
          operation: 'auth.mutation',
          errorCode: 'RATE_LIMITED',
        },
        'operator mutation rate limit exceeded',
      );
      throw new RateLimitedError();
    }

    operators.set(req, operator);
    next();
  };
}

/** 403 unless the authenticated operator has at least `role`. */
export function requireRole(
  role: OperatorRole,
  logger: Logger,
  writesOnly = false,
): RequestHandler {
  return (req, _res, next) => {
    if (writesOnly && READ_METHODS.includes(req.method)) {
      next();
      return;
    }
    const operator = operatorOf(req);
    if (!hasRole(operator, role)) {
      logger.warn(
        {
          requestId: requestId(req),
          operatorId: operator.id,
          operation: 'auth.authorize',
          errorCode: 'FORBIDDEN',
          required: role,
        },
        'authorization rejected',
      );
      throw new ForbiddenError(`Requires the ${role} role`);
    }
    next();
  };
}
