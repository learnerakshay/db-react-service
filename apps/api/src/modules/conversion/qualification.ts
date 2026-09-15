import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/index.js';
import type { Database, DbClient } from '../../db/client.js';
import {
  CampaignLeadStatus,
  ExtractionOutcome,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
  QualificationFactSource,
  QualificationResult,
  ReplyAction,
  ReplyProcessingStatus,
} from '../../generated/prisma/enums.js';
import type { Logger } from '../../lib/logger.js';
import { AiProviderError, type AiProvider } from '../../providers/ai/index.js';
import { campaignConfigSchema } from '../campaigns/campaigns.js';
import { transitionCampaignLead } from '../campaigns/membership.js';
import type { OutboundDependencies } from '../messaging/outbound.js';
import { InvalidAiOutputError } from '../replies/classifier.js';
import { loadConversationHistory } from '../replies/context.js';
import { findSuppressed } from '../suppression/suppression.js';
import { offerBooking } from './booking.js';
import { evaluateQualification, parseFactValue } from './evaluator.js';
import { extractQualificationFacts } from './extraction.js';
import { loadQualificationFacts, recordQualificationFacts, type FactInput } from './facts.js';
import { sendConversionMessage, type ConversionSendOutcome } from './sender.js';

export interface QualificationDependencies {
  db: Database;
  ai: AiProvider;
  outbound: OutboundDependencies;
  logger: Logger;
  conversion: AppConfig['conversion'];
  replies: AppConfig['replies'];
}

/**
 * Phase 2 actions after which the conversation is still automated. Escalated
 * or skipped messages belong to a human or to opt-out handling, so they never
 * trigger qualification messages.
 */
export const QUALIFYING_REPLY_ACTIONS: readonly ReplyAction[] = [
  ReplyAction.ENGAGE,
  ReplyAction.ANSWER_QUESTION,
  ReplyAction.CLARIFY,
  ReplyAction.QUALIFICATION_ANSWER,
];

export type QualificationRunOutcome =
  'EVALUATED' | 'ALREADY_EVALUATED' | 'NOT_ELIGIBLE' | 'STATE_CHANGED';

export interface QualificationRunResult {
  outcome: QualificationRunOutcome;
  evaluationId: string | null;
  result: QualificationResult | null;
  sends: ConversionSendOutcome[];
}

