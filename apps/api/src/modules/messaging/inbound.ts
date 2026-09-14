import type { Database, DbClient } from '../../db/client.js';
import {
  CampaignLeadStatus,
  InboundResolution,
  MessageDirection,
  MessagePurpose,
  MessageStatus,
  SafetyAction,
  WebhookEventKind,
  WebhookEventOutcome,
} from '../../generated/prisma/enums.js';
import type { InboundMessageEvent } from '../../providers/messaging/index.js';
import { canTransitionCampaignLead, transitionCampaignLead } from '../campaigns/membership.js';
import { normalizePhone } from '../leads/phone.js';
import { addSuppression, findSuppressed } from '../suppression/suppression.js';
import { isHardOptOut } from './opt-out.js';

export interface InboundResult {
  messageId: string | null;
  /** The same provider message was already processed; nothing was changed. */
  duplicate: boolean;
  resolution: InboundResolution | null;
  hardOptOut: boolean;
}

interface Association {
  resolution: InboundResolution;
  campaignId: string | null;
  campaignLeadId: string | null;
}

/**
 * Persist one inbound SMS exactly once and apply deterministic safety handling.
 *
 * One transaction:
 *  1. Insert the webhook event (UNIQUE provider + eventKey). If it already
 *     exists this delivery is a duplicate: return without changing anything.
 *  2. Resolve the sender to a lead by E.164 phone, and campaign context from
 *     outbound campaign messages sent to that lead from the receiving number.
 *     Zero or several matches are recorded as such, never guessed.
 *  3. Insert the Message (UNIQUE provider + providerMessageId).
 *  4. Hard opt-out command: create global suppression for the phone (unless
 *     one exists) and move every campaign membership that can opt out to
 *     OPTED_OUT through the transition service.
 *
 * Messages without a safety action are left for classification (Prompt 2).
 */
export async function recordInboundMessage(
  db: Database,
  providerName: string,
  event: InboundMessageEvent,
  options: { transactionTimeoutMs: number; now?: Date },
): Promise<InboundResult> {
  const now = options.now ?? new Date();
  const eventKey = `inbound:${event.providerMessageId}`;

  return db.$transaction(
    async (tx) => {
      const inserted = await tx.providerWebhookEvent.createMany({
        data: [
          {
            provider: providerName,
            eventKey,
            kind: WebhookEventKind.INBOUND_MESSAGE,
            providerMessageId: event.providerMessageId,
            outcome: WebhookEventOutcome.PROCESSED,
            receivedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        const existing = await tx.message.findUnique({
          where: {
            provider_providerMessageId: {
              provider: providerName,
              providerMessageId: event.providerMessageId,
            },
          },
          select: { id: true, inboundResolution: true, safetyAction: true },
        });
        return {
          messageId: existing?.id ?? null,
          duplicate: true,
          resolution: existing?.inboundResolution ?? null,
          hardOptOut: existing?.safetyAction === SafetyAction.HARD_OPT_OUT,
        };
      }

      const sender = normalizePhone(event.from);
      const lead = sender.ok
        ? await tx.lead.findUnique({ where: { phone: sender.e164 }, select: { id: true } })
        : null;
      const association: Association =
        lead === null
          ? { resolution: InboundResolution.UNKNOWN_SENDER, campaignId: null, campaignLeadId: null }
          : await associateCampaign(tx, lead.id, event.to);
      const hardOptOut = isHardOptOut(event.body);

      const message = await tx.message.create({
        data: {
          direction: MessageDirection.INBOUND,
          purpose: MessagePurpose.INBOUND_REPLY,
          status: MessageStatus.RECEIVED,
          provider: providerName,
          providerMessageId: event.providerMessageId,
          leadId: lead?.id ?? null,
          campaignId: association.campaignId,
          campaignLeadId: association.campaignLeadId,
          fromNumber: sender.ok ? sender.e164 : event.from,
          toNumber: event.to,
          body: event.body,
          inboundResolution: association.resolution,
          safetyAction: hardOptOut ? SafetyAction.HARD_OPT_OUT : null,
          receivedAt: now,
        },
      });

      await tx.providerWebhookEvent.update({
        where: { provider_eventKey: { provider: providerName, eventKey } },
        data: { messageId: message.id },
      });

      if (hardOptOut && sender.ok) {
        await applyHardOptOut(
          tx,
          sender.e164,
          lead?.id ?? null,
          `${providerName}:${event.providerMessageId}`,
          now,
        );
      }

      return {
        messageId: message.id,
        duplicate: false,
        resolution: association.resolution,
        hardOptOut,
      };
    },
    { timeout: options.transactionTimeoutMs, maxWait: options.transactionTimeoutMs },
  );
}

async function associateCampaign(
  tx: DbClient,
  leadId: string,
  receivingNumber: string,
): Promise<Association> {
  const outbound = await tx.message.findMany({
    where: {
      leadId,
      direction: MessageDirection.OUTBOUND,
      fromNumber: receivingNumber,
      campaignLeadId: { not: null },
      status: {
        in: [
          MessageStatus.ACCEPTED,
          MessageStatus.SENT,
          MessageStatus.DELIVERED,
          MessageStatus.UNCERTAIN,
        ],
      },
    },
    distinct: ['campaignLeadId'],
    select: { campaignId: true, campaignLeadId: true },
    take: 2,
  });

  const [only, second] = outbound;
  if (only === undefined) {
    return { resolution: InboundResolution.NO_CAMPAIGN, campaignId: null, campaignLeadId: null };
  }
  if (second !== undefined) {
    return {
      resolution: InboundResolution.AMBIGUOUS_CAMPAIGN,
      campaignId: null,
      campaignLeadId: null,
    };
  }
  return {
    resolution: InboundResolution.MATCHED,
    campaignId: only.campaignId,
    campaignLeadId: only.campaignLeadId,
  };
}

/** Global suppression for `phone` plus OPTED_OUT for every membership that allows it. */
export async function applyHardOptOut(
  tx: DbClient,
  phone: string,
  leadId: string | null,
  reference: string,
  now: Date,
): Promise<void> {
  const existing = await findSuppressed(tx, { phones: [phone], emails: [] });
  if (existing.phones.size === 0) {
    await addSuppression(tx, { phone, reason: 'OPT_OUT', source: 'INBOUND_MESSAGE', reference });
  }
  if (leadId === null) return;

  const memberships = await tx.campaignLead.findMany({
    where: { leadId },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
  });
  for (const membership of memberships) {
    if (canTransitionCampaignLead(membership.status, CampaignLeadStatus.OPTED_OUT)) {
      await transitionCampaignLead(
        tx,
        {
          campaignLeadId: membership.id,
          from: membership.status,
          to: CampaignLeadStatus.OPTED_OUT,
        },
        now,
      );
    }
  }
}
