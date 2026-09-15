import type { DbClient } from '../../db/client.js';
import {
  CampaignLeadStatus,
  CampaignStatus,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
  ReplyProcessingStatus,
} from '../../generated/prisma/enums.js';
import type { SendMessageResult } from '../../providers/messaging/index.js';
import { campaignConfigSchema, type CampaignConfigSnapshot } from '../campaigns/campaigns.js';
import { canTransitionCampaignLead, transitionCampaignLead } from '../campaigns/membership.js';
import {
  isWithinSendWindow,
  localTimeOfDay,
  resolveRecipientTimezone,
} from '../dispatch/send-window.js';
import { step1SendKey, type OutboundDependencies } from '../messaging/outbound.js';
import { renderStep1Message } from '../messaging/template.js';
import { addSuppression, findSuppressed } from '../suppression/suppression.js';

export type Step2SendOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'RETRY_LATER'
  | 'UNCERTAIN'
  | 'CANCELLED_SUPPRESSED'
  | 'CANCELLED_TEMPLATE'
  | 'SKIPPED_NOT_ELIGIBLE'
  | 'SKIPPED_CAMPAIGN_NOT_ACTIVE'
  | 'SKIPPED_NO_TEMPLATE'
  | 'SKIPPED_NOT_DUE'
  | 'SKIPPED_REPLIED'
  | 'SKIPPED_HUMAN_REVIEW'
  | 'SKIPPED_OUTSIDE_WINDOW'
  | 'SKIPPED_HUMAN_TAKEOVER'
  | 'ALREADY_HANDLED'
  | 'IN_FLIGHT';

export interface Step2SendResult {
  outcome: Step2SendOutcome;
  messageId: string | null;
}

/** One logical Step 2 per membership (UNIQUE Message.sendKey). */
export function step2SendKey(campaignLeadId: string): string {
  return `${campaignLeadId}:${MessagePurpose.CAMPAIGN_STEP_2}`;
}

const HOUR_MS = 3_600_000;

const PROVIDER_ACCEPTED: readonly MessageStatus[] = [
  MessageStatus.ACCEPTED,
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
];

interface MemberRow {
  id: string;
  status: CampaignLeadStatus;
  campaignId: string;
  leadId: string;
  campaignStatus: CampaignStatus;
  config: unknown;
  phone: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  timezone: string | null;
  automationPausedAt: Date | null;
}

type Prepared =
  | { kind: 'send'; messageId: string; to: string; body: string }
  | { kind: 'done'; result: Step2SendResult };

/**
 * Send the Step 2 closeout for one STEP_1_SENT membership, at most once.
 * Built like `sendStep1Message` (Phase 2):
 *
 *  1. Prepare (transaction, membership FOR UPDATE, campaign FOR SHARE):
 *     existing non-PENDING Step 2 → report it, never send again; membership
 *     STEP_1_SENT; campaign ACTIVE; Step 2 template; Step 1 accepted by the
 *     provider at least `followUpDelayHours` ago; no inbound message from the
 *     lead since Step 1; no escalation awaiting a human; inside the send
 *     window; then suppression under SHARE lock. Claim as SENDING.
 *  2. Provider call outside any transaction.
 *  3. Record: ACCEPTED → STEP_2_SENT; retryable rejection → PENDING; unknown →
 *     UNCERTAIN (never resent); permanent rejection → FAILED and the
 *     membership is archived (or opted out for a provider opt-out).
 */
export async function sendStep2Message(
  deps: OutboundDependencies,
  campaignLeadId: string,
  now: Date = new Date(),
): Promise<Step2SendResult> {
  const prepared = await prepareStep2(deps, campaignLeadId, now);
  if (prepared.kind === 'done') return prepared.result;

  let result: SendMessageResult;
  try {
    result = await deps.provider.sendMessage({
      to: prepared.to,
      from: deps.fromNumber,
      body: prepared.body,
      statusCallbackUrl: deps.statusCallbackUrl,
    });
  } catch (err) {
    deps.logger.error(
      { err, operation: 'messaging.step2', campaignLeadId, provider: deps.provider.name },
      'messaging adapter threw; recording step 2 as UNCERTAIN',
    );
    result = { outcome: 'UNCERTAIN', errorCode: 'ADAPTER_ERROR' };
  }
  return recordStep2Result(deps, campaignLeadId, prepared, result);
}

