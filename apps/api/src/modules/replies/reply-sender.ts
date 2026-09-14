import { CampaignLeadStatus, MessageStatus } from '../../generated/prisma/enums.js';
import type { SendMessageResult } from '../../providers/messaging/index.js';
import { canTransitionCampaignLead, transitionCampaignLead } from '../campaigns/membership.js';
import type { OutboundDependencies } from '../messaging/outbound.js';
import { addSuppression, findSuppressed } from '../suppression/suppression.js';

export type ReplySendOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'RETRY_LATER'
  | 'UNCERTAIN'
  | 'CANCELLED'
  | 'ALREADY_HANDLED'
  | 'IN_FLIGHT'
  | 'NOT_FOUND';

interface ReplyRow {
  id: string;
  status: MessageStatus;
  sendingStartedAt: Date | null;
  toNumber: string;
  fromNumber: string;
  body: string | null;
  campaignLeadId: string;
  membershipStatus: CampaignLeadStatus;
  email: string | null;
}

type Prepared =
  { kind: 'send'; row: ReplyRow; body: string } | { kind: 'done'; outcome: ReplySendOutcome };

/**
 * Send one PENDING conversational reply through the messaging provider, at
 * most once. Same guarantees as Step 1 sending (Phase 2 / Prompt 1):
 *  - the Message row and membership are locked; only PENDING is sent;
 *  - membership must not be OPTED_OUT, and global suppression is re-checked
 *    under a SHARE lock immediately before the claim;
 *  - the row is claimed as SENDING before the provider call;
 *  - UNCERTAIN outcomes are never resent automatically.
 * The reply text was persisted before this function runs.
 */
