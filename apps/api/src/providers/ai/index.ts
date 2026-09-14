import type { ZodType } from 'zod';

/**
 * AI provider boundary. PROVISIONAL — finalized in Phase 2.
 * AI may classify, extract, summarize or draft. Its output is data validated
 * against a schema; it never triggers side effects directly. A deterministic
 * router decides what happens next.
 */

export interface StructuredRequest<TOutput> {
  instructions: string;
  input: string;
  schema: ZodType<TOutput>;
}

export interface AiProvider {
  readonly name: string;
  /** Resolves only with output that passed `schema`; otherwise rejects. */
  generateStructured<TOutput>(request: StructuredRequest<TOutput>): Promise<TOutput>;
}
