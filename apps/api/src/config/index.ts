import { parseEnv, type Env } from './env.js';

/**
 * The only place in the API that reads `process.env` is the entrypoint, which
 * hands it to `loadConfig`. Everything else receives `AppConfig`.
 */
export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  http: {
    port: number;
    apiUrl: string;
    corsOrigins: string[];
    jsonBodyLimit: string;
    shutdownTimeoutMs: number;
  };
  database: {
    /** Undefined outside production when not configured. */
    url: string | undefined;
  };
  providers: {
    ai: { openaiApiKey: string | undefined };
    messaging: {
      provider: string | undefined;
      accountId: string | undefined;
      authToken: string | undefined;
      fromNumber: string | undefined;
    };
    calendar: { provider: string | undefined };
    crm: { provider: string | undefined };
    notifications: { provider: string | undefined };
  };
  campaign: {
    defaultTimezone: string;
    sendWindow: { start: string; end: string };
    hourlyDispatchLimit: number;
    followUpDelayHours: number;
    archiveDelayDays: number;
  };
  classifier: {
    confidenceThreshold: number;
  };
}

export const SERVICE_NAME = 'cadentor-reactivation-api';

const DEV_WEB_URL = 'http://localhost:5173';
const JSON_BODY_LIMIT = '100kb';
const SHUTDOWN_TIMEOUT_MS = 10_000;

export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const env = parseEnv(source);
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    http: {
      port: env.API_PORT,
      apiUrl: env.API_URL,
      // Production requires WEB_URL (enforced in env.ts); dev falls back to Vite.
      corsOrigins: [env.WEB_URL ?? DEV_WEB_URL],
      jsonBodyLimit: JSON_BODY_LIMIT,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    },
    database: { url: env.DATABASE_URL },
    providers: {
      ai: { openaiApiKey: env.OPENAI_API_KEY },
      messaging: {
        provider: env.SMS_PROVIDER,
        accountId: env.SMS_ACCOUNT_ID,
        authToken: env.SMS_AUTH_TOKEN,
        fromNumber: env.SMS_FROM_NUMBER,
      },
      calendar: { provider: env.CALENDAR_PROVIDER },
      crm: { provider: env.CRM_PROVIDER },
      notifications: { provider: env.OWNER_NOTIFICATION_PROVIDER },
    },
    campaign: {
      defaultTimezone: env.DEFAULT_CAMPAIGN_TIMEZONE,
      sendWindow: { start: env.CAMPAIGN_SEND_WINDOW_START, end: env.CAMPAIGN_SEND_WINDOW_END },
      hourlyDispatchLimit: env.CAMPAIGN_HOURLY_DISPATCH_LIMIT,
      followUpDelayHours: env.CAMPAIGN_FOLLOW_UP_DELAY_HOURS,
      archiveDelayDays: env.CAMPAIGN_ARCHIVE_DELAY_DAYS,
    },
    classifier: { confidenceThreshold: env.CLASSIFIER_CONFIDENCE_THRESHOLD },
  };
}
