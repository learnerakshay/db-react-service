import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import type {
  IntegrationDestination,
  IntegrationEventType,
} from '../../src/generated/prisma/enums.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { processIntegrationDelivery } from '../../src/modules/integrations/deliveries.js';
import type { CrmBookingSync } from '../../src/providers/crm/index.js';
import type { PostBookingHandoff } from '../../src/providers/handoff/index.js';
import type { OwnerNotification } from '../../src/providers/notifications/index.js';
import { bookingEvent, qualifiedMember } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import {
  deliveryDeps,
  FakeCrm,
  FakeHandoff,
  FakeNotifier,
  TEST_OPERATIONS,
} from '../helpers/operations.js';

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

const OPTIONS = { transactionTimeoutMs: 30_000 };
const MINUTE = 60_000;

async function booked() {
  const context = await qualifiedMember(db);
  const confirm = bookingEvent({
    kind: 'BOOKING_CREATED',
    bookingReference: context.opportunity.bookingReference,
  });
  await applyBookingEvent(db, 'fakecal', confirm, OPTIONS);
  return { ...context, confirm };
}

const deliveries = () =>
  db.integrationDelivery.findMany({ orderBy: [{ createdAt: 'asc' }, { idempotencyKey: 'asc' }] });
const delivery = (eventType: IntegrationEventType, destination: IntegrationDestination) =>
  db.integrationDelivery.findFirstOrThrow({ where: { eventType, destination } });
const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const summary = async () =>
  (await deliveries()).map((d) => `${d.eventType}:${d.destination}`).sort();

