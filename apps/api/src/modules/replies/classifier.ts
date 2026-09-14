import { z } from 'zod';
import { IntentClassification } from '../../generated/prisma/enums.js';
import type { AiProvider } from '../../providers/ai/index.js';
import type { ConversationTurn } from './context.js';
import { CLASSIFIER_INSTRUCTIONS } from './prompts.js';

/** Shape requested from the provider. Kept free of bounds the provider may not support. */
export const intentFormatSchema = z.object({
  classification: z.enum(IntentClassification),
  confidence: z.number(),
  extractedDetails: z.object({
    preferredTime: z.string().nullable(),
    specificQuery: z.string().nullable(),
  }),
});

/** Application contract. Raw model output must pass this before any use. */
export const intentAnalysisSchema = z
  .object({
    classification: z.enum(IntentClassification),
    confidence: z.number().min(0).max(1),
    extractedDetails: z
      .object({
        preferredTime: z.string().trim().max(200).nullable(),
        specificQuery: z.string().trim().max(500).nullable(),
      })
      .strict(),
  })
  .strict();

export type IntentAnalysis = z.infer<typeof intentAnalysisSchema>;

export interface AiCallMeta {
  model: string;
  requestId: string | null;
}

/** Model output that did not match the application contract. Never retried. */
export class InvalidAiOutputError extends Error {
  readonly schemaName: string;
  readonly meta: AiCallMeta;

  constructor(schemaName: string, meta: AiCallMeta, cause?: unknown) {
    super(`AI output failed validation: ${schemaName}`, { cause });
    this.name = 'InvalidAiOutputError';
    this.schemaName = schemaName;
    this.meta = meta;
  }
}

/**
 * Classify one inbound message. The model's self-reported confidence is only a
 * routing signal; it is not a calibrated probability.
 */
export async function classifyInboundMessage(
  ai: AiProvider,
  message: string,
  history: readonly ConversationTurn[],
  maxOutputTokens: number,
): Promise<{ analysis: IntentAnalysis; meta: AiCallMeta }> {
  const response = await ai.generateStructured({
    schemaName: 'intent_analysis',
    instructions: CLASSIFIER_INSTRUCTIONS,
    input: JSON.stringify({ recentConversation: history, latestMessage: message }),
    schema: intentFormatSchema,
    maxOutputTokens,
  });
  const meta = { model: response.model, requestId: response.requestId };
  const parsed = intentAnalysisSchema.safeParse(response.output);
  if (!parsed.success) throw new InvalidAiOutputError('intent_analysis', meta, parsed.error);
  return { analysis: parsed.data, meta };
}
