import type { Database } from '../../db/client.js';
import {
  MessageDirection,
  MessageStatus,
  WebhookEventKind,
  WebhookEventOutcome,
} from '../../generated/prisma/enums.js';
import type { DeliveryStatus, DeliveryStatusEvent } from '../../providers/messaging/index.js';

export interface DeliveryResult {
  duplicate: boolean;
  outcome: WebhookEventOutcome | null;
  messageId: string | null;
}

const DELIVERY_RANK: Readonly<Record<DeliveryStatus, number>> = {
  ACCEPTED: 1,
  SENT: 2,
  DELIVERED: 3,
  FAILED: 3,
};

const TRACKED_FROM: Readonly<Partial<Record<MessageStatus, number>>> = {
  [MessageStatus.ACCEPTED]: 1,
  [MessageStatus.SENT]: 2,
};

/**
 * Delivery updates only move forward: ACCEPTED → SENT → DELIVERED | FAILED.
 * DELIVERED and FAILED are final. Messages in any other state (never accepted,
 * cancelled, inbound) are not changed by delivery events.
 */
export function isForwardDeliveryUpdate(current: MessageStatus, next: DeliveryStatus): boolean {
  const currentRank = TRACKED_FROM[current];
  return currentRank !== undefined && DELIVERY_RANK[next] > currentRank;
}

/**
 * Apply one delivery status callback exactly once. Updates only the Message;
 * campaign membership state is never changed by delivery events.
 */
export async function applyDeliveryStatus(
  db: Database,
  providerName: string,
  event: DeliveryStatusEvent,
  options: { transactionTimeoutMs: number; now?: Date },
): Promise<DeliveryResult> {
  const now = options.now ?? new Date();
  const eventKey = `status:${event.providerMessageId}:${event.providerStatus}`;

  return db.$transaction(
    async (tx) => {
      const inserted = await tx.providerWebhookEvent.createMany({
        data: [
          {
            provider: providerName,
            eventKey,
            kind: WebhookEventKind.DELIVERY_STATUS,
            providerMessageId: event.providerMessageId,
            providerStatus: event.providerStatus,
            errorCode: event.errorCode,
            outcome: WebhookEventOutcome.PROCESSED,
            receivedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return { duplicate: true, outcome: null, messageId: null };

      const rows = await tx.$queryRaw<
        { id: string; status: MessageStatus; direction: MessageDirection }[]
      >`
        SELECT "id", "status", "direction" FROM "Message"
        WHERE "provider" = ${providerName} AND "providerMessageId" = ${event.providerMessageId}
        FOR UPDATE`;
      const message = rows[0];

      let outcome: WebhookEventOutcome;
      if (message === undefined) {
        outcome = WebhookEventOutcome.UNKNOWN_MESSAGE;
      } else if (event.status === null || message.direction !== MessageDirection.OUTBOUND) {
        outcome = WebhookEventOutcome.IGNORED;
      } else if (!isForwardDeliveryUpdate(message.status, event.status)) {
        outcome = WebhookEventOutcome.STALE;
      } else {
        outcome = WebhookEventOutcome.PROCESSED;
        const next = event.status;
        await tx.message.update({
          where: { id: message.id },
          data: {
            status: MessageStatus[next],
            ...(next === 'SENT' ? { sentAt: now } : {}),
            ...(next === 'DELIVERED' ? { deliveredAt: now } : {}),
            ...(next === 'FAILED'
              ? { failedAt: now, errorCode: event.errorCode ?? event.providerStatus }
              : {}),
          },
        });
      }

      await tx.providerWebhookEvent.update({
        where: { provider_eventKey: { provider: providerName, eventKey } },
        data: { outcome, messageId: message?.id ?? null },
      });
      return { duplicate: false, outcome, messageId: message?.id ?? null };
    },
    { timeout: options.transactionTimeoutMs, maxWait: options.transactionTimeoutMs },
  );
}
