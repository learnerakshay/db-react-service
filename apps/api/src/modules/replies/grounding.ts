import { z } from 'zod';
import type { AiProvider } from '../../providers/ai/index.js';
import type { RetrievedFact } from '../knowledge/retrieval.js';
import { InvalidAiOutputError, type AiCallMeta } from './classifier.js';
import type { ConversationTurn } from './context.js';
import { GROUNDED_ANSWER_INSTRUCTIONS } from './prompts.js';

export const groundedAnswerSchema = z
  .object({
    answerable: z.boolean(),
    answer: z.string().nullable(),
    citedFactIds: z.array(z.string()),
  })
  .strict();

export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;

export type GroundingRejection =
  | 'NOT_ANSWERABLE'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'NO_CITATIONS'
  | 'UNKNOWN_CITATION'
  | 'UNSUPPORTED_DETAIL';

export type GroundingCheck =
  { ok: true; answer: string; citedFactIds: string[] } | { ok: false; reason: GroundingRejection };

/** Ask the model to answer strictly from the retrieved facts. Output is validated. */
export async function generateGroundedAnswer(
  ai: AiProvider,
  request: {
    question: string;
    facts: readonly RetrievedFact[];
    history: readonly ConversationTurn[];
    maxOutputTokens: number;
  },
): Promise<{ answer: GroundedAnswer; meta: AiCallMeta }> {
  const response = await ai.generateStructured({
    schemaName: 'grounded_answer',
    instructions: GROUNDED_ANSWER_INSTRUCTIONS,
    input: JSON.stringify({
      facts: request.facts.map((fact) => ({
        id: fact.id,
        category: fact.category,
        question: fact.question,
        content: fact.content,
      })),
      recentConversation: request.history,
      question: request.question,
    }),
    schema: groundedAnswerSchema,
    maxOutputTokens: request.maxOutputTokens,
  });
  const meta = { model: response.model, requestId: response.requestId };
  const parsed = groundedAnswerSchema.safeParse(response.output);
  if (!parsed.success) throw new InvalidAiOutputError('grounded_answer', meta, parsed.error);
  return { answer: parsed.data, meta };
}

const SPECIFIC_DETAIL = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+|\$?\d[\d,.:/]*%?/gi;

/**
 * Deterministic grounding policy applied before any answer is sent:
 * - the model must claim the question is answerable, with a non-empty answer
 *   within the SMS length limit;
 * - it must cite at least one fact, and only facts it was given;
 * - every specific detail in the answer (numbers, prices, times, percentages,
 *   URLs, emails) must appear verbatim in the cited facts.
 * This cannot prove an answer is correct; it blocks the most harmful
 * fabrications (invented prices, hours, contact details).
 */
export function validateGroundedAnswer(
  answer: GroundedAnswer,
  facts: readonly RetrievedFact[],
  maxLength: number,
): GroundingCheck {
  if (!answer.answerable) return { ok: false, reason: 'NOT_ANSWERABLE' };
  const text = (answer.answer ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: false, reason: 'EMPTY' };
  if (text.length > maxLength) return { ok: false, reason: 'TOO_LONG' };

  const cited = [...new Set(answer.citedFactIds)];
  if (cited.length === 0) return { ok: false, reason: 'NO_CITATIONS' };
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const citedFacts = cited.map((id) => byId.get(id));
  if (citedFacts.some((fact) => fact === undefined))
    return { ok: false, reason: 'UNKNOWN_CITATION' };

  const factText = normalize(
    citedFacts.map((fact) => `${fact?.question ?? ''} ${fact?.content ?? ''}`).join(' '),
  );
  for (const match of text.matchAll(SPECIFIC_DETAIL)) {
    const detail = normalize(match[0].replace(/[.,;:!?)/]+$/, ''));
    if (detail !== '' && !factText.includes(detail))
      return { ok: false, reason: 'UNSUPPORTED_DETAIL' };
  }

  return { ok: true, answer: text, citedFactIds: cited };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/,/g, '');
}
