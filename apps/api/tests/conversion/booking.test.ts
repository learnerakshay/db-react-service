import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { processQualification } from '../../src/modules/conversion/qualification.js';
import { sendConversionMessage } from '../../src/modules/conversion/sender.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import type { BookingEvent } from '../../src/providers/calendar/index.js';
import { apiRouter } from '../../src/routes/api.js';
import { FakeAiProvider } from '../helpers/ai.js';
import {
  APPOINTMENT_START,
  bookingEvent,
  CALENDAR_SIGNATURE,
  conversionDeps,
  engagedMember,
  extracted,
  FakeCalendarProvider,
  replyFromLead,
} from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { FakeMessagingProvider, outboundDeps } from '../helpers/messaging.js';

let db: Database;
let server: Server;
let base: string;

beforeAll(async () => {
  db = connectTestDatabase();
  const config = loadConfig({ NODE_ENV: 'test' });
  const calendar = new FakeCalendarProvider();
  const app = createApp({
    config,
    logger: silentLogger,
    checkDatabase: () => Promise.resolve('up'),
    api: apiRouter({
      db,
      config,
      logger: silentLogger,
      calendarProviders: new Map([[calendar.name, calendar]]),
    }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await db.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(db);
});

const OPTIONS = { transactionTimeoutMs: 30_000 };

/** A QUALIFIED member with an OFFERED opportunity whose link was (or was not) sent. */
async function qualified(scriptLinkSend?: Parameters<FakeMessagingProvider['script']>[0]) {
  const messaging = new FakeMessagingProvider();
  const ai = new FakeAiProvider();
  const context = await engagedMember(db, ai, messaging);
  const inbound = await replyFromLead(
    db,
    ai,
    messaging,
    context.lead.phone,
    'gutter cleaning, $900',
  );
  ai.script(
    'qualification_extraction',
    extracted({
      serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
      budget: { value: 900, evidence: '$900' },
    }),
  );
  if (scriptLinkSend !== undefined) messaging.script(scriptLinkSend);
  await processQualification(conversionDeps(db, ai, messaging), inbound);
  const opportunity = await db.bookingOpportunity.findFirstOrThrow({
    where: { campaignLeadId: context.member.id },
  });
  if (opportunity.linkMessageId === null) throw new Error('no link message');
  return { ...context, messaging, ai, opportunity, linkMessageId: opportunity.linkMessageId };
}

const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const opportunityOf = (id: string) => db.bookingOpportunity.findUniqueOrThrow({ where: { id } });
const linkSends = (messaging: FakeMessagingProvider) =>
  messaging.calls.filter((call) => call.body.startsWith('You qualify!'));

function confirm(reference: string, overrides: Partial<BookingEvent> = {}): BookingEvent {
  return bookingEvent({ kind: 'BOOKING_CREATED', bookingReference: reference, ...overrides });
}

describe('booking link delivery', () => {
  it('sends the booking link once across retryable failure, retries and concurrent workers', async () => {
    const { member, messaging, opportunity, linkMessageId } = await qualified({
      outcome: 'REJECTED',
      retryable: true,
      recipientOptedOut: false,
      errorCode: '429',
    });
    expect(await db.message.findUniqueOrThrow({ where: { id: linkMessageId } })).toMatchObject({
      status: 'PENDING',
      errorCode: '429',
    });
    expect((await opportunityOf(opportunity.id)).sentAt).toBeNull();

    messaging.delayMs = 150;
    const outcomes = await Promise.all([
      sendConversionMessage(outboundDeps(db, messaging), linkMessageId),
      sendConversionMessage(outboundDeps(db, messaging), linkMessageId),
    ]);
    messaging.delayMs = 0;
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['ACCEPTED', 'IN_FLIGHT']);
    expect(await sendConversionMessage(outboundDeps(db, messaging), linkMessageId)).toEqual({
      outcome: 'ALREADY_HANDLED',
    });

    expect(linkSends(messaging)).toHaveLength(2); // one rejected attempt, one accepted
    expect(await db.message.count({ where: { purpose: 'BOOKING_LINK' } })).toBe(1);
    const sent = await opportunityOf(opportunity.id);
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.status).toBe('OFFERED');
    expect(await statusOf(member.id)).toBe('QUALIFIED');
  });

  it('never sends a booking link to a lead suppressed after the link was written', async () => {
    const { member, lead, messaging, opportunity, linkMessageId } = await qualified({
      outcome: 'REJECTED',
      retryable: true,
      recipientOptedOut: false,
      errorCode: '429',
    });
    await addSuppression(db, { phone: lead.phone, reason: 'OPT_OUT', source: 'OPERATOR' });
    const callsBefore = messaging.calls.length;

    expect(await sendConversionMessage(outboundDeps(db, messaging), linkMessageId)).toEqual({
      outcome: 'CANCELLED',
    });

    expect(messaging.calls).toHaveLength(callsBefore);
    expect(await db.message.findUniqueOrThrow({ where: { id: linkMessageId } })).toMatchObject({
      status: 'CANCELLED',
      errorCode: 'SUPPRESSED',
    });
    expect(await statusOf(member.id)).toBe('OPTED_OUT');
    expect((await opportunityOf(opportunity.id)).status).toBe('CANCELLED');
  });

  it('a sent link leaves the member QUALIFIED; only trusted confirmation books', async () => {
    const { member, opportunity } = await qualified();
    expect(await statusOf(member.id)).toBe('QUALIFIED');
    expect(await opportunityOf(opportunity.id)).toMatchObject({
      status: 'OFFERED',
      confirmedAt: null,
    });

    const result = await applyBookingEvent(
      db,
      'fakecal',
      confirm(opportunity.bookingReference),
      OPTIONS,
    );

    expect(result).toEqual({
      duplicate: false,
      outcome: 'PROCESSED',
      opportunityId: opportunity.id,
    });
    expect(await statusOf(member.id)).toBe('BOOKED');
    const booked = await opportunityOf(opportunity.id);
    expect(booked).toMatchObject({
      status: 'CONFIRMED',
      externalBookingId: 'booking-1',
      appointmentStartAt: APPOINTMENT_START,
      appointmentTimezone: 'America/New_York',
    });
    expect(booked.confirmedAt).toBeInstanceOf(Date);
  });
});

describe('booking webhook', () => {
  async function post(body: unknown, signature: string | null) {
    return fetch(`${base}/api/v1/webhooks/calendar/fakecal`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        ...(signature === null ? {} : { 'x-fake-signature': signature }),
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects unsigned events before parsing and books on a verified event', async () => {
    const { member, opportunity } = await qualified();
    const event = confirm(opportunity.bookingReference);

    expect((await post(event, null)).status).toBe(403);
    expect((await post(event, 'wrong')).status).toBe(403);
    expect(await db.calendarWebhookEvent.count()).toBe(0);
    expect(await statusOf(member.id)).toBe('QUALIFIED');

    expect((await post(event, CALENDAR_SIGNATURE)).status).toBe(204);
    expect(await statusOf(member.id)).toBe('BOOKED');
    expect((await post({ kind: 'OTHER' }, CALENDAR_SIGNATURE)).status).toBe(204);
    expect(
      (await post({ ...event, eventId: 'x', timezone: 'Mars/Base' }, CALENDAR_SIGNATURE)).status,
    ).toBe(400);
  });

  it('applies duplicate and concurrent deliveries of one event exactly once', async () => {
    const { member, opportunity } = await qualified();
    const event = confirm(opportunity.bookingReference);

    const results = await Promise.all([
      applyBookingEvent(db, 'fakecal', event, OPTIONS),
      applyBookingEvent(db, 'fakecal', event, OPTIONS),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await applyBookingEvent(db, 'fakecal', event, OPTIONS)).toMatchObject({
      duplicate: true,
    });

    // Same booking redelivered under a new event id: recorded, nothing changes.
    expect(
      await applyBookingEvent(db, 'fakecal', confirm(opportunity.bookingReference), OPTIONS),
    ).toMatchObject({ duplicate: false, outcome: 'ALREADY_APPLIED' });

    expect(await db.calendarWebhookEvent.count()).toBe(2);
    expect(await statusOf(member.id)).toBe('BOOKED');
  });

  it('never attaches an unrelated event to the wrong lead', async () => {
    const first = await qualified();
    const second = await qualified();

    const outcomes = [
      await applyBookingEvent(db, 'fakecal', confirm('unknown-reference'), OPTIONS),
      await applyBookingEvent(
        db,
        'fakecal',
        confirm(first.opportunity.bookingReference, { inviteePhone: second.lead.phone }),
        OPTIONS,
      ),
      await applyBookingEvent(db, 'othercal', confirm(first.opportunity.bookingReference), OPTIONS),
    ];
    expect(outcomes.map((o) => o.outcome)).toEqual(['UNMATCHED', 'MISMATCH', 'MISMATCH']);
    expect(await statusOf(first.member.id)).toBe('QUALIFIED');

    // Booking id already confirmed for the first lead cannot be claimed via the second's reference.
    await applyBookingEvent(
      db,
      'fakecal',
      confirm(first.opportunity.bookingReference, { inviteePhone: first.lead.phone }),
      OPTIONS,
    );
    expect(
      await applyBookingEvent(db, 'fakecal', confirm(second.opportunity.bookingReference), OPTIONS),
    ).toMatchObject({ outcome: 'MISMATCH', opportunityId: null });
    expect(await statusOf(first.member.id)).toBe('BOOKED');
    expect(await statusOf(second.member.id)).toBe('QUALIFIED');
  });

  it('cannot book a membership that is not QUALIFIED', async () => {
    const { member, opportunity } = await qualified();
    await db.campaignLead.update({ where: { id: member.id }, data: { status: 'OPTED_OUT' } });

    expect(
      await applyBookingEvent(db, 'fakecal', confirm(opportunity.bookingReference), OPTIONS),
    ).toMatchObject({ outcome: 'INVALID_STATE' });
    expect((await opportunityOf(opportunity.id)).status).toBe('OFFERED');
  });
});

describe('cancellation and reschedule', () => {
  it('cancels deterministically: history kept, member back to QUALIFIED, no automatic re-offer', async () => {
    const { member, messaging, opportunity } = await qualified();
    await applyBookingEvent(db, 'fakecal', confirm(opportunity.bookingReference), OPTIONS);
    const cancel = bookingEvent({
      kind: 'BOOKING_CANCELLED',
      startAt: null,
      endAt: null,
      timezone: null,
    });
    const callsBefore = messaging.calls.length;

    expect(await applyBookingEvent(db, 'fakecal', cancel, OPTIONS)).toMatchObject({
      outcome: 'PROCESSED',
    });
    expect(await applyBookingEvent(db, 'fakecal', cancel, OPTIONS)).toMatchObject({
      duplicate: true,
    });

    const cancelled = await opportunityOf(opportunity.id);
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      externalBookingId: 'booking-1',
      appointmentStartAt: APPOINTMENT_START,
    });
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(cancelled.confirmedAt).toBeInstanceOf(Date);
    expect(await statusOf(member.id)).toBe('QUALIFIED');
    expect(
      (await db.calendarWebhookEvent.findMany({ orderBy: { receivedAt: 'asc' } })).map(
        (e) => e.kind,
      ),
    ).toEqual(['BOOKING_CREATED', 'BOOKING_CANCELLED']);
    expect(await db.bookingOpportunity.count()).toBe(1);
    expect(messaging.calls).toHaveLength(callsBefore);

    // A late confirmation for the cancelled opportunity does not re-book.
    expect(
      await applyBookingEvent(
        db,
        'fakecal',
        confirm(opportunity.bookingReference, { externalBookingId: 'booking-2' }),
        OPTIONS,
      ),
    ).toMatchObject({ outcome: 'INVALID_STATE' });
    expect(await statusOf(member.id)).toBe('QUALIFIED');
  });

  it('reschedules the same appointment without creating a second one', async () => {
    const { member, opportunity } = await qualified();
    await applyBookingEvent(db, 'fakecal', confirm(opportunity.bookingReference), OPTIONS);
    const newStart = new Date('2026-07-22T18:00:00Z');
    const reschedule = bookingEvent({
      kind: 'BOOKING_RESCHEDULED',
      externalBookingId: 'booking-2',
      previousExternalBookingId: 'booking-1',
      startAt: newStart,
      endAt: new Date(newStart.getTime() + 30 * 60_000),
      timezone: 'America/Chicago',
    });

    expect(await applyBookingEvent(db, 'fakecal', reschedule, OPTIONS)).toMatchObject({
      outcome: 'PROCESSED',
      opportunityId: opportunity.id,
    });
    expect(
      await applyBookingEvent(db, 'fakecal', { ...reschedule, eventId: 'redelivery' }, OPTIONS),
    ).toMatchObject({ outcome: 'ALREADY_APPLIED' });

    expect(await db.bookingOpportunity.count()).toBe(1);
    expect(await opportunityOf(opportunity.id)).toMatchObject({
      status: 'CONFIRMED',
      externalBookingId: 'booking-2',
      appointmentStartAt: newStart,
      appointmentTimezone: 'America/Chicago',
    });
    expect(await statusOf(member.id)).toBe('BOOKED');

    // Cancelling the replaced booking id matches nothing and changes nothing.
    const stale = bookingEvent({
      kind: 'BOOKING_CANCELLED',
      externalBookingId: 'booking-1',
      startAt: null,
      endAt: null,
      timezone: null,
    });
    expect(await applyBookingEvent(db, 'fakecal', stale, OPTIONS)).toMatchObject({
      outcome: 'UNMATCHED',
    });
    expect((await opportunityOf(opportunity.id)).status).toBe('CONFIRMED');
  });
});