async function prepareStep2(
  deps: OutboundDependencies,
  campaignLeadId: string,
  now: Date,
): Promise<Prepared> {
  const sendKey = step2SendKey(campaignLeadId);

  return deps.db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<MemberRow[]>`
        SELECT cl."id", cl."status", cl."campaignId", cl."leadId",
               c."status" AS "campaignStatus", c."config",
               l."phone", l."email", l."firstName", l."lastName", l."timezone",
               l."automationPausedAt"
        FROM "CampaignLead" cl
        JOIN "Campaign" c ON c."id" = cl."campaignId"
        JOIN "Lead" l ON l."id" = cl."leadId"
        WHERE cl."id" = ${campaignLeadId}::uuid
        FOR UPDATE OF cl FOR SHARE OF c, l`;
      const member = rows[0];
      if (member === undefined) return done('SKIPPED_NOT_ELIGIBLE', null);

      const existing = await tx.message.findUnique({
        where: { sendKey },
        select: { id: true, status: true, sendingStartedAt: true },
      });
      if (existing !== null && existing.status !== MessageStatus.PENDING) {
        if (existing.status !== MessageStatus.SENDING) return done('ALREADY_HANDLED', existing.id);
        const startedAt = existing.sendingStartedAt?.getTime() ?? 0;
        if (now.getTime() - startedAt <= deps.sendingStaleAfterMs)
          return done('IN_FLIGHT', existing.id);
        await tx.message.update({
          where: { id: existing.id },
          data: { status: MessageStatus.UNCERTAIN, errorCode: 'SENDING_INTERRUPTED' },
        });
        return done('UNCERTAIN', existing.id);
      }
      const existingId = existing?.id ?? null;

      if (member.status !== CampaignLeadStatus.STEP_1_SENT) {
        if (existingId !== null) await cancel(tx, existingId, 'MEMBERSHIP_NOT_STEP_1_SENT');
        return done('SKIPPED_NOT_ELIGIBLE', existingId);
      }
      if (member.campaignStatus !== CampaignStatus.ACTIVE) {
        return done('SKIPPED_CAMPAIGN_NOT_ACTIVE', existingId);
      }
      const parsed = campaignConfigSchema.safeParse(member.config);
      const template = parsed.success ? parsed.data.messages?.step2 : undefined;
      if (!parsed.success || template === undefined) return done('SKIPPED_NO_TEMPLATE', existingId);

      const step1 = await tx.message.findUnique({
        where: { sendKey: step1SendKey(campaignLeadId) },
        select: { status: true, acceptedAt: true },
      });
      if (step1?.acceptedAt == null || !PROVIDER_ACCEPTED.includes(step1.status)) {
        return done('SKIPPED_NOT_ELIGIBLE', existingId);
      }
      const dueAt = step1.acceptedAt.getTime() + parsed.data.followUpDelayHours * HOUR_MS;
      if (now.getTime() < dueAt) return done('SKIPPED_NOT_DUE', existingId);

      const replies = await tx.message.count({
        where: {
          leadId: member.leadId,
          direction: MessageDirection.INBOUND,
          createdAt: { gt: step1.acceptedAt },
        },
      });
      if (replies > 0) return done('SKIPPED_REPLIED', existingId);
      const escalations = await tx.replyProcessing.count({
        where: { leadId: member.leadId, status: ReplyProcessingStatus.ESCALATED },
      });
      if (escalations > 0) return done('SKIPPED_HUMAN_REVIEW', existingId);

      if (!insideSendWindow(parsed.data, member.timezone, now)) {
        return done('SKIPPED_OUTSIDE_WINDOW', existingId);
      }

      await tx.$executeRaw`LOCK TABLE "SuppressionEntry" IN SHARE MODE`;
      const suppressed = await findSuppressed(tx, {
        phones: [member.phone],
        emails: member.email === null ? [] : [member.email],
      });
      if (suppressed.phones.size > 0 || suppressed.emails.size > 0) {
        const messageId = await recordCancelled(tx, deps, member, existingId, 'SUPPRESSED');
        await transitionCampaignLead(
          tx,
          {
            campaignLeadId,
            from: CampaignLeadStatus.STEP_1_SENT,
            to: CampaignLeadStatus.OPTED_OUT,
          },
          now,
        );
        return done('CANCELLED_SUPPRESSED', messageId);
      }
      // Phase 4 human takeover (lead row held FOR SHARE): no closeout while paused.
      if (member.automationPausedAt !== null) return done('SKIPPED_HUMAN_TAKEOVER', existingId);

      const rendered = renderStep1Message(template, member);
      if (!rendered.ok) {
        deps.logger.error(
          { operation: 'messaging.step2', campaignLeadId, campaignId: member.campaignId },
          'step 2 template could not be rendered; closeout cancelled',
        );
        const messageId = await recordCancelled(
          tx,
          deps,
          member,
          existingId,
          'TEMPLATE_RENDER_FAILED',
        );
        await transitionCampaignLead(
          tx,
          {
            campaignLeadId,
            from: CampaignLeadStatus.STEP_1_SENT,
            to: CampaignLeadStatus.DORMANT_ARCHIVED,
          },
          now,
        );
        return done('CANCELLED_TEMPLATE', messageId);
      }

      const claim = {
        status: MessageStatus.SENDING,
        body: rendered.body,
        sendingStartedAt: now,
        errorCode: null,
      };
      const message =
        existingId === null
          ? await tx.message.create({ data: { ...outboundBase(deps, member), ...claim } })
          : await tx.message.update({ where: { id: existingId }, data: claim });
      return { kind: 'send', messageId: message.id, to: member.phone, body: rendered.body };
    },
    { timeout: deps.transactionTimeoutMs, maxWait: deps.transactionTimeoutMs },
  );
}

