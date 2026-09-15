import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import type { IntegrationDestination } from '../../src/generated/prisma/enums.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { processIntegrationDelivery } from '../../src/modules/integrations/deliveries.js';
import { requeueBlockedDeliveries } from '../../src/modules/integrations/recovery.js';
import type { OperatorContext } from '../../src/modules/reviews/resolution.js';
import { bookingEvent, qualifiedMember } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { deliveryDeps, FakeCrm, FakeNotifier } from '../helpers/operations.js';

let db: Database;

beforeAll(() => {
  db = connectTestDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(db);
});

const context = (now = new Date()): OperatorContext => ({
  actor: { id: 'admin', role: 'ADMIN' },
  now,
  transactionTimeoutMs: 30_000,
});

const deliveryOf = (destination: IntegrationDestination) =>
  db.integrationDelivery.findFirstOrThrow({ where: { destination } });

describe('blocked integration recovery', () => {
  it('requeues only NOT_CONFIGURED deliveries of now-configured destinations, once', async () => {
    const qualified = await qualifiedMember(db);
    await applyBookingEvent(
      db,
      'fakecal',
      bookingEvent({
        kind: 'BOOKING_CREATED',
        bookingReference: qualified.opportunity.bookingReference,
      }),
      { transactionTimeoutMs: 30_000 },
    );

    // CRM configured but permanently failing; notification and handoff not configured.
    const crm = new FakeCrm();
    crm.scripts.push({ outcome: 'FAILED', retryable: false, errorCode: 'HTTP_400' });
    expect(
      await processIntegrationDelivery(deliveryDeps(db, { crm }), (await deliveryOf('CRM')).id),
    ).toBe('FAILED');
    for (const destination of ['OWNER_NOTIFICATION', 'POST_BOOKING_HANDOFF'] as const) {
      expect(
        await processIntegrationDelivery(deliveryDeps(db), (await deliveryOf(destination)).id),
      ).toBe('BLOCKED');
    }

    // The owner-notification provider is now configured; CRM "configured" too.
    const now = new Date('2026-09-15T12:00:00Z');
    const result = await requeueBlockedDeliveries(db, ['CRM', 'OWNER_NOTIFICATION'], context(now));
    expect(result).toEqual({
      requeued: 1,
      byDestination: { CRM: 0, OWNER_NOTIFICATION: 1, POST_BOOKING_HANDOFF: 0 },
    });

    expect(await deliveryOf('OWNER_NOTIFICATION')).toMatchObject({
      status: 'PENDING',
      lastErrorCode: null,
      attempts: 0,
      nextAttemptAt: now,
    });
    // A permanent failure is never requeued; an unconfigured destination stays blocked.
    expect(await deliveryOf('CRM')).toMatchObject({ status: 'FAILED', lastErrorCode: 'HTTP_400' });
    expect(await deliveryOf('POST_BOOKING_HANDOFF')).toMatchObject({
      status: 'BLOCKED',
      lastErrorCode: 'NOT_CONFIGURED',
    });

    // Delivery now succeeds with the same idempotency key.
    const notifier = new FakeNotifier();
    const owner = await deliveryOf('OWNER_NOTIFICATION');
    expect(
      await processIntegrationDelivery(
        deliveryDeps(db, { notifications: notifier }),
        owner.id,
        now,
      ),
    ).toBe('COMPLETED');
    expect(notifier.calls[0]?.idempotencyKey).toBe(owner.idempotencyKey);

    // Idempotent and audited once.
    expect(
      await requeueBlockedDeliveries(db, ['CRM', 'OWNER_NOTIFICATION'], context(now)),
    ).toMatchObject({ requeued: 0 });
    const audits = await db.operatorAuditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: 'admin',
      action: 'INTEGRATION_REQUEUE',
      metadata: { requeued: 1, OWNER_NOTIFICATION: 1 },
    });
  });
});
