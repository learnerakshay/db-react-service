import type { AppConfig } from '../../config/index.js';
import type { Database, DbClient } from '../../db/client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  IntegrationDeliveryStatus,
  IntegrationDestination,
  IntegrationEventType,
} from '../../generated/prisma/enums.js';
import type { Logger } from '../../lib/logger.js';
import type { CrmBookingSync } from '../../providers/crm/index.js';
import type { PostBookingHandoff } from '../../providers/handoff/index.js';
import type { IntegrationProviders } from '../../providers/integrations.js';
import type { OwnerNotification } from '../../providers/notifications/index.js';

/** Which external side effects each booking event produces. */
export const DESTINATIONS_BY_EVENT: Readonly<
  Record<IntegrationEventType, readonly IntegrationDestination[]>
> = {
  // Conversion: CRM "Reactivated" sync, owner alert, Service 3 enrollment.
  BOOKING_CONFIRMED: [
    IntegrationDestination.CRM,
    IntegrationDestination.OWNER_NOTIFICATION,
    IntegrationDestination.POST_BOOKING_HANDOFF,
  ],
  // Same booking, new time: no CRM sync, so no second conversion is recorded.
  BOOKING_RESCHEDULED: [
    IntegrationDestination.OWNER_NOTIFICATION,
    IntegrationDestination.POST_BOOKING_HANDOFF,
  ],
  BOOKING_CANCELLED: [
    IntegrationDestination.CRM,
    IntegrationDestination.OWNER_NOTIFICATION,
    IntegrationDestination.POST_BOOKING_HANDOFF,
  ],
};

export const REACTIVATED_TAG = 'Reactivated';

/**
 * One logical action per key. Confirmation and cancellation happen once per
 * booking opportunity; each verified reschedule event is its own action.
 */
export function deliveryKey(
  sourceId: string,
  eventType: IntegrationEventType,
  destination: IntegrationDestination,
): string {
  return `${sourceId}:${eventType}:${destination}`;
}

/**
 * Write the outbox rows for one applied booking event in the caller's booking
 * transaction. Duplicate calls add nothing (UNIQUE idempotencyKey). No external
 * call happens here, so delivery problems can never roll back a booking.
 */
