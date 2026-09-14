import type { IntentClassification } from '../../src/generated/prisma/enums.js';
import type {
  AiProvider,
  StructuredRequest,
  StructuredResponse,
} from '../../src/providers/ai/index.js';

/** One scripted provider response: raw output, a thrown error, or a function of the request. */
export type AiStep =
  { output: unknown } | { error: Error } | { run: (request: StructuredRequest) => unknown };

/** Stand-in for the AI network boundary. Records every request it receives. */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake-ai';
  readonly requests: StructuredRequest[] = [];
  delayMs = 0;
  private readonly steps = new Map<string, AiStep[]>();

  script(schemaName: string, ...steps: AiStep[]): this {
    const queue = this.steps.get(schemaName) ?? [];
    queue.push(...steps);
    this.steps.set(schemaName, queue);
    return this;
  }

  calls(schemaName: string): StructuredRequest[] {
    return this.requests.filter((request) => request.schemaName === schemaName);
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.requests.push(request);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const step = this.steps.get(request.schemaName)?.shift();
    if (step === undefined)
      throw new Error(`FakeAiProvider: no scripted response for ${request.schemaName}`);
    if ('error' in step) throw step.error;
    const output = 'run' in step ? step.run(request) : step.output;
    return { output, model: 'fake-model', requestId: `fake-req-${this.requests.length}` };
  }
}

interface IntentDetails {
  preferredTime?: string;
  specificQuery?: string;
}

/** Raw intent_analysis output as a well-behaved model would return it. */
export function intentOutput(
  classification: IntentClassification,
  confidence = 0.95,
  details: IntentDetails = {},
): Record<string, unknown> {
  return {
    classification,
    confidence,
    extractedDetails: {
      preferredTime: details.preferredTime ?? null,
      specificQuery: details.specificQuery ?? null,
    },
  };
}

export function intent(
  classification: IntentClassification,
  confidence = 0.95,
  details: IntentDetails = {},
): AiStep {
  return { output: intentOutput(classification, confidence, details) };
}

export function grounded(answer: string | null, citedFactIds: string[], answerable = true): AiStep {
  return { output: { answerable, answer, citedFactIds } };
}
