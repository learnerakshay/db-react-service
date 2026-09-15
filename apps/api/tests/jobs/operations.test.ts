import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { createPgBossQueue } from '../../src/jobs/boss.js';
import {
  OPERATIONS_JOB_NAMES,
  operationsJobQueues,
  registerOperationsWorkers,
  runOperationsTick,
  type OperationsJobDeps,
} from '../../src/jobs/operations.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { bookingEvent, qualifiedMember } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { FakeMessagingProvider, outboundDeps } from '../helpers/messaging.js';
import {
  deliveryDeps,
  FakeCrm,
  FakeHandoff,
  FakeNotifier,
  step1Member,
  STEP2_TEMPLATE,
  TEST_OPERATIONS,
} from '../helpers/operations.js';

/** Real pg-boss workers; only SMS, CRM, notification and Service 3 boundaries are faked. */

let db: Database;
const running: JobQueue[] = [];

async function startWorkers(providers: {
  messaging: FakeMessagingProvider;
  crm: FakeCrm;
  notifications: FakeNotifier;
  handoff: FakeHandoff;
}): Promise<OperationsJobDeps> {
  const queue = createPgBossQueue(
    {
      connectionString: inject('databaseUrl'),
      schema: 'pgboss_test',
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5_000,
      schedule: false,
      queues: operationsJobQueues(TEST_OPERATIONS, loadConfig({ NODE_ENV: 'test' }).messaging),
    },
    silentLogger,
  );
  await queue.start();
  running.push(queue);
  const deps: OperationsJobDeps = {
    queue,
    logger: silentLogger,
    db,
    operations: TEST_OPERATIONS,
    outbound: outboundDeps(db, providers.messaging),
    deliveries: deliveryDeps(db, providers),
  };
  await registerOperationsWorkers(deps);
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

describe('operations with pg-boss', () => {
  it('sends step 2 and each booking delivery once despite duplicate ticks, duplicate jobs and a restart', async () => {
    const providers = {
      messaging: new FakeMessagingProvider(),
      crm: new FakeCrm(),
      notifications: new FakeNotifier(),
      handoff: new FakeHandoff(),
    };
    providers.crm.delayMs = 200;
    const followUp = await step1Member(db, providers.messaging, {
      followUpDelayHours: 0.0001,
      sendWindow: { start: '00:00', end: '23:59' },
    });
    const bookedLead = await qualifiedMember(db);
    await applyBookingEvent(
      db,
      'fakecal',
      bookingEvent({
        kind: 'BOOKING_CREATED',
        bookingReference: bookedLead.opportunity.bookingReference,
      }),
      { transactionTimeoutMs: 30_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    let deps = await startWorkers(providers);
    const [crmDelivery] = await db.integrationDelivery.findMany({ where: { destination: 'CRM' } });
    await Promise.all([
      runOperationsTick(deps),
      runOperationsTick(deps),
      deps.queue.enqueue(
        OPERATIONS_JOB_NAMES.step2Send,
        { campaignLeadId: followUp.member.id },
        { idempotencyKey: `dup-${followUp.member.id}` },
      ),
      deps.queue.enqueue(
        OPERATIONS_JOB_NAMES.delivery,
        { deliveryId: crmDelivery?.id },
        { idempotencyKey: `dup-${crmDelivery?.id ?? ''}` },
      ),
    ]);
    await waitFor(async () => {
      const step2 = await db.message.findFirst({ where: { purpose: 'CAMPAIGN_STEP_2' } });
      const open = await db.integrationDelivery.count({ where: { status: { not: 'COMPLETED' } } });
      return step2?.status === 'ACCEPTED' && open === 0;
    });

    await stopAll();
    deps = await startWorkers(providers);
    expect(await runOperationsTick(deps)).toEqual({
      step2Candidates: 0,
      archived: 0,
      deliveries: 0,
    });
    await deps.queue.enqueue(
      OPERATIONS_JOB_NAMES.step2Send,
      { campaignLeadId: followUp.member.id },
      { idempotencyKey: `again-${followUp.member.id}` },
    );
    await deps.queue.enqueue(
      OPERATIONS_JOB_NAMES.delivery,
      { deliveryId: crmDelivery?.id },
      { idempotencyKey: `again-${crmDelivery?.id ?? ''}` },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(providers.messaging.calls.filter((c) => c.body === STEP2_TEMPLATE.body)).toHaveLength(1);
    expect(
      (await db.campaignLead.findUniqueOrThrow({ where: { id: followUp.member.id } })).status,
    ).toBe('STEP_2_SENT');
    expect(providers.crm.calls).toHaveLength(1);
    expect(providers.notifications.calls).toHaveLength(1);
    expect(providers.handoff.calls).toHaveLength(1);
    expect(await db.integrationDelivery.count()).toBe(3);
    expect(
      (await db.campaignLead.findUniqueOrThrow({ where: { id: bookedLead.member.id } })).status,
    ).toBe('BOOKED');
  });
});
