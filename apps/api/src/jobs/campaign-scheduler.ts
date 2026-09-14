import type { AppConfig } from '../config/index.js';
import type { Database, DbClient } from '../db/client.js';
import { CampaignStatus } from '../generated/prisma/enums.js';
import type { Logger } from '../lib/logger.js';
import type { JobQueue, QueueDefinition } from './queue.js';
import { createCampaignAdmissionWorker } from './workers/campaign-admission.js';

/** Deterministic job names. Renaming one orphans jobs already in the database. */
export const JOB_NAMES = {
  schedulerTick: 'campaign-scheduler-tick',
  campaignAdmission: 'campaign-admission',
} as const;

const TICK_RETRY_LIMIT = 1;
const TICK_RETRY_DELAY_SECONDS = 5;
const TICK_EXPIRE_IN_SECONDS = 60;
const ACTIVE_CAMPAIGN_PAGE_SIZE = 500;

export function campaignJobQueues(jobs: AppConfig['jobs']): QueueDefinition[] {
  return [
    {
      name: JOB_NAMES.schedulerTick,
      retryLimit: TICK_RETRY_LIMIT,
      retryDelaySeconds: TICK_RETRY_DELAY_SECONDS,
      expireInSeconds: TICK_EXPIRE_IN_SECONDS,
      singleQueuedPerKey: true,
    },
    {
      name: JOB_NAMES.campaignAdmission,
      retryLimit: jobs.admissionRetryLimit,
      retryDelaySeconds: jobs.admissionRetryDelaySeconds,
      expireInSeconds: jobs.admissionExpireInSeconds,
      singleQueuedPerKey: true,
    },
  ];
}

/**
 * Scheduler tick: enqueue one admission job per ACTIVE campaign, keyed by
 * campaign id so overlapping ticks collapse into a single waiting job. Even if
 * duplicates run, admission is idempotent and capacity-safe.
 */
export async function enqueueActiveCampaigns(
  db: DbClient,
  queue: JobQueue,
): Promise<{ campaigns: number; enqueued: number }> {
  let campaigns = 0;
  let enqueued = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await db.campaign.findMany({
      where: {
        status: CampaignStatus.ACTIVE,
        ...(cursor === undefined ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: 'asc' },
      take: ACTIVE_CAMPAIGN_PAGE_SIZE,
      select: { id: true },
    });
    for (const { id } of page) {
      campaigns++;
      const jobId = await queue.enqueue(
        JOB_NAMES.campaignAdmission,
        { campaignId: id },
        { idempotencyKey: id },
      );
      if (jobId !== null) enqueued++;
    }
    const last = page.at(-1);
    if (last === undefined || page.length < ACTIVE_CAMPAIGN_PAGE_SIZE) break;
    cursor = last.id;
  }

  return { campaigns, enqueued };
}

export interface CampaignSchedulerDeps {
  db: Database;
  queue: JobQueue;
  logger: Logger;
  config: AppConfig;
}

/** Start consuming tick and admission jobs in this process. */
export async function registerCampaignWorkers(deps: CampaignSchedulerDeps): Promise<void> {
  await deps.queue.work<unknown>(JOB_NAMES.schedulerTick, async (job) => {
    const result = await enqueueActiveCampaigns(deps.db, deps.queue);
    deps.logger.info(
      { jobId: job.id, operation: 'scheduler.tick', ...result },
      'scheduler tick enqueued campaign admissions',
    );
  });

  await deps.queue.work(
    JOB_NAMES.campaignAdmission,
    createCampaignAdmissionWorker({
      db: deps.db,
      logger: deps.logger,
      dispatch: deps.config.dispatch,
    }),
  );
}

/** Register the recurring tick (idempotent; safe on every boot). */
export async function scheduleCampaignScheduler(deps: CampaignSchedulerDeps): Promise<void> {
  await deps.queue.schedule(JOB_NAMES.schedulerTick, deps.config.jobs.schedulerCron);
}
