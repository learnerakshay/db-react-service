import { z } from 'zod';
import type { DbClient } from '../../db/client.js';
import { KnowledgeCategory } from '../../generated/prisma/enums.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

export const createKnowledgeSchema = z
  .object({
    campaignId: z.uuid().nullable().optional(),
    category: z.enum(KnowledgeCategory),
    question: z.string().trim().min(1).max(300).nullable().optional(),
    content: z.string().trim().min(1).max(2000),
    keywords: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(20).optional(),
  })
  .strict();

/** Store an operator-approved fact. The reply engine may only answer from these. */
export async function createKnowledgeItem(db: DbClient, input: unknown) {
  const parsed = createKnowledgeSchema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid knowledge item');
  const data = parsed.data;

  const campaignId = data.campaignId ?? null;
  if (campaignId !== null) {
    const campaign = await db.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (campaign === null) throw new NotFoundError('Campaign not found');
  }

  return db.knowledgeItem.create({
    data: {
      campaignId,
      category: data.category,
      question: data.question ?? null,
      content: data.content,
      keywords: [...new Set(data.keywords ?? [])],
    },
  });
}

/** Active facts; with a campaign id, that campaign's facts plus business-wide ones. */
export async function listKnowledgeItems(db: DbClient, campaignId: string | undefined) {
  return db.knowledgeItem.findMany({
    where: {
      active: true,
      ...(campaignId === undefined ? {} : { OR: [{ campaignId }, { campaignId: null }] }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
}

/** Retire a fact. Facts are deactivated rather than deleted so answers stay auditable. */
export async function deactivateKnowledgeItem(db: DbClient, id: string) {
  const item = await db.knowledgeItem.findUnique({ where: { id } });
  if (item === null) throw new NotFoundError('Knowledge item not found');
  if (!item.active) return item;
  return db.knowledgeItem.update({ where: { id }, data: { active: false } });
}
