import type { AppConfig } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import {
  findInboundNeedingProcessing,
  findPendingReplies,
  type ReplyDependencies,
} from '../modules/replies/processor.js';
import type { JobQueue, QueueDefinition } from './queue.js';
import { createReplyProcessWorker, createReplySendWorker } from './workers/reply-processing.js';

/** Deterministic job names. Renaming one orphans jobs already in the database. */
export const REPLY_JOB_NAMES = {
  tick: 'reply-processing-tick',
  process: 'reply-process',
  send: 'reply-send',
} as const;

const TICK_RETRY_LIMIT = 1;
const TICK_RETRY_DELAY_SECONDS = 5;
const TICK_EXPIRE_IN_SECONDS = 60;

export function replyJobQueues(replies: AppConfig['replies']): QueueDefinition[] {
  const work = {
    retryLimit: replies.jobRetryLimit,
    retryDelaySeconds: replies.jobRetryDelaySeconds,
    expireInSeconds: replies.jobExpireInSeconds,
    singleQueuedPerKey: true,
  };
  return [
    {
      name: REPLY_JOB_NAMES.tick,
      retryLimit: TICK_RETRY_LIMIT,
      retryDelaySeconds: TICK_RETRY_DELAY_SECONDS,
      expireInSeconds: TICK_EXPIRE_IN_SECONDS,
      singleQueuedPerKey: true,
    },
    { name: REPLY_JOB_NAMES.process, ...work },
    { name: REPLY_JOB_NAMES.send, ...work },
  ];
}

export interface ReplyJobDeps {
  queue: JobQueue;
  logger: Logger;
  replyDeps: ReplyDependencies;
}

/** Enqueue immediate processing for a newly stored inbound message. */
export async function enqueueInboundProcessing(queue: JobQueue, messageId: string): Promise<void> {
  await queue.enqueue(REPLY_JOB_NAMES.process, { messageId }, { idempotencyKey: messageId });
}

/**
 * Safety net for anything the webhook did not enqueue or a worker did not
 * finish: unprocessed, retryable or stale inbound messages, and persisted
 * replies still PENDING.
 */
export async function enqueueReplyWork(
  deps: ReplyJobDeps,
  now: Date = new Date(),
): Promise<{ inbound: number; pendingReplies: number }> {
  const { db, replies } = deps.replyDeps;

  const inbound = await findInboundNeedingProcessing(
    db,
    now,
    replies.processingStaleAfterMs,
    replies.tickBatchSize,
  );
  for (const messageId of inbound) await enqueueInboundProcessing(deps.queue, messageId);

  const pendingReplies = await findPendingReplies(
    db,
    now,
    replies.pendingReplyResendAfterMs,
    replies.tickBatchSize,
  );
  for (const messageId of pendingReplies) {
    await deps.queue.enqueue(REPLY_JOB_NAMES.send, { messageId }, { idempotencyKey: messageId });
  }
  return { inbound: inbound.length, pendingReplies: pendingReplies.length };
}

export async function registerReplyWorkers(deps: ReplyJobDeps): Promise<void> {
  await deps.queue.work<unknown>(REPLY_JOB_NAMES.tick, async (job) => {
    const result = await enqueueReplyWork(deps);
    deps.logger.info(
      { jobId: job.id, operation: 'replies.tick', ...result },
      'reply processing tick',
    );
  });
  await deps.queue.work(REPLY_JOB_NAMES.process, createReplyProcessWorker(deps.replyDeps));
  await deps.queue.work(
    REPLY_JOB_NAMES.send,
    createReplySendWorker(deps.replyDeps.outbound, deps.logger),
  );
}

export async function scheduleReplyProcessing(deps: ReplyJobDeps): Promise<void> {
  await deps.queue.schedule(REPLY_JOB_NAMES.tick, deps.replyDeps.replies.cron);
}