describe('booking outbox', () => {
  it('BOOKED creates exactly one CRM sync, owner notification and handoff, despite duplicate events', async () => {
    const { lead, campaign, opportunity, confirm } = await booked();

    expect(await applyBookingEvent(db, 'fakecal', confirm, OPTIONS)).toMatchObject({
      duplicate: true,
    });
    expect(
      await applyBookingEvent(db, 'fakecal', { ...confirm, eventId: 'redelivered' }, OPTIONS),
    ).toMatchObject({
      outcome: 'ALREADY_APPLIED',
    });

    expect(await summary()).toEqual([
      'BOOKING_CONFIRMED:CRM',
      'BOOKING_CONFIRMED:OWNER_NOTIFICATION',
      'BOOKING_CONFIRMED:POST_BOOKING_HANDOFF',
    ]);
    const crm = await delivery('BOOKING_CONFIRMED', 'CRM');
    expect(crm).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      idempotencyKey: `${opportunity.id}:BOOKING_CONFIRMED:CRM`,
    });
    expect(crm.payload as unknown as CrmBookingSync).toMatchObject({
      idempotencyKey: crm.idempotencyKey,
      event: 'BOOKING_CONFIRMED',
      tags: ['Reactivated'],
      contact: { phone: lead.phone, leadReference: lead.id },
      campaign: { id: campaign.id },
      booking: { reference: opportunity.bookingReference, externalBookingId: 'booking-1' },
    });

    const owner = (await delivery('BOOKING_CONFIRMED', 'OWNER_NOTIFICATION'))
      .payload as unknown as OwnerNotification;
    expect(owner.subject).toBe('New booking: Unnamed lead');
    expect(owner.body).toContain(`Booking reference: ${opportunity.bookingReference}`);
    expect(owner.body).toContain('(America/New_York)');
    expect(owner.body).not.toContain(lead.phone);
  });

  it('retries a transient CRM failure with the same idempotency key and completes once', async () => {
    await booked();
    const crm = new FakeCrm();
    crm.scripts.push({ outcome: 'FAILED', retryable: true, errorCode: 'HTTP_503' });
    const deps = deliveryDeps(db, { crm });
    const { id } = await delivery('BOOKING_CONFIRMED', 'CRM');
    const now = new Date();

    expect(await processIntegrationDelivery(deps, id, now)).toBe('RETRY');
    const retry = await db.integrationDelivery.findUniqueOrThrow({ where: { id } });
    expect(retry).toMatchObject({ status: 'RETRY', attempts: 1, lastErrorCode: 'HTTP_503' });
    expect(retry.nextAttemptAt.getTime()).toBe(
      now.getTime() + TEST_OPERATIONS.deliveryRetryBaseDelaySeconds * 1000,
    );
    expect(await processIntegrationDelivery(deps, id, now)).toBe('NOT_DUE');

    const later = new Date(now.getTime() + 2 * MINUTE);
    expect(await processIntegrationDelivery(deps, id, later)).toBe('COMPLETED');
    expect(await processIntegrationDelivery(deps, id, later)).toBe('ALREADY_FINAL');

    expect(crm.calls).toHaveLength(2);
    expect(new Set(crm.calls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(await db.integrationDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'COMPLETED',
      attempts: 2,
      provider: 'fake-crm',
      lastErrorCode: null,
    });
    expect(await db.integrationDelivery.count({ where: { destination: 'CRM' } })).toBe(1);
  });

  it('concurrent workers make one provider call; an interrupted claim is reclaimed with the same key', async () => {
    await booked();
    const crm = new FakeCrm();
    crm.delayMs = 150;
    const { id } = await delivery('BOOKING_CONFIRMED', 'CRM');
    const outcomes = await Promise.all([
      processIntegrationDelivery(deliveryDeps(db, { crm }), id),
      processIntegrationDelivery(deliveryDeps(db, { crm }), id),
    ]);
    expect(outcomes.sort()).toEqual(['COMPLETED', 'IN_FLIGHT']);
    expect(crm.calls).toHaveLength(1);

    const notifier = new FakeNotifier();
    const owner = await delivery('BOOKING_CONFIRMED', 'OWNER_NOTIFICATION');
    const now = new Date();
    await db.integrationDelivery.update({
      where: { id: owner.id },
      data: { status: 'PROCESSING', attempts: 1, claimedAt: new Date(now.getTime() - 11 * MINUTE) },
    });
    expect(
      await processIntegrationDelivery(
        deliveryDeps(db, { notifications: notifier }),
        owner.id,
        now,
      ),
    ).toBe('COMPLETED');
    expect(notifier.calls.map((c) => c.idempotencyKey)).toEqual([owner.idempotencyKey]);
    expect(
      (await db.integrationDelivery.findUniqueOrThrow({ where: { id: owner.id } })).attempts,
    ).toBe(2);
  });

  it('CRM and notification failures never undo the booking', async () => {
    const { member, opportunity } = await booked();
    const crm = new FakeCrm();
    crm.scripts.push({ outcome: 'FAILED', retryable: false, errorCode: 'INVALID_CONTACT' });
    const notifier = new FakeNotifier();
    notifier.scripts.push(...Array.from({ length: 5 }, () => new Error('network down')));
    const deps = deliveryDeps(db, { crm, notifications: notifier });

    expect(
      await processIntegrationDelivery(deps, (await delivery('BOOKING_CONFIRMED', 'CRM')).id),
    ).toBe('FAILED');

    const { id } = await delivery('BOOKING_CONFIRMED', 'OWNER_NOTIFICATION');
    let at = Date.now();
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(await processIntegrationDelivery(deps, id, new Date(at)));
      at += 60 * MINUTE;
    }
    expect(outcomes).toEqual(['RETRY', 'RETRY', 'RETRY', 'RETRY', 'FAILED']);
    expect(await db.integrationDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      attempts: TEST_OPERATIONS.deliveryMaxAttempts,
      lastErrorCode: 'ADAPTER_ERROR',
    });
    expect(notifier.calls).toHaveLength(5);

    expect(await statusOf(member.id)).toBe('BOOKED');
    expect(
      (await db.bookingOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).status,
    ).toBe('CONFIRMED');
  });

  it('sends one owner notification per booking', async () => {
    await booked();
    const notifier = new FakeNotifier();
    const deps = deliveryDeps(db, { notifications: notifier });
    const { id } = await delivery('BOOKING_CONFIRMED', 'OWNER_NOTIFICATION');
    expect(await processIntegrationDelivery(deps, id)).toBe('COMPLETED');
    expect(await processIntegrationDelivery(deps, id)).toBe('ALREADY_FINAL');
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.subject).toBe('New booking: Unnamed lead');
  });

  it('persists one handoff per confirmed booking and marks it BLOCKED when Service 3 is not configured', async () => {
    const first = await booked();
    const unconfigured = deliveryDeps(db);
    for (const row of await deliveries()) {
      expect(await processIntegrationDelivery(unconfigured, row.id)).toBe('BLOCKED');
      expect(await processIntegrationDelivery(unconfigured, row.id)).toBe('ALREADY_FINAL');
    }
    const handoff = await delivery('BOOKING_CONFIRMED', 'POST_BOOKING_HANDOFF');
    expect(handoff).toMatchObject({
      status: 'BLOCKED',
      lastErrorCode: 'NOT_CONFIGURED',
      attempts: 0,
      completedAt: null,
    });
    expect(handoff.payload as unknown as PostBookingHandoff).toMatchObject({
      event: 'BOOKING_CONFIRMED',
      bookingReference: first.opportunity.bookingReference,
      lead: { reference: first.lead.id, phone: first.lead.phone },
      appointment: { startAt: '2026-07-20T15:00:00.000Z', timezone: 'America/New_York' },
    });
    expect(await statusOf(first.member.id)).toBe('BOOKED');

    await resetDatabase(db);
    await booked();
    const service3 = new FakeHandoff();
    const { id } = await delivery('BOOKING_CONFIRMED', 'POST_BOOKING_HANDOFF');
    expect(await processIntegrationDelivery(deliveryDeps(db, { handoff: service3 }), id)).toBe(
      'COMPLETED',
    );
    expect(service3.calls).toHaveLength(1);
  });
});

