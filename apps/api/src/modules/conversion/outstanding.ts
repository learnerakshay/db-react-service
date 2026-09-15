import type { DbClient } from '../../db/client.js';
import { MessageStatus, QualificationResult } from '../../generated/prisma/enums.js';
import { qualificationQuestionSendKey } from './qualification.js';

const DELIVERED_TO_PROVIDER: readonly MessageStatus[] = [
  MessageStatus.ACCEPTED,
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
];

/**
 * A qualification question is outstanding when the membership's latest
 * evaluation still needs information and the question for its next field was
 * accepted by the provider. It stays outstanding until an evaluation changes that.
 */
export async function hasOutstandingQualificationQuestion(
  db: DbClient,
  campaignLeadId: string,
): Promise<boolean> {
  const latest = await db.qualificationEvaluation.findFirst({
    where: { campaignLeadId },
    orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { result: true, nextField: true },
  });
  if (latest?.result !== QualificationResult.PENDING_INFORMATION || latest.nextField === null) {
    return false;
  }
  const question = await db.message.findUnique({
    where: { sendKey: qualificationQuestionSendKey(campaignLeadId, latest.nextField) },
    select: { status: true },
  });
  return question !== null && DELIVERED_TO_PROVIDER.includes(question.status);
}
