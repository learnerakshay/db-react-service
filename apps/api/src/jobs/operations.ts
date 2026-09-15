import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import type { Logger } from '../lib/logger.js';
import { archiveDueMembers } from '../modules/followup/archival.js';
import { findStep2Candidates } from '../modules/followup/step2.js';
import {
  findDueDeliveries,
  type DeliveryDependencies,
} from '../modules/integrations/deliveries.js';
import type { OutboundDependencies } from '../modules/messaging/outbound.js';
import type { JobQueue, QueueDefinition } from './queue.js';
import { createDeliveryWorker, createStep2SendWorker } from './workers/operations.js';

/** Deterministic job names. Renaming one orphans jobs already in the database. */
export const OPERATIONS_JOB_NAMES = {
  tick: 'operations-tick',
  step2Send: 'outbound-step2-send',
  delivery: 'integration-delivery',
} as const;

const TICK_RETRY_LIMIT = 1;
const TICK_RETRY_DELAY_SECONDS = 5;
const TICK_EXPIRE_IN_SECONDS = 60;

export function operationsJobQueues(
  operations: AppConfig['operations'],
  messaging: AppConfig['messaging'],
): QueueDefinition[] {
  return [
    {
      name: OPERATIONS_JOB_NAMES.tick,
      retryLimit: TICK_RETRY_LIMIT,
      retryDelaySeconds: TICK_RETRY_DELAY_SECONDS,
      expireInSeconds: TICK_EXPIRE_IN_SECONDS,
      singleQueuedPerKey: true,
    },
    {
      name: OPERATIONS_JOB_NAMES.step2Send,
      retryLimit: messaging.sendRetryLimit,
      retryDelaySeconds: messaging.sendRetryDelaySeconds,
      expireInSeconds: messaging.sendExpireInSeconds,
      singleQueuedPerKey: true,
    },
    {
      name: OPERATIONS_JOB_NAMES.delivery,
      retryLimit: operations.jobRetryLimit,
      retryDelaySeconds: operations.jobRetryDelaySeconds,
      expireInSeconds: operations.jobExpireInSeconds,
      singleQueuedPerKey: true,
    },
  ];
}

export interface OperationsJobDeps {
  queue: JobQueue;
  logger: Logger;
  db: Database;
  operations: AppConfig['operations'];
  /** Absent when no messaging provider is configured: no Step 2 sends. */
  outbound: OutboundDependencies | undefined;
  deliveries: DeliveryDependencies;
}

/**
 * Operational tick (bounded, oldest first, safe to duplicate):
 *  - enqueue Step 2 for due STEP_1_SENT members (key = membership id);
 *  - archive members whose closeout went unanswered for archiveDelayDays;
 *  - enqueue due integration deliveries (key = delivery id).
 */
export async function runOperationsTick(
  deps: OperationsJobDeps,
  now: Date = new Date(),
): Promise<{ step2Candidates: number; archived: number; deliveries: number }> {
  const { db, operations } = deps;

  const candidates =
    deps.outbound === undefined ? [] : await findStep2Candidates(db, now, operations.tickBatchSize);
  for (const campaignLeadId of candidates) {
    await deps.queue.enqueue(
      OPERATIONS_JOB_NAMES.step2Send,
      { campaignLeadId },
      { idempotencyKey: campaignLeadId },
    );
  }

  const archived = await archiveDueMembers(
    db,
    now,
    operations.tickBatchSize,
    operations.transactionTimeoutMs,
  );

  const due = await findDueDeliveries(
    db,
    now,
    operations.deliveryProcessingStaleAfterMs,
    operations.tickBatchSize,
  );
  for (const deliveryId of due) {
    await deps.queue.enqueue(
      OPERATIONS_JOB_NAMES.delivery,
      { deliveryId },
      { idempotencyKey: deliveryId },
    );
  }
  return { step2Candidates: candidates.length, archived, deliveries: due.length };
}

export async function registerOperationsWorkers(deps: OperationsJobDeps): Promise<void> {
  await deps.queue.work<unknown>(OPERATIONS_JOB_NAMES.tick, async (job) => {
    const result = await runOperationsTick(deps);
    deps.logger.info({ jobId: job.id, operation: 'operations.tick', ...result }, 'operations tick');
  });
  if (deps.outbound !== undefined) {
    await deps.queue.work(OPERATIONS_JOB_NAMES.step2Send, createStep2SendWorker(deps.outbound));
  }
  await deps.queue.work(OPERATIONS_JOB_NAMES.delivery, createDeliveryWorker(deps.deliveries));
}

export async function scheduleOperations(deps: OperationsJobDeps): Promise<void> {
  await deps.queue.schedule(OPERATIONS_JOB_NAMES.tick, deps.operations.cron);
}
