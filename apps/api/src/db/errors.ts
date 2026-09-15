import { Prisma } from '../generated/prisma/client.js';

/**
 * P2002: unique constraint violation.
 * P2034: write conflict or deadlock; the transaction may be retried.
 */
export type PrismaErrorCode = 'P2002' | 'P2034';

export function hasPrismaCode(err: unknown, code: PrismaErrorCode): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

/** Prisma: can't reach server, timeout, connection closed, pool timeout. */
const UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
/** Node network errors and PostgreSQL shutdown / connection / capacity SQLSTATEs. */
const UNAVAILABLE_DRIVER_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);
/** Prisma driver adapter error kinds for an unreachable database. */
const UNAVAILABLE_ADAPTER_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
  'TlsConnectionError',
]);
/** pg-pool reports connection timeouts only through the message text. */
const UNAVAILABLE_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|connection timeout|can't reach database server/i;

/**
 * True only for infrastructure unavailability (the database cannot be reached
 * or accept work), never for query, constraint or programming errors, which
 * must keep surfacing as 500s. Walks a bounded `cause` chain.
 */
export function isDatabaseUnavailableError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, kind, message, cause } = current as {
      code?: unknown;
      kind?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      typeof code === 'string' &&
      (UNAVAILABLE_PRISMA_CODES.has(code) || UNAVAILABLE_DRIVER_CODES.has(code))
    ) {
      return true;
    }
    if (typeof kind === 'string' && UNAVAILABLE_ADAPTER_KINDS.has(kind)) return true;
    if (typeof message === 'string' && UNAVAILABLE_MESSAGE.test(message)) return true;
    current = cause;
  }
  return false;
}
