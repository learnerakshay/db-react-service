import type { DbClient } from '../../db/client.js';
import {
  BookingStatus,
  CampaignLeadStatus,
  MessagePurpose,
  MessageStatus,
} from '../../generated/prisma/enums.js';
import type { SendMessageResult } from '../../providers/messaging/index.js';
import { canTransitionCampaignLead, transitionCampaignLead } from '../campaigns/membership.js';
import type { OutboundDependencies } from '../messaging/outbound.js';
import { addSuppression, findSuppressed } from '../suppression/suppression.js';

export type ConversionSendOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'RETRY_LATER'
  | 'UNCERTAIN'
  | 'CANCELLED'
  | 'ALREADY_HANDLED'
  | 'IN_FLIGHT'
  | 'NOT_FOUND';

interface Row {
  id: string;
  status: MessageStatus;
  purpose: MessagePurpose;
  sendingStartedAt: Date | null;
  toNumber: string;
  fromNumber: string;
  body: string | null;
  campaignLeadId: string;
  membershipStatus: CampaignLeadStatus;
  email: string | null;
  opportunityId: string | null;
  opportunityStatus: BookingStatus | null;
  automationPausedAt: Date | null;
}

type Prepared =
  { kind: 'send'; row: Row; body: string } | { kind: 'done'; outcome: ConversionSendOutcome };

/** Membership status a conversion message still makes sense in. */
const EXPECTED_MEMBERSHIP: Readonly<Partial<Record<MessagePurpose, CampaignLeadStatus>>> = {
  QUALIFICATION_QUESTION: CampaignLeadStatus.ENGAGED,
  BOOKING_LINK: CampaignLeadStatus.QUALIFIED,
};

/**
 * Send one PENDING QUALIFICATION_QUESTION or BOOKING_LINK message at most once.
 * Built the same way as `sendConversationalReply` (Phase 2):
 *  - Message and membership rows locked; only PENDING is sent;
 *  - membership must still be in the state the message was written for
 *    (ENGAGED for questions; QUALIFIED with an OFFERED opportunity for links);
 *  - global suppression re-checked under a SHARE lock immediately before the claim;
 *  - claimed as SENDING before the provider call; UNCERTAIN is never resent.
 * An accepted booking link records `sentAt` on the opportunity and never
 * changes membership status.
 */
export async function sendConversionMessage(
  deps: OutboundDependencies,
  messageId: string,
  now: Date = new Date(),
): Promise<{ outcome: ConversionSendOutcome }> {
  const prepared = await deps.db.$transaction(
    async (tx): Promise<Prepared> => {
      const rows = await tx.$queryRaw<Row[]>`
        SELECT m."id", m."status", m."purpose", m."sendingStartedAt", m."toNumber", m."fromNumber",
               m."body", m."campaignLeadId", cl."status" AS "membershipStatus", l."email",
               bo."id" AS "opportunityId", bo."status" AS "opportunityStatus",
               l."automationPausedAt"
        FROM "Message" m
        JOIN "CampaignLead" cl ON cl."id" = m."campaignLeadId"
        JOIN "Lead" l ON l."id" = m."leadId"
        LEFT JOIN "BookingOpportunity" bo ON bo."linkMessageId" = m."id"
        WHERE m."id" = ${messageId}::uuid
          AND m."purpose" IN ('QUALIFICATION_QUESTION'::"MessagePurpose", 'BOOKING_LINK'::"MessagePurpose")
        FOR UPDATE OF m, cl FOR SHARE OF l`;
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

      if (row.membershipStatus !== EXPECTED_MEMBERSHIP[row.purpose]) {
        return cancel('MEMBERSHIP_STATE_CHANGED');
      }
      if (
        row.purpose === MessagePurpose.BOOKING_LINK &&
        row.opportunityStatus !== BookingStatus.OFFERED
      ) {
        return cancel('OPPORTUNITY_NOT_OFFERED');
      }

      await tx.$executeRaw`LOCK TABLE "SuppressionEntry" IN SHARE MODE`;
      const suppressed = await findSuppressed(tx, {
        phones: [row.toNumber],
        emails: row.email === null ? [] : [row.email],
      });
      if (suppressed.phones.size > 0 || suppressed.emails.size > 0) {
        await optOutMembership(
          tx,
          row.campaignLeadId,
          row.membershipStatus,
          row.opportunityId,
          now,
        );
        return cancel('SUPPRESSED');
      }
      // Phase 4 human takeover: the operator owns the conversation.
      if (row.automationPausedAt !== null) return cancel('HUMAN_TAKEOVER');
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
      { err, operation: 'conversion.send', messageId: row.id, provider: deps.provider.name },
      'messaging adapter threw; recording conversion message as UNCERTAIN',
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
        if (row.opportunityId !== null) {
          await tx.bookingOpportunity.update({
            where: { id: row.opportunityId },
            data: { sentAt: at },
          });
        }
        return { outcome: 'ACCEPTED' as const };
      }
      if (result.outcome === 'UNCERTAIN') {
        await tx.message.update({
          where: { id: row.id },
          data: { status: MessageStatus.UNCERTAIN, errorCode: result.errorCode },
        });
        deps.logger.warn(
          { operation: 'conversion.send', messageId: row.id, errorCode: result.errorCode },
          'conversion message outcome unknown; marked UNCERTAIN and will not be resent',
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
        if (member !== null) {
          await optOutMembership(tx, row.campaignLeadId, member.status, row.opportunityId, at);
        }
      }
      return { outcome: 'REJECTED' as const };
    },
    { timeout: deps.transactionTimeoutMs, maxWait: deps.transactionTimeoutMs },
  );
}

async function optOutMembership(
  tx: DbClient,
  campaignLeadId: string,
  status: CampaignLeadStatus,
  opportunityId: string | null,
  now: Date,
): Promise<void> {
  if (canTransitionCampaignLead(status, CampaignLeadStatus.OPTED_OUT)) {
    await transitionCampaignLead(
      tx,
      { campaignLeadId, from: status, to: CampaignLeadStatus.OPTED_OUT },
      now,
    );
  }
  if (opportunityId !== null) {
    await tx.bookingOpportunity.updateMany({
      where: { id: opportunityId, status: BookingStatus.OFFERED },
      data: { status: BookingStatus.CANCELLED, cancelledAt: now },
    });
  }
}
