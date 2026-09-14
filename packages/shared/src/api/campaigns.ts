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

/**
 * Step 1 SMS template. Placeholders use `{{name}}`. Lead variables
 * (`firstName`, `lastName`) require a fallback; other names must be defined in
 * `variables`. Example body: "Hey {{firstName}}, still looking to {{outcome}}?"
 */
export interface Step1MessageTemplate {
  body: string;
  variables: Record<string, string>;
  fallbacks: { firstName?: string; lastName?: string };
}

/**
 * Fixed operator-approved reply texts sent by the deterministic reply router.
 * A missing text means that path escalates to a human instead of replying.
 */
export interface ReplyMessageTemplates {
  /** Sent after a confident positive reply. */
  positive?: string;
  /** Sent once after a confident decline. */
  decline?: string;
  /** Sent once for a confident but unclear reply. */
  clarify?: string;
  /** Sent when a question cannot be answered from approved knowledge. */
  handoff?: string;
}

/** Operational settings snapshotted onto a campaign at creation. */
export interface CampaignConfig {
  messages?: { step1: Step1MessageTemplate; replies?: ReplyMessageTemplates };
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
