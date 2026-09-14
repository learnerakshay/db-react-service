import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { ConfigurationError } from '../../src/lib/errors.js';
import {
  createConfiguredMessaging,
  statusCallbackUrl,
} from '../../src/providers/messaging/registry.js';

/** Format-valid placeholder, built at runtime so it never looks like a real SID in source. */
const TEST_ACCOUNT_SID = `AC${'0'.repeat(32)}`;

const TWILIO = {
  SMS_PROVIDER: 'twilio',
  SMS_ACCOUNT_ID: TEST_ACCOUNT_SID,
  SMS_AUTH_TOKEN: 'config-test-token',
  SMS_FROM_NUMBER: '+15005550006',
};

describe('messaging configuration', () => {
  it('leaves messaging disabled when SMS_PROVIDER is unset', () => {
    expect(createConfiguredMessaging(loadConfig({}))).toBeUndefined();
  });

  it('builds the Twilio provider when fully configured', () => {
    const config = loadConfig({ ...TWILIO, API_URL: 'https://api.example.com/' });
    const messaging = createConfiguredMessaging(config);
    expect(messaging?.provider.name).toBe('twilio');
    expect(messaging?.fromNumber).toBe('+15005550006');
    expect(statusCallbackUrl(config, 'twilio')).toBe(
      'https://api.example.com/api/v1/webhooks/messaging/twilio/status',
    );
  });

  it('requires credentials and an E.164 sender when a provider is set', () => {
    expect(() => loadConfig({ SMS_PROVIDER: 'twilio' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...TWILIO, SMS_FROM_NUMBER: '5005550006' })).toThrow(
      /SMS_FROM_NUMBER/,
    );
    expect(() => loadConfig({ ...TWILIO, SMS_PROVIDER: 'carrier-pigeon' })).toThrow(/SMS_PROVIDER/);
    expect(() => loadConfig({ ...TWILIO, SMS_ACCOUNT_ID: 'not-a-sid' })).toThrow(/SMS_ACCOUNT_ID/);
  });

  it('requires a public https API_URL for webhooks in production', () => {
    const production = {
      ...TWILIO,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://db/app',
      WEB_URL: 'https://app.example.com',
    };
    expect(() => loadConfig({ ...production, API_URL: 'http://api.example.com' })).toThrow(
      /API_URL/,
    );
    expect(() => loadConfig({ ...production, API_URL: 'https://api.example.com' })).not.toThrow();
  });

  it('never includes credential values in configuration errors', () => {
    try {
      loadConfig({ ...TWILIO, SMS_FROM_NUMBER: 'not-a-number' });
    } catch (err) {
      expect(String(err)).not.toContain('config-test-token');
      return;
    }
    throw new Error('expected loadConfig to throw');
  });
});
