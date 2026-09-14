import type { DependencyStatus } from '@cadentor/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import type { Logger } from '../lib/logger.js';

export type Database = PrismaClient;

/** Either the root client or an interactive transaction client. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Single construction point for database access. Create one instance per
 * process (in server.ts) and pass it down; never instantiate PrismaClient elsewhere.
 */
export function createDatabase(url: string): Database {
  const adapter = new PrismaPg({
    connectionString: url,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  return new PrismaClient({ adapter });
}

/** Readiness probe. Failures are logged without connection details. */
export function databaseHealthCheck(
  db: Database | undefined,
  logger: Logger,
): () => Promise<DependencyStatus> {
  return async () => {
    if (db === undefined) return 'not_configured';
    try {
      await db.$queryRaw`SELECT 1`;
      return 'up';
    } catch (err) {
      logger.warn(
        {
          operation: 'database.ping',
          errorCode: 'DATABASE_ERROR',
          errorName: err instanceof Error ? err.name : typeof err,
        },
        'database ping failed',
      );
      return 'down';
    }
  };
}
