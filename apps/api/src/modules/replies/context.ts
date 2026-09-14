import type { DbClient } from '../../db/client.js';
import { MessageDirection, MessageStatus } from '../../generated/prisma/enums.js';

export interface ConversationTurn {
  from: 'LEAD' | 'BUSINESS';
  text: string;
}

/**
 * Bounded conversation context for one inbound message: the most recent
 * `limit` messages of the same campaign membership, oldest first, each cut to
 * `maxChars`. Inbound messages without a matched membership get no history, so
 * other campaigns and other leads can never leak into the prompt. Outbound
 * messages count only once the provider accepted them.
 */
export async function loadConversationHistory(
  db: DbClient,
  inbound: { id: string; campaignLeadId: string | null; createdAt: Date },
  limit: number,
  maxChars: number,
): Promise<ConversationTurn[]> {
  if (inbound.campaignLeadId === null || limit <= 0) return [];

  const rows = await db.message.findMany({
    where: {
      campaignLeadId: inbound.campaignLeadId,
      id: { not: inbound.id },
      createdAt: { lte: inbound.createdAt },
      body: { not: null },
      OR: [
        { direction: MessageDirection.INBOUND },
        {
          direction: MessageDirection.OUTBOUND,
          status: { in: [MessageStatus.ACCEPTED, MessageStatus.SENT, MessageStatus.DELIVERED] },
        },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { direction: true, body: true },
  });

  return rows.reverse().map((row) => ({
    from: row.direction === MessageDirection.INBOUND ? 'LEAD' : 'BUSINESS',
    text: (row.body ?? '').slice(0, maxChars),
  }));
}
