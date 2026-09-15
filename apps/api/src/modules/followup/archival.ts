import type { Database, DbClient } from '../../db/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CampaignLeadStatus } from '../../generated/prisma/enums.js';
import { transitionCampaignLead } from '../campaigns/membership.js';

/**
 * Memberships whose Step 2 closeout went out (STEP_2_SENT, or STEP_1_SENT with
 * an UNCERTAIN Step 2 that is never resent) at least `archiveDelayDays` ago,
 * with no inbound message from the lead since, no escalation awaiting a human
 * and no booking opportunity. The Step 2 reference time is when the send was
 * claimed, so a reply racing the provider call still blocks archival.
 */
function archivableQuery(now: Date, filter: Prisma.Sql, suffix: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT cl."id", cl."status"
    FROM "CampaignLead" cl
    JOIN "Campaign" c ON c."id" = cl."campaignId"
    JOIN "Message" s ON s."campaignLeadId" = cl."id"
      AND s."direction" = 'OUTBOUND'::"MessageDirection"
      AND s."purpose" = 'CAMPAIGN_STEP_2'::"MessagePurpose"
    WHERE (
        cl."status" = 'STEP_2_SENT'::"CampaignLeadStatus"
        OR (cl."status" = 'STEP_1_SENT'::"CampaignLeadStatus" AND s."status" = 'UNCERTAIN'::"MessageStatus")
      )
      AND COALESCE(s."sendingStartedAt", s."createdAt")
          + make_interval(secs => (c."config" ->> 'archiveDelayDays')::float8 * 86400)
          <= ${now}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM "Message" i
        WHERE i."leadId" = cl."leadId"
          AND i."direction" = 'INBOUND'::"MessageDirection"
          AND i."createdAt" > COALESCE(s."sendingStartedAt", s."createdAt"))
      AND NOT EXISTS (
        SELECT 1 FROM "ReplyProcessing" r
        WHERE r."leadId" = cl."leadId" AND r."status" = 'ESCALATED'::"ReplyProcessingStatus")
      AND NOT EXISTS (SELECT 1 FROM "BookingOpportunity" b WHERE b."campaignLeadId" = cl."id")
      AND NOT EXISTS (
        SELECT 1 FROM "Lead" p WHERE p."id" = cl."leadId" AND p."automationPausedAt" IS NOT NULL)
      ${filter}
    ORDER BY COALESCE(s."sendingStartedAt", s."createdAt"), cl."id"
    ${suffix}`;
}

export async function findArchivableMembers(
  db: DbClient,
  now: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(
    archivableQuery(now, Prisma.empty, Prisma.sql`LIMIT ${limit}`),
  );
  return rows.map((row) => row.id);
}

/**
 * Archive one membership if it is still due, re-checking every condition under
 * the membership row lock. Uses the transition service; nothing is deleted.
 */
export async function archiveDormantMember(
  db: Database,
  campaignLeadId: string,
  now: Date,
  transactionTimeoutMs: number,
): Promise<boolean> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: CampaignLeadStatus }[]>(
        archivableQuery(
          now,
          Prisma.sql`AND cl."id" = ${campaignLeadId}::uuid`,
          Prisma.sql`LIMIT 1 FOR UPDATE OF cl`,
        ),
      );
      const row = rows[0];
      if (row === undefined) return false;
      await transitionCampaignLead(
        tx,
        { campaignLeadId, from: row.status, to: CampaignLeadStatus.DORMANT_ARCHIVED },
        now,
      );
      return true;
    },
    { timeout: transactionTimeoutMs, maxWait: transactionTimeoutMs },
  );
}

/** Bounded archival pass, oldest closeout first. Safe to run concurrently. */
export async function archiveDueMembers(
  db: Database,
  now: Date,
  limit: number,
  transactionTimeoutMs: number,
): Promise<number> {
  let archived = 0;
  for (const id of await findArchivableMembers(db, now, limit)) {
    if (await archiveDormantMember(db, id, now, transactionTimeoutMs)) archived++;
  }
  return archived;
}
