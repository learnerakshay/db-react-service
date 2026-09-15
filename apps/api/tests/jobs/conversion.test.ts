import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { createPgBossQueue } from '../../src/jobs/boss.js';
import {
  CONVERSION_JOB_NAMES,
  conversionJobQueues,
  enqueueConversionWork,
  registerConversionWorkers,
  type ConversionJobDeps,
} from '../../src/jobs/conversion.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { loadConfig } from '../../src/config/index.js';
import { FakeAiProvider } from '../helpers/ai.js';
import { conversionDeps, engagedMember, extracted } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { FakeMessagingProvider } from '../helpers/messaging.js';

/** Real pg-boss workers; only the AI and SMS network boundaries are faked. */

let db: Database;
const running: JobQueue[] = [];

async function startWorkers(ai: FakeAiProvider, messaging: FakeMessagingProvider) {
  const queue = createPgBossQueue(
    {
      connectionString: inject('databaseUrl'),
      schema: 'pgboss_test',
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5_000,
      schedule: false,
      queues: conversionJobQueues(loadConfig({ NODE_ENV: 'test' }).conversion),
    },
    silentLogger,
  );
  await queue.start();
  running.push(queue);
  const deps: ConversionJobDeps = {
    queue,
    logger: silentLogger,
    qualificationDeps: conversionDeps(db, ai, messaging),
  };
  await registerConversionWorkers(deps);
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

describe('conversion with pg-boss', () => {
  it('qualifies and sends one booking link despite duplicate ticks, duplicate jobs and a restart', async () => {
    const ai = new FakeAiProvider();
    const messaging = new FakeMessagingProvider();
    const { member, inbound } = await engagedMember(db, ai, messaging, {
      firstReply: 'Yes! gutter cleaning, budget $900',
    });
    ai.delayMs = 200;
    ai.script(
      'qualification_extraction',
      ...Array.from({ length: 4 }, () =>
        extracted({
          serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
          budget: { value: 900, evidence: '$900' },
        }),
      ),
    );
    let deps = await startWorkers(ai, messaging);

    await Promise.all([
      enqueueConversionWork(deps),
      enqueueConversionWork(deps),
      deps.queue.enqueue(
        CONVERSION_JOB_NAMES.qualify,
        { messageId: inbound },
        { idempotencyKey: `dup-${inbound}` },
      ),
    ]);
    await waitFor(async () => {
      const link = await db.message.findFirst({ where: { purpose: 'BOOKING_LINK' } });
      return link?.status === 'ACCEPTED';
    });

    await stopAll();
    deps = await startWorkers(ai, messaging);
    expect(await enqueueConversionWork(deps)).toEqual({ inbound: 0, pendingSends: 0 });
    await deps.queue.enqueue(
      CONVERSION_JOB_NAMES.qualify,
      { messageId: inbound },
      { idempotencyKey: `again-${inbound}` },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(await db.qualificationEvaluation.count()).toBe(1);
    expect(await db.bookingOpportunity.count()).toBe(1);
    expect(await db.message.count({ where: { purpose: 'BOOKING_LINK' } })).toBe(1);
    expect(messaging.calls.filter((c) => c.body.startsWith('You qualify!'))).toHaveLength(1);
    expect((await db.campaignLead.findUniqueOrThrow({ where: { id: member.id } })).status).toBe(
      'QUALIFIED',
    );
  });
});
