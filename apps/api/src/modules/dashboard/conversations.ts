import type {
  CampaignLeadStatus,
  ConversationDetail,
  ConversationFilter,
  ConversationListItem,
  EscalationReason,
  LeadDetail,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
  Page,
  ReviewItem,
} from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ReplyProcessingStatus } from '../../generated/prisma/enums.js';
import { NotFoundError } from '../../lib/errors.js';
import { automationState } from '../leads/takeover.js';
import { leadName } from './metrics.js';

export interface PageQuery {
  page: number;
  pageSize: number;
}

const PREVIEW_CHARS = 140;

function phoneLast4(phone: string): string {
  return phone.slice(-4);
}

/**
 * One row per lead with messages, ordered by latest message (newest first,
 * lead id as tiebreak). Campaign context is the membership of the latest
 * message, else the lead's most recently changed membership.
 *
 * ponytail: DISTINCT ON scans every message of the matched leads per page;
 * fine at single-business volume. A denormalized Lead.lastMessageAt is the
 * upgrade path if the Message table grows past a few million rows.
 */
export async function listConversations(
  db: DbClient,
  query: PageQuery & { campaignId?: string | undefined; filter: ConversationFilter },
): Promise<Page<ConversationListItem>> {
  const inCampaign = (alias: string) =>
    query.campaignId === undefined
      ? Prisma.empty
      : Prisma.sql`AND ${Prisma.raw(alias)}."campaignId" = ${query.campaignId}::uuid`;
  const openReview = Prisma.sql`EXISTS (SELECT 1 FROM "ReplyProcessing" r
    WHERE r."leadId" = latest."leadId" AND r."status" = 'ESCALATED')`;
  const filter =
    query.filter === 'takeover'
      ? Prisma.sql`WHERE l."automationPausedAt" IS NOT NULL`
      : query.filter === 'attention'
        ? Prisma.sql`WHERE l."automationPausedAt" IS NOT NULL OR ${openReview}`
        : Prisma.empty;

  const base = Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (m."leadId") m."id", m."leadId", m."direction", m."purpose", m."status",
             LEFT(m."body", ${PREVIEW_CHARS}) AS "preview", m."createdAt", m."campaignLeadId"
      FROM "Message" m
      WHERE m."leadId" IS NOT NULL ${inCampaign('m')}
      ORDER BY m."leadId", m."createdAt" DESC, m."id" DESC
    )
    SELECT latest.*, l."firstName", l."lastName", l."phone", l."automationPausedAt"
    FROM latest JOIN "Lead" l ON l."id" = latest."leadId"
    ${filter}`;

  const [counted, rows] = await Promise.all([
    db.$queryRaw<{ total: bigint }[]>`SELECT COUNT(*) AS "total" FROM (${base}) t`,
    db.$queryRaw<
      {
        leadId: string;
        direction: MessageDirection;
        purpose: MessagePurpose;
        status: MessageStatus;
        preview: string | null;
        createdAt: Date;
        firstName: string | null;
        lastName: string | null;
        phone: string;
        automationPausedAt: Date | null;
        membershipStatus: CampaignLeadStatus | null;
        campaignId: string | null;
        campaignName: string | null;
        openReviews: bigint;
      }[]
    >`
      SELECT t."leadId", t."direction", t."purpose", t."status", t."preview", t."createdAt",
             t."firstName", t."lastName", t."phone", t."automationPausedAt",
             cl."status" AS "membershipStatus", c."id" AS "campaignId", c."name" AS "campaignName",
             (SELECT COUNT(*) FROM "ReplyProcessing" r
               WHERE r."leadId" = t."leadId" AND r."status" = 'ESCALATED') AS "openReviews"
      FROM (${base}) t
      LEFT JOIN LATERAL (
        SELECT cl."status", cl."campaignId" FROM "CampaignLead" cl
        WHERE cl."leadId" = t."leadId" ${inCampaign('cl')}
        ORDER BY (cl."id" = t."campaignLeadId") DESC NULLS LAST, cl."statusChangedAt" DESC, cl."id" DESC
        LIMIT 1
      ) cl ON TRUE
      LEFT JOIN "Campaign" c ON c."id" = cl."campaignId"
      ORDER BY t."createdAt" DESC, t."leadId" DESC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
  ]);

  return {
    page: query.page,
    pageSize: query.pageSize,
    total: Number(counted[0]?.total ?? 0),
    items: rows.map((row) => ({
      leadId: row.leadId,
      leadName: leadName(row.firstName, row.lastName),
      phoneLast4: phoneLast4(row.phone),
      campaign:
        row.campaignId === null || row.campaignName === null
          ? null
          : { id: row.campaignId, name: row.campaignName },
      membershipStatus: row.membershipStatus,
      lastMessage: {
        direction: row.direction,
        purpose: row.purpose,
        status: row.status,
        preview: row.preview,
        at: row.createdAt.toISOString(),
      },
      openReviews: Number(row.openReviews),
      automation: automationState(row.automationPausedAt),
    })),
  };
}

