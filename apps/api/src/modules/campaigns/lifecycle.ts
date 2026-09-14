import type { CampaignAction } from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import type { Campaign } from '../../generated/prisma/client.js';
import { CampaignStatus } from '../../generated/prisma/enums.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { campaignConfigSchema } from './campaigns.js';

const S = CampaignStatus;

/** The only legal Campaign status changes. COMPLETED is terminal. */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  DRAFT: [S.ACTIVE],
  ACTIVE: [S.PAUSED, S.COMPLETED],
  PAUSED: [S.ACTIVE, S.COMPLETED],
  COMPLETED: [],
};

/** Each operator action names the states it applies to; all are legal transitions. */
export const CAMPAIGN_ACTION_RULES: Readonly<
  Record<CampaignAction, { from: readonly CampaignStatus[]; to: CampaignStatus }>
> = {
  start: { from: [S.DRAFT], to: S.ACTIVE },
  pause: { from: [S.ACTIVE], to: S.PAUSED },
  resume: { from: [S.PAUSED], to: S.ACTIVE },
  complete: { from: [S.ACTIVE, S.PAUSED], to: S.COMPLETED },
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

/**
 * The single write path for Campaign.status. Rejects actions that do not apply
 * to the current status, refuses to activate a campaign whose stored config is
 * invalid, and writes with a compare-and-set on the status it validated.
 *
 * Pausing takes effect for all future admissions: the admission transaction
 * locks the campaign row and re-reads its status, so a pause either commits
 * before an admission run starts (run admits nothing) or waits for it to finish.
 */
export async function applyCampaignAction(
  db: DbClient,
  campaignId: string,
  action: CampaignAction,
  now: Date = new Date(),
): Promise<Campaign> {
  const rule = CAMPAIGN_ACTION_RULES[action];
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (campaign === null) throw new NotFoundError('Campaign not found');

  if (!rule.from.includes(campaign.status) || !canTransitionCampaign(campaign.status, rule.to)) {
    throw new ConflictError(`Cannot ${action} a ${campaign.status} campaign`);
  }

  if (rule.to === S.ACTIVE) {
    const config = campaignConfigSchema.safeParse(campaign.config);
    if (!config.success) {
      throw ValidationError.fromZod(
        config.error,
        'Campaign config is invalid; it cannot be activated',
      );
    }
  }

  const { count } = await db.campaign.updateMany({
    where: { id: campaignId, status: campaign.status },
    data: { status: rule.to, statusChangedAt: now },
  });
  if (count !== 1) throw new ConflictError('Campaign status changed concurrently; retry');

  return db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
}
