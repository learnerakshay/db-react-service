import { z } from 'zod';
import { ConfigurationError } from '../lib/errors.js';
import { parseOperatorTokens } from './operators.js';

/** `.env` files produce `KEY=` for unset values; treat blanks as absent. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const field = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);

const optionalString = field(z.string().trim().min(1).optional());

export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in 24h time');

export const timezone = z.string().refine(isValidTimeZone, 'must be a valid IANA timezone');

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    // Intl throws RangeError for unknown zones; that *is* the validation result.
    return false;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: field(z.enum(['development', 'test', 'production']).default('development')),
    LOG_LEVEL: field(
      z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    ),

    DATABASE_URL: field(z.url({ protocol: /^postgres(ql)?$/ }).optional()),

    API_PORT: field(z.coerce.number().int().min(1).max(65_535).default(4000)),
    WEB_URL: field(z.url().optional()),
    API_URL: field(z.url().default('http://localhost:4000')),
    /** Reverse-proxy hops in front of the API (for client IPs in rate limiting). */
    TRUST_PROXY: field(z.coerce.number().int().min(0).max(10).default(0)),

    // Operator access (Phase 4 / Prompt 2): "<id>:<OPERATOR|ADMIN>:<sha256 hex>", comma-separated.
    OPERATOR_TOKENS: optionalString,

    // Future provider credentials: accepted now, required by their owning phase.
    OPENAI_API_KEY: optionalString,
    OPENAI_MODEL: optionalString,
    SMS_PROVIDER: field(z.enum(['twilio']).optional()),
    SMS_ACCOUNT_ID: optionalString,
    SMS_AUTH_TOKEN: optionalString,
    SMS_FROM_NUMBER: field(
      z
        .string()
        .trim()
        .regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 number')
        .optional(),
    ),
    CALENDAR_PROVIDER: optionalString,
    CRM_PROVIDER: optionalString,
    OWNER_NOTIFICATION_PROVIDER: optionalString,

    // Future campaign operations: typed and defaulted, no workflow uses them yet.
    DEFAULT_CAMPAIGN_TIMEZONE: field(timezone.default('America/New_York')),
    CAMPAIGN_SEND_WINDOW_START: field(timeOfDay.default('09:00')),
    CAMPAIGN_SEND_WINDOW_END: field(timeOfDay.default('18:00')),
    CAMPAIGN_HOURLY_DISPATCH_LIMIT: field(z.coerce.number().int().positive().default(60)),
    CAMPAIGN_FOLLOW_UP_DELAY_HOURS: field(z.coerce.number().positive().default(48)),
    CAMPAIGN_ARCHIVE_DELAY_DAYS: field(z.coerce.number().positive().default(14)),
    CLASSIFIER_CONFIDENCE_THRESHOLD: field(z.coerce.number().min(0).max(1).default(0.8)),

    // Lead imports.
    IMPORT_MAX_FILE_BYTES: field(
      z.coerce
        .number()
        .int()
        .positive()
        .max(100 * 1024 * 1024)
        .default(10 * 1024 * 1024),
    ),

    // Background jobs. Set false to run an API-only process (no scheduler/workers).
    JOB_WORKERS_ENABLED: field(
      z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
    ),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (env.NODE_ENV === 'production') {
      for (const key of ['DATABASE_URL', 'WEB_URL', 'OPERATOR_TOKENS'] as const) {
        if (env[key] === undefined) issue(key, 'is required in production');
      }
      // Operator tokens travel in headers: never over plain HTTP in production.
      for (const key of ['API_URL', 'WEB_URL'] as const) {
        const value = env[key];
        if (value !== undefined && !value.startsWith('https://')) {
          issue(key, 'must be an https URL in production');
        }
      }
    }
    // CORS allows exactly this origin: no wildcard, path or query.
    if (
      env.WEB_URL !== undefined &&
      new URL(env.WEB_URL).origin !== env.WEB_URL.replace(/\/$/, '')
    ) {
      issue('WEB_URL', 'must be a bare origin such as https://ops.example.com');
    }
    const operators = parseOperatorTokens(env.OPERATOR_TOKENS);
    if (!operators.ok) issue('OPERATOR_TOKENS', operators.message);
    // No default model: the operator chooses it explicitly.
    if (env.OPENAI_API_KEY !== undefined && env.OPENAI_MODEL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_MODEL'],
        message: 'is required when OPENAI_API_KEY is set',
      });
    }
    if (env.SMS_PROVIDER !== undefined) {
      for (const key of ['SMS_ACCOUNT_ID', 'SMS_AUTH_TOKEN', 'SMS_FROM_NUMBER'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when SMS_PROVIDER is set',
          });
        }
      }
      // The Twilio SDK throws on a malformed Account SID; fail at startup instead.
      if (env.SMS_ACCOUNT_ID !== undefined && !/^AC[0-9a-fA-F]{32}$/.test(env.SMS_ACCOUNT_ID)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMS_ACCOUNT_ID'],
          message: 'must be a Twilio Account SID (AC followed by 32 hex characters)',
        });
      }
      // Webhook signatures are computed over the public URL built from API_URL.
      if (env.NODE_ENV === 'production' && !env.API_URL.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['API_URL'],
          message: 'must be the public https URL when SMS_PROVIDER is set in production',
        });
      }
    }
    // HH:MM strings compare correctly lexicographically.
    if (env.CAMPAIGN_SEND_WINDOW_START >= env.CAMPAIGN_SEND_WINDOW_END) {
      ctx.addIssue({
        code: 'custom',
        path: ['CAMPAIGN_SEND_WINDOW_END'],
        message: 'must be later than CAMPAIGN_SEND_WINDOW_START',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validate raw environment variables. Throws ConfigurationError naming every
 * invalid key. Messages never include the offending values (they may be secrets).
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `  - ${key}: ${issue.message}`;
  });
  return failConfiguration(`Invalid environment configuration:\n${problems.join('\n')}`);
}

function failConfiguration(message: string): never {
  throw new ConfigurationError(message);
}