export async function enqueueBookingDeliveries(
  tx: DbClient,
  input: {
    eventType: IntegrationEventType;
    bookingOpportunityId: string;
    calendarEventId: string;
    now: Date;
  },
): Promise<number> {
  const opportunity = await tx.bookingOpportunity.findUniqueOrThrow({
    where: { id: input.bookingOpportunityId },
    select: {
      id: true,
      bookingReference: true,
      externalBookingId: true,
      appointmentStartAt: true,
      appointmentEndAt: true,
      appointmentTimezone: true,
      campaignLead: {
        select: {
          id: true,
          campaign: { select: { id: true, name: true } },
          lead: {
            select: {
              id: true,
              phone: true,
              email: true,
              firstName: true,
              lastName: true,
              externalId: true,
              timezone: true,
            },
          },
        },
      },
    },
  });
  const { lead, campaign } = opportunity.campaignLead;
  const sourceId =
    input.eventType === IntegrationEventType.BOOKING_RESCHEDULED
      ? input.calendarEventId
      : opportunity.id;
  const startAt = opportunity.appointmentStartAt?.toISOString() ?? null;

  const payloadFor = (destination: IntegrationDestination, idempotencyKey: string) => {
    switch (destination) {
      case IntegrationDestination.CRM: {
        const payload: CrmBookingSync = {
          idempotencyKey,
          event:
            input.eventType === IntegrationEventType.BOOKING_CANCELLED
              ? 'BOOKING_CANCELLED'
              : 'BOOKING_CONFIRMED',
          contact: {
            phone: lead.phone,
            email: lead.email,
            firstName: lead.firstName,
            lastName: lead.lastName,
            leadReference: lead.id,
            sourceExternalId: lead.externalId,
          },
          tags: [REACTIVATED_TAG],
          campaign,
          booking: {
            reference: opportunity.bookingReference,
            externalBookingId: opportunity.externalBookingId,
            startAt,
            timezone: opportunity.appointmentTimezone,
          },
        };
        return payload;
      }
      case IntegrationDestination.OWNER_NOTIFICATION: {
        const payload: OwnerNotification = {
          idempotencyKey,
          ...ownerNotificationText(input.eventType, {
            leadName: displayName(lead.firstName, lead.lastName),
            campaignName: campaign.name,
            startAt: opportunity.appointmentStartAt,
            timezone: opportunity.appointmentTimezone,
            leadReference: lead.id,
            bookingReference: opportunity.bookingReference,
          }),
        };
        return payload;
      }
      case IntegrationDestination.POST_BOOKING_HANDOFF: {
        const payload: PostBookingHandoff = {
          idempotencyKey,
          event: input.eventType,
          bookingReference: opportunity.bookingReference,
          lead: {
            reference: lead.id,
            phone: lead.phone,
            firstName: lead.firstName,
            timezone: lead.timezone,
          },
          campaign,
          appointment: {
            startAt,
            endAt: opportunity.appointmentEndAt?.toISOString() ?? null,
            timezone: opportunity.appointmentTimezone,
          },
        };
        return payload;
      }
    }
  };

  const { count } = await tx.integrationDelivery.createMany({
    data: DESTINATIONS_BY_EVENT[input.eventType].map((destination) => {
      const idempotencyKey = deliveryKey(sourceId, input.eventType, destination);
      return {
        idempotencyKey,
        eventType: input.eventType,
        destination,
        campaignLeadId: opportunity.campaignLead.id,
        bookingOpportunityId: opportunity.id,
        calendarEventId: input.calendarEventId,
        // Contract interfaces hold only JSON-safe values (strings, numbers, null, arrays).
        payload: payloadFor(destination, idempotencyKey) as unknown as Prisma.InputJsonObject,
        status: IntegrationDeliveryStatus.PENDING,
        nextAttemptAt: input.now,
      };
    }),
    skipDuplicates: true,
  });
  return count;
}

const SUBJECTS: Readonly<Record<IntegrationEventType, string>> = {
  BOOKING_CONFIRMED: 'New booking',
  BOOKING_RESCHEDULED: 'Booking rescheduled',
  BOOKING_CANCELLED: 'Booking cancelled',
};

/** Operational facts only: no phone number, email or message content. */
export function ownerNotificationText(
  eventType: IntegrationEventType,
  details: {
    leadName: string;
    campaignName: string;
    startAt: Date | null;
    timezone: string | null;
    leadReference: string;
    bookingReference: string;
  },
): { subject: string; body: string } {
  const when =
    details.startAt === null || details.timezone === null
      ? 'not provided'
      : `${new Intl.DateTimeFormat('en-US', {
          timeZone: details.timezone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(details.startAt)} (${details.timezone})`;
  return {
    subject: `${SUBJECTS[eventType]}: ${details.leadName}`,
    body: [
      `Lead: ${details.leadName}`,
      `Campaign: ${details.campaignName}`,
      `Appointment: ${when}`,
      `Lead reference: ${details.leadReference}`,
      `Booking reference: ${details.bookingReference}`,
    ].join('\n'),
  };
}

function displayName(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName]
    .map((part) => (part ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim())
    .filter((part) => part !== '')
    .join(' ')
    .slice(0, 80);
  return name === '' ? 'Unnamed lead' : name;
}

// ---------------------------------------------------------------------------
// Delivery processing
// ---------------------------------------------------------------------------

export interface DeliveryDependencies {
  db: Database;
  logger: Logger;
  providers: IntegrationProviders;
  operations: AppConfig['operations'];
}

export type DeliveryOutcome =
  | 'COMPLETED'
  | 'RETRY'
  | 'FAILED'
  | 'BLOCKED'
  | 'ALREADY_FINAL'
  | 'IN_FLIGHT'
  | 'NOT_DUE'
  | 'NOT_FOUND';

