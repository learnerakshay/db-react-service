import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { createPgBossQueue } from '../../src/jobs/boss.js';
import {
  enqueueStep1Sends,
  OUTBOUND_JOB_NAMES,
  outboundJobQueues,
  registerOutboundWorkers,
  type OutboundDispatchDeps,
} from '../../src/jobs/outbound-dispatch.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { localTimeOfDay } from '../../src/modules/dispatch/send-window.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { admit, stageMembers } from '../helpers/dispatch.js';
import {
  createMessagingCampaign,
  FakeMessagingProvider,
  outboundDeps,
} from '../helpers/messaging.js';

/** Real pg-boss workers; only the provider network call is faked. */

const config = loadConfig({ NODE_ENV: 'test' });
let db: Database;
const running: JobQueue[] = [];

async function startWorkers(provider: FakeMessagingProvider): Promise<OutboundDispatchDeps> {
  const queue = createPgBossQueue(
    {
      connectionString: inject('databaseUrl'),
      schema: 'pgboss_test',
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5_000,
      schedule: false,
      queues: outboundJobQueues(config.messaging),
    },
    silentLogger,
  );
  await queue.start();
  running.push(queue);
  const deps: OutboundDispatchDeps = {
    queue,
    logger: silentLogger,
    messaging: config.messaging,
    outbound: outboundDeps(db, provider),
  };
  await registerOutboundWorkers(deps);
  return deps;
}

async function stopAll() {
  await Promise.all(running.splice(0).map((queue) => queue.stop()));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('condition not met in time');
}

/** All-day window in a zone whose current local time is not the excluded last minute. */
async function queuedCampaign(count: number) {
  const timezone = localTimeOfDay(new Date(), 'UTC') >= '23:50' ? 'Etc/GMT+2' : 'UTC';
  const campaign = await createMessagingCampaign(db, {
    timezone,
    sendWindow: { start: '00:00', end: '23:59' },
  });
  await stageMembers(
    db,
    campaign.id,
    Array.from({ length: count }, () => ({})),
  );
  const admitted = await admit(db, campaign.id, { now: undefined });
  expect(admitted.admitted).toBe(count);
  return campaign;
}

const sentCount = (campaignId: string) =>
  db.campaignLead.count({ where: { campaignId, status: 'STEP_1_SENT' } });

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

describe('outbound dispatch with pg-boss', () => {
  it('sends each queued member exactly once despite duplicate ticks, duplicate jobs and a restart', async () => {
    const provider = new FakeMessagingProvider();
    let deps = await startWorkers(provider);
    const campaign = await queuedCampaign(3);
    const members = await db.campaignLead.findMany({ where: { campaignId: campaign.id } });

    await Promise.all([
      enqueueStep1Sends(deps),
      enqueueStep1Sends(deps),
      ...members.map((m) =>
        deps.queue.enqueue(
          OUTBOUND_JOB_NAMES.step1Send,
          { campaignLeadId: m.id },
          { idempotencyKey: `dup-${m.id}` },
        ),
      ),
    ]);
    await waitFor(async () => (await sentCount(campaign.id)) === 3);

    await stopAll();
    deps = await startWorkers(provider);
    const tick = await enqueueStep1Sends(deps);
    expect(tick.candidates).toBe(0);
    for (const m of members) {
      await deps.queue.enqueue(
        OUTBOUND_JOB_NAMES.step1Send,
        { campaignLeadId: m.id },
        { idempotencyKey: `again-${m.id}` },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(provider.calls).toHaveLength(3);
    expect(await db.message.count({ where: { direction: 'OUTBOUND' } })).toBe(3);
    expect(await sentCount(campaign.id)).toBe(3);
  });

  it('discards invalid payloads without sending', async () => {
    const provider = new FakeMessagingProvider();
    const deps = await startWorkers(provider);
    const campaign = await queuedCampaign(1);

    await deps.queue.enqueue(
      OUTBOUND_JOB_NAMES.step1Send,
      { campaignLeadId: 'nope' },
      { idempotencyKey: 'bad' },
    );
    await enqueueStep1Sends(deps);
    await waitFor(async () => (await sentCount(campaign.id)) === 1);
    expect(provider.calls).toHaveLength(1);
  });
});
