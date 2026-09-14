import { z } from 'zod';

const replyText = z.string().trim().min(1).max(320);

/**
 * Fixed, operator-approved reply texts chosen by the deterministic router.
 * No placeholders and no model generation: what is configured is what is sent.
 */
export const replyTemplatesSchema = z
  .object({
    positive: replyText.optional(),
    decline: replyText.optional(),
    clarify: replyText.optional(),
    handoff: replyText.optional(),
  })
  .strict();

export type ReplyTemplates = z.infer<typeof replyTemplatesSchema>;
