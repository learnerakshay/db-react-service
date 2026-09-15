import {
  CAMPAIGN_LEAD_STATUSES,
  type ActivityItem,
  type CampaignLeadStatus,
  type CampaignMetrics,
  type OverviewMetrics,
} from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import { Prisma, type Campaign } from '../../generated/prisma/client.js';
import {
  type CampaignStatus,
  IntegrationDeliveryStatus,
  QualificationResult,
} from '../../generated/prisma/enums.js';
import { CAPACITY_WINDOW_MS } from '../dispatch/admission.js';

/**
 * Authoritative Mission Control metric definitions (docs/mission-control.md).
 * Every figure is a read of database state; nothing here writes.
 *
 * "Accepted" outbound = status ACCEPTED, SENT or DELIVERED: the provider took
 * the message. PENDING/SENDING (not sent), FAILED, CANCELLED and UNCERTAIN
 * (outcome unknown) are never counted as sent.
 */
const ACCEPTED_OUTBOUND = Prisma.sql`m."direction" = 'OUTBOUND' AND m."status" IN ('ACCEPTED', 'SENT', 'DELIVERED')`;

/** Reached QUALIFIED: currently QUALIFIED/BOOKED, or a QUALIFIED evaluation on record. */
const REACHED_QUALIFIED = Prisma.sql`(
  cl."status" IN ('QUALIFIED', 'BOOKED')
  OR EXISTS (SELECT 1 FROM "QualificationEvaluation" e
             WHERE e."campaignLeadId" = cl."id" AND e."result" = 'QUALIFIED'))`;

type Count = bigint | number;