/** The latest `limit` messages of one lead, returned oldest first. */
export async function getConversation(
  db: DbClient,
  leadId: string,
  limit: number,
): Promise<ConversationDetail> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, firstName: true, lastName: true, phone: true, automationPausedAt: true },
  });
  if (lead === null) throw new NotFoundError('Lead not found');

  const newest = await db.message.findMany({
    where: { leadId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      direction: true,
      purpose: true,
      status: true,
      body: true,
      createdAt: true,
      deliveredAt: true,
      errorCode: true,
      campaignId: true,
      // Validated, routed fields only: never AI request ids or model output.
      replyProcessing: {
        select: {
          status: true,
          classification: true,
          confidence: true,
          action: true,
          escalationReason: true,
        },
      },
      qualificationEvaluation: { select: { result: true, missingFields: true } },
      bookingOpportunity: { select: { status: true } },
    },
  });

  return {
    lead: {
      id: lead.id,
      name: leadName(lead.firstName, lead.lastName),
      phoneLast4: phoneLast4(lead.phone),
      automation: automationState(lead.automationPausedAt),
    },
    hasEarlier: newest.length > limit,
    messages: newest
      .slice(0, limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        direction: m.direction,
        purpose: m.purpose,
        status: m.status,
        body: m.body,
        at: m.createdAt.toISOString(),
        deliveredAt: m.deliveredAt?.toISOString() ?? null,
        errorCode: m.errorCode,
        campaignId: m.campaignId,
        reply: m.replyProcessing,
        qualification: m.qualificationEvaluation,
        booking: m.bookingOpportunity,
      })),
  };
}

/**
 * Unresolved human-review items: ESCALATED reply processing, newest first.
 * Reading never changes their status.
 */
export async function listReviews(
  db: DbClient,
  query: PageQuery & { campaignId?: string | undefined; reason?: EscalationReason | undefined },
): Promise<Page<ReviewItem>> {
  const where: Prisma.ReplyProcessingWhereInput = {
    status: ReplyProcessingStatus.ESCALATED,
    ...(query.reason === undefined ? {} : { escalationReason: query.reason }),
    ...(query.campaignId === undefined
      ? {}
      : { campaignLead: { is: { campaignId: query.campaignId } } }),
  };
  const [total, rows] = await Promise.all([
    db.replyProcessing.count({ where }),
    db.replyProcessing.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        escalationReason: true,
        classification: true,
        confidence: true,
        createdAt: true,
        inboundMessage: { select: { id: true, body: true, createdAt: true } },
        lead: {
          select: { id: true, firstName: true, lastName: true, automationPausedAt: true },
        },
        campaignLead: { select: { status: true, campaign: { select: { id: true, name: true } } } },
      },
    }),
  ]);

  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: rows.map((row) => ({
      processingId: row.id,
      leadId: row.lead?.id ?? null,
      leadName:
        row.lead === null ? 'Unknown sender' : leadName(row.lead.firstName, row.lead.lastName),
      campaign: row.campaignLead?.campaign ?? null,
      membershipStatus: row.campaignLead?.status ?? null,
      inbound: {
        id: row.inboundMessage.id,
        body: row.inboundMessage.body,
        at: row.inboundMessage.createdAt.toISOString(),
      },
      escalationReason: row.escalationReason,
      classification: row.classification,
      confidence: row.confidence,
      createdAt: row.createdAt.toISOString(),
      automation: row.lead === null ? null : automationState(row.lead.automationPausedAt),
    })),
  };
}

