import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import { AiProviderError, type AiProvider } from './index.js';

/** OpenAI adapter. The only module that imports the OpenAI SDK. */

export const OPENAI_PROVIDER_NAME = 'openai';

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** The single SDK call used; replaceable at the network boundary in tests. */
export interface OpenAiResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
    ): Promise<Pick<Response, 'id' | 'model' | 'status' | 'output_text'>>;
  };
}

export function createOpenAiProvider(
  config: OpenAiConfig,
  client?: OpenAiResponsesClient,
): AiProvider {
  const api = client ?? defaultClient(config);

  return {
    name: OPENAI_PROVIDER_NAME,

    async generateStructured(request) {
      let response: Pick<Response, 'id' | 'model' | 'status' | 'output_text'>;
      try {
        response = await api.responses.create({
          model: config.model,
          instructions: request.instructions,
          input: request.input,
          max_output_tokens: request.maxOutputTokens,
          // Lead conversations are not retained by the provider for reuse.
          store: false,
          text: { format: zodTextFormat(request.schema, request.schemaName) },
        });
      } catch (err) {
        throw classifyOpenAiError(err);
      }

      if (response.status !== undefined && response.status !== 'completed') {
        throw new AiProviderError(OPENAI_PROVIDER_NAME, 'INVALID_OUTPUT');
      }

      let output: unknown;
      try {
        output = JSON.parse(response.output_text);
      } catch (err) {
        throw new AiProviderError(OPENAI_PROVIDER_NAME, 'INVALID_OUTPUT', err);
      }
      return { output, model: String(response.model), requestId: response.id };
    },
  };
}

/** Timeouts, rate limits, 5xx and connection failures are transient; other API errors are not. */
export function classifyOpenAiError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiProviderError(OPENAI_PROVIDER_NAME, 'TIMEOUT', err);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new AiProviderError(OPENAI_PROVIDER_NAME, 'UNAVAILABLE', err);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new AiProviderError(OPENAI_PROVIDER_NAME, 'RATE_LIMITED', err);
  }
  if (err instanceof OpenAI.APIError) {
    const status: unknown = err.status;
    return new AiProviderError(
      OPENAI_PROVIDER_NAME,
      typeof status === 'number' && status >= 500 ? 'UNAVAILABLE' : 'REQUEST_REJECTED',
      err,
    );
  }
  return new AiProviderError(OPENAI_PROVIDER_NAME, 'UNAVAILABLE', err);
}

function defaultClient(config: OpenAiConfig): OpenAiResponsesClient {
  // Retries are owned by the job queue, not the SDK.
  const sdk = new OpenAI({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 0 });
  return {
    responses: {
      create: async (body) => {
        const response = await sdk.responses.create(body);
        return {
          id: response.id,
          model: response.model,
          status: response.status,
          output_text: response.output_text,
        };
      },
    },
  };
}