export function leadName(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
  return name === '' ? 'Unnamed lead' : name;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export async function getOverviewMetrics(
  db: DbClient,
  confidenceThreshold: number,
): Promise<OverviewMetrics> {
  const rows = await db.$queryRaw<Record<keyof OverviewMetrics, Count>[]>`
    WITH first_contact AS (
      SELECT m."leadId", MIN(COALESCE(m."acceptedAt", m."createdAt")) AS "at"
      FROM "Message" m
      WHERE ${ACCEPTED_OUTBOUND} AND m."leadId" IS NOT NULL
      GROUP BY m."leadId"
    )
    SELECT
      (SELECT COUNT(*) FROM "Lead") AS "totalIngested",
      (SELECT COUNT(*) FROM "Message" m WHERE ${ACCEPTED_OUTBOUND}) AS "outboundSent",
      (SELECT COUNT(*) FROM first_contact) AS "contactedLeads",
      (SELECT COUNT(*) FROM first_contact fc WHERE EXISTS (
        SELECT 1 FROM "Message" i
        WHERE i."leadId" = fc."leadId" AND i."direction" = 'INBOUND' AND i."createdAt" > fc."at"
      )) AS "repliedLeads",
      (SELECT COUNT(DISTINCT r."leadId") FROM "ReplyProcessing" r
        WHERE r."classification" = 'POSITIVE_INTEREST'
          AND r."confidence" >= ${confidenceThreshold}) AS "positiveIntentLeads",
      (SELECT COUNT(*) FROM "CampaignLead" cl WHERE ${REACHED_QUALIFIED}) AS "qualified",
      (SELECT COUNT(*) FROM "BookingOpportunity" b
        WHERE b."status" = 'CONFIRMED' AND b."confirmedAt" IS NOT NULL) AS "booked",
      (SELECT COUNT(*) FROM "Campaign" WHERE "status" = 'ACTIVE') AS "activeCampaigns",
      (SELECT COUNT(*) FROM "ReplyProcessing" WHERE "status" = 'ESCALATED') AS "openReviews",
      (SELECT COUNT(*) FROM first_contact fc WHERE EXISTS (
        SELECT 1 FROM "CampaignLead" cl WHERE cl."leadId" = fc."leadId" AND cl."status" = 'OPTED_OUT'
      )) AS "optedOutLeads"`;
  const row = rows[0];
  if (row === undefined) throw new Error('metrics query returned no row');
  const n = (key: keyof OverviewMetrics): number => Number(row[key]);

  return {
    totalIngested: n('totalIngested'),
    outboundSent: n('outboundSent'),
    contactedLeads: n('contactedLeads'),
    repliedLeads: n('repliedLeads'),
    replyRate: ratio(n('repliedLeads'), n('contactedLeads')),
    positiveIntentLeads: n('positiveIntentLeads'),
    qualified: n('qualified'),
    booked: n('booked'),
    activeCampaigns: n('activeCampaigns'),
    openReviews: n('openReviews'),
    optedOutLeads: n('optedOutLeads'),
    optOutRate: ratio(n('optedOutLeads'), n('contactedLeads')),
  };
}

/** One page of campaigns, newest first (id as tiebreak). */
export async function listCampaigns(
  db: DbClient,
  query: { page: number; pageSize: number; status?: CampaignStatus | undefined },
): Promise<{ campaigns: Campaign[]; total: number }> {
  const where = query.status === undefined ? {} : { status: query.status };
  const [total, campaigns] = await Promise.all([
    db.campaign.count({ where }),
    db.campaign.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return { campaigns, total };
}

export interface CampaignMetricsRow extends CampaignMetrics {
  admittedLastHour: number;
  lastActivityAt: Date | null;
}

/** Metrics for a bounded set of campaigns (one page) in two queries. */
export async function getCampaignMetrics(
  db: DbClient,
  campaignIds: readonly string[],
  now: Date,
): Promise<Map<string, CampaignMetricsRow>> {
  const result = new Map<string, CampaignMetricsRow>();
  if (campaignIds.length === 0) return result;
  const ids = [...campaignIds];
  const windowStart = new Date(now.getTime() - CAPACITY_WINDOW_MS);

  const [grouped, rows] = await Promise.all([
    db.campaignLead.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    db.$queryRaw<
      {
        id: string;
        step1Sent: Count;
        outboundSent: Count;
        repliedLeads: Count;
        qualified: Count;
        booked: Count;
        admittedLastHour: Count;
        lastActivityAt: Date | null;
      }[]
    >`
      SELECT c."id",
        (SELECT COUNT(*) FROM "Message" m
          WHERE m."campaignId" = c."id" AND ${ACCEPTED_OUTBOUND}
            AND m."purpose" = 'CAMPAIGN_STEP_1') AS "step1Sent",
        (SELECT COUNT(*) FROM "Message" m
          WHERE m."campaignId" = c."id" AND ${ACCEPTED_OUTBOUND}) AS "outboundSent",
        (SELECT COUNT(DISTINCT m."leadId") FROM "Message" m
          WHERE m."campaignId" = c."id" AND m."direction" = 'INBOUND') AS "repliedLeads",
        (SELECT COUNT(*) FROM "CampaignLead" cl
          WHERE cl."campaignId" = c."id" AND ${REACHED_QUALIFIED}) AS "qualified",
        (SELECT COUNT(*) FROM "BookingOpportunity" b
          JOIN "CampaignLead" cl ON cl."id" = b."campaignLeadId"
          WHERE cl."campaignId" = c."id" AND b."status" = 'CONFIRMED'
            AND b."confirmedAt" IS NOT NULL) AS "booked",
        (SELECT COUNT(*) FROM "DispatchAdmission" a
          WHERE a."campaignId" = c."id" AND a."admittedAt" > ${windowStart}) AS "admittedLastHour",
        (SELECT MAX(m."createdAt") FROM "Message" m WHERE m."campaignId" = c."id") AS "lastActivityAt"
      FROM "Campaign" c
      WHERE c."id" = ANY(${ids}::uuid[])`,
  ]);

  for (const row of rows) {
    const members = Object.fromEntries(
      CAMPAIGN_LEAD_STATUSES.map((status) => [status, 0]),
    ) as Record<CampaignLeadStatus, number>;
    result.set(row.id, {
      members,
      enrolled: 0,
      step1Sent: Number(row.step1Sent),
      outboundSent: Number(row.outboundSent),
      repliedLeads: Number(row.repliedLeads),
      qualified: Number(row.qualified),
      booked: Number(row.booked),
      admittedLastHour: Number(row.admittedLastHour),
      lastActivityAt: row.lastActivityAt,
    });
  }
  for (const group of grouped) {
    const metrics = result.get(group.campaignId);
    if (metrics === undefined) continue;
    metrics.members[group.status] = group._count._all;
    metrics.enrolled += group._count._all;
  }
  return result;
}

/**
 * Recent operational events for one campaign, newest first. Bounded: at most
 * `limit` rows are read per source. Details are identifiers and statuses,
 * never message bodies.
 */
export async function getCampaignActivity(
  db: DbClient,
  campaignId: string,
  limit: number,
): Promise<ActivityItem[]> {
  const name = { select: { firstName: true, lastName: true } } as const;
  const [messages, evaluations, bookings, optOuts, deliveries] = await Promise.all([
    db.message.findMany({
      where: { campaignId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        direction: true,
        purpose: true,
        status: true,
        createdAt: true,
        leadId: true,
        lead: name,
      },
    }),
    db.qualificationEvaluation.findMany({
      where: {
        campaignLead: { campaignId },
        result: { in: [QualificationResult.QUALIFIED, QualificationResult.NOT_QUALIFIED] },
      },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        result: true,
        evaluatedAt: true,
        campaignLead: { select: { leadId: true, lead: name } },
      },
    }),
    db.bookingOpportunity.findMany({
      where: { campaignLead: { campaignId }, confirmedAt: { not: null } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        status: true,
        confirmedAt: true,
        cancelledAt: true,
        campaignLead: { select: { leadId: true, lead: name } },
      },
    }),
    db.campaignLead.findMany({
      where: { campaignId, status: 'OPTED_OUT' },
      orderBy: [{ statusChangedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { statusChangedAt: true, leadId: true, lead: name },
    }),
    db.integrationDelivery.findMany({
      where: {
        campaignLead: { campaignId },
        status: {
          in: [
            IntegrationDeliveryStatus.FAILED,
            IntegrationDeliveryStatus.RETRY,
            IntegrationDeliveryStatus.BLOCKED,
          ],
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        destination: true,
        status: true,
        lastErrorCode: true,
        updatedAt: true,
        campaignLead: { select: { leadId: true, lead: name } },
      },
    }),
  ]);

  const items: (Omit<ActivityItem, 'at'> & { time: number })[] = [
    ...messages.map((m) => ({
      kind: m.direction,
      time: m.createdAt.getTime(),
      leadId: m.leadId,
      leadName: m.lead === null ? 'Unknown sender' : leadName(m.lead.firstName, m.lead.lastName),
      detail: `${m.purpose} · ${m.status}`,
    })),
    ...evaluations.map((e) => ({
      kind:
        e.result === QualificationResult.QUALIFIED
          ? ('QUALIFIED' as const)
          : ('NOT_QUALIFIED' as const),
      time: e.evaluatedAt.getTime(),
      leadId: e.campaignLead.leadId,
      leadName: leadName(e.campaignLead.lead.firstName, e.campaignLead.lead.lastName),
      detail: e.result,
    })),
    ...bookings.map((b) => ({
      kind: 'BOOKING' as const,
      time: (b.cancelledAt ?? b.confirmedAt ?? new Date(0)).getTime(),
      leadId: b.campaignLead.leadId,
      leadName: leadName(b.campaignLead.lead.firstName, b.campaignLead.lead.lastName),
      detail: b.status,
    })),
    ...optOuts.map((o) => ({
      kind: 'OPT_OUT' as const,
      time: o.statusChangedAt.getTime(),
      leadId: o.leadId,
      leadName: leadName(o.lead.firstName, o.lead.lastName),
      detail: 'OPTED_OUT',
    })),
    ...deliveries.map((d) => ({
      kind: 'INTEGRATION' as const,
      time: d.updatedAt.getTime(),
      leadId: d.campaignLead.leadId,
      leadName: leadName(d.campaignLead.lead.firstName, d.campaignLead.lead.lastName),
      detail: [d.destination, d.status, d.lastErrorCode]
        .filter((part) => part !== null)
        .join(' · '),
    })),
  ];

  return items
    .sort((a, b) => b.time - a.time)
    .slice(0, limit)
    .map(({ time, ...item }) => ({ ...item, at: new Date(time).toISOString() }));
}
