import type { AppConfig } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import {
  archivePermanentSendFailures,
  findStep1SendCandidates,
  markInterruptedSends,
  type OutboundDependencies,
} from '../modules/messaging/outbound.js';
import type { JobQueue, QueueDefinition } from './queue.js';
import { createStep1SendWorker } from './workers/step1-send.js';

/** Deterministic job names. Renaming one orphans jobs already in the database. */
export const OUTBOUND_JOB_NAMES = {
  dispatchTick: 'outbound-dispatch-tick',
  step1Send: 'outbound-step1-send',
} as const;

const TICK_RETRY_LIMIT = 1;
const TICK_RETRY_DELAY_SECONDS = 5;
const TICK_EXPIRE_IN_SECONDS = 60;

export function outboundJobQueues(messaging: AppConfig['messaging']): QueueDefinition[] {
  return [
    {
      name: OUTBOUND_JOB_NAMES.dispatchTick,
      retryLimit: TICK_RETRY_LIMIT,
      retryDelaySeconds: TICK_RETRY_DELAY_SECONDS,
      expireInSeconds: TICK_EXPIRE_IN_SECONDS,
      singleQueuedPerKey: true,
    },
    {
      name: OUTBOUND_JOB_NAMES.step1Send,
      retryLimit: messaging.sendRetryLimit,
      retryDelaySeconds: messaging.sendRetryDelaySeconds,
      expireInSeconds: messaging.sendExpireInSeconds,
      singleQueuedPerKey: true,
    },
  ];
}

export interface OutboundDispatchDeps {
  queue: JobQueue;
  logger: Logger;
  outbound: OutboundDependencies;
  messaging: AppConfig['messaging'];
}

/**
 * Dispatch tick: mark interrupted sends UNCERTAIN, then enqueue one Step 1
 * job per eligible QUEUED membership, keyed by membership id.
 */
export async function enqueueStep1Sends(
  deps: OutboundDispatchDeps,
  now: Date = new Date(),
): Promise<{ interrupted: number; archived: number; candidates: number; enqueued: number }> {
  const { db } = deps.outbound;
  const interrupted = await markInterruptedSends(db, now, deps.messaging.sendingStaleAfterMs);
  const archived = await archivePermanentSendFailures(db, now, deps.messaging.dispatchBatchSize);
  const candidates = await findStep1SendCandidates(db, now, deps.messaging.dispatchBatchSize);

  let enqueued = 0;
  for (const campaignLeadId of candidates) {
    const jobId = await deps.queue.enqueue(
      OUTBOUND_JOB_NAMES.step1Send,
      { campaignLeadId },
      { idempotencyKey: campaignLeadId },
    );
    if (jobId !== null) enqueued++;
  }
  return { interrupted, archived, candidates: candidates.length, enqueued };
}

export async function registerOutboundWorkers(deps: OutboundDispatchDeps): Promise<void> {
  await deps.queue.work<unknown>(OUTBOUND_JOB_NAMES.dispatchTick, async (job) => {
    const result = await enqueueStep1Sends(deps);
    if (result.interrupted > 0) {
      deps.logger.warn(
        { jobId: job.id, operation: 'messaging.dispatch', interrupted: result.interrupted },
        'interrupted sends marked UNCERTAIN; reconcile with the provider',
      );
    }
    deps.logger.info(
      { jobId: job.id, operation: 'messaging.dispatch', ...result },
      'outbound dispatch tick',
    );
  });
  await deps.queue.work(OUTBOUND_JOB_NAMES.step1Send, createStep1SendWorker(deps.outbound));
}

export async function scheduleOutboundDispatch(deps: OutboundDispatchDeps): Promise<void> {
  await deps.queue.schedule(OUTBOUND_JOB_NAMES.dispatchTick, deps.messaging.dispatchCron);
}
