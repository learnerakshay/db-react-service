import type { DbClient } from '../../db/client.js';
import { CampaignLeadStatus } from '../../generated/prisma/enums.js';
import { ConflictError } from '../../lib/errors.js';

const S = CampaignLeadStatus;

/**
 * The only legal CampaignLead status changes. Terminal states have no exits.
 * Prompt 2+ extends behavior by calling `transitionCampaignLead`, and adds
 * edges here only with tests.
 */
export const CAMPAIGN_LEAD_TRANSITIONS: Readonly<
  Record<CampaignLeadStatus, readonly CampaignLeadStatus[]>
> = {
  STAGED: [S.QUEUED, S.OPTED_OUT, S.DORMANT_ARCHIVED],
  QUEUED: [S.STEP_1_SENT, S.OPTED_OUT, S.DORMANT_ARCHIVED],
  STEP_1_SENT: [S.STEP_2_SENT, S.ENGAGED, S.OPTED_OUT, S.DORMANT_ARCHIVED],
  STEP_2_SENT: [S.ENGAGED, S.OPTED_OUT, S.DORMANT_ARCHIVED],
  ENGAGED: [S.QUALIFIED, S.BOOKED, S.OPTED_OUT, S.DORMANT_ARCHIVED],
  QUALIFIED: [S.BOOKED, S.OPTED_OUT, S.DORMANT_ARCHIVED],
  BOOKED: [S.OPTED_OUT],
  OPTED_OUT: [],
  DORMANT_ARCHIVED: [],
};

export function canTransitionCampaignLead(
  from: CampaignLeadStatus,
  to: CampaignLeadStatus,
): boolean {
  return CAMPAIGN_LEAD_TRANSITIONS[from].includes(to);
}

/**
 * The single write path for CampaignLead.status. Rejects illegal transitions,
 * and applies legal ones with a compare-and-set on the expected current status
 * so concurrent writers cannot skip or repeat a step.
 */
export async function transitionCampaignLead(
  db: DbClient,
  change: { campaignLeadId: string; from: CampaignLeadStatus; to: CampaignLeadStatus },
  now: Date = new Date(),
): Promise<void> {
  if (!canTransitionCampaignLead(change.from, change.to)) {
    throw new ConflictError(`Illegal campaign lead transition ${change.from} -> ${change.to}`);
  }
  const { count } = await db.campaignLead.updateMany({
    where: { id: change.campaignLeadId, status: change.from },
    data: { status: change.to, statusChangedAt: now },
  });
  if (count !== 1) {
    throw new ConflictError(`Campaign lead is not in the expected ${change.from} state`);
  }
}

/**
 * Enroll leads into a campaign as STAGED. Skips, in the same statement:
 * leads already in the campaign (unique campaignId+leadId), non-ACTIVE leads,
 * and leads whose phone or email is suppressed. Returns memberships created.
 *
 * Suppression can still be added after staging; dispatch (Phase 1 Prompt 2)
 * must re-check suppression immediately before any send.
 */
export async function stageLeadsForCampaign(
  db: DbClient,
  input: { campaignId: string; leadIds: readonly string[]; importBatchId: string | null },
): Promise<number> {
  if (input.leadIds.length === 0) return 0;
  return db.$executeRaw`
    INSERT INTO "CampaignLead"
      ("id", "campaignId", "leadId", "status", "statusChangedAt", "importBatchId", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${input.campaignId}::uuid, l."id", 'STAGED'::"CampaignLeadStatus",
           now(), ${input.importBatchId}::uuid, now(), now()
    FROM "Lead" l
    WHERE l."id" = ANY(${[...input.leadIds]}::uuid[])
      AND l."status" = 'ACTIVE'::"LeadStatus"
      AND NOT EXISTS (
        SELECT 1 FROM "SuppressionEntry" s
        WHERE s."phone" = l."phone" OR (l."email" IS NOT NULL AND s."email" = l."email")
      )
    ORDER BY l."id"
    ON CONFLICT ("campaignId", "leadId") DO NOTHING`;
}
