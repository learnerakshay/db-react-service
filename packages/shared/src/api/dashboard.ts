import type { CampaignLeadStatus, CampaignStatus, CampaignSummary } from './campaigns.js';

// ---------------------------------------------------------------------------
// Mission Control (Phase 4 / Prompt 1). Read models only: every number is
// computed server-side from database state (see docs/mission-control.md).
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Offset pagination with a stable server-side order. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export type MessageDirection = 'OUTBOUND' | 'INBOUND';
export type MessagePurpose =
  | 'CAMPAIGN_STEP_1'
  | 'INBOUND_REPLY'
  | 'CONVERSATIONAL_REPLY'
  | 'QUALIFICATION_QUESTION'
  | 'BOOKING_LINK'
  | 'CAMPAIGN_STEP_2';
export type MessageStatus =
  | 'PENDING'
  | 'SENDING'
  | 'ACCEPTED'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'UNCERTAIN'
  | 'CANCELLED'
  | 'RECEIVED';
export type IntentClassification =
  'POSITIVE_INTEREST' | 'SPECIFIC_QUESTION' | 'NOT_INTERESTED' | 'HARD_OPT_OUT' | 'AMBIGUOUS';
export type ReplyProcessingStatus = 'PROCESSING' | 'RETRY' | 'COMPLETED' | 'ESCALATED' | 'SKIPPED';
export type ReplyAction =
  | 'OPT_OUT'
  | 'ENGAGE'
  | 'ANSWER_QUESTION'
  | 'CLOSE_DECLINED'
  | 'CLARIFY'
  | 'HUMAN_REVIEW'
  | 'QUALIFICATION_ANSWER';
export const ESCALATION_REASONS = [
  'LOW_CONFIDENCE',
  'UNKNOWN_SENDER',
  'AMBIGUOUS_CAMPAIGN',
  'NO_CAMPAIGN',
  'CONVERSATION_CLOSED',
  'AWAITING_HUMAN_REVIEW',
  'NO_REPLY_TEMPLATE',
  'AMBIGUOUS_REPLY',
  'MISSING_KNOWLEDGE',
  'UNGROUNDED_ANSWER',
  'INVALID_AI_OUTPUT',
  'AI_UNAVAILABLE',
  'LEAD_SUPPRESSED',
  'INBOUND_TOO_OLD',
  'HUMAN_TAKEOVER',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];
export type QualificationResult = 'PENDING_INFORMATION' | 'QUALIFIED' | 'NOT_QUALIFIED';
export type ExtractionOutcome = 'EXTRACTED' | 'NOT_REQUIRED' | 'INVALID_OUTPUT' | 'AI_UNAVAILABLE';
export type QualificationFactSource = 'IMPORT' | 'OPERATOR' | 'CONVERSATION' | 'SYSTEM';
export type BookingStatus = 'OFFERED' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
export type IntegrationDestination = 'CRM' | 'OWNER_NOTIFICATION' | 'POST_BOOKING_HANDOFF';
export type IntegrationEventType =
  'BOOKING_CONFIRMED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED';
export const INTEGRATION_DELIVERY_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'RETRY',
  'FAILED',
  'BLOCKED',
] as const;
export type IntegrationDeliveryStatus = (typeof INTEGRATION_DELIVERY_STATUSES)[number];
export type SuppressionReason =
  'OPT_OUT' | 'DO_NOT_CONTACT' | 'COMPLAINT' | 'LEGAL' | 'INVALID_CONTACT';
export type SuppressionSource = 'IMPORT' | 'OPERATOR' | 'INBOUND_MESSAGE' | 'PROVIDER';

// --- Overview ----------------------------------------------------------------

