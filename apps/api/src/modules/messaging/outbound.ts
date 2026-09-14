import type { Database, DbClient } from '../../db/client.js';
import {
  CampaignLeadStatus,
  CampaignStatus,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
} from '../../generated/prisma/enums.js';
import type { Logger } from '../../lib/logger.js';
import type { MessagingProvider, SendMessageResult } from '../../providers/messaging/index.js';
import { campaignConfigSchema, type CampaignConfigSnapshot } from '../campaigns/campaigns.js';
import { transitionCampaignLead } from '../campaigns/membership.js';
import {
  isWithinSendWindow,
  localTimeOfDay,
  resolveRecipientTimezone,
} from '../dispatch/send-window.js';
import { addSuppression, findSuppressed } from '../suppression/suppression.js';
import { renderStep1Message } from './template.js';

export interface OutboundDependencies {
  db: Database;
  provider: MessagingProvider;
  logger: Logger;
  /** E.164 sender number. */
  fromNumber: string;
  statusCallbackUrl: string | null;
  sendingStaleAfterMs: number;
  transactionTimeoutMs: number;
}

export type Step1SendOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'RETRY_LATER'
  | 'UNCERTAIN'
  | 'CANCELLED_SUPPRESSED'
  | 'CANCELLED_TEMPLATE'
  | 'SKIPPED_NOT_QUEUED'
  | 'SKIPPED_CAMPAIGN_NOT_ACTIVE'
  | 'SKIPPED_NO_TEMPLATE'
  | 'SKIPPED_OUTSIDE_WINDOW'
  | 'ALREADY_HANDLED'
  | 'IN_FLIGHT';

export interface Step1SendResult {
  outcome: Step1SendOutcome;
  messageId: string | null;
}

/** One logical Step 1 send per membership, enforced by UNIQUE Message.sendKey. */
export function step1SendKey(campaignLeadId: string): string {
  return `${campaignLeadId}:${MessagePurpose.CAMPAIGN_STEP_1}`;
}

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
}

type Prepared =
  | { kind: 'send'; messageId: string; to: string; body: string }
  | { kind: 'done'; result: Step1SendResult };

/**
 * Send the Step 1 message for one QUEUED membership, at most once.
 *
 *  1. Prepare (transaction, membership row locked FOR UPDATE):
 *     existing logical send? → report it, never send again;
 *     membership still QUEUED, campaign ACTIVE, template present, recipient
 *     inside send window; then, holding SHARE on SuppressionEntry, the final
 *     suppression check. Claim by writing the Message as SENDING.
 *  2. Call the provider outside any transaction.
 *  3. Record: ACCEPTED → Message ACCEPTED + STEP_1_SENT; definite rejection →
 *     FAILED (or PENDING when retryable); unknown outcome → UNCERTAIN.
 *
 * STEP_1_SENT is written only after the provider accepted the message.
 */
export async function sendStep1Message(
  deps: OutboundDependencies,
  campaignLeadId: string,
  now: Date = new Date(),
): Promise<Step1SendResult> {
  const prepared = await prepareStep1(deps, campaignLeadId, now);
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
      { err, operation: 'messaging.send', campaignLeadId, provider: deps.provider.name },
      'messaging adapter threw; recording the send as UNCERTAIN',
    );
    result = { outcome: 'UNCERTAIN', errorCode: 'ADAPTER_ERROR' };
  }

  return recordSendResult(deps, campaignLeadId, prepared, result);
}

