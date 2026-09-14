import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { ConfigurationError } from '../../src/lib/errors.js';
import { AiProviderError } from '../../src/providers/ai/index.js';
import {
  classifyOpenAiError,
  createOpenAiProvider,
  type OpenAiResponsesClient,
} from '../../src/providers/ai/openai.js';
import { createConfiguredAi } from '../../src/providers/ai/registry.js';
import { intentFormatSchema } from '../../src/modules/replies/classifier.js';

function stubClient(response: { output_text: string; status?: 'completed' | 'incomplete' }) {
  const bodies: ResponseCreateParamsNonStreaming[] = [];
  const client: OpenAiResponsesClient = {
    responses: {
      create: (body) => {
        bodies.push(body);
        return Promise.resolve({
          id: 'resp_1',
          model: 'test-model',
          status: response.status ?? 'completed',
          output_text: response.output_text,
        });
      },
    },
  };
  return { client, bodies };
}

const config = { apiKey: 'unit-test-openai-key', model: 'test-model', timeoutMs: 1000 };

const request = {
  schemaName: 'intent_analysis',
  instructions: 'Classify.',
  input: '{"latestMessage":"yes"}',
  schema: intentFormatSchema,
  maxOutputTokens: 300,
};

describe('OpenAI adapter', () => {
  it('requests strict structured output without storing the conversation', async () => {
    const { client, bodies } = stubClient({
      output_text: '{"classification":"POSITIVE_INTEREST"}',
    });
    const result = await createOpenAiProvider(config, client).generateStructured(request);

    expect(result).toEqual({
      output: { classification: 'POSITIVE_INTEREST' },
      model: 'test-model',
      requestId: 'resp_1',
    });
    const body = bodies[0];
    expect(body).toMatchObject({
      model: 'test-model',
      instructions: 'Classify.',
      input: '{"latestMessage":"yes"}',
      max_output_tokens: 300,
      store: false,
      text: { format: { type: 'json_schema', name: 'intent_analysis', strict: true } },
    });
  });

  it('rejects unparseable or incomplete output', async () => {
    await expect(
      createOpenAiProvider(
        config,
        stubClient({ output_text: 'Sure! {classification' }).client,
      ).generateStructured(request),
    ).rejects.toMatchObject({ failure: 'INVALID_OUTPUT', retryable: false });
    await expect(
      createOpenAiProvider(
        config,
        stubClient({ output_text: '{}', status: 'incomplete' }).client,
      ).generateStructured(request),
    ).rejects.toMatchObject({ failure: 'INVALID_OUTPUT' });
  });

  it.each([
    [new OpenAI.APIConnectionTimeoutError(), 'TIMEOUT', true],
    [new OpenAI.APIConnectionError({ message: 'socket closed' }), 'UNAVAILABLE', true],
    [
      OpenAI.APIError.generate(
        429,
        { error: { message: 'slow down' } },
        'slow down',
        new Headers(),
      ),
      'RATE_LIMITED',
      true,
    ],
    [
      OpenAI.APIError.generate(503, { error: { message: 'busy' } }, 'busy', new Headers()),
      'UNAVAILABLE',
      true,
    ],
    [
      OpenAI.APIError.generate(
        400,
        { error: { message: 'bad schema' } },
        'bad schema',
        new Headers(),
      ),
      'REQUEST_REJECTED',
      false,
    ],
    [new Error('unexpected'), 'UNAVAILABLE', true],
  ] as const)('classifies %s', (error, failure, retryable) => {
    const classified = classifyOpenAiError(error);
    expect(classified).toBeInstanceOf(AiProviderError);
    expect(classified).toMatchObject({ failure, retryable });
  });

  it('surfaces provider errors through generateStructured', async () => {
    const client: OpenAiResponsesClient = {
      responses: { create: () => Promise.reject(new OpenAI.APIConnectionTimeoutError()) },
    };
    await expect(
      createOpenAiProvider(config, client).generateStructured(request),
    ).rejects.toMatchObject({
      failure: 'TIMEOUT',
    });
  });
});

describe('AI configuration', () => {
  it('is disabled without an API key and requires an explicit model with one', () => {
    expect(createConfiguredAi(loadConfig({}))).toBeUndefined();
    expect(() => loadConfig({ OPENAI_API_KEY: 'unit-test-openai-key' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ OPENAI_API_KEY: 'unit-test-openai-key' })).toThrow(/OPENAI_MODEL/);
    const provider = createConfiguredAi(
      loadConfig({ OPENAI_API_KEY: 'unit-test-openai-key', OPENAI_MODEL: 'test-model' }),
    );
    expect(provider?.name).toBe('openai');
  });

  it('never includes the API key in configuration errors', () => {
    try {
      loadConfig({ OPENAI_API_KEY: 'unit-test-openai-key' });
    } catch (err) {
      expect(String(err)).not.toContain('unit-test-openai-key');
      return;
    }
    throw new Error('expected loadConfig to throw');
  });
});
