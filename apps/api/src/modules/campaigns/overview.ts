import { CAMPAIGN_LEAD_STATUSES, type CampaignLeadStatus } from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import type { Campaign } from '../../generated/prisma/client.js';
import { NotFoundError } from '../../lib/errors.js';
import { CAPACITY_WINDOW_MS } from '../dispatch/admission.js';

export interface CampaignOverview {
  campaign: Campaign;
  members: Record<CampaignLeadStatus, number>;
  admittedLastHour: number;
}

/** Read model for operators: campaign, membership counts, current hourly usage. */
export async function getCampaignOverview(
  db: DbClient,
  campaignId: string,
  now: Date,
): Promise<CampaignOverview> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (campaign === null) throw new NotFoundError('Campaign not found');

  const [grouped, admittedLastHour] = await Promise.all([
    db.campaignLead.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
    db.dispatchAdmission.count({
      where: { campaignId, admittedAt: { gt: new Date(now.getTime() - CAPACITY_WINDOW_MS) } },
    }),
  ]);

  const members = Object.fromEntries(CAMPAIGN_LEAD_STATUSES.map((status) => [status, 0])) as Record<
    CampaignLeadStatus,
    number
  >;
  for (const row of grouped) members[row.status] = row._count._all;

  return { campaign, members, admittedLastHour };
}
