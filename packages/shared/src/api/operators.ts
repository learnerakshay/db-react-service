import type { AutomationState, IntegrationDestination } from './dashboard.js';

// ---------------------------------------------------------------------------
// Operator access, human review resolution and audit (Phase 4 / Prompt 2).
// ---------------------------------------------------------------------------

/** ADMIN can do everything OPERATOR can, plus configuration and recovery actions. */
export const OPERATOR_ROLES = ['OPERATOR', 'ADMIN'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** GET /api/v1/auth/me */
export interface OperatorIdentity {
  id: string;
  role: OperatorRole;
}

export const REVIEW_RESOLUTIONS = [
  'RESUME_AUTOMATION',
  'KEEP_HUMAN_TAKEOVER',
  'ARCHIVE',
  'MARK_HANDLED',
] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];

export const REVIEW_STATES = ['OPEN', 'RESOLVED'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** POST /api/v1/reviews/:id/resolve */
export interface ResolveReviewRequest {
  resolution: ReviewResolution;
  /** Optional operator note, at most 500 characters. Do not paste contact details. */
  note?: string;
}

export interface ReviewResolutionResponse {
  /** False when this review was already resolved the same way (nothing changed). */
  changed: boolean;
  /** Open reviews of the same lead closed by this action. */
  resolvedCount: number;
  automation: AutomationState | null;
  /** Membership status after ARCHIVE; null for other resolutions. */
  membershipStatus: string | null;
}

/** POST /api/v1/leads/:id/takeover and /resume-automation */
export interface AutomationChangeResponse {
  automation: AutomationState;
  changed: boolean;
  /** Open reviews resolved as RESUME_AUTOMATION (resume only). */
  resolvedReviews: number;
}

export const OPERATOR_ACTIONS = [
  'CAMPAIGN_START',
  'CAMPAIGN_PAUSE',
  'CAMPAIGN_RESUME',
  'CAMPAIGN_COMPLETE',
  'HUMAN_TAKEOVER',
  'RESUME_AUTOMATION',
  'REVIEW_RESOLVED',
  'INTEGRATION_REQUEUE',
] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = ['CAMPAIGN', 'LEAD', 'REVIEW', 'INTEGRATION'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** GET /api/v1/audit */
export interface AuditEventDto {
  id: string;
  actorId: string;
  actorRole: string;
  action: OperatorAction;
  targetType: AuditTargetType;
  targetId: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

/** POST /api/v1/integrations/requeue-blocked (ADMIN) */
export interface RequeueBlockedResponse {
  requeued: number;
  byDestination: Record<IntegrationDestination, number>;
}
