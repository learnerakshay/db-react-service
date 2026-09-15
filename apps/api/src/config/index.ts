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
    ai: { openaiApiKey: string | undefined; model: string | undefined };
    messaging: {
      provider: Env['SMS_PROVIDER'];
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
  messaging: {
    /** Provider HTTP timeout per send. A timeout is recorded UNCERTAIN, never resent. */
    sendTimeoutMs: number;
    /** A SENDING message older than this was interrupted and becomes UNCERTAIN. */
    sendingStaleAfterMs: number;
    /** QUEUED memberships examined per dispatch tick. */
    dispatchBatchSize: number;
    dispatchCron: string;
    transactionTimeoutMs: number;
    sendRetryLimit: number;
    sendRetryDelaySeconds: number;
    sendExpireInSeconds: number;
    webhookBodyLimit: string;
  };
  replies: {
    /** Prior messages of the same conversation given to the model. */
    historyLimit: number;
    historyMessageMaxChars: number;
    maxReplyLength: number;
    knowledgeMaxItems: number;
    aiTimeoutMs: number;
    classifierMaxOutputTokens: number;
    answerMaxOutputTokens: number;
    /** Claims per inbound message before escalating as AI_UNAVAILABLE. */
    processingMaxAttempts: number;
    processingStaleAfterMs: number;
    /** Older inbound messages are escalated instead of auto-answered. */
    maxInboundAgeMs: number;
    transactionTimeoutMs: number;
    tickBatchSize: number;
    cron: string;
    jobRetryLimit: number;
    jobRetryDelaySeconds: number;
    jobExpireInSeconds: number;
    /** PENDING replies older than this are re-enqueued for sending. */
    pendingReplyResendAfterMs: number;
  };
  conversion: {
    extractionMaxOutputTokens: number;
    tickBatchSize: number;
    cron: string;
    jobRetryLimit: number;
    jobRetryDelaySeconds: number;
    jobExpireInSeconds: number;
    /** PENDING question/booking-link messages older than this are re-enqueued. */
    pendingSendAfterMs: number;
    transactionTimeoutMs: number;
    webhookBodyLimit: string;
  };
  operations: {
    /** Step 2 candidates, archival and deliveries: one pg-boss cron tick. */
    cron: string;
    /** Rows examined per kind per tick. */
    tickBatchSize: number;
    transactionTimeoutMs: number;
    /** Provider attempts per integration delivery before FAILED. */
    deliveryMaxAttempts: number;
    /** Retry delay doubles per attempt from this base. */
    deliveryRetryBaseDelaySeconds: number;
    /** A PROCESSING delivery older than this was interrupted and may be reclaimed. */
    deliveryProcessingStaleAfterMs: number;
    jobRetryLimit: number;
    jobRetryDelaySeconds: number;
    jobExpireInSeconds: number;
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
const MESSAGING_SEND_TIMEOUT_MS = 15_000;
const MESSAGING_SENDING_STALE_AFTER_MS = 10 * 60_000;
const MESSAGING_DISPATCH_BATCH_SIZE = 500;
const MESSAGING_DISPATCH_CRON = '* * * * *';
const MESSAGING_TRANSACTION_TIMEOUT_MS = 30_000;
const MESSAGING_SEND_RETRY_LIMIT = 2;
const MESSAGING_SEND_RETRY_DELAY_SECONDS = 30;
/** Must exceed the send timeout plus both short transactions. */
const MESSAGING_SEND_EXPIRE_IN_SECONDS = 120;
const MESSAGING_WEBHOOK_BODY_LIMIT = '64kb';
const REPLIES_HISTORY_LIMIT = 10;
const REPLIES_HISTORY_MESSAGE_MAX_CHARS = 480;
const REPLIES_MAX_REPLY_LENGTH = 320;
const REPLIES_KNOWLEDGE_MAX_ITEMS = 8;
const REPLIES_AI_TIMEOUT_MS = 20_000;
const REPLIES_CLASSIFIER_MAX_OUTPUT_TOKENS = 300;
const REPLIES_ANSWER_MAX_OUTPUT_TOKENS = 500;
const REPLIES_PROCESSING_MAX_ATTEMPTS = 3;
const REPLIES_PROCESSING_STALE_AFTER_MS = 5 * 60_000;
const REPLIES_MAX_INBOUND_AGE_MS = 24 * 60 * 60_000;
const REPLIES_TRANSACTION_TIMEOUT_MS = 30_000;
const REPLIES_TICK_BATCH_SIZE = 200;
const REPLIES_CRON = '* * * * *';
const REPLIES_JOB_RETRY_LIMIT = 2;
const REPLIES_JOB_RETRY_DELAY_SECONDS = 30;
/** Must exceed two AI calls plus one provider send. */
const REPLIES_JOB_EXPIRE_IN_SECONDS = 180;
const REPLIES_PENDING_REPLY_RESEND_AFTER_MS = 60_000;
const CONVERSION_EXTRACTION_MAX_OUTPUT_TOKENS = 400;
const CONVERSION_TICK_BATCH_SIZE = 200;
const CONVERSION_CRON = '* * * * *';
const CONVERSION_JOB_RETRY_LIMIT = 2;
const CONVERSION_JOB_RETRY_DELAY_SECONDS = 30;
/** Must exceed one AI call plus two provider sends. */
const CONVERSION_JOB_EXPIRE_IN_SECONDS = 120;
const CONVERSION_PENDING_SEND_AFTER_MS = 60_000;
const CONVERSION_TRANSACTION_TIMEOUT_MS = 30_000;
const CONVERSION_WEBHOOK_BODY_LIMIT = '64kb';
const OPERATIONS_CRON = '* * * * *';
const OPERATIONS_TICK_BATCH_SIZE = 200;
const OPERATIONS_TRANSACTION_TIMEOUT_MS = 30_000;
const OPERATIONS_DELIVERY_MAX_ATTEMPTS = 5;
const OPERATIONS_DELIVERY_RETRY_BASE_DELAY_SECONDS = 60;
const OPERATIONS_DELIVERY_PROCESSING_STALE_AFTER_MS = 10 * 60_000;
const OPERATIONS_JOB_RETRY_LIMIT = 2;
const OPERATIONS_JOB_RETRY_DELAY_SECONDS = 30;
/** Must exceed one provider call plus two short transactions. */
const OPERATIONS_JOB_EXPIRE_IN_SECONDS = 120;

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
      ai: { openaiApiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL },
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
    messaging: {
      sendTimeoutMs: MESSAGING_SEND_TIMEOUT_MS,
      sendingStaleAfterMs: MESSAGING_SENDING_STALE_AFTER_MS,
      dispatchBatchSize: MESSAGING_DISPATCH_BATCH_SIZE,
      dispatchCron: MESSAGING_DISPATCH_CRON,
      transactionTimeoutMs: MESSAGING_TRANSACTION_TIMEOUT_MS,
      sendRetryLimit: MESSAGING_SEND_RETRY_LIMIT,
      sendRetryDelaySeconds: MESSAGING_SEND_RETRY_DELAY_SECONDS,
      sendExpireInSeconds: MESSAGING_SEND_EXPIRE_IN_SECONDS,
      webhookBodyLimit: MESSAGING_WEBHOOK_BODY_LIMIT,
    },
    replies: {
      historyLimit: REPLIES_HISTORY_LIMIT,
      historyMessageMaxChars: REPLIES_HISTORY_MESSAGE_MAX_CHARS,
      maxReplyLength: REPLIES_MAX_REPLY_LENGTH,
      knowledgeMaxItems: REPLIES_KNOWLEDGE_MAX_ITEMS,
      aiTimeoutMs: REPLIES_AI_TIMEOUT_MS,
      classifierMaxOutputTokens: REPLIES_CLASSIFIER_MAX_OUTPUT_TOKENS,
      answerMaxOutputTokens: REPLIES_ANSWER_MAX_OUTPUT_TOKENS,
      processingMaxAttempts: REPLIES_PROCESSING_MAX_ATTEMPTS,
      processingStaleAfterMs: REPLIES_PROCESSING_STALE_AFTER_MS,
      maxInboundAgeMs: REPLIES_MAX_INBOUND_AGE_MS,
      transactionTimeoutMs: REPLIES_TRANSACTION_TIMEOUT_MS,
      tickBatchSize: REPLIES_TICK_BATCH_SIZE,
      cron: REPLIES_CRON,
      jobRetryLimit: REPLIES_JOB_RETRY_LIMIT,
      jobRetryDelaySeconds: REPLIES_JOB_RETRY_DELAY_SECONDS,
      jobExpireInSeconds: REPLIES_JOB_EXPIRE_IN_SECONDS,
      pendingReplyResendAfterMs: REPLIES_PENDING_REPLY_RESEND_AFTER_MS,
    },
    conversion: {
      extractionMaxOutputTokens: CONVERSION_EXTRACTION_MAX_OUTPUT_TOKENS,
      tickBatchSize: CONVERSION_TICK_BATCH_SIZE,
      cron: CONVERSION_CRON,
      jobRetryLimit: CONVERSION_JOB_RETRY_LIMIT,
      jobRetryDelaySeconds: CONVERSION_JOB_RETRY_DELAY_SECONDS,
      jobExpireInSeconds: CONVERSION_JOB_EXPIRE_IN_SECONDS,
      pendingSendAfterMs: CONVERSION_PENDING_SEND_AFTER_MS,
      transactionTimeoutMs: CONVERSION_TRANSACTION_TIMEOUT_MS,
      webhookBodyLimit: CONVERSION_WEBHOOK_BODY_LIMIT,
    },
    operations: {
      cron: OPERATIONS_CRON,
      tickBatchSize: OPERATIONS_TICK_BATCH_SIZE,
      transactionTimeoutMs: OPERATIONS_TRANSACTION_TIMEOUT_MS,
      deliveryMaxAttempts: OPERATIONS_DELIVERY_MAX_ATTEMPTS,
      deliveryRetryBaseDelaySeconds: OPERATIONS_DELIVERY_RETRY_BASE_DELAY_SECONDS,
      deliveryProcessingStaleAfterMs: OPERATIONS_DELIVERY_PROCESSING_STALE_AFTER_MS,
      jobRetryLimit: OPERATIONS_JOB_RETRY_LIMIT,
      jobRetryDelaySeconds: OPERATIONS_JOB_RETRY_DELAY_SECONDS,
      jobExpireInSeconds: OPERATIONS_JOB_EXPIRE_IN_SECONDS,
    },
  };
}