type Normalized =
  | { ok: true; externalReference: string | null }
  | { ok: false; retryable: boolean; errorCode: string };

type Claim =
  | { kind: 'done'; outcome: DeliveryOutcome }
  | {
      kind: 'claimed';
      attempts: number;
      destination: IntegrationDestination;
      payload: unknown;
      call: () => Promise<Normalized>;
      provider: string;
    };

const FINAL: readonly IntegrationDeliveryStatus[] = [
  IntegrationDeliveryStatus.COMPLETED,
  IntegrationDeliveryStatus.FAILED,
  IntegrationDeliveryStatus.BLOCKED,
];

/**
 * Deliver one outbox row, at most one provider call per claim.
 *
 *  1. Claim (transaction, row FOR UPDATE): final → no-op; live PROCESSING →
 *     stop; not yet due → stop; no provider for the destination → BLOCKED
 *     (NOT_CONFIGURED; nothing sent); attempts exhausted → FAILED; else
 *     PROCESSING with attempts + 1. A stale PROCESSING claim (crash) is reclaimed.
 *  2. Provider call outside any transaction, with the row's idempotency key so
 *     a reclaimed or retried attempt does not duplicate the external action.
 *  3. Record for this attempt only: COMPLETED, RETRY with exponential backoff
 *     (transient), or FAILED (permanent / attempts exhausted) for intervention.
 * Booking and membership state are never touched here.
 */
