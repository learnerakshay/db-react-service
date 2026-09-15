import type { AppConfig } from '../../config/index.js';
import type { Database, DbClient } from '../../db/client.js';
import {
  CampaignLeadStatus,
  EscalationReason,
  type InboundResolution,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
  ReplyAction,
  ReplyProcessingStatus,
  SafetyAction,
} from '../../generated/prisma/enums.js';
import type { Logger } from '../../lib/logger.js';
import { AiProviderError, type AiProvider } from '../../providers/ai/index.js';
import { campaignConfigSchema } from '../campaigns/campaigns.js';
import { hasOutstandingQualificationQuestion } from '../conversion/outstanding.js';
import { canTransitionCampaignLead, transitionCampaignLead } from '../campaigns/membership.js';
import { retrieveRelevantKnowledge } from '../knowledge/retrieval.js';
import { normalizePhone } from '../leads/phone.js';
import { applyHardOptOut } from '../messaging/inbound.js';
import type { OutboundDependencies } from '../messaging/outbound.js';
import { findSuppressed } from '../suppression/suppression.js';
import { classifyInboundMessage, InvalidAiOutputError, type IntentAnalysis } from './classifier.js';
import { loadConversationHistory } from './context.js';
import { generateGroundedAnswer, validateGroundedAnswer } from './grounding.js';
import { sendConversationalReply, type ReplySendOutcome } from './reply-sender.js';
import { routeReply } from './router.js';

export interface ReplyDependencies {
  db: Database;
  ai: AiProvider;
  outbound: OutboundDependencies;
  logger: Logger;
  confidenceThreshold: number;
  replies: AppConfig['replies'];
}

export type ProcessOutcome =
  | 'COMPLETED'
  | 'ESCALATED'
  | 'SKIPPED'
  | 'RETRY'
  | 'ALREADY_PROCESSED'
  | 'IN_FLIGHT'
  | 'NOT_INBOUND';

export interface ProcessResult {
  outcome: ProcessOutcome;
  processingId: string | null;
  replyOutcome: ReplySendOutcome | null;
}

interface InboundSnapshot {
  id: string;
  body: string;
  leadId: string | null;
  campaignId: string | null;
  campaignLeadId: string | null;
  resolution: InboundResolution;
  safetyAction: SafetyAction | null;
  fromNumber: string;
  toNumber: string;
  createdAt: Date;
}

type Claim =
  | { kind: 'claimed'; processingId: string; attempts: number; inbound: InboundSnapshot }
  | {
      kind: 'done';
      outcome: ProcessOutcome;
      processingId: string | null;
      replyMessageId: string | null;
    };

