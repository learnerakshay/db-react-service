import type { AppConfig } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import {
  findInboundNeedingQualification,
  findPendingConversionMessages,
  type QualificationDependencies,
} from '../modules/conversion/qualification.js';
import type { JobQueue, QueueDefinition } from './queue.js';
import { createConversionSendWorker, createQualificationWorker } from './workers/conversion.js';

/** Deterministic job names. Renaming one orphans jobs already in the database. */
export const CONVERSION_JOB_NAMES = {
  tick: 'conversion-tick',
  qualify: 'qualification-process',
  send: 'conversion-send',
} as const;

const TICK_RETRY_LIMIT = 1;
const TICK_RETRY_DELAY_SECONDS = 5;
const TICK_EXPIRE_IN_SECONDS = 60;

export function conversionJobQueues(conversion: AppConfig['conversion']): QueueDefinition[] {
  const work = {
    retryLimit: conversion.jobRetryLimit,
    retryDelaySeconds: conversion.jobRetryDelaySeconds,
    expireInSeconds: conversion.jobExpireInSeconds,
    singleQueuedPerKey: true,
  };
  return [
    {
      name: CONVERSION_JOB_NAMES.tick,
      retryLimit: TICK_RETRY_LIMIT,
      retryDelaySeconds: TICK_RETRY_DELAY_SECONDS,
      expireInSeconds: TICK_EXPIRE_IN_SECONDS,
      singleQueuedPerKey: true,
    },
    { name: CONVERSION_JOB_NAMES.qualify, ...work },
    { name: CONVERSION_JOB_NAMES.send, ...work },
  ];
}

export interface ConversionJobDeps {
  queue: JobQueue;
  logger: Logger;
  qualificationDeps: QualificationDependencies;
}

/**
 * Tick: enqueue qualification for inbound messages that need it (key = message
 * id) and re-enqueue persisted questions/booking links still PENDING. Handlers
 * are idempotent, so duplicate or overlapping ticks are harmless.
 */
export async function enqueueConversionWork(
  deps: ConversionJobDeps,
  now: Date = new Date(),
): Promise<{ inbound: number; pendingSends: number }> {
  const { db, conversion, replies } = deps.qualificationDeps;

  const inbound = await findInboundNeedingQualification(
    db,
    now,
    replies.maxInboundAgeMs,
    conversion.tickBatchSize,
  );
  for (const messageId of inbound) {
    await deps.queue.enqueue(
      CONVERSION_JOB_NAMES.qualify,
      { messageId },
      { idempotencyKey: messageId },
    );
  }

  const pendingSends = await findPendingConversionMessages(
    db,
    now,
    conversion.pendingSendAfterMs,
    conversion.tickBatchSize,
  );
  for (const messageId of pendingSends) {
    await deps.queue.enqueue(
      CONVERSION_JOB_NAMES.send,
      { messageId },
      { idempotencyKey: messageId },
    );
  }
  return { inbound: inbound.length, pendingSends: pendingSends.length };
}

export async function registerConversionWorkers(deps: ConversionJobDeps): Promise<void> {
  await deps.queue.work<unknown>(CONVERSION_JOB_NAMES.tick, async (job) => {
    const result = await enqueueConversionWork(deps);
    deps.logger.info({ jobId: job.id, operation: 'conversion.tick', ...result }, 'conversion tick');
  });
  await deps.queue.work(
    CONVERSION_JOB_NAMES.qualify,
    createQualificationWorker(deps.qualificationDeps),
  );
  await deps.queue.work(
    CONVERSION_JOB_NAMES.send,
    createConversionSendWorker(deps.qualificationDeps.outbound, deps.logger),
  );
}

export async function scheduleConversion(deps: ConversionJobDeps): Promise<void> {
  await deps.queue.schedule(CONVERSION_JOB_NAMES.tick, deps.qualificationDeps.conversion.cron);
}
