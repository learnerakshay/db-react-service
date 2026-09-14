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
  imports: {
    maxFileBytes: number;
    /** Largest single CSV record accepted. */
    maxRecordBytes: number;
    /** Rows written per database transaction. */
    chunkSize: number;
    /** PROCESSING imports older than this are presumed crashed. */
    staleAfterMs: number;
  };
  dispatch: {
    /** Maximum STAGED memberships examined per campaign per admission run. */
    scanLimit: number;
    pageSize: number;
    transactionTimeoutMs: number;
  };
  jobs: {
    /** Start pg-boss, the scheduler and workers in this process. */
    workersEnabled: boolean;
    /** pg-boss schema holding job tables (separate from Prisma's). */
    schema: string;
    schedulerCron: string;
    pollingIntervalSeconds: number;
    admissionRetryLimit: number;
    admissionRetryDelaySeconds: number;
    admissionExpireInSeconds: number;
    /** Graceful stop budget; must stay below http.shutdownTimeoutMs. */
    stopTimeoutMs: number;
  };
}

export const SERVICE_NAME = 'cadentor-reactivation-api';

const DEV_WEB_URL = 'http://localhost:5173';
const JSON_BODY_LIMIT = '100kb';
const SHUTDOWN_TIMEOUT_MS = 10_000;
const IMPORT_MAX_RECORD_BYTES = 64 * 1024;
const IMPORT_CHUNK_SIZE = 250;
const IMPORT_STALE_AFTER_MS = 30 * 60_000;
const DISPATCH_SCAN_LIMIT = 2000;
const DISPATCH_PAGE_SIZE = 200;
const DISPATCH_TRANSACTION_TIMEOUT_MS = 30_000;
const JOBS_SCHEMA = 'pgboss';
/** Every minute. pg-boss runs each occurrence once across all instances. */
const SCHEDULER_CRON = '* * * * *';
const JOB_POLLING_INTERVAL_SECONDS = 2;
const ADMISSION_RETRY_LIMIT = 3;
const ADMISSION_RETRY_DELAY_SECONDS = 15;
const ADMISSION_EXPIRE_IN_SECONDS = 120;
const JOB_STOP_TIMEOUT_MS = 8_000;

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
    imports: {
      maxFileBytes: env.IMPORT_MAX_FILE_BYTES,
      maxRecordBytes: IMPORT_MAX_RECORD_BYTES,
      chunkSize: IMPORT_CHUNK_SIZE,
      staleAfterMs: IMPORT_STALE_AFTER_MS,
    },
    dispatch: {
      scanLimit: DISPATCH_SCAN_LIMIT,
      pageSize: DISPATCH_PAGE_SIZE,
      transactionTimeoutMs: DISPATCH_TRANSACTION_TIMEOUT_MS,
    },
    jobs: {
      workersEnabled: env.JOB_WORKERS_ENABLED,
      schema: JOBS_SCHEMA,
      schedulerCron: SCHEDULER_CRON,
      pollingIntervalSeconds: JOB_POLLING_INTERVAL_SECONDS,
      admissionRetryLimit: ADMISSION_RETRY_LIMIT,
      admissionRetryDelaySeconds: ADMISSION_RETRY_DELAY_SECONDS,
      admissionExpireInSeconds: ADMISSION_EXPIRE_IN_SECONDS,
      stopTimeoutMs: JOB_STOP_TIMEOUT_MS,
    },
  };
}