export async function sendConversationalReply(
  deps: OutboundDependencies,
  replyMessageId: string,
  now: Date = new Date(),
): Promise<{ outcome: ReplySendOutcome }> {
  const prepared = await deps.db.$transaction(
    async (tx): Promise<Prepared> => {
      const rows = await tx.$queryRaw<ReplyRow[]>`
        SELECT m."id", m."status", m."sendingStartedAt", m."toNumber", m."fromNumber", m."body",
               m."campaignLeadId", cl."status" AS "membershipStatus", l."email"
        FROM "Message" m
        JOIN "CampaignLead" cl ON cl."id" = m."campaignLeadId"
        JOIN "Lead" l ON l."id" = m."leadId"
        WHERE m."id" = ${replyMessageId}::uuid
          AND m."purpose" = 'CONVERSATIONAL_REPLY'::"MessagePurpose"
        FOR UPDATE OF m, cl`;
      const row = rows[0];
      if (row === undefined) return { kind: 'done', outcome: 'NOT_FOUND' };

      if (row.status === MessageStatus.SENDING) {
        const startedAt = row.sendingStartedAt?.getTime() ?? 0;
        if (now.getTime() - startedAt <= deps.sendingStaleAfterMs)
          return { kind: 'done', outcome: 'IN_FLIGHT' };
        await tx.message.update({
          where: { id: row.id },
          data: { status: MessageStatus.UNCERTAIN, errorCode: 'SENDING_INTERRUPTED' },
        });
        return { kind: 'done', outcome: 'UNCERTAIN' };
      }
      if (row.status !== MessageStatus.PENDING) return { kind: 'done', outcome: 'ALREADY_HANDLED' };

      const cancel = async (reason: string): Promise<Prepared> => {
        await tx.message.update({
          where: { id: row.id },
          data: { status: MessageStatus.CANCELLED, errorCode: reason },
        });
        return { kind: 'done', outcome: 'CANCELLED' };
      };

      if (row.membershipStatus === CampaignLeadStatus.OPTED_OUT)
        return cancel('MEMBERSHIP_OPTED_OUT');

      await tx.$executeRaw`LOCK TABLE "SuppressionEntry" IN SHARE MODE`;
      const suppressed = await findSuppressed(tx, {
        phones: [row.toNumber],
        emails: row.email === null ? [] : [row.email],
      });
      if (suppressed.phones.size > 0 || suppressed.emails.size > 0) {
        if (canTransitionCampaignLead(row.membershipStatus, CampaignLeadStatus.OPTED_OUT)) {
          await transitionCampaignLead(
            tx,
            {
              campaignLeadId: row.campaignLeadId,
              from: row.membershipStatus,
              to: CampaignLeadStatus.OPTED_OUT,
            },
            now,
          );
        }
        return cancel('SUPPRESSED');
      }
      if (row.body === null) return cancel('EMPTY_BODY');

      await tx.message.update({
        where: { id: row.id },
        data: { status: MessageStatus.SENDING, sendingStartedAt: now, errorCode: null },
      });
      return { kind: 'send', row, body: row.body };
    },
    { timeout: deps.transactionTimeoutMs, maxWait: deps.transactionTimeoutMs },
  );

  if (prepared.kind === 'done') return { outcome: prepared.outcome };
  const { row } = prepared;

  let result: SendMessageResult;
  try {
    result = await deps.provider.sendMessage({
      to: row.toNumber,
      from: row.fromNumber,
      body: prepared.body,
      statusCallbackUrl: deps.statusCallbackUrl,
    });
  } catch (err) {
    deps.logger.error(
      { err, operation: 'replies.send', messageId: row.id, provider: deps.provider.name },
      'messaging adapter threw; recording reply as UNCERTAIN',
    );
    result = { outcome: 'UNCERTAIN', errorCode: 'ADAPTER_ERROR' };
  }

  const at = new Date();
  return deps.db.$transaction(
    async (tx) => {
      if (result.outcome === 'ACCEPTED') {
        await tx.message.update({
          where: { id: row.id },
          data: {
            status: MessageStatus.ACCEPTED,
            providerMessageId: result.providerMessageId,
            acceptedAt: at,
            errorCode: null,
          },
        });
        return { outcome: 'ACCEPTED' as const };
      }
      if (result.outcome === 'UNCERTAIN') {
        await tx.message.update({
          where: { id: row.id },
          data: { status: MessageStatus.UNCERTAIN, errorCode: result.errorCode },
        });
        deps.logger.warn(
          { operation: 'replies.send', messageId: row.id, errorCode: result.errorCode },
          'reply outcome unknown; marked UNCERTAIN and will not be resent',
        );
        return { outcome: 'UNCERTAIN' as const };
      }
      if (result.retryable) {
        await tx.message.update({
          where: { id: row.id },
          data: { status: MessageStatus.PENDING, errorCode: result.errorCode },
        });
        return { outcome: 'RETRY_LATER' as const };
      }

      await tx.message.update({
        where: { id: row.id },
        data: { status: MessageStatus.FAILED, failedAt: at, errorCode: result.errorCode },
      });
      if (result.recipientOptedOut) {
        const existing = await findSuppressed(tx, { phones: [row.toNumber], emails: [] });
        if (existing.phones.size === 0) {
          await addSuppression(tx, {
            phone: row.toNumber,
            reason: 'OPT_OUT',
            source: 'PROVIDER',
            reference: `${deps.provider.name}:${result.errorCode}`,
          });
        }
        const member = await tx.campaignLead.findUnique({
          where: { id: row.campaignLeadId },
          select: { status: true },
        });
        if (
          member !== null &&
          canTransitionCampaignLead(member.status, CampaignLeadStatus.OPTED_OUT)
        ) {
          await transitionCampaignLead(
            tx,
            {
              campaignLeadId: row.campaignLeadId,
              from: member.status,
              to: CampaignLeadStatus.OPTED_OUT,
            },
            at,
          );
        }
      }
      return { outcome: 'REJECTED' as const };
    },
    { timeout: deps.transactionTimeoutMs, maxWait: deps.transactionTimeoutMs },
  );
}
