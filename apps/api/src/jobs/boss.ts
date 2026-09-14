import { PgBoss } from 'pg-boss';
import type { Logger } from '../lib/logger.js';
import type { JobHandler, JobQueue, QueueDefinition } from './queue.js';

export interface PgBossQueueOptions {
  connectionString: string;
  /** PostgreSQL schema for pg-boss tables; kept apart from Prisma's `public`. */
  schema: string;
  pollingIntervalSeconds: number;
  /** Graceful stop: wait this long for active jobs before giving up. */
  stopTimeoutMs: number;
  /** Run the cron timekeeper in this instance. */
  schedule: boolean;
  queues: readonly QueueDefinition[];
}

/**
 * JobQueue backed by pg-boss (PostgreSQL). The only module that imports
 * pg-boss. Jobs, retries and schedules live in the database, so they survive
 * process restarts; there is no in-memory queue state to lose.
 */
export function createPgBossQueue(options: PgBossQueueOptions, logger: Logger): JobQueue {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema,
    application_name: 'cadentor-jobs',
    schedule: options.schedule,
  });
  boss.on('error', (err) => {
    logger.error({ err, operation: 'jobs.pgboss' }, 'pg-boss error');
  });

  let started = false;

  return {
    async start() {
      await boss.start();
      started = true;
      for (const queue of options.queues) {
        await boss.createQueue(queue.name, {
          policy: queue.singleQueuedPerKey ? 'stately' : 'standard',
          retryLimit: queue.retryLimit,
          retryDelay: queue.retryDelaySeconds,
          retryBackoff: true,
          expireInSeconds: queue.expireInSeconds,
        });
      }
      logger.info(
        { operation: 'jobs.start', queues: options.queues.map((q) => q.name) },
        'job queue started',
      );
    },

    async stop() {
      if (!started) return;
      started = false;
      await boss.stop({ graceful: true, timeout: options.stopTimeoutMs });
      logger.info({ operation: 'jobs.stop' }, 'job queue stopped');
    },

    async enqueue(name, payload, enqueueOptions = {}) {
      if (typeof payload !== 'object' || payload === null) {
        throw new TypeError(`Job payload for "${name}" must be an object`);
      }
      // pg-boss validates keys that are present, so omit unset options entirely.
      const { idempotencyKey, startAfter, retryLimit, retryDelaySeconds } = enqueueOptions;
      return boss.send(name, payload, {
        ...(idempotencyKey === undefined ? {} : { singletonKey: idempotencyKey }),
        ...(startAfter === undefined ? {} : { startAfter }),
        ...(retryLimit === undefined ? {} : { retryLimit }),
        ...(retryDelaySeconds === undefined ? {} : { retryDelay: retryDelaySeconds }),
      });
    },

    async work<TPayload>(name: string, handler: JobHandler<TPayload>) {
      // Options are left to inference so `includeMetadata: true` selects the
      // metadata handler (retryCount). Payload shape is validated by each worker.
      await boss.work(
        name,
        {
          includeMetadata: true,
          batchSize: 1,
          pollingIntervalSeconds: options.pollingIntervalSeconds,
        },
        async (jobs) => {
          for (const job of jobs) {
            await handler({
              id: job.id,
              name: job.name,
              payload: job.data as TPayload,
              attempt: job.retryCount + 1,
            });
          }
        },
      );
    },

    async schedule(name, cron) {
      await boss.schedule(name, cron, null, { tz: 'UTC' });
    },
  };
}
