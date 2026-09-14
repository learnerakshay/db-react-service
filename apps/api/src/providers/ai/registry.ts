import type { AppConfig } from '../../config/index.js';
import type { AiProvider } from './index.js';
import { createOpenAiProvider } from './openai.js';

/** Build the configured AI provider, or undefined when OPENAI_API_KEY is unset. */
export function createConfiguredAi(config: AppConfig): AiProvider | undefined {
  const { openaiApiKey, model } = config.providers.ai;
  // env.ts requires OPENAI_MODEL whenever OPENAI_API_KEY is set.
  if (openaiApiKey === undefined || model === undefined) return undefined;
  return createOpenAiProvider({
    apiKey: openaiApiKey,
    model,
    timeoutMs: config.replies.aiTimeoutMs,
  });
}
