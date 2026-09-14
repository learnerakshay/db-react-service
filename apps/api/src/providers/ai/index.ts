import type { ZodType } from 'zod';
import { ProviderError } from '../../lib/errors.js';

/**
 * AI provider boundary. Finalized in Phase 2 / Prompt 2.
 *
 * AI may classify, extract and draft text. Its output is untrusted data: the
 * caller validates it with the application schema before using it, and it
 * never triggers side effects. Deterministic application code decides every
 * state change, suppression, send and escalation.
 */

export interface StructuredRequest {
  /** Provider-visible name for the output format. */
  schemaName: string;
  instructions: string;
  /** Model input. Must never contain credentials or data about other leads. */
  input: string;
  /** Output shape requested from the provider (structured output format). */
  schema: ZodType;
  maxOutputTokens: number;
}

export interface StructuredResponse {
  /** Parsed JSON exactly as returned. Not yet validated. */
  output: unknown;
  model: string;
  requestId: string | null;
}

export type AiFailure =
  'TIMEOUT' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'REQUEST_REJECTED' | 'INVALID_OUTPUT';

const RETRYABLE: ReadonlySet<AiFailure> = new Set(['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE']);

export class AiProviderError extends ProviderError {
  readonly failure: AiFailure;
  /** Transient: the same request may succeed later. AI calls have no side effects. */
  readonly retryable: boolean;

  constructor(provider: string, failure: AiFailure, cause?: unknown) {
    super(provider, `AI provider failure: ${failure}`, cause);
    this.failure = failure;
    this.retryable = RETRYABLE.has(failure);
  }
}

export interface AiProvider {
  readonly name: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
}