interface Extraction {
  outcome: ExtractionOutcome;
  facts: FactInput[];
  discarded: string[];
  aiModel: string | null;
  aiRequestId: string | null;
  errorCode: string | null;
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** One logical question per membership and field (UNIQUE Message.sendKey). */
export function qualificationQuestionSendKey(campaignLeadId: string, field: string): string {
  return `${campaignLeadId}:${MessagePurpose.QUALIFICATION_QUESTION}:${field}`;
}

/**
 * Qualify an ENGAGED membership from one inbound message, at most once per message.
 *
 *  1. Eligibility (no AI): inbound message of an ENGAGED membership whose
 *     campaign has qualification rules, reply processing COMPLETED with an
 *     automated action, not too old, lead not suppressed.
 *  2. Extraction (no transaction): only for fields not known from a
 *     higher-precedence source. Output is Zod-validated and evidence-checked.
 *     Unusable output keeps existing facts; transient AI failures are retried
 *     by the job unless this is the final attempt.
 *  3. Apply (transaction, membership locked): write facts by precedence,
 *     evaluate deterministically, persist the evaluation (UNIQUE per inbound),
 *     then act: PENDING_INFORMATION → one configured question per field;
 *     NOT_QUALIFIED → DORMANT_ARCHIVED; QUALIFIED → QUALIFIED + booking offer.
 *  4. Send persisted messages through `sendConversionMessage`.
 */
export async function processQualification(
  deps: QualificationDependencies,
  inboundMessageId: string,
  options: { now?: Date; finalAttempt?: boolean } = {},
): Promise<QualificationRunResult> {
  const now = options.now ?? new Date();
  const { db } = deps;
  const notEligible: QualificationRunResult = {
    outcome: 'NOT_ELIGIBLE',
    evaluationId: null,
    result: null,
    sends: [],
  };

  const inbound = await db.message.findUnique({
    where: { id: inboundMessageId },
    select: {
      id: true,
      direction: true,
      body: true,
      toNumber: true,
      createdAt: true,
      replyProcessing: { select: { status: true, action: true } },
      qualificationEvaluation: { select: { id: true, result: true } },
      campaignLead: {
        select: {
          id: true,
          status: true,
          campaignId: true,
          leadId: true,
          lead: { select: { phone: true, email: true, automationPausedAt: true } },
          campaign: { select: { config: true } },
        },
      },
    },
  });
  if (inbound === null) return notEligible;
  if (inbound.qualificationEvaluation !== null) {
    return {
      outcome: 'ALREADY_EVALUATED',
      evaluationId: inbound.qualificationEvaluation.id,
      result: inbound.qualificationEvaluation.result,
      sends: [],
    };
  }

  const member = inbound.campaignLead;
  const parsedConfig =
    member === null ? null : campaignConfigSchema.safeParse(member.campaign.config);
  const campaignConfig = parsedConfig?.success === true ? parsedConfig.data : null;
  const qualification = campaignConfig?.qualification;
  const action = inbound.replyProcessing?.action ?? null;
  if (
    member === null ||
    campaignConfig === null ||
    qualification === undefined ||
    inbound.direction !== MessageDirection.INBOUND ||
    inbound.body === null ||
    member.status !== CampaignLeadStatus.ENGAGED ||
    member.lead.automationPausedAt !== null ||
    inbound.replyProcessing?.status !== ReplyProcessingStatus.COMPLETED ||
    action === null ||
    !QUALIFYING_REPLY_ACTIONS.includes(action) ||
    now.getTime() - inbound.createdAt.getTime() > deps.replies.maxInboundAgeMs
  ) {
    return notEligible;
  }

  const suppressed = await findSuppressed(db, {
    phones: [member.lead.phone],
    emails: member.lead.email === null ? [] : [member.lead.email],
  });
  if (suppressed.phones.size > 0 || suppressed.emails.size > 0) return notEligible;

  // --- Extraction (AI produces candidate facts only) -----------------------
  const known = await loadQualificationFacts(db, member.id);
  const requested = qualification.fields.filter((field) => {
    const fact = known.get(field.key);
    return fact === undefined || fact.source === QualificationFactSource.CONVERSATION;
  });
  let extraction: Extraction = {
    outcome: ExtractionOutcome.NOT_REQUIRED,
    facts: [],
    discarded: [],
    aiModel: null,
    aiRequestId: null,
    errorCode: null,
  };
  if (requested.length > 0) {
    try {
      const history = await loadConversationHistory(
        db,
        { id: inbound.id, campaignLeadId: member.id, createdAt: inbound.createdAt },
        deps.replies.historyLimit,
        deps.replies.historyMessageMaxChars,
      );
      const extracted = await extractQualificationFacts(deps.ai, {
        fields: requested,
        latestMessage: inbound.body,
        history,
        maxOutputTokens: deps.conversion.extractionMaxOutputTokens,
      });
      extraction = {
        outcome: ExtractionOutcome.EXTRACTED,
        facts: extracted.facts,
        discarded: extracted.discarded,
        aiModel: extracted.meta.model,
        aiRequestId: extracted.meta.requestId,
        errorCode: extracted.discarded.length > 0 ? 'UNSUPPORTED_VALUE' : null,
      };
    } catch (err) {
      if (err instanceof AiProviderError && err.retryable && options.finalAttempt === false) {
        throw err;
      }
      if (err instanceof InvalidAiOutputError) {
        extraction = {
          ...extraction,
          outcome: ExtractionOutcome.INVALID_OUTPUT,
          aiModel: err.meta.model,
          aiRequestId: err.meta.requestId,
          errorCode: 'INVALID_AI_OUTPUT',
        };
      } else if (err instanceof AiProviderError) {
        extraction = {
          ...extraction,
          outcome:
            err.failure === 'INVALID_OUTPUT'
              ? ExtractionOutcome.INVALID_OUTPUT
              : ExtractionOutcome.AI_UNAVAILABLE,
          errorCode: err.failure,
        };
      } else {
        throw err;
      }
      deps.logger.warn(
        {
          operation: 'qualification.extract',
          campaignLeadId: member.id,
          messageId: inbound.id,
          errorCode: extraction.errorCode,
        },
        'extraction unusable; existing facts kept',
      );
    }
  }

  // --- Deterministic evaluation and side effects (one transaction) --------
  const fromNumber = E164.test(inbound.toNumber) ? inbound.toNumber : deps.outbound.fromNumber;
  const applied = await db.$transaction(
    async (tx: DbClient) => {
      const locked = await tx.$queryRaw<
        { status: CampaignLeadStatus; automationPausedAt: Date | null }[]
      >`
        SELECT cl."status", l."automationPausedAt"
        FROM "CampaignLead" cl JOIN "Lead" l ON l."id" = cl."leadId"
        WHERE cl."id" = ${member.id}::uuid
        FOR UPDATE OF cl FOR SHARE OF l`;
      if (locked[0]?.status !== CampaignLeadStatus.ENGAGED)
        return { kind: 'state_changed' as const };
      // Phase 4 human takeover: no evaluation, transition or message while paused.
      if (locked[0].automationPausedAt !== null) return { kind: 'paused' as const };

      const existing = await tx.qualificationEvaluation.findUnique({
        where: { inboundMessageId: inbound.id },
        select: { id: true, result: true },
      });
      if (existing !== null) return { kind: 'already' as const, ...existing };

      const { skipped } = await recordQualificationFacts(tx, {
        campaignLeadId: member.id,
        config: qualification,
        facts: extraction.facts,
        source: QualificationFactSource.CONVERSATION,
        observedAt: inbound.createdAt,
        sourceMessageId: inbound.id,
      });
      const stored = await loadQualificationFacts(tx, member.id);
      const values = new Map([...stored].map(([field, fact]) => [field, fact.value]));
      const decision = evaluateQualification(qualification, values);
      const usedFacts = Object.fromEntries(
        qualification.fields.flatMap((field) => {
          const value = parseFactValue(field, values.get(field.key));
          return value === undefined ? [] : [[field.key, value]];
        }),
      );

      const evaluation = await tx.qualificationEvaluation.create({
        data: {
          campaignLeadId: member.id,
          inboundMessageId: inbound.id,
          result: decision.result,
          missingFields: decision.missingFields,
          failedRequirements: decision.failedRequirements,
          nextField: decision.nextField,
          facts: usedFacts,
          rulesHash: createHash('sha256').update(JSON.stringify(qualification)).digest('hex'),
          rulesSnapshot: qualification,
          extraction: extraction.outcome,
          discardedFields: [...extraction.discarded, ...skipped],
          aiModel: extraction.aiModel,
          aiRequestId: extraction.aiRequestId,
          errorCode: extraction.errorCode,
          evaluatedAt: now,
        },
      });

      const messageIds: string[] = [];
      switch (decision.result) {
        case QualificationResult.PENDING_INFORMATION: {
          const field = qualification.fields.find((f) => f.key === decision.nextField);
          if (field?.question === undefined) break;
          const sendKey = qualificationQuestionSendKey(member.id, field.key);
          const created = await tx.message.createMany({
            data: [
              {
                direction: MessageDirection.OUTBOUND,
                purpose: MessagePurpose.QUALIFICATION_QUESTION,
                status: MessageStatus.PENDING,
                provider: deps.outbound.provider.name,
                leadId: member.leadId,
                campaignId: member.campaignId,
                campaignLeadId: member.id,
                fromNumber,
                toNumber: member.lead.phone,
                body: field.question,
                sendKey,
              },
            ],
            skipDuplicates: true,
          });
          if (created.count === 1) {
            const question = await tx.message.findUniqueOrThrow({
              where: { sendKey },
              select: { id: true },
            });
            messageIds.push(question.id);
          }
          break;
        }
        case QualificationResult.NOT_QUALIFIED:
          await transitionCampaignLead(
            tx,
            {
              campaignLeadId: member.id,
              from: CampaignLeadStatus.ENGAGED,
              to: CampaignLeadStatus.DORMANT_ARCHIVED,
            },
            now,
          );
          break;
        case QualificationResult.QUALIFIED: {
          await transitionCampaignLead(
            tx,
            {
              campaignLeadId: member.id,
              from: CampaignLeadStatus.ENGAGED,
              to: CampaignLeadStatus.QUALIFIED,
            },
            now,
          );
          if (campaignConfig.booking === undefined) {
            deps.logger.warn(
              {
                operation: 'qualification.apply',
                campaignLeadId: member.id,
                campaignId: member.campaignId,
              },
              'member qualified but the campaign has no booking config; no link offered',
            );
            break;
          }
          const offer = await offerBooking(tx, {
            campaignLeadId: member.id,
            campaignId: member.campaignId,
            leadId: member.leadId,
            toNumber: member.lead.phone,
            fromNumber,
            messagingProvider: deps.outbound.provider.name,
            booking: campaignConfig.booking,
          });
          if (offer.messageId !== null) messageIds.push(offer.messageId);
          break;
        }
      }
      return {
        kind: 'evaluated' as const,
        id: evaluation.id,
        result: decision.result,
        messageIds,
      };
    },
    {
      timeout: deps.conversion.transactionTimeoutMs,
      maxWait: deps.conversion.transactionTimeoutMs,
    },
  );

  if (applied.kind === 'paused') return notEligible;
  if (applied.kind === 'state_changed') {
    return { outcome: 'STATE_CHANGED', evaluationId: null, result: null, sends: [] };
  }
  if (applied.kind === 'already') {
    return {
      outcome: 'ALREADY_EVALUATED',
      evaluationId: applied.id,
      result: applied.result,
      sends: [],
    };
  }

  const sends: ConversionSendOutcome[] = [];
  for (const messageId of applied.messageIds) {
    sends.push((await sendConversionMessage(deps.outbound, messageId, now)).outcome);
  }
  deps.logger.info(
    {
      operation: 'qualification.process',
      campaignLeadId: member.id,
      messageId: inbound.id,
      status: applied.result,
      extraction: extraction.outcome,
      sends,
    },
    'qualification evaluated',
  );
  return { outcome: 'EVALUATED', evaluationId: applied.id, result: applied.result, sends };
}

/**
 * Inbound messages that may trigger qualification and have no evaluation yet,
 * oldest first.
 *
 * ponytail: the campaign-has-rules filter runs after the SQL limit, so a batch
 * full of messages from campaigns without rules delays later ones until they
 * age out (maxInboundAgeMs). Storing a rules flag on Campaign is the upgrade path.
 */
export async function findInboundNeedingQualification(
  db: DbClient,
  now: Date,
  maxInboundAgeMs: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.message.findMany({
    where: {
      direction: MessageDirection.INBOUND,
      createdAt: { gt: new Date(now.getTime() - maxInboundAgeMs) },
      qualificationEvaluation: { is: null },
      replyProcessing: {
        is: {
          status: ReplyProcessingStatus.COMPLETED,
          action: { in: [...QUALIFYING_REPLY_ACTIONS] },
        },
      },
      campaignLead: { is: { status: CampaignLeadStatus.ENGAGED } },
      lead: { is: { automationPausedAt: null } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, campaignLead: { select: { campaign: { select: { config: true } } } } },
  });
  return rows
    .filter((row) => {
      const config = campaignConfigSchema.safeParse(row.campaignLead?.campaign.config);
      return config.success && config.data.qualification !== undefined;
    })
    .map((row) => row.id);
}

/** Questions and booking links persisted but not sent (crash, or retryable rejection). */
export async function findPendingConversionMessages(
  db: DbClient,
  now: Date,
  olderThanMs: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.message.findMany({
    where: {
      direction: MessageDirection.OUTBOUND,
      purpose: { in: [MessagePurpose.QUALIFICATION_QUESTION, MessagePurpose.BOOKING_LINK] },
      status: MessageStatus.PENDING,
      updatedAt: { lt: new Date(now.getTime() - olderThanMs) },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
