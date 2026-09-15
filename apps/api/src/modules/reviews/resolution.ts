import type {
  AutomationChangeResponse,
  AutomationState,
  ReviewResolution,
  ReviewResolutionResponse,
} from '@cadentor/shared';
import type { Database, DbClient } from '../../db/client.js';
import { CampaignLeadStatus, ReplyProcessingStatus } from '../../generated/prisma/enums.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { Operator } from '../auth/operators.js';
import { recordOperatorAction } from '../audit/audit.js';
import { canTransitionCampaignLead, transitionCampaignLead } from '../campaigns/membership.js';
import { cancelOpenBookingOffers } from '../conversion/booking.js';
import { automationState, setHumanTakeover } from '../leads/takeover.js';

/**
 * An open human review: an ESCALATED reply-processing record not yet resolved.
 * Every automation gate that waits for a human (reply routing, Step 2,
 * archival) and the review queue use exactly this filter.
 */
export const OPEN_REVIEW = {
  status: ReplyProcessingStatus.ESCALATED,
  reviewResolvedAt: null,
} as const;

export interface OperatorContext {
  actor: Operator;
  requestId?: string | undefined;
  now: Date;
  transactionTimeoutMs: number;
}

interface ReviewRow {
  id: string;
  status: ReplyProcessingStatus;
  leadId: string | null;
  campaignLeadId: string | null;
  reviewResolvedAt: Date | null;
  reviewResolution: ReviewResolution | null;
}

/**
 * Resolve one human review. Blocking is lead-level, so the resolution closes
 * every open review of the same lead (only this one for an unknown sender).
 *
 *  - RESUME_AUTOMATION:   clear human takeover; eligible automation continues.
 *  - KEEP_HUMAN_TAKEOVER: start or keep takeover; the operator continues manually.
 *  - ARCHIVE:             review membership → DORMANT_ARCHIVED through the
 *                         transition map (409 when illegal, e.g. BOOKED or
 *                         OPTED_OUT) and its open booking offer is withdrawn.
 *  - MARK_HANDLED:        close the review; automation state unchanged.
 *
 * Never deletes or rewrites the routed outcome, never touches suppression,
 * booking confirmations or campaign status. Repeating the same resolution is a
 * no-op (`changed: false`, no audit); a different one on a resolved review is 409.
 * Lock order matches the send paths: membership, then lead.
 */
export async function resolveReview(
  db: Database,
  processingId: string,
  input: { resolution: ReviewResolution; note: string | null },
  context: OperatorContext,
): Promise<ReviewResolutionResponse> {
  const { resolution } = input;
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<ReviewRow[]>`
        SELECT "id", "status", "leadId", "campaignLeadId", "reviewResolvedAt", "reviewResolution"
        FROM "ReplyProcessing" WHERE "id" = ${processingId}::uuid FOR UPDATE`;
      const review = rows[0];
      if (review?.status !== ReplyProcessingStatus.ESCALATED) {
        throw new NotFoundError('Review not found');
      }
      if (review.reviewResolvedAt !== null) {
        if (review.reviewResolution !== resolution) {
          throw new ConflictError(
            `Review is already resolved as ${String(review.reviewResolution)}`,
          );
        }
        return {
          changed: false,
          resolvedCount: 0,
          automation: await currentAutomation(tx, review.leadId),
          membershipStatus: null,
        };
      }
      if (
        review.leadId === null &&
        (resolution === 'RESUME_AUTOMATION' || resolution === 'KEEP_HUMAN_TAKEOVER')
      ) {
        throw new ConflictError('The sender is not a known lead; there is no automation to change');
      }

      let membershipStatus: CampaignLeadStatus | null = null;
      if (resolution === 'ARCHIVE') {
        if (review.campaignLeadId === null) {
          throw new ConflictError('This review has no campaign membership to archive');
        }
        membershipStatus = await archiveMembership(tx, review.campaignLeadId, context.now);
      }
      if (review.leadId !== null) {
        await tx.$queryRaw`SELECT 1 FROM "Lead" WHERE "id" = ${review.leadId}::uuid FOR UPDATE`;
      }

      let automation: AutomationState | null = null;
      let automationChanged = false;
      if (review.leadId !== null) {
        if (resolution === 'RESUME_AUTOMATION' || resolution === 'KEEP_HUMAN_TAKEOVER') {
          const result = await setHumanTakeover(
            tx,
            review.leadId,
            resolution === 'KEEP_HUMAN_TAKEOVER',
            context.now,
          );
          automation = result.automation;
          automationChanged = result.changed;
        } else {
          automation = await currentAutomation(tx, review.leadId);
        }
      }

      const resolvedCount = await closeOpenReviews(
        tx,
        review.leadId === null ? { id: review.id } : { leadId: review.leadId },
        { resolution, note: input.note, actor: context.actor, now: context.now },
      );
      await recordOperatorAction(tx, {
        actor: context.actor,
        action: 'REVIEW_RESOLVED',
        targetType: 'REVIEW',
        targetId: review.id,
        requestId: context.requestId,
        metadata: {
          resolution,
          resolvedCount,
          leadId: review.leadId,
          automationChanged,
          membershipStatus,
          hasNote: input.note !== null,
        },
      });
      return { changed: true, resolvedCount, automation, membershipStatus };
    },
    { timeout: context.transactionTimeoutMs, maxWait: context.transactionTimeoutMs },
  );
}

