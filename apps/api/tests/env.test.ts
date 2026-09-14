import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { parseEnv } from '../src/config/env.js';
import { ConfigurationError } from '../src/lib/errors.js';

function configError(source: Record<string, string | undefined>): ConfigurationError {
  try {
    parseEnv(source);
  } catch (err) {
    if (err instanceof ConfigurationError) return err;
    throw err;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('applies defaults so development starts with no variables', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CAMPAIGN_SEND_WINDOW_START).toBe('09:00');
    expect(env.CLASSIFIER_CONFIDENCE_THRESHOLD).toBe(0.8);
  });

  it('treats blank values (KEY= in .env) as unset', () => {
    const env = parseEnv({ API_PORT: '', DATABASE_URL: '  ', SMS_PROVIDER: '' });
    expect(env.API_PORT).toBe(4000);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SMS_PROVIDER).toBeUndefined();
  });

  it('coerces numeric values', () => {
    const env = parseEnv({ API_PORT: '8080', CAMPAIGN_HOURLY_DISPATCH_LIMIT: '25' });
    expect(env.API_PORT).toBe(8080);
    expect(env.CAMPAIGN_HOURLY_DISPATCH_LIMIT).toBe(25);
  });

  it('does not require future provider variables', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://db/app',
        WEB_URL: 'https://app.example.com',
      }),
    ).not.toThrow();
  });

  it('requires DATABASE_URL and WEB_URL in production, naming both', () => {
    const err = configError({ NODE_ENV: 'production' });
    expect(err.message).toContain('DATABASE_URL: is required in production');
    expect(err.message).toContain('WEB_URL: is required in production');
  });

  it('rejects invalid values with the key name', () => {
    expect(configError({ API_PORT: 'abc' }).message).toContain('API_PORT');
    expect(configError({ LOG_LEVEL: 'loud' }).message).toContain('LOG_LEVEL');
    expect(configError({ DEFAULT_CAMPAIGN_TIMEZONE: 'Mars/Olympus' }).message).toContain(
      'DEFAULT_CAMPAIGN_TIMEZONE',
    );
    expect(configError({ CLASSIFIER_CONFIDENCE_THRESHOLD: '1.5' }).message).toContain(
      'CLASSIFIER_CONFIDENCE_THRESHOLD',
    );
    expect(configError({ CAMPAIGN_SEND_WINDOW_START: '9am' }).message).toContain(
      'CAMPAIGN_SEND_WINDOW_START',
    );
  });

  it('rejects a send window that ends before it starts', () => {
    const err = configError({
      CAMPAIGN_SEND_WINDOW_START: '18:00',
      CAMPAIGN_SEND_WINDOW_END: '09:00',
    });
    expect(err.message).toContain('CAMPAIGN_SEND_WINDOW_END');
  });

  it('never echoes values into the error message', () => {
    const err = configError({ DATABASE_URL: 'mysql://user:s3cret-value@host/db' });
    expect(err.message).toContain('DATABASE_URL');
    expect(err.message).not.toContain('s3cret-value');
  });
});

describe('loadConfig', () => {
  it('maps env into the typed AppConfig', () => {
    const config = loadConfig({ API_PORT: '5000', WEB_URL: 'https://ops.example.com' });
    expect(config.http.port).toBe(5000);
    expect(config.http.corsOrigins).toEqual(['https://ops.example.com']);
    expect(config.campaign.sendWindow).toEqual({ start: '09:00', end: '18:00' });
    expect(config.providers.messaging.provider).toBeUndefined();
  });

  it('falls back to the Vite dev origin for CORS outside production', () => {
    expect(loadConfig({}).http.corsOrigins).toEqual(['http://localhost:5173']);
  });
});