async function prepareStep1(
  deps: OutboundDependencies,
  campaignLeadId: string,
  now: Date,
): Promise<Prepared> {
  const sendKey = step1SendKey(campaignLeadId);

  return deps.db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<MemberRow[]>`
        SELECT cl."id", cl."status", cl."campaignId", cl."leadId",
               c."status" AS "campaignStatus", c."config",
               l."phone", l."email", l."firstName", l."lastName", l."timezone"
        FROM "CampaignLead" cl
        JOIN "Campaign" c ON c."id" = cl."campaignId"
        JOIN "Lead" l ON l."id" = cl."leadId"
        WHERE cl."id" = ${campaignLeadId}::uuid
        FOR UPDATE OF cl FOR SHARE OF c`;
      const member = rows[0];
      if (member === undefined) return done('SKIPPED_NOT_QUEUED', null);

      const existing = await tx.message.findUnique({
        where: { sendKey },
        select: { id: true, status: true, sendingStartedAt: true },
      });

      if (existing !== null && existing.status !== MessageStatus.PENDING) {
        if (existing.status !== MessageStatus.SENDING) return done('ALREADY_HANDLED', existing.id);
        const startedAt = existing.sendingStartedAt?.getTime() ?? 0;
        if (now.getTime() - startedAt <= deps.sendingStaleAfterMs)
          return done('IN_FLIGHT', existing.id);
        // A send was claimed but never recorded: the provider may have accepted it.
        await tx.message.update({
          where: { id: existing.id },
          data: { status: MessageStatus.UNCERTAIN, errorCode: 'SENDING_INTERRUPTED' },
        });
        return done('UNCERTAIN', existing.id);
      }

      const existingId = existing?.id ?? null;

      if (member.status !== CampaignLeadStatus.QUEUED) {
        if (existing !== null) await cancel(tx, existing.id, 'MEMBERSHIP_NOT_QUEUED');
        return done('SKIPPED_NOT_QUEUED', existingId);
      }
      if (member.campaignStatus !== CampaignStatus.ACTIVE) {
        return done('SKIPPED_CAMPAIGN_NOT_ACTIVE', existingId);
      }

      const parsed = campaignConfigSchema.safeParse(member.config);
      const template = parsed.success ? parsed.data.messages?.step1 : undefined;
      if (!parsed.success || template === undefined) return done('SKIPPED_NO_TEMPLATE', existingId);

      if (!insideSendWindow(parsed.data, member.timezone, now)) {
        return done('SKIPPED_OUTSIDE_WINDOW', existingId);
      }

      // Final suppression check. SHARE mode makes concurrent suppression inserts
      // wait until this claim commits; the provider is called right after.
      await tx.$executeRaw`LOCK TABLE "SuppressionEntry" IN SHARE MODE`;
      const suppressed = await findSuppressed(tx, {
        phones: [member.phone],
        emails: member.email === null ? [] : [member.email],
      });
      if (suppressed.phones.size > 0 || suppressed.emails.size > 0) {
        const messageId = await recordCancelled(tx, deps, member, existingId, 'SUPPRESSED');
        await transitionCampaignLead(
          tx,
          { campaignLeadId, from: CampaignLeadStatus.QUEUED, to: CampaignLeadStatus.OPTED_OUT },
          now,
        );
        return done('CANCELLED_SUPPRESSED', messageId);
      }

      const rendered = renderStep1Message(template, member);
      if (!rendered.ok) {
        deps.logger.error(
          { operation: 'messaging.render', campaignLeadId, campaignId: member.campaignId },
          'step 1 template could not be rendered; send cancelled',
        );
        const messageId = await recordCancelled(
          tx,
          deps,
          member,
          existingId,
          'TEMPLATE_RENDER_FAILED',
        );
        // Unrecoverable for this membership: do not leave it QUEUED forever.
        await transitionCampaignLead(
          tx,
          {
            campaignLeadId,
            from: CampaignLeadStatus.QUEUED,
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

async function recordSendResult(
  deps: OutboundDependencies,
  campaignLeadId: string,
  prepared: Extract<Prepared, { kind: 'send' }>,
  result: SendMessageResult,
): Promise<Step1SendResult> {
  const { messageId } = prepared;
  const at = new Date();

  return deps.db.$transaction(
    async (tx) => {
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
        const member = await tx.campaignLead.findUnique({
          where: { id: campaignLeadId },
          select: { status: true },
        });
        if (member?.status === CampaignLeadStatus.QUEUED) {
          await transitionCampaignLead(
            tx,
            { campaignLeadId, from: CampaignLeadStatus.QUEUED, to: CampaignLeadStatus.STEP_1_SENT },
            at,
          );
        } else {
          deps.logger.warn(
            { operation: 'messaging.send', campaignLeadId, messageId, status: member?.status },
            'message accepted but membership changed during the send; status left unchanged',
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
          { operation: 'messaging.send', campaignLeadId, messageId, errorCode: result.errorCode },
          'provider outcome unknown; message marked UNCERTAIN and will not be resent',
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

      if (result.recipientOptedOut) {
        // The carrier/provider holds an opt-out for this number: make it global here too.
        const existing = await findSuppressed(tx, { phones: [prepared.to], emails: [] });
        if (existing.phones.size === 0) {
          await addSuppression(tx, {
            phone: prepared.to,
            reason: 'OPT_OUT',
            source: 'PROVIDER',
            reference: `${deps.provider.name}:${result.errorCode}`,
          });
        }
        const member = await tx.campaignLead.findUnique({
          where: { id: campaignLeadId },
          select: { status: true },
        });
        if (member?.status === CampaignLeadStatus.QUEUED) {
          await transitionCampaignLead(
            tx,
            { campaignLeadId, from: CampaignLeadStatus.QUEUED, to: CampaignLeadStatus.OPTED_OUT },
            at,
          );
        }
      } else {
        // Permanent rejection (e.g. invalid recipient) is never retried, so the
        // membership must not stay QUEUED forever.
        await archiveQueuedMembership(tx, campaignLeadId, at);
      }
      return { outcome: 'REJECTED', messageId };
    },
    { timeout: deps.transactionTimeoutMs, maxWait: deps.transactionTimeoutMs },
  );
}

/**
 * QUEUED memberships that still need a Step 1 attempt: ACTIVE campaign, a
 * template, recipient inside the send window now, and no logical send yet
 * (or only a retryable PENDING one). Oldest queued first.
 *
 * ponytail: the window filter runs after the SQL limit; if `limit` members at
 * the head are all out of window, later in-window members wait for a later
 * tick. Per-timezone selection is the upgrade path.
 */
export async function findStep1SendCandidates(
  db: DbClient,
  now: Date,
  limit: number,
): Promise<string[]> {
  const members = await db.campaignLead.findMany({
    where: {
      status: CampaignLeadStatus.QUEUED,
      campaign: { status: CampaignStatus.ACTIVE },
      messages: {
        none: {
          direction: MessageDirection.OUTBOUND,
          purpose: MessagePurpose.CAMPAIGN_STEP_1,
          status: { not: MessageStatus.PENDING },
        },
      },
    },
    orderBy: [{ statusChangedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: {
      id: true,
      lead: { select: { timezone: true } },
      campaign: { select: { config: true } },
    },
  });

  return members
    .filter((member) => {
      const config = campaignConfigSchema.safeParse(member.campaign.config);
      return (
        config.success &&
        config.data.messages !== undefined &&
        insideSendWindow(config.data, member.lead.timezone, now)
      );
    })
    .map((member) => member.id);
}

/** Claimed sends that never recorded an outcome become UNCERTAIN (not resent). */
async function archiveQueuedMembership(
  tx: DbClient,
  campaignLeadId: string,
  at: Date,
): Promise<void> {
  const member = await tx.campaignLead.findUnique({
    where: { id: campaignLeadId },
    select: { status: true },
  });
  if (member?.status === CampaignLeadStatus.QUEUED) {
    await transitionCampaignLead(
      tx,
      { campaignLeadId, from: CampaignLeadStatus.QUEUED, to: CampaignLeadStatus.DORMANT_ARCHIVED },
      at,
    );
  }
}

/**
 * Archive memberships still QUEUED behind a permanent Step 1 failure (FAILED,
 * or cancelled for an unrenderable template), e.g. from before this cleanup
 * existed. UNCERTAIN and retryable PENDING sends are never archived here.
 */
export async function archivePermanentSendFailures(
  db: DbClient,
  now: Date,
  limit: number,
): Promise<number> {
  const stuck = await db.campaignLead.findMany({
    where: {
      status: CampaignLeadStatus.QUEUED,
      messages: {
        some: {
          direction: MessageDirection.OUTBOUND,
          purpose: MessagePurpose.CAMPAIGN_STEP_1,
          OR: [
            { status: MessageStatus.FAILED },
            { status: MessageStatus.CANCELLED, errorCode: 'TEMPLATE_RENDER_FAILED' },
          ],
        },
      },
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true },
  });

  let archived = 0;
  for (const { id } of stuck) {
    const { count } = await db.campaignLead.updateMany({
      where: { id, status: CampaignLeadStatus.QUEUED },
      data: { status: CampaignLeadStatus.DORMANT_ARCHIVED, statusChangedAt: now },
    });
    archived += count;
  }
  return archived;
}

export async function markInterruptedSends(
  db: DbClient,
  now: Date,
  staleAfterMs: number,
): Promise<number> {
  const { count } = await db.message.updateMany({
    where: {
      direction: MessageDirection.OUTBOUND,
      status: MessageStatus.SENDING,
      sendingStartedAt: { lt: new Date(now.getTime() - staleAfterMs) },
    },
    data: { status: MessageStatus.UNCERTAIN, errorCode: 'SENDING_INTERRUPTED' },
  });
  return count;
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
    purpose: MessagePurpose.CAMPAIGN_STEP_1,
    provider: deps.provider.name,
    leadId: member.leadId,
    campaignId: member.campaignId,
    campaignLeadId: member.id,
    fromNumber: deps.fromNumber,
    toNumber: member.phone,
    sendKey: step1SendKey(member.id),
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

function done(outcome: Step1SendOutcome, messageId: string | null): Prepared {
  return { kind: 'done', result: { outcome, messageId } };
}