describe('cancellation and reschedule operations', () => {
  it('handles a cancellation once, keeping the confirmed deliveries', async () => {
    const { member } = await booked();
    const cancel = bookingEvent({
      kind: 'BOOKING_CANCELLED',
      startAt: null,
      endAt: null,
      timezone: null,
    });

    await applyBookingEvent(db, 'fakecal', cancel, OPTIONS);
    await applyBookingEvent(db, 'fakecal', cancel, OPTIONS);
    expect(
      await applyBookingEvent(db, 'fakecal', { ...cancel, eventId: 'again' }, OPTIONS),
    ).toMatchObject({
      outcome: 'ALREADY_APPLIED',
    });

    expect(await summary()).toEqual([
      'BOOKING_CANCELLED:CRM',
      'BOOKING_CANCELLED:OWNER_NOTIFICATION',
      'BOOKING_CANCELLED:POST_BOOKING_HANDOFF',
      'BOOKING_CONFIRMED:CRM',
      'BOOKING_CONFIRMED:OWNER_NOTIFICATION',
      'BOOKING_CONFIRMED:POST_BOOKING_HANDOFF',
    ]);
    expect(
      (
        (await delivery('BOOKING_CANCELLED', 'OWNER_NOTIFICATION'))
          .payload as unknown as OwnerNotification
      ).subject,
    ).toBe('Booking cancelled: Unnamed lead');
    expect(await statusOf(member.id)).toBe('QUALIFIED');
  });

  it('notifies once per material reschedule without a second conversion', async () => {
    const { member } = await booked();
    const firstMove = bookingEvent({
      kind: 'BOOKING_RESCHEDULED',
      externalBookingId: 'booking-2',
      previousExternalBookingId: 'booking-1',
      startAt: new Date('2026-07-21T15:00:00Z'),
      endAt: null,
    });
    const secondMove = bookingEvent({
      kind: 'BOOKING_RESCHEDULED',
      externalBookingId: 'booking-3',
      previousExternalBookingId: 'booking-2',
      startAt: new Date('2026-07-22T15:00:00Z'),
      endAt: null,
    });

    await applyBookingEvent(db, 'fakecal', firstMove, OPTIONS);
    await applyBookingEvent(db, 'fakecal', firstMove, OPTIONS);
    await applyBookingEvent(db, 'fakecal', secondMove, OPTIONS);
    expect(
      await applyBookingEvent(db, 'fakecal', { ...secondMove, eventId: 'repeat' }, OPTIONS),
    ).toMatchObject({
      outcome: 'ALREADY_APPLIED',
    });

    const rows = await deliveries();
    expect(
      rows
        .filter((d) => d.eventType === 'BOOKING_RESCHEDULED')
        .map((d) => d.destination)
        .sort(),
    ).toEqual([
      'OWNER_NOTIFICATION',
      'OWNER_NOTIFICATION',
      'POST_BOOKING_HANDOFF',
      'POST_BOOKING_HANDOFF',
    ]);
    expect(rows.filter((d) => d.destination === 'CRM')).toHaveLength(1);
    expect(rows.filter((d) => d.eventType === 'BOOKING_CONFIRMED')).toHaveLength(3);
    expect(await db.bookingOpportunity.count()).toBe(1);
    expect(await statusOf(member.id)).toBe('BOOKED');
  });
});