/** Operator takeover of a lead. Audited only when it changed the state. */
export async function takeOverLead(
  db: Database,
  leadId: string,
  context: OperatorContext,
): Promise<AutomationChangeResponse> {
  return db.$transaction(
    async (tx) => {
      const { automation, changed } = await setHumanTakeover(tx, leadId, true, context.now);
      if (changed) {
        await recordOperatorAction(tx, {
          actor: context.actor,
          action: 'HUMAN_TAKEOVER',
          targetType: 'LEAD',
          targetId: leadId,
          requestId: context.requestId,
        });
      }
      return { automation, changed, resolvedReviews: 0 };
    },
    { timeout: context.transactionTimeoutMs, maxWait: context.transactionTimeoutMs },
  );
}

/**
 * Resume automation for a lead: clear takeover and resolve its open reviews as
 * RESUME_AUTOMATION in one transaction, so no stale escalation keeps blocking
 * eligible automation. Suppression and terminal states still stop every send.
 */
export async function resumeLeadAutomation(
  db: Database,
  leadId: string,
  context: OperatorContext,
): Promise<AutomationChangeResponse> {
  return db.$transaction(
    async (tx) => {
      const { automation, changed } = await setHumanTakeover(tx, leadId, false, context.now);
      const resolvedReviews = await closeOpenReviews(
        tx,
        { leadId },
        { resolution: 'RESUME_AUTOMATION', note: null, actor: context.actor, now: context.now },
      );
      if (changed || resolvedReviews > 0) {
        await recordOperatorAction(tx, {
          actor: context.actor,
          action: 'RESUME_AUTOMATION',
          targetType: 'LEAD',
          targetId: leadId,
          requestId: context.requestId,
          metadata: { takeoverCleared: changed, resolvedReviews },
        });
      }
      return { automation, changed: changed || resolvedReviews > 0, resolvedReviews };
    },
    { timeout: context.transactionTimeoutMs, maxWait: context.transactionTimeoutMs },
  );
}

async function closeOpenReviews(
  tx: DbClient,
  scope: { id: string } | { leadId: string },
  resolution: { resolution: ReviewResolution; note: string | null; actor: Operator; now: Date },
): Promise<number> {
  const { count } = await tx.replyProcessing.updateMany({
    where: { ...scope, ...OPEN_REVIEW },
    data: {
      reviewResolvedAt: resolution.now,
      reviewResolution: resolution.resolution,
      reviewResolvedBy: resolution.actor.id,
      reviewNote: resolution.note,
    },
  });
  return count;
}

async function archiveMembership(
  tx: DbClient,
  campaignLeadId: string,
  now: Date,
): Promise<CampaignLeadStatus> {
  const members = await tx.$queryRaw<{ status: CampaignLeadStatus }[]>`
    SELECT "status" FROM "CampaignLead" WHERE "id" = ${campaignLeadId}::uuid FOR UPDATE`;
  const status = members[0]?.status;
  if (status === undefined) throw new NotFoundError('Campaign membership not found');
  if (status !== CampaignLeadStatus.DORMANT_ARCHIVED) {
    if (!canTransitionCampaignLead(status, CampaignLeadStatus.DORMANT_ARCHIVED)) {
      throw new ConflictError(`A ${status} membership cannot be archived`);
    }
    await transitionCampaignLead(
      tx,
      { campaignLeadId, from: status, to: CampaignLeadStatus.DORMANT_ARCHIVED },
      now,
    );
  }
  await cancelOpenBookingOffers(tx, campaignLeadId, now);
  return CampaignLeadStatus.DORMANT_ARCHIVED;
}

async function currentAutomation(
  tx: DbClient,
  leadId: string | null,
): Promise<AutomationState | null> {
  if (leadId === null) return null;
  const lead = await tx.lead.findUnique({
    where: { id: leadId },
    select: { automationPausedAt: true },
  });
  return lead === null ? null : automationState(lead.automationPausedAt);
}