interface Decision {
  status: 'COMPLETED' | 'ESCALATED' | 'SKIPPED';
  action: ReplyAction;
  escalationReason: EscalationReason | null;
  analysis: IntentAnalysis | null;
  engage: boolean;
  close: boolean;
  optOut: boolean;
  reply: string | null;
  knowledgeItemIds: string[];
  aiModel: string | null;
  aiRequestIds: string[];
  errorCode: string | null;
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Process one persisted inbound message at most once, logically.
 *
 *  1. Claim (transaction): UNIQUE ReplyProcessing(inboundMessageId). A second
 *     worker sees the claim and stops; a stale claim (crash) is re-claimed with
 *     a higher attempt number, and only the latest attempt may record results.
 *  2. Decide (no transaction): deterministic safety gate (exact opt-out already
 *     handled, suppressed lead, stale message), bounded context, classification,
 *     Zod validation, deterministic routing, grounded answering when needed.
 *     The model produces data only.
 *  3. Apply (transaction): suppression, membership transitions and the reply
 *     Message (PENDING, UNIQUE sendKey `<inboundId>:CONVERSATIONAL_REPLY`) are
 *     written together with the processing result.
 *  4. Send the persisted reply through the messaging provider (idempotent).
 */
export async function processInboundMessage(
  deps: ReplyDependencies,
  inboundMessageId: string,
  now: Date = new Date(),
): Promise<ProcessResult> {
  const claim = await claimProcessing(deps, inboundMessageId, now);

  if (claim.kind === 'done') {
    // Resume a reply whose send did not finish in an earlier run.
    const reply =
      claim.replyMessageId === null
        ? null
        : await sendConversationalReply(deps.outbound, claim.replyMessageId, now);
    return {
      outcome: claim.outcome,
      processingId: claim.processingId,
      replyOutcome: reply?.outcome ?? null,
    };
  }

  let decision: Decision;
  try {
    decision = await decide(deps, claim, now);
  } catch (err) {
    if (err instanceof AiProviderError && err.retryable) return recordRetry(deps, claim, err, now);
    if (err instanceof InvalidAiOutputError || err instanceof AiProviderError) {
      deps.logger.warn(
        {
          operation: 'replies.classify',
          messageId: inboundMessageId,
          errorCode: err instanceof AiProviderError ? err.failure : 'INVALID_AI_OUTPUT',
        },
        'AI result unusable; message escalated to human review',
      );
      decision = makeDecision({
        status: 'ESCALATED',
        action: ReplyAction.HUMAN_REVIEW,
        escalationReason:
          err instanceof InvalidAiOutputError || err.failure === 'INVALID_OUTPUT'
            ? EscalationReason.INVALID_AI_OUTPUT
            : EscalationReason.AI_UNAVAILABLE,
        errorCode: err instanceof AiProviderError ? err.failure : 'INVALID_AI_OUTPUT',
        aiModel: err instanceof InvalidAiOutputError ? err.meta.model : null,
      });
    } else {
      throw err;
    }
  }

  const applied = await applyDecision(deps, claim, decision, now);
  if (applied.kind === 'lost') {
    return { outcome: 'IN_FLIGHT', processingId: claim.processingId, replyOutcome: null };
  }

  const reply =
    applied.replyMessageId === null
      ? null
      : await sendConversationalReply(deps.outbound, applied.replyMessageId, now);
  deps.logger.info(
    {
      operation: 'replies.process',
      messageId: inboundMessageId,
      status: decision.status,
      action: decision.action,
      escalationReason: decision.escalationReason,
      classification: decision.analysis?.classification,
      replyOutcome: reply?.outcome,
    },
    'inbound message processed',
  );
  return {
    outcome: decision.status,
    processingId: claim.processingId,
    replyOutcome: reply?.outcome ?? null,
  };
}

async function claimProcessing(
  deps: ReplyDependencies,
  inboundMessageId: string,
  now: Date,
): Promise<Claim> {
  return deps.db.$transaction(
    async (tx): Promise<Claim> => {
      const message = await tx.message.findUnique({
        where: { id: inboundMessageId },
        select: {
          id: true,
          direction: true,
          body: true,
          leadId: true,
          campaignId: true,
          campaignLeadId: true,
          inboundResolution: true,
          safetyAction: true,
          fromNumber: true,
          toNumber: true,
          createdAt: true,
        },
      });
      if (
        message === null ||
        message.direction !== MessageDirection.INBOUND ||
        message.body === null ||
        message.inboundResolution === null
      ) {
        return { kind: 'done', outcome: 'NOT_INBOUND', processingId: null, replyMessageId: null };
      }
      const inbound: InboundSnapshot = {
        id: message.id,
        body: message.body,
        leadId: message.leadId,
        campaignId: message.campaignId,
        campaignLeadId: message.campaignLeadId,
        resolution: message.inboundResolution,
        safetyAction: message.safetyAction,
        fromNumber: message.fromNumber,
        toNumber: message.toNumber,
        createdAt: message.createdAt,
      };

      const inserted = await tx.replyProcessing.createMany({
        data: [
          {
            inboundMessageId,
            leadId: message.leadId,
            campaignLeadId: message.campaignLeadId,
            status: ReplyProcessingStatus.PROCESSING,
            attempts: 1,
            claimedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      const rows = await tx.$queryRaw<
        {
          id: string;
          status: ReplyProcessingStatus;
          attempts: number;
          claimedAt: Date;
          replyMessageId: string | null;
        }[]
      >`
        SELECT "id", "status", "attempts", "claimedAt", "replyMessageId"
        FROM "ReplyProcessing" WHERE "inboundMessageId" = ${inboundMessageId}::uuid
        FOR UPDATE`;
      const row = rows[0];
      if (row === undefined) throw new Error('ReplyProcessing row missing after claim insert');

      if (inserted.count === 1) {
        return { kind: 'claimed', processingId: row.id, attempts: 1, inbound };
      }
      if (
        row.status === ReplyProcessingStatus.COMPLETED ||
        row.status === ReplyProcessingStatus.ESCALATED ||
        row.status === ReplyProcessingStatus.SKIPPED
      ) {
        return {
          kind: 'done',
          outcome: 'ALREADY_PROCESSED',
          processingId: row.id,
          replyMessageId: row.replyMessageId,
        };
      }

      const stale = now.getTime() - row.claimedAt.getTime() > deps.replies.processingStaleAfterMs;
      if (row.status === ReplyProcessingStatus.PROCESSING && !stale) {
        return { kind: 'done', outcome: 'IN_FLIGHT', processingId: row.id, replyMessageId: null };
      }

      if (row.attempts >= deps.replies.processingMaxAttempts) {
        await tx.replyProcessing.update({
          where: { id: row.id },
          data: {
            status: ReplyProcessingStatus.ESCALATED,
            action: ReplyAction.HUMAN_REVIEW,
            escalationReason: EscalationReason.AI_UNAVAILABLE,
            completedAt: now,
          },
        });
        return { kind: 'done', outcome: 'ESCALATED', processingId: row.id, replyMessageId: null };
      }

      await tx.replyProcessing.update({
        where: { id: row.id },
        data: {
          status: ReplyProcessingStatus.PROCESSING,
          attempts: row.attempts + 1,
          claimedAt: now,
        },
      });
      return { kind: 'claimed', processingId: row.id, attempts: row.attempts + 1, inbound };
    },
    { timeout: deps.replies.transactionTimeoutMs, maxWait: deps.replies.transactionTimeoutMs },
  );
}

async function decide(
  deps: ReplyDependencies,
  claim: Extract<Claim, { kind: 'claimed' }>,
  now: Date,
): Promise<Decision> {
  const { db } = deps;
  const { inbound } = claim;

  // --- Deterministic safety gate (no AI) ---------------------------------
  if (inbound.safetyAction === SafetyAction.HARD_OPT_OUT) {
    return makeDecision({ status: 'SKIPPED', action: ReplyAction.OPT_OUT });
  }
  if (now.getTime() - inbound.createdAt.getTime() > deps.replies.maxInboundAgeMs) {
    return escalate(EscalationReason.INBOUND_TOO_OLD);
  }

  const lead =
    inbound.leadId === null
      ? null
      : await db.lead.findUnique({
          where: { id: inbound.leadId },
          select: { phone: true, email: true },
        });
  const senderPhone = lead?.phone ?? senderE164(inbound);
  const suppressed = await findSuppressed(db, {
    phones: senderPhone === null ? [] : [senderPhone],
    emails: lead?.email === null || lead?.email === undefined ? [] : [lead.email],
  });
  if (suppressed.phones.size > 0 || suppressed.emails.size > 0) {
    return escalate(EscalationReason.LEAD_SUPPRESSED);
  }

  // --- Classification (AI produces data only) ----------------------------
  const history = await loadConversationHistory(
    db,
    inbound,
    deps.replies.historyLimit,
    deps.replies.historyMessageMaxChars,
  );
  const classified = await classifyInboundMessage(
    deps.ai,
    inbound.body,
    history,
    deps.replies.classifierMaxOutputTokens,
  );
  const { analysis } = classified;
  const aiRequestIds = classified.meta.requestId === null ? [] : [classified.meta.requestId];
  const base = { analysis, aiModel: classified.meta.model, aiRequestIds };

  // --- Deterministic routing ---------------------------------------------
  const membership =
    inbound.campaignLeadId === null
      ? null
      : await db.campaignLead.findUnique({
          where: { id: inbound.campaignLeadId },
          select: { status: true, campaign: { select: { config: true } } },
        });
  const config =
    membership === null ? null : campaignConfigSchema.safeParse(membership.campaign.config);
  const templates = config?.success === true ? (config.data.messages?.replies ?? {}) : {};

  const awaitingHumanReview =
    inbound.leadId !== null &&
    (await db.replyProcessing.count({
      where: {
        leadId: inbound.leadId,
        status: ReplyProcessingStatus.ESCALATED,
        id: { not: claim.processingId },
        inboundMessage: { createdAt: { lt: inbound.createdAt } },
      },
    })) > 0;
  const clarificationAlreadySent =
    inbound.campaignLeadId !== null &&
    (await db.replyProcessing.count({
      where: {
        campaignLeadId: inbound.campaignLeadId,
        action: ReplyAction.CLARIFY,
        id: { not: claim.processingId },
      },
    })) > 0;

  const qualificationQuestionOutstanding =
    inbound.campaignLeadId !== null &&
    membership?.status === CampaignLeadStatus.ENGAGED &&
    (await hasOutstandingQualificationQuestion(db, inbound.campaignLeadId));

  const route = routeReply({
    analysis,
    confidenceThreshold: deps.confidenceThreshold,
    resolution: inbound.resolution,
    membershipStatus: membership?.status ?? null,
    awaitingHumanReview,
    clarificationAlreadySent,
    templates,
    qualificationQuestionOutstanding,
  });

  switch (route.action) {
    case 'OPT_OUT':
      return makeDecision({
        ...base,
        status: 'COMPLETED',
        action: ReplyAction.OPT_OUT,
        optOut: true,
      });
    case 'ENGAGE':
      return makeDecision({
        ...base,
        status: 'COMPLETED',
        action: ReplyAction.ENGAGE,
        engage: true,
        reply: route.reply,
      });
    case 'CLOSE_DECLINED':
      return makeDecision({
        ...base,
        status: 'COMPLETED',
        action: ReplyAction.CLOSE_DECLINED,
        close: true,
        reply: route.reply,
      });
    case 'CLARIFY':
      return makeDecision({
        ...base,
        status: 'COMPLETED',
        action: ReplyAction.CLARIFY,
        reply: route.reply,
      });
    case 'QUALIFICATION_ANSWER':
      // No generic reply: the qualification job extracts and evaluates this answer.
      return makeDecision({
        ...base,
        status: 'COMPLETED',
        action: ReplyAction.QUALIFICATION_ANSWER,
      });
    case 'HUMAN_REVIEW':
      return makeDecision({
        ...base,
        status: 'ESCALATED',
        action: ReplyAction.HUMAN_REVIEW,
        escalationReason: route.reason,
        engage: route.engage,
      });
    case 'ANSWER_QUESTION': {
      const question = analysis.extractedDetails.specificQuery ?? inbound.body;
      const facts = await retrieveRelevantKnowledge(db, {
        campaignId: inbound.campaignId,
        query: `${question} ${inbound.body}`,
        limit: deps.replies.knowledgeMaxItems,
      });
      const handoff = templates.handoff ?? null;
      if (facts.length === 0) {
        return makeDecision({
          ...base,
          status: 'ESCALATED',
          action: ReplyAction.HUMAN_REVIEW,
          escalationReason: EscalationReason.MISSING_KNOWLEDGE,
          engage: true,
          reply: handoff,
        });
      }

      const grounded = await generateGroundedAnswer(deps.ai, {
        question,
        facts,
        history,
        maxOutputTokens: deps.replies.answerMaxOutputTokens,
      });
      if (grounded.meta.requestId !== null) aiRequestIds.push(grounded.meta.requestId);

      const check = validateGroundedAnswer(grounded.answer, facts, deps.replies.maxReplyLength);
      if (!check.ok) {
        return makeDecision({
          ...base,
          status: 'ESCALATED',
          action: ReplyAction.HUMAN_REVIEW,
          escalationReason:
            check.reason === 'NOT_ANSWERABLE'
              ? EscalationReason.MISSING_KNOWLEDGE
              : EscalationReason.UNGROUNDED_ANSWER,
          engage: true,
          reply: handoff,
          knowledgeItemIds: facts.map((fact) => fact.id),
          errorCode: check.reason,
        });
      }
      return makeDecision({
        ...base,
        status: 'COMPLETED',
        action: ReplyAction.ANSWER_QUESTION,
        engage: true,
        reply: check.answer,
        knowledgeItemIds: check.citedFactIds,
      });
    }
  }
}

async function applyDecision(
  deps: ReplyDependencies,
  claim: Extract<Claim, { kind: 'claimed' }>,
  decision: Decision,
  now: Date,
): Promise<{ kind: 'lost' } | { kind: 'applied'; replyMessageId: string | null }> {
  const { inbound } = claim;

  return deps.db.$transaction(
    async (tx) => {
      const current = await tx.$queryRaw<{ status: ReplyProcessingStatus; attempts: number }[]>`
        SELECT "status", "attempts" FROM "ReplyProcessing"
        WHERE "id" = ${claim.processingId}::uuid FOR UPDATE`;
      const row = current[0];
      // Only the worker holding the latest claim may record results.
      if (row?.status !== ReplyProcessingStatus.PROCESSING || row.attempts !== claim.attempts) {
        return { kind: 'lost' as const };
      }

      let membershipStatus: CampaignLeadStatus | null = null;
      if (inbound.campaignLeadId !== null) {
        const memberships = await tx.$queryRaw<{ status: CampaignLeadStatus }[]>`
          SELECT "status" FROM "CampaignLead" WHERE "id" = ${inbound.campaignLeadId}::uuid FOR UPDATE`;
        membershipStatus = memberships[0]?.status ?? null;
      }
      const lead =
        inbound.leadId === null
          ? null
          : await tx.lead.findUnique({ where: { id: inbound.leadId }, select: { phone: true } });

      if (decision.optOut) {
        const phone = lead?.phone ?? senderE164(inbound);
        if (phone !== null)
          await applyHardOptOut(tx, phone, inbound.leadId, `ai:${inbound.id}`, now);
        if (inbound.leadId !== null) {
          await tx.message.updateMany({
            where: {
              leadId: inbound.leadId,
              direction: MessageDirection.OUTBOUND,
              status: MessageStatus.PENDING,
            },
            data: { status: MessageStatus.CANCELLED, errorCode: 'LEAD_OPTED_OUT' },
          });
        }
        if (
          membershipStatus !== null &&
          canTransitionCampaignLead(membershipStatus, CampaignLeadStatus.OPTED_OUT)
        ) {
          membershipStatus = CampaignLeadStatus.OPTED_OUT;
        }
      }

      if (
        decision.engage &&
        inbound.campaignLeadId !== null &&
        (membershipStatus === CampaignLeadStatus.STEP_1_SENT ||
          membershipStatus === CampaignLeadStatus.STEP_2_SENT)
      ) {
        await transitionCampaignLead(
          tx,
          {
            campaignLeadId: inbound.campaignLeadId,
            from: membershipStatus,
            to: CampaignLeadStatus.ENGAGED,
          },
          now,
        );
        membershipStatus = CampaignLeadStatus.ENGAGED;
      }

      if (
        decision.close &&
        inbound.campaignLeadId !== null &&
        membershipStatus !== null &&
        canTransitionCampaignLead(membershipStatus, CampaignLeadStatus.DORMANT_ARCHIVED)
      ) {
        await transitionCampaignLead(
          tx,
          {
            campaignLeadId: inbound.campaignLeadId,
            from: membershipStatus,
            to: CampaignLeadStatus.DORMANT_ARCHIVED,
          },
          now,
        );
        membershipStatus = CampaignLeadStatus.DORMANT_ARCHIVED;
      }

      let replyMessageId: string | null = null;
      if (
        decision.reply !== null &&
        inbound.leadId !== null &&
        inbound.campaignLeadId !== null &&
        lead !== null &&
        membershipStatus !== null &&
        membershipStatus !== CampaignLeadStatus.OPTED_OUT
      ) {
        const reply = await tx.message.create({
          data: {
            direction: MessageDirection.OUTBOUND,
            purpose: MessagePurpose.CONVERSATIONAL_REPLY,
            status: MessageStatus.PENDING,
            provider: deps.outbound.provider.name,
            leadId: inbound.leadId,
            campaignId: inbound.campaignId,
            campaignLeadId: inbound.campaignLeadId,
            fromNumber: E164.test(inbound.toNumber) ? inbound.toNumber : deps.outbound.fromNumber,
            toNumber: lead.phone,
            body: decision.reply,
            sendKey: replySendKey(inbound.id),
          },
        });
        replyMessageId = reply.id;
      }

      await tx.replyProcessing.update({
        where: { id: claim.processingId },
        data: {
          status: ReplyProcessingStatus[decision.status],
          action: decision.action,
          escalationReason: decision.escalationReason,
          classification: decision.analysis?.classification ?? null,
          confidence: decision.analysis?.confidence ?? null,
          preferredTime: decision.analysis?.extractedDetails.preferredTime ?? null,
          specificQuery: decision.analysis?.extractedDetails.specificQuery ?? null,
          knowledgeItemIds: decision.knowledgeItemIds,
          aiProvider: decision.aiModel === null ? null : deps.ai.name,
          aiModel: decision.aiModel,
          aiRequestIds: decision.aiRequestIds,
          replyMessageId,
          errorCode: decision.errorCode,
          completedAt: now,
        },
      });
      return { kind: 'applied' as const, replyMessageId };
    },
    { timeout: deps.replies.transactionTimeoutMs, maxWait: deps.replies.transactionTimeoutMs },
  );
}

async function recordRetry(
  deps: ReplyDependencies,
  claim: Extract<Claim, { kind: 'claimed' }>,
  err: AiProviderError,
  now: Date,
): Promise<ProcessResult> {
  const exhausted = claim.attempts >= deps.replies.processingMaxAttempts;
  const { count } = await deps.db.replyProcessing.updateMany({
    where: {
      id: claim.processingId,
      status: ReplyProcessingStatus.PROCESSING,
      attempts: claim.attempts,
    },
    data: exhausted
      ? {
          status: ReplyProcessingStatus.ESCALATED,
          action: ReplyAction.HUMAN_REVIEW,
          escalationReason: EscalationReason.AI_UNAVAILABLE,
          errorCode: err.failure,
          completedAt: now,
        }
      : { status: ReplyProcessingStatus.RETRY, errorCode: err.failure },
  });
  deps.logger.warn(
    {
      operation: 'replies.classify',
      messageId: claim.inbound.id,
      errorCode: err.failure,
      attempt: claim.attempts,
    },
    exhausted
      ? 'AI unavailable after final attempt; escalated'
      : 'transient AI failure; will retry',
  );
  const outcome: ProcessOutcome = count === 0 ? 'IN_FLIGHT' : exhausted ? 'ESCALATED' : 'RETRY';
  return { outcome, processingId: claim.processingId, replyOutcome: null };
}

/** Inbound messages without a finished processing record, oldest first. */
export async function findInboundNeedingProcessing(
  db: DbClient,
  now: Date,
  staleAfterMs: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.message.findMany({
    where: {
      direction: MessageDirection.INBOUND,
      OR: [
        { replyProcessing: { is: null } },
        { replyProcessing: { is: { status: ReplyProcessingStatus.RETRY } } },
        {
          replyProcessing: {
            is: {
              status: ReplyProcessingStatus.PROCESSING,
              claimedAt: { lt: new Date(now.getTime() - staleAfterMs) },
            },
          },
        },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Replies persisted but not sent (crash before send, or retryable rejection). */
export async function findPendingReplies(
  db: DbClient,
  now: Date,
  olderThanMs: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.message.findMany({
    where: {
      direction: MessageDirection.OUTBOUND,
      purpose: MessagePurpose.CONVERSATIONAL_REPLY,
      status: MessageStatus.PENDING,
      updatedAt: { lt: new Date(now.getTime() - olderThanMs) },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export function replySendKey(inboundMessageId: string): string {
  return `${inboundMessageId}:${MessagePurpose.CONVERSATIONAL_REPLY}`;
}

function senderE164(inbound: InboundSnapshot): string | null {
  const phone = normalizePhone(inbound.fromNumber);
  return phone.ok ? phone.e164 : null;
}

function escalate(reason: EscalationReason): Decision {
  return makeDecision({
    status: 'ESCALATED',
    action: ReplyAction.HUMAN_REVIEW,
    escalationReason: reason,
  });
}

function makeDecision(partial: Partial<Decision> & Pick<Decision, 'status' | 'action'>): Decision {
  return {
    escalationReason: null,
    analysis: null,
    engage: false,
    close: false,
    optOut: false,
    reply: null,
    knowledgeItemIds: [],
    aiModel: null,
    aiRequestIds: [],
    errorCode: null,
    ...partial,
  };
}
