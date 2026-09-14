import type { AppConfig } from '../../config/index.js';
import { ConfigurationError } from '../../lib/errors.js';
import type { MessagingProvider } from './index.js';
import { createTwilioProvider } from './twilio.js';

export interface ConfiguredMessaging {
  provider: MessagingProvider;
  fromNumber: string;
}

/** Build the configured SMS provider, or undefined when SMS_PROVIDER is unset. */
export function createConfiguredMessaging(config: AppConfig): ConfiguredMessaging | undefined {
  const settings = config.providers.messaging;
  if (settings.provider === undefined) return undefined;

  const { accountId, authToken, fromNumber } = settings;
  if (accountId === undefined || authToken === undefined || fromNumber === undefined) {
    throw new ConfigurationError('SMS provider credentials are incomplete');
  }

  // Twilio is the only provider (SMS_PROVIDER is validated as 'twilio').
  return {
    provider: createTwilioProvider({
      accountSid: accountId,
      authToken,
      timeoutMs: config.messaging.sendTimeoutMs,
    }),
    fromNumber,
  };
}

/** Public URL a provider posts delivery updates to. */
export function statusCallbackUrl(config: AppConfig, providerName: string): string {
  return `${publicApiBase(config)}/api/v1/webhooks/messaging/${providerName}/status`;
}

export function publicApiBase(config: AppConfig): string {
  return config.http.apiUrl.replace(/\/+$/, '');
}
