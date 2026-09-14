import type { ErrorCode } from '@cadentor/shared';
import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Standard structured fields. Use these names (not ad-hoc variants) so logs
 * can be filtered consistently across requests, jobs and provider calls.
 * Never log raw lead contact data, message bodies, credentials or tokens.
 */
export interface LogContext {
  requestId?: string;
  campaignId?: string;
  leadId?: string;
  jobId?: string;
  provider?: string;
  operation?: string;
  status?: string;
  errorCode?: ErrorCode;
}

/** Defense in depth: values at these paths are replaced before output. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...[
    'password',
    'token',
    'authToken',
    'apiKey',
    'secret',
    'databaseUrl',
    'connectionString',
  ].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'cadentor-reactivation-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}