export interface OverviewMetrics {
  /** Lead records created by imports (unique contacts; duplicates, invalid and suppressed rows excluded). */
  totalIngested: number;
  /** Outbound messages the provider accepted (ACCEPTED, SENT or DELIVERED). */
  outboundSent: number;
  /** Distinct leads with at least one provider-accepted outbound message. */
  contactedLeads: number;
  /** Contacted leads with an inbound message received after their first accepted outbound. */
  repliedLeads: number;
  /** repliedLeads / contactedLeads; null when nobody was contacted. */
  replyRate: number | null;
  /** Distinct leads with a validated POSITIVE_INTEREST classification at or above the routing threshold. */
  positiveIntentLeads: number;
  /** Memberships currently QUALIFIED or BOOKED, or with a QUALIFIED evaluation on record. */
  qualified: number;
  /** Booking opportunities CONFIRMED by a verified calendar event (never a sent link). */
  booked: number;
  activeCampaigns: number;
  /** Escalated reply processing records (human review not yet resolved). */
  openReviews: number;
  /** Contacted leads with an OPTED_OUT membership. */
  optedOutLeads: number;
  /** optedOutLeads / contactedLeads; null when nobody was contacted. */
  optOutRate: number | null;
}

export interface DashboardOverview {
  metrics: OverviewMetrics;
  generatedAt: string;
}

// --- Campaigns ---------------------------------------------------------------

export interface CampaignMetrics {
  /** Memberships per status (0 when none). */
  members: Record<CampaignLeadStatus, number>;
  enrolled: number;
  /** Step 1 messages accepted by the provider. */
  step1Sent: number;
  /** All provider-accepted outbound messages for the campaign. */
  outboundSent: number;
  /** Distinct leads with an inbound message matched to this campaign. */
  repliedLeads: number;
  qualified: number;
  booked: number;
}

export interface CampaignRow extends CampaignMetrics {
  id: string;
  name: string;
  status: CampaignStatus;
  statusChangedAt: string;
  createdAt: string;
  hourlyLimit: number;
  admittedLastHour: number;
  sendWindow: { start: string; end: string };
  timezone: string | null;
  /** Latest message (either direction) for the campaign. */
  lastActivityAt: string | null;
}

export type ActivityKind =
  'OUTBOUND' | 'INBOUND' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'BOOKING' | 'OPT_OUT' | 'INTEGRATION';

export interface ActivityItem {
  kind: ActivityKind;
  at: string;
  leadId: string | null;
  leadName: string;
  /** Machine-readable detail, e.g. "CAMPAIGN_STEP_1 · ACCEPTED". Never message bodies. */
  detail: string;
}

export interface CampaignOverviewResponse {
  campaign: CampaignSummary;
  metrics: CampaignMetrics;
  dispatch: { hourlyLimit: number; admittedLastHour: number; remainingThisHour: number };
  activity: ActivityItem[];
}

// --- Conversations -------------------------------------------------------------

