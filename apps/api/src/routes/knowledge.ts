import type { KnowledgeItemDto } from '@cadentor/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { KnowledgeItem } from '../generated/prisma/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import {
  createKnowledgeItem,
  deactivateKnowledgeItem,
  listKnowledgeItems,
} from '../modules/knowledge/knowledge.js';
import type { ApiRouterDependencies } from './api.js';

const idSchema = z.uuid();

/** Operator-managed approved facts used for grounded answers. */
export function knowledgeRouter({ db }: ApiRouterDependencies): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const item = await createKnowledgeItem(db, req.body);
    res.status(201).json(toDto(item));
  });

  router.get('/', async (req, res) => {
    const raw = req.query.campaignId;
    let campaignId: string | undefined;
    if (raw !== undefined) {
      const parsed = idSchema.safeParse(raw);
      if (!parsed.success) throw new ValidationError('campaignId must be a UUID');
      campaignId = parsed.data;
    }
    const items = await listKnowledgeItems(db, campaignId);
    res.json(items.map(toDto));
  });

  router.post('/:id/deactivate', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) throw new NotFoundError('Knowledge item not found');
    res.json(toDto(await deactivateKnowledgeItem(db, id.data)));
  });

  return router;
}

function toDto(item: KnowledgeItem): KnowledgeItemDto {
  return {
    id: item.id,
    campaignId: item.campaignId,
    category: item.category,
    question: item.question,
    content: item.content,
    keywords: item.keywords,
    active: item.active,
    createdAt: item.createdAt.toISOString(),
  };
}
