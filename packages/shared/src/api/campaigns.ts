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

/** Operational settings snapshotted onto a campaign at creation. */
export interface CampaignConfig {
  timezone: string;
  sendWindow: { start: string; end: string };
  hourlyDispatchLimit: number;
  followUpDelayHours: number;
  archiveDelayDays: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: CampaignStatus;
  config: CampaignConfig;
  createdAt: string;
}
