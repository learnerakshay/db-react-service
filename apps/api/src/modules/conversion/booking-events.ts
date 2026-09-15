import { z } from 'zod';
import { isValidTimeZone } from '../../config/env.js';
import type { Database, DbClient } from '../../db/client.js';
import {
  BookingStatus,
  CalendarEventOutcome,
  CampaignLeadStatus,
  IntegrationEventType,
} from '../../generated/prisma/enums.js';
import { ValidationError } from '../../lib/errors.js';
import type { BookingEvent } from '../../providers/calendar/index.js';
import { transitionCampaignLead } from '../campaigns/membership.js';
import { enqueueBookingDeliveries } from '../integrations/deliveries.js';
import { normalizeEmail } from '../leads/email.js';
import { normalizePhone } from '../leads/phone.js';

const identifier = z.string().trim().min(1).max(200);

const INTEGRATION_EVENT: Readonly<Record<BookingEvent['kind'], IntegrationEventType>> = {
  BOOKING_CREATED: IntegrationEventType.BOOKING_CONFIRMED,
  BOOKING_RESCHEDULED: IntegrationEventType.BOOKING_RESCHEDULED,
  BOOKING_CANCELLED: IntegrationEventType.BOOKING_CANCELLED,
};

/** Adapter output is a trust boundary too: validated before anything is written. */
export const bookingEventSchema = z
  .object({
    kind: z.enum(['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED']),
    eventId: z.string().trim().min(1).max(200),
    externalBookingId: identifier,
    previousExternalBookingId: identifier.nullable(),
    bookingReference: z.string().trim().min(1).max(64).nullable(),
    startAt: z.date().nullable(),
    endAt: z.date().nullable(),
    timezone: z.string().refine(isValidTimeZone, 'must be a valid IANA timezone').nullable(),
    inviteePhone: z.string().max(32).nullable(),
    inviteeEmail: z.string().max(254).nullable(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.kind !== 'BOOKING_CANCELLED' && (event.startAt === null || event.timezone === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['startAt'],
        message: 'start time and timezone are required',
      });
    }
    if (event.startAt !== null && event.endAt !== null && event.endAt <= event.startAt) {
      ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'must be after startAt' });
    }
  });

type ValidEvent = z.infer<typeof bookingEventSchema>;

export interface BookingEventResult {
  /** The same provider event was already recorded; nothing changed. */
  duplicate: boolean;
  outcome: CalendarEventOutcome | null;
  opportunityId: string | null;
}

interface Applied {
  outcome: CalendarEventOutcome;
  opportunityId: string | null;
}

/**
 * Apply one verified calendar event exactly once (UNIQUE provider + eventKey).
 * The only path to BOOKED.
 *
 * Resolution: the booking reference from the link and/or the provider booking
 * id must identify one opportunity of this provider; the invitee identity, when
 * given, must match the lead (phone first, else email). Otherwise nothing changes.
 *
 *  - BOOKING_CREATED:     OFFERED + membership QUALIFIED → CONFIRMED + BOOKED
 *  - BOOKING_RESCHEDULED: CONFIRMED → same row, new time (and booking id)
 *  - BOOKING_CANCELLED:   CONFIRMED → CANCELLED (row kept); BOOKED → QUALIFIED.
 *                          No new link is offered automatically.
 */