async function recordStep2Result(
  deps: OutboundDependencies,
  campaignLeadId: string,
  prepared: Extract<Prepared, { kind: 'send' }>,
  result: SendMessageResult,
): Promise<Step2SendResult> {
  const { messageId } = prepared;
  const at = new Date();

  return deps.db.$transaction(
    async (tx) => {
      const member = async () =>
        (
          await tx.campaignLead.findUnique({
            where: { id: campaignLeadId },
            select: { status: true },
          })
        )?.status;

      if (result.outcome === 'ACCEPTED') {
        await tx.message.update({
          where: { id: messageId },
          data: {
            status: MessageStatus.ACCEPTED,
            providerMessageId: result.providerMessageId,
            acceptedAt: at,
            errorCode: null,
          },
        });
        const status = await member();
        if (status === CampaignLeadStatus.STEP_1_SENT) {
          await transitionCampaignLead(
            tx,
            { campaignLeadId, from: status, to: CampaignLeadStatus.STEP_2_SENT },
            at,
          );
        } else {
          deps.logger.warn(
            { operation: 'messaging.step2', campaignLeadId, messageId, status },
            'step 2 accepted but membership changed during the send; status left unchanged',
          );
        }
        return { outcome: 'ACCEPTED', messageId };
      }

      if (result.outcome === 'UNCERTAIN') {
        await tx.message.update({
          where: { id: messageId },
          data: { status: MessageStatus.UNCERTAIN, errorCode: result.errorCode },
        });
        deps.logger.warn(
          { operation: 'messaging.step2', campaignLeadId, messageId, errorCode: result.errorCode },
          'step 2 outcome unknown; marked UNCERTAIN and will not be resent',
        );
        return { outcome: 'UNCERTAIN', messageId };
      }

      if (result.retryable) {
        await tx.message.update({
          where: { id: messageId },
          data: { status: MessageStatus.PENDING, errorCode: result.errorCode },
        });
        return { outcome: 'RETRY_LATER', messageId };
      }

      await tx.message.update({
        where: { id: messageId },
        data: { status: MessageStatus.FAILED, failedAt: at, errorCode: result.errorCode },
      });
      const status = await member();
      if (result.recipientOptedOut) {
        const existing = await findSuppressed(tx, { phones: [prepared.to], emails: [] });
        if (existing.phones.size === 0) {
          await addSuppression(tx, {
            phone: prepared.to,
            reason: 'OPT_OUT',
            source: 'PROVIDER',
            reference: `${deps.provider.name}:${result.errorCode}`,
          });
        }
        if (
          status !== undefined &&
          canTransitionCampaignLead(status, CampaignLeadStatus.OPTED_OUT)
        ) {
          await transitionCampaignLead(
            tx,
            { campaignLeadId, from: status, to: CampaignLeadStatus.OPTED_OUT },
            at,
          );
        }
      } else if (status === CampaignLeadStatus.STEP_1_SENT) {
        // The closeout can never be delivered and is never retried: close the lifecycle.
        await transitionCampaignLead(
          tx,
          { campaignLeadId, from: status, to: CampaignLeadStatus.DORMANT_ARCHIVED },
          at,
        );
      }
      return { outcome: 'REJECTED', messageId };
    },
    { timeout: deps.transactionTimeoutMs, maxWait: deps.transactionTimeoutMs },
  );
}

