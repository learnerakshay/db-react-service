import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { createPgBossQueue } from '../../src/jobs/boss.js';
import {
  campaignJobQueues,
  enqueueActiveCampaigns,
  JOB_NAMES,
  registerCampaignWorkers,
} from '../../src/jobs/campaign-scheduler.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { localTimeOfDay } from '../../src/modules/dispatch/send-window.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { createCampaignWith, stageMembers, statusCounts } from '../helpers/dispatch.js';

/**
 * Real pg-boss against the test database. Admission here uses the database
 * clock, so campaigns get an all-day window in a timezone whose current local
 * time is not the excluded final minute.
 */

const config = loadConfig({ NODE_ENV: 'test' });
let db: Database;
const running: JobQueue[] = [];

async function startWorkers(): Promise<JobQueue> {
  const queue = createPgBossQueue(
    {
      connectionString: inject('databaseUrl'),
      schema: 'pgboss_test',
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5_000,
      schedule: false,
      queues: campaignJobQueues(config.jobs),
    },
    silentLogger,
  );
  await queue.start();
  running.push(queue);
  await registerCampaignWorkers({ db, queue, logger: silentLogger, config });
  return queue;
}

async function stopAll() {
  await Promise.all(running.splice(0).map((queue) => queue.stop()));
}

async function allDayCampaign(hourlyDispatchLimit: number) {
  const timezone = localTimeOfDay(new Date(), 'UTC') >= '23:50' ? 'Etc/GMT+2' : 'UTC';
  return createCampaignWith(db, {
    timezone,
    hourlyDispatchLimit,
    sendWindow: { start: '00:00', end: '23:59' },
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('condition not met in time');
}

const queuedCount = (campaignId: string) =>
  db.campaignLead.count({ where: { campaignId, status: 'QUEUED' } });

beforeAll(() => {
  db = connectTestDatabase();
});
afterAll(async () => {
  await stopAll();
  await db.$disconnect();
});
beforeEach(async () => {
  await stopAll();
  await resetDatabase(db);
});

describe('pg-boss campaign scheduler', () => {
  it('fans out ACTIVE campaigns only and workers admit up to capacity', async () => {
    const queue = await startWorkers();
    const active = await allDayCampaign(3);
    const paused = await createCampaignWith(db, { status: 'PAUSED', name: 'paused' });
    await stageMembers(db, active.id, [{}, {}, {}, {}, {}]);
    await stageMembers(db, paused.id, [{}, {}]);

    const tick = await enqueueActiveCampaigns(db, queue);
    expect(tick.campaigns).toBe(1);

    await waitFor(async () => (await queuedCount(active.id)) === 3);
    const admissions = await db.dispatchAdmission.findMany({ where: { campaignId: active.id } });
    expect(admissions).toHaveLength(3);
    expect(admissions.every((a) => a.jobId !== null)).toBe(true);
    expect(await statusCounts(db, paused.id)).toEqual({ STAGED: 2 });
  });

  it('is unaffected by duplicate ticks, repeated jobs and a worker restart', async () => {
    let queue = await startWorkers();
    const campaign = await allDayCampaign(3);
    await stageMembers(
      db,
      campaign.id,
      Array.from({ length: 10 }, () => ({})),
    );

    // Overlapping ticks plus extra jobs under distinct keys, so pg-boss does not
    // collapse them: several admission runs really execute for one campaign.
    await Promise.all([
      enqueueActiveCampaigns(db, queue),
      enqueueActiveCampaigns(db, queue),
      queue.enqueue(
        JOB_NAMES.campaignAdmission,
        { campaignId: campaign.id },
        { idempotencyKey: 'dup-1' },
      ),
      queue.enqueue(
        JOB_NAMES.campaignAdmission,
        { campaignId: campaign.id },
        { idempotencyKey: 'dup-2' },
      ),
    ]);
    await waitFor(async () => (await queuedCount(campaign.id)) === 3);

    // Simulated process restart: new pg-boss instance, same database.
    await stopAll();
    queue = await startWorkers();
    await enqueueActiveCampaigns(db, queue);
    await queue.enqueue(
      JOB_NAMES.campaignAdmission,
      { campaignId: campaign.id },
      { idempotencyKey: 'dup-3' },
    );

    // Give the new workers time to process; capacity for this hour is used.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await statusCounts(db, campaign.id)).toEqual({ QUEUED: 3, STAGED: 7 });
    expect(await db.dispatchAdmission.count({ where: { campaignId: campaign.id } })).toBe(3);
  });

  it('completes jobs with invalid payloads without admitting anything', async () => {
    const queue = await startWorkers();
    const campaign = await allDayCampaign(5);
    await stageMembers(db, campaign.id, [{}]);

    await queue.enqueue(
      JOB_NAMES.campaignAdmission,
      { campaignId: 'not-a-uuid' },
      { idempotencyKey: 'bad' },
    );
    await queue.enqueue(
      JOB_NAMES.campaignAdmission,
      { campaignId: campaign.id },
      { idempotencyKey: campaign.id },
    );
    await waitFor(async () => (await queuedCount(campaign.id)) === 1);
  });

  it('collapses duplicate waiting jobs for the same campaign key', async () => {
    // Queue started without workers, so the first job stays waiting.
    const queue = createPgBossQueue(
      {
        connectionString: inject('databaseUrl'),
        schema: 'pgboss_test',
        pollingIntervalSeconds: 0.5,
        stopTimeoutMs: 5_000,
        schedule: false,
        queues: campaignJobQueues(config.jobs),
      },
      silentLogger,
    );
    await queue.start();
    running.push(queue);
    const campaign = await allDayCampaign(5);
    const first = await queue.enqueue(
      JOB_NAMES.campaignAdmission,
      { campaignId: campaign.id },
      { idempotencyKey: campaign.id },
    );
    const second = await queue.enqueue(
      JOB_NAMES.campaignAdmission,
      { campaignId: campaign.id },
      { idempotencyKey: campaign.id },
    );
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