export const CONVERSATION_FILTERS = ['all', 'attention', 'takeover'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export type AutomationMode = 'AUTOMATION_ACTIVE' | 'HUMAN_TAKEOVER';

export interface AutomationState {
  mode: AutomationMode;
  /** When the operator took over; null while automation is active. */
  pausedAt: string | null;
}

export interface ConversationListItem {
  leadId: string;
  leadName: string;
  phoneLast4: string;
  campaign: { id: string; name: string } | null;
  membershipStatus: CampaignLeadStatus | null;
  lastMessage: {
    direction: MessageDirection;
    purpose: MessagePurpose;
    status: MessageStatus;
    preview: string | null;
    at: string;
  };
  openReviews: number;
  automation: AutomationState;
}

export interface ConversationMessage {
  id: string;
  direction: MessageDirection;
  purpose: MessagePurpose;
  status: MessageStatus;
  body: string | null;
  at: string;
  deliveredAt: string | null;
  errorCode: string | null;
  campaignId: string | null;
  /** Routed outcome for an inbound message. Validated fields only, never model reasoning. */
  reply: {
    status: ReplyProcessingStatus;
    classification: IntentClassification | null;
    confidence: number | null;
    action: ReplyAction | null;
    escalationReason: EscalationReason | null;
  } | null;
  qualification: { result: QualificationResult; missingFields: string[] } | null;
  booking: { status: BookingStatus } | null;
}

export interface ConversationDetail {
  lead: { id: string; name: string; phoneLast4: string; automation: AutomationState };
  /** Oldest first; the latest `limit` messages. */
  messages: ConversationMessage[];
  hasEarlier: boolean;
}

// --- Human review ---------------------------------------------------------------

export interface ReviewItem {
  processingId: string;
  leadId: string | null;
  leadName: string;
  campaign: { id: string; name: string } | null;
  membershipStatus: CampaignLeadStatus | null;
  inbound: { id: string; body: string | null; at: string };
  escalationReason: EscalationReason | null;
  classification: IntentClassification | null;
  confidence: number | null;
  createdAt: string;
  automation: AutomationState | null;
  /** OPEN until an operator resolves it (Phase 4 / Prompt 2). */
  state: 'OPEN' | 'RESOLVED';
  resolution: {
    type: 'RESUME_AUTOMATION' | 'KEEP_HUMAN_TAKEOVER' | 'ARCHIVE' | 'MARK_HANDLED';
    resolvedAt: string;
    resolvedBy: string;
    note: string | null;
  } | null;
}

// --- Lead detail ----------------------------------------------------------------

export interface LeadMembershipDetail {
  id: string;
  campaign: { id: string; name: string; status: CampaignStatus };
  status: CampaignLeadStatus;
  statusChangedAt: string;
  createdAt: string;
  facts: {
    field: string;
    value: string | number | boolean | null;
    source: QualificationFactSource;
    observedAt: string;
  }[];
  latestEvaluation: {
    result: QualificationResult;
    missingFields: string[];
    nextField: string | null;
    extraction: ExtractionOutcome;
    evaluatedAt: string;
  } | null;
  bookings: {
    id: string;
    status: BookingStatus;
    appointmentStartAt: string | null;
    appointmentEndAt: string | null;
    appointmentTimezone: string | null;
    linkSentAt: string | null;
    confirmedAt: string | null;
    cancelledAt: string | null;
  }[];
  deliveries: {
    id: string;
    destination: IntegrationDestination;
    eventType: IntegrationEventType;
    status: IntegrationDeliveryStatus;
    attempts: number;
    lastErrorCode: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

export interface LeadDetail {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  source: string;
  externalId: string | null;
  timezone: string | null;
  createdAt: string;
  importBatch: { id: string; sourceLabel: string; startedAt: string } | null;
  suppression: { reason: SuppressionReason; source: SuppressionSource; createdAt: string }[];
  automation: AutomationState;
  memberships: LeadMembershipDetail[];
}

// --- Integration health ---------------------------------------------------------

export type IntegrationKey = IntegrationDestination | 'CALENDAR';

/**
 * NOT_CONFIGURED: no provider adapter; BLOCKED rows were never sent.
 * FAILING: a provider is configured and deliveries are FAILED or RETRY.
 * IDLE: configured, nothing recorded yet. HEALTHY: configured, no failures.
 */
export type IntegrationHealthState = 'HEALTHY' | 'IDLE' | 'FAILING' | 'NOT_CONFIGURED';

export interface IntegrationHealth {
  key: IntegrationKey;
  configured: boolean;
  state: IntegrationHealthState;
  /** Delivery counts by status, or calendar webhook events by outcome for CALENDAR. */
  counts: Record<string, number>;
}

export interface IntegrationProblem {
  id: string;
  destination: IntegrationDestination;
  eventType: IntegrationEventType;
  status: IntegrationDeliveryStatus;
  attempts: number;
  lastErrorCode: string | null;
  updatedAt: string;
  leadId: string;
  leadName: string;
}

export interface IntegrationHealthResponse {
  integrations: IntegrationHealth[];
  /** Most recent FAILED, RETRY and BLOCKED deliveries. */
  problems: IntegrationProblem[];
}
