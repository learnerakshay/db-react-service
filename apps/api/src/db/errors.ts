import { Prisma } from '../generated/prisma/client.js';

/**
 * P2002: unique constraint violation.
 * P2034: write conflict or deadlock; the transaction may be retried.
 */
export type PrismaErrorCode = 'P2002' | 'P2034';

export function hasPrismaCode(err: unknown, code: PrismaErrorCode): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}
