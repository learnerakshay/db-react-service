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

/** One operator rule on a qualification field. Strings compare case-insensitively. */
export type QualificationRequirement =
  | { kind: 'present' }
  | { kind: 'equals'; value: string | number | boolean }
  | { kind: 'oneOf'; values: string[] }
  | { kind: 'min'; value: number }
  | { kind: 'max'; value: number };

/** Every configured field is required; requirements add value rules. */
export interface QualificationFieldConfig {
  /** `^[a-z][A-Za-z0-9_]{0,19}$` */
  key: string;
  type: 'string' | 'number' | 'boolean';
  /** What the extractor looks for. Never decides qualification. */
  description: string;
  /** Fixed text sent once when this is the next missing field. */
  question?: string;
  requirements: QualificationRequirement[];
}

/** Operator-supplied booking link. `message` contains `{{bookingUrl}}` exactly once. */
export interface BookingLinkConfig {
  /** Calendar provider whose verified webhooks confirm bookings. */
  provider: string;
  /** https scheduling page; the booking reference is added as `referenceParam`. */
  url: string;
  referenceParam: string;
  message: string;
}

/** Operational settings snapshotted onto a campaign at creation. */
export interface CampaignConfig {
  messages?: {
    step1: Step1MessageTemplate;
    /** No-response closeout sent `followUpDelayHours` after Step 1; same template rules. */
    step2?: Step1MessageTemplate;
    replies?: ReplyMessageTemplates;
  };
  qualification?: { fields: QualificationFieldConfig[] };
  booking?: BookingLinkConfig;
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