export async function applyBookingEvent(
  db: Database,
  providerName: string,
  input: BookingEvent,
  options: { transactionTimeoutMs: number; now?: Date },
): Promise<BookingEventResult> {
  const parsed = bookingEventSchema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid booking event');
  const event = parsed.data;
  const now = options.now ?? new Date();
  const eventKey = `${event.kind}:${event.eventId}`;

  return db.$transaction(
    async (tx) => {
      const inserted = await tx.calendarWebhookEvent.createMany({
        data: [
          {
            provider: providerName,
            eventKey,
            kind: event.kind,
            externalBookingId: event.externalBookingId,
            bookingReference: event.bookingReference,
            appointmentStartAt: event.startAt,
            appointmentTimezone: event.timezone,
            outcome: CalendarEventOutcome.PROCESSED,
            receivedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return { duplicate: true, outcome: null, opportunityId: null };

      const applied = await resolveAndApply(tx, providerName, event, now);
      const recorded = await tx.calendarWebhookEvent.update({
        where: { provider_eventKey: { provider: providerName, eventKey } },
        data: { outcome: applied.outcome, bookingOpportunityId: applied.opportunityId },
      });
      // Phase 3 / Prompt 2: outbox rows for CRM, owner and Service 3, committed
      // with the booking change and delivered later; they can never undo it.
      if (applied.outcome === CalendarEventOutcome.PROCESSED && applied.opportunityId !== null) {
        await enqueueBookingDeliveries(tx, {
          eventType: INTEGRATION_EVENT[event.kind],
          bookingOpportunityId: applied.opportunityId,
          calendarEventId: recorded.id,
          now,
        });
      }
      return { duplicate: false, ...applied };
    },
    { timeout: options.transactionTimeoutMs, maxWait: options.transactionTimeoutMs },
  );
}

async function resolveAndApply(
  tx: DbClient,
  providerName: string,
  event: ValidEvent,
  now: Date,
): Promise<Applied> {
  const byReference =
    event.bookingReference === null
      ? null
      : await tx.bookingOpportunity.findUnique({
          where: { bookingReference: event.bookingReference },
          select: { id: true },
        });
  const bookingIds = [event.externalBookingId];
  if (event.previousExternalBookingId !== null) bookingIds.push(event.previousExternalBookingId);
  const byBooking = await tx.bookingOpportunity.findFirst({
    where: { calendarProvider: providerName, externalBookingId: { in: bookingIds } },
    select: { id: true },
  });
  if (byReference !== null && byBooking !== null && byReference.id !== byBooking.id) {
    return { outcome: CalendarEventOutcome.MISMATCH, opportunityId: null };
  }
  const opportunityId = (byBooking ?? byReference)?.id;
  if (opportunityId === undefined)
    return { outcome: CalendarEventOutcome.UNMATCHED, opportunityId: null };
  const result = (outcome: CalendarEventOutcome): Applied => ({ outcome, opportunityId });

  // Lock order everywhere: membership, then opportunity.
  const members = await tx.$queryRaw<
    { id: string; status: CampaignLeadStatus; phone: string; email: string | null }[]
  >`
    SELECT cl."id", cl."status", l."phone", l."email"
    FROM "CampaignLead" cl JOIN "Lead" l ON l."id" = cl."leadId"
    WHERE cl."id" = (SELECT "campaignLeadId" FROM "BookingOpportunity" WHERE "id" = ${opportunityId}::uuid)
    FOR UPDATE OF cl`;
  const opportunities = await tx.$queryRaw<
    {
      status: BookingStatus;
      calendarProvider: string;
      externalBookingId: string | null;
      appointmentStartAt: Date | null;
      appointmentEndAt: Date | null;
      appointmentTimezone: string | null;
    }[]
  >`
    SELECT "status", "calendarProvider", "externalBookingId", "appointmentStartAt",
           "appointmentEndAt", "appointmentTimezone"
    FROM "BookingOpportunity" WHERE "id" = ${opportunityId}::uuid FOR UPDATE`;
  const member = members[0];
  const opportunity = opportunities[0];
  if (member === undefined || opportunity === undefined)
    return result(CalendarEventOutcome.UNMATCHED);

  if (opportunity.calendarProvider !== providerName || !inviteeMatches(event, member)) {
    return result(CalendarEventOutcome.MISMATCH);
  }

  switch (event.kind) {
    case 'BOOKING_CREATED': {
      if (opportunity.status === BookingStatus.CONFIRMED) {
        return result(
          opportunity.externalBookingId === event.externalBookingId
            ? CalendarEventOutcome.ALREADY_APPLIED
            : CalendarEventOutcome.INVALID_STATE,
        );
      }
      if (
        opportunity.status !== BookingStatus.OFFERED ||
        member.status !== CampaignLeadStatus.QUALIFIED
      ) {
        return result(CalendarEventOutcome.INVALID_STATE);
      }
      await tx.bookingOpportunity.update({
        where: { id: opportunityId },
        data: {
          status: BookingStatus.CONFIRMED,
          externalBookingId: event.externalBookingId,
          appointmentStartAt: event.startAt,
          appointmentEndAt: event.endAt,
          appointmentTimezone: event.timezone,
          confirmedAt: now,
        },
      });
      await transitionCampaignLead(
        tx,
        {
          campaignLeadId: member.id,
          from: CampaignLeadStatus.QUALIFIED,
          to: CampaignLeadStatus.BOOKED,
        },
        now,
      );
      return result(CalendarEventOutcome.PROCESSED);
    }

    case 'BOOKING_RESCHEDULED': {
      if (opportunity.status !== BookingStatus.CONFIRMED)
        return result(CalendarEventOutcome.INVALID_STATE);
      const current = opportunity.externalBookingId;
      if (current !== event.externalBookingId && current !== event.previousExternalBookingId) {
        return result(CalendarEventOutcome.INVALID_STATE);
      }
      if (
        current === event.externalBookingId &&
        opportunity.appointmentStartAt?.getTime() === event.startAt?.getTime() &&
        (opportunity.appointmentEndAt?.getTime() ?? null) === (event.endAt?.getTime() ?? null) &&
        opportunity.appointmentTimezone === event.timezone
      ) {
        return result(CalendarEventOutcome.ALREADY_APPLIED);
      }
      await tx.bookingOpportunity.update({
        where: { id: opportunityId },
        data: {
          externalBookingId: event.externalBookingId,
          appointmentStartAt: event.startAt,
          appointmentEndAt: event.endAt,
          appointmentTimezone: event.timezone,
        },
      });
      return result(CalendarEventOutcome.PROCESSED);
    }

    case 'BOOKING_CANCELLED': {
      if (opportunity.externalBookingId !== event.externalBookingId) {
        return result(CalendarEventOutcome.INVALID_STATE);
      }
      if (opportunity.status === BookingStatus.CANCELLED)
        return result(CalendarEventOutcome.ALREADY_APPLIED);
      if (opportunity.status !== BookingStatus.CONFIRMED)
        return result(CalendarEventOutcome.INVALID_STATE);
      await tx.bookingOpportunity.update({
        where: { id: opportunityId },
        data: { status: BookingStatus.CANCELLED, cancelledAt: now },
      });
      if (member.status === CampaignLeadStatus.BOOKED) {
        await transitionCampaignLead(
          tx,
          {
            campaignLeadId: member.id,
            from: CampaignLeadStatus.BOOKED,
            to: CampaignLeadStatus.QUALIFIED,
          },
          now,
        );
      }
      return result(CalendarEventOutcome.PROCESSED);
    }
  }
}

/** Invitee identity, when the provider supplies one, must be this lead's. */
function inviteeMatches(event: ValidEvent, lead: { phone: string; email: string | null }): boolean {
  if (event.inviteePhone !== null) {
    const phone = normalizePhone(event.inviteePhone);
    return phone.ok && phone.e164 === lead.phone;
  }
  if (event.inviteeEmail !== null && lead.email !== null) {
    const email = normalizeEmail(event.inviteeEmail);
    return email.ok && email.email === lead.email;
  }
  return true;
}