export async function getLeadDetail(
  db: DbClient,
  leadId: string,
  limit: number,
): Promise<LeadDetail> {
  const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      status: true,
      source: true,
      externalId: true,
      timezone: true,
      createdAt: true,
      automationPausedAt: true,
      firstImportBatch: { select: { id: true, sourceLabel: true, startedAt: true } },
      campaignMemberships: {
        orderBy: newestFirst,
        take: limit,
        select: {
          id: true,
          status: true,
          statusChangedAt: true,
          createdAt: true,
          campaign: { select: { id: true, name: true, status: true } },
          qualificationFacts: {
            orderBy: { field: 'asc' },
            select: { field: true, value: true, source: true, observedAt: true },
          },
          qualificationEvaluations: {
            orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: {
              result: true,
              missingFields: true,
              nextField: true,
              extraction: true,
              evaluatedAt: true,
            },
          },
          bookingOpportunities: {
            orderBy: newestFirst,
            take: limit,
            select: {
              id: true,
              status: true,
              appointmentStartAt: true,
              appointmentEndAt: true,
              appointmentTimezone: true,
              sentAt: true,
              confirmedAt: true,
              cancelledAt: true,
            },
          },
          integrationDeliveries: {
            orderBy: newestFirst,
            take: limit,
            select: {
              id: true,
              destination: true,
              eventType: true,
              status: true,
              attempts: true,
              lastErrorCode: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });
  if (lead === null) throw new NotFoundError('Lead not found');

  const suppression = await db.suppressionEntry.findMany({
    where: {
      OR: [{ phone: lead.phone }, ...(lead.email === null ? [] : [{ email: lead.email }])],
    },
    orderBy: newestFirst,
    take: limit,
    select: { reason: true, source: true, createdAt: true },
  });

  const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
  return {
    id: lead.id,
    name: leadName(lead.firstName, lead.lastName),
    phone: lead.phone,
    email: lead.email,
    status: lead.status,
    source: lead.source,
    externalId: lead.externalId,
    timezone: lead.timezone,
    createdAt: lead.createdAt.toISOString(),
    importBatch:
      lead.firstImportBatch === null
        ? null
        : { ...lead.firstImportBatch, startedAt: lead.firstImportBatch.startedAt.toISOString() },
    suppression: suppression.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
    automation: automationState(lead.automationPausedAt),
    memberships: lead.campaignMemberships.map((member) => {
      const evaluation = member.qualificationEvaluations[0];
      return {
        id: member.id,
        campaign: member.campaign,
        status: member.status,
        statusChangedAt: member.statusChangedAt.toISOString(),
        createdAt: member.createdAt.toISOString(),
        facts: member.qualificationFacts.map((fact) => ({
          field: fact.field,
          value:
            typeof fact.value === 'string' ||
            typeof fact.value === 'number' ||
            typeof fact.value === 'boolean'
              ? fact.value
              : null,
          source: fact.source,
          observedAt: fact.observedAt.toISOString(),
        })),
        latestEvaluation:
          evaluation === undefined
            ? null
            : { ...evaluation, evaluatedAt: evaluation.evaluatedAt.toISOString() },
        bookings: member.bookingOpportunities.map((booking) => ({
          id: booking.id,
          status: booking.status,
          appointmentStartAt: iso(booking.appointmentStartAt),
          appointmentEndAt: iso(booking.appointmentEndAt),
          appointmentTimezone: booking.appointmentTimezone,
          linkSentAt: iso(booking.sentAt),
          confirmedAt: iso(booking.confirmedAt),
          cancelledAt: iso(booking.cancelledAt),
        })),
        deliveries: member.integrationDeliveries.map((delivery) => ({
          ...delivery,
          createdAt: delivery.createdAt.toISOString(),
          updatedAt: delivery.updatedAt.toISOString(),
        })),
      };
    }),
  };
}
