export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_LEAD_STATUSES = [
  'STAGED',
  'QUEUED',
  'STEP_1_SENT',
  'STEP_2_SENT',
  'ENGAGED',
  'QUALIFIED',
  'BOOKED',
  'OPTED_OUT',
  'DORMANT_ARCHIVED',
] as const;
export type CampaignLeadStatus = (typeof CAMPAIGN_LEAD_STATUSES)[number];

/** Operator actions that change a campaign's status. */
export const CAMPAIGN_ACTIONS = ['start', 'pause', 'resume', 'complete'] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

/** Operational settings snapshotted onto a campaign at creation. */
export interface CampaignConfig {
  /** Fallback IANA timezone for leads without one; null = no fallback. */
  timezone: string | null;
  /** Recipient-local send window, HH:MM 24h, end exclusive. */
  sendWindow: { start: string; end: string };
  /** Application-level admissions per rolling hour (not a carrier limit). */
  hourlyDispatchLimit: number;
  followUpDelayHours: number;
  archiveDelayDays: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: CampaignStatus;
  config: CampaignConfig;
  statusChangedAt: string;
  createdAt: string;
}

export interface CampaignDetail extends CampaignSummary {
  /** Membership count per status (statuses with no members are 0). */
  members: Record<CampaignLeadStatus, number>;
  dispatch: {
    hourlyLimit: number;
    admittedLastHour: number;
    remainingThisHour: number;
  };
}