export async function processIntegrationDelivery(
  deps: DeliveryDependencies,
  deliveryId: string,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  const { operations } = deps;
  const claim = await deps.db.$transaction(
    async (tx): Promise<Claim> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "IntegrationDelivery" WHERE "id" = ${deliveryId}::uuid FOR UPDATE`;
      if (locked.length === 0) return { kind: 'done', outcome: 'NOT_FOUND' };
      const row = await tx.integrationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });

      if (FINAL.includes(row.status)) return { kind: 'done', outcome: 'ALREADY_FINAL' };
      if (row.status === IntegrationDeliveryStatus.PROCESSING) {
        const claimedAt = row.claimedAt?.getTime() ?? 0;
        if (now.getTime() - claimedAt <= operations.deliveryProcessingStaleAfterMs) {
          return { kind: 'done', outcome: 'IN_FLIGHT' };
        }
      } else if (row.nextAttemptAt.getTime() > now.getTime()) {
        return { kind: 'done', outcome: 'NOT_DUE' };
      }

      const target = resolveCall(deps.providers, row.destination, row.payload);
      if (target === null) {
        await tx.integrationDelivery.update({
          where: { id: row.id },
          data: {
            status: IntegrationDeliveryStatus.BLOCKED,
            lastErrorCode: 'NOT_CONFIGURED',
            claimedAt: null,
          },
        });
        return { kind: 'done', outcome: 'BLOCKED' };
      }
      if (row.attempts >= operations.deliveryMaxAttempts) {
        await tx.integrationDelivery.update({
          where: { id: row.id },
          data: { status: IntegrationDeliveryStatus.FAILED, lastErrorCode: 'MAX_ATTEMPTS' },
        });
        return { kind: 'done', outcome: 'FAILED' };
      }

      const attempts = row.attempts + 1;
      await tx.integrationDelivery.update({
        where: { id: row.id },
        data: {
          status: IntegrationDeliveryStatus.PROCESSING,
          attempts,
          claimedAt: now,
          provider: target.provider,
        },
      });
      return {
        kind: 'claimed',
        attempts,
        destination: row.destination,
        payload: row.payload,
        call: target.call,
        provider: target.provider,
      };
    },
    { timeout: operations.transactionTimeoutMs, maxWait: operations.transactionTimeoutMs },
  );
  if (claim.kind === 'done') return claim.outcome;

  let result: Normalized;
  try {
    result = await claim.call();
  } catch (err) {
    deps.logger.error(
      {
        err,
        operation: 'integrations.deliver',
        deliveryId,
        provider: claim.provider,
        destination: claim.destination,
      },
      'integration adapter threw; treating as transient failure',
    );
    result = { ok: false, retryable: true, errorCode: 'ADAPTER_ERROR' };
  }

  let outcome: DeliveryOutcome;
  let data;
  if (result.ok) {
    outcome = 'COMPLETED';
    data = {
      status: IntegrationDeliveryStatus.COMPLETED,
      externalReference: result.externalReference,
      lastErrorCode: null,
      completedAt: now,
    };
  } else if (result.retryable && claim.attempts < operations.deliveryMaxAttempts) {
    outcome = 'RETRY';
    const delayMs = operations.deliveryRetryBaseDelaySeconds * 1000 * 2 ** (claim.attempts - 1);
    data = {
      status: IntegrationDeliveryStatus.RETRY,
      lastErrorCode: result.errorCode,
      nextAttemptAt: new Date(now.getTime() + delayMs),
    };
  } else {
    outcome = 'FAILED';
    data = { status: IntegrationDeliveryStatus.FAILED, lastErrorCode: result.errorCode };
  }

  const { count } = await deps.db.integrationDelivery.updateMany({
    where: {
      id: deliveryId,
      status: IntegrationDeliveryStatus.PROCESSING,
      attempts: claim.attempts,
    },
    data,
  });
  if (count === 0) return 'IN_FLIGHT';
  const log =
    outcome === 'COMPLETED'
      ? deps.logger.info.bind(deps.logger)
      : deps.logger.warn.bind(deps.logger);
  log(
    {
      operation: 'integrations.deliver',
      deliveryId,
      provider: claim.provider,
      destination: claim.destination,
      status: outcome,
      errorCode: result.ok ? null : result.errorCode,
      attempt: claim.attempts,
    },
    'integration delivery attempt recorded',
  );
  return outcome;
}

function resolveCall(
  providers: IntegrationProviders,
  destination: IntegrationDestination,
  payload: unknown,
): { provider: string; call: () => Promise<Normalized> } | null {
  switch (destination) {
    case IntegrationDestination.CRM: {
      const crm = providers.crm;
      if (crm === undefined) return null;
      return {
        provider: crm.name,
        call: async () => {
          const result = await crm.syncBooking(payload as CrmBookingSync);
          return result.outcome === 'SYNCED'
            ? { ok: true, externalReference: result.externalContactId }
            : { ok: false, retryable: result.retryable, errorCode: result.errorCode };
        },
      };
    }
    case IntegrationDestination.OWNER_NOTIFICATION: {
      const notifications = providers.notifications;
      if (notifications === undefined) return null;
      return {
        provider: notifications.name,
        call: async () => {
          const result = await notifications.notify(payload as OwnerNotification);
          return result.outcome === 'DELIVERED'
            ? { ok: true, externalReference: result.externalReference }
            : { ok: false, retryable: result.retryable, errorCode: result.errorCode };
        },
      };
    }
    case IntegrationDestination.POST_BOOKING_HANDOFF: {
      const handoff = providers.handoff;
      if (handoff === undefined) return null;
      return {
        provider: handoff.name,
        call: async () => {
          const result = await handoff.deliver(payload as PostBookingHandoff);
          return result.outcome === 'ACCEPTED'
            ? { ok: true, externalReference: result.externalReference }
            : { ok: false, retryable: result.retryable, errorCode: result.errorCode };
        },
      };
    }
  }
}

/** Due deliveries (PENDING/RETRY past nextAttemptAt, or stale PROCESSING), oldest first. */
export async function findDueDeliveries(
  db: DbClient,
  now: Date,
  staleAfterMs: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.integrationDelivery.findMany({
    where: {
      OR: [
        {
          status: { in: [IntegrationDeliveryStatus.PENDING, IntegrationDeliveryStatus.RETRY] },
          nextAttemptAt: { lte: now },
        },
        {
          status: IntegrationDeliveryStatus.PROCESSING,
          claimedAt: { lt: new Date(now.getTime() - staleAfterMs) },
        },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