/**
 * STEP_1_SENT memberships that look due for Step 2, oldest Step 1 first: ACTIVE
 * campaign with a Step 2 template, `followUpDelayHours` elapsed, no Step 2
 * beyond a retryable PENDING, no inbound message from the lead since Step 1,
 * no escalation. `sendStep2Message` re-checks everything under lock.
 *
 * ponytail: the send-window filter runs after the SQL limit, as for Step 1; a
 * head of out-of-window members delays in-window ones to a later tick.
 */
export async function findStep2Candidates(
  db: DbClient,
  now: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string; timezone: string | null; config: unknown }[]>`
    SELECT cl."id", l."timezone", c."config"
    FROM "CampaignLead" cl
    JOIN "Campaign" c ON c."id" = cl."campaignId"
    JOIN "Lead" l ON l."id" = cl."leadId"
    WHERE cl."status" = 'STEP_1_SENT'::"CampaignLeadStatus"
      AND c."status" = 'ACTIVE'::"CampaignStatus"
      AND l."automationPausedAt" IS NULL
      AND c."config" -> 'messages' -> 'step2' IS NOT NULL
      AND cl."statusChangedAt"
          + make_interval(secs => (c."config" ->> 'followUpDelayHours')::float8 * 3600)
          <= ${now}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM "Message" s
        WHERE s."campaignLeadId" = cl."id"
          AND s."purpose" = 'CAMPAIGN_STEP_2'::"MessagePurpose"
          AND s."status" <> 'PENDING'::"MessageStatus")
      AND NOT EXISTS (
        SELECT 1 FROM "Message" i
        WHERE i."leadId" = cl."leadId"
          AND i."direction" = 'INBOUND'::"MessageDirection"
          AND i."createdAt" > cl."statusChangedAt")
      AND NOT EXISTS (
        SELECT 1 FROM "ReplyProcessing" r
        WHERE r."leadId" = cl."leadId" AND r."status" = 'ESCALATED'::"ReplyProcessingStatus")
    ORDER BY cl."statusChangedAt", cl."id"
    LIMIT ${limit}`;

  return rows
    .filter((row) => {
      const config = campaignConfigSchema.safeParse(row.config);
      return config.success && insideSendWindow(config.data, row.timezone, now);
    })
    .map((row) => row.id);
}

function insideSendWindow(
  config: CampaignConfigSnapshot,
  leadTimezone: string | null,
  now: Date,
): boolean {
  const zone = resolveRecipientTimezone(leadTimezone, config.timezone);
  return zone !== null && isWithinSendWindow(localTimeOfDay(now, zone.timezone), config.sendWindow);
}

function outboundBase(deps: OutboundDependencies, member: MemberRow) {
  return {
    direction: MessageDirection.OUTBOUND,
    purpose: MessagePurpose.CAMPAIGN_STEP_2,
    provider: deps.provider.name,
    leadId: member.leadId,
    campaignId: member.campaignId,
    campaignLeadId: member.id,
    fromNumber: deps.fromNumber,
    toNumber: member.phone,
    sendKey: step2SendKey(member.id),
  };
}

async function recordCancelled(
  tx: DbClient,
  deps: OutboundDependencies,
  member: MemberRow,
  existingId: string | null,
  reason: string,
): Promise<string> {
  if (existingId !== null) {
    await cancel(tx, existingId, reason);
    return existingId;
  }
  const message = await tx.message.create({
    data: {
      ...outboundBase(deps, member),
      status: MessageStatus.CANCELLED,
      body: null,
      errorCode: reason,
    },
  });
  return message.id;
}

async function cancel(tx: DbClient, messageId: string, reason: string): Promise<void> {
  await tx.message.update({
    where: { id: messageId },
    data: { status: MessageStatus.CANCELLED, errorCode: reason },
  });
}

function done(outcome: Step2SendOutcome, messageId: string | null): Prepared {
  return { kind: 'done', result: { outcome, messageId } };
}
