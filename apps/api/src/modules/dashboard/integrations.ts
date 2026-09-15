import {
  INTEGRATION_DELIVERY_STATUSES,
  type IntegrationDestination,
  type IntegrationHealth,
  type IntegrationHealthResponse,
  type IntegrationHealthState,
} from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import { IntegrationDeliveryStatus } from '../../generated/prisma/enums.js';
import { leadName } from './metrics.js';

/** Which providers this process has adapters for (never credentials). */
export interface IntegrationAvailability {
  crm: boolean;
  notifications: boolean;
  handoff: boolean;
  calendar: boolean;
}

/**
 * Delivery health per destination. "Not configured" (no adapter; rows are
 * BLOCKED with NOT_CONFIGURED and nothing was sent) is reported separately
 * from "configured but failing" (FAILED or RETRY rows). BLOCKED is never
 * counted as success.
 */
export async function getIntegrationHealth(
  db: DbClient,
  availability: IntegrationAvailability,
  problemLimit: number,
): Promise<IntegrationHealthResponse> {
  const [grouped, calendarEvents, problems] = await Promise.all([
    db.integrationDelivery.groupBy({ by: ['destination', 'status'], _count: { _all: true } }),
    db.calendarWebhookEvent.groupBy({ by: ['outcome'], _count: { _all: true } }),
    db.integrationDelivery.findMany({
      where: {
        status: {
          in: [
            IntegrationDeliveryStatus.FAILED,
            IntegrationDeliveryStatus.RETRY,
            IntegrationDeliveryStatus.BLOCKED,
          ],
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: problemLimit,
      select: {
        id: true,
        destination: true,
        eventType: true,
        status: true,
        attempts: true,
        lastErrorCode: true,
        updatedAt: true,
        campaignLead: {
          select: { leadId: true, lead: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
  ]);

  const destinations: [IntegrationDestination, boolean][] = [
    ['CRM', availability.crm],
    ['OWNER_NOTIFICATION', availability.notifications],
    ['POST_BOOKING_HANDOFF', availability.handoff],
  ];
  const integrations: IntegrationHealth[] = destinations.map(([key, configured]) => {
    const counts: Record<string, number> = Object.fromEntries(
      INTEGRATION_DELIVERY_STATUSES.map((status) => [status, 0]),
    );
    for (const row of grouped) {
      if (row.destination === key) counts[row.status] = row._count._all;
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const failing = (counts.FAILED ?? 0) + (counts.RETRY ?? 0) > 0;
    const state: IntegrationHealthState = !configured
      ? 'NOT_CONFIGURED'
      : failing
        ? 'FAILING'
        : total === 0
          ? 'IDLE'
          : 'HEALTHY';
    return { key, configured, state, counts };
  });

  const calendarCounts: Record<string, number> = Object.fromEntries(
    calendarEvents.map((row) => [row.outcome, row._count._all]),
  );
  integrations.push({
    key: 'CALENDAR',
    configured: availability.calendar,
    state: !availability.calendar
      ? 'NOT_CONFIGURED'
      : calendarEvents.length === 0
        ? 'IDLE'
        : 'HEALTHY',
    counts: calendarCounts,
  });

  return {
    integrations,
    problems: problems.map((row) => ({
      id: row.id,
      destination: row.destination,
      eventType: row.eventType,
      status: row.status,
      attempts: row.attempts,
      lastErrorCode: row.lastErrorCode,
      updatedAt: row.updatedAt.toISOString(),
      leadId: row.campaignLead.leadId,
      leadName: leadName(row.campaignLead.lead.firstName, row.campaignLead.lead.lastName),
    })),
  };
}
