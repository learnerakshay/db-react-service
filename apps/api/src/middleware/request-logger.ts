import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../lib/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept caller-supplied IDs only when they are short and log-safe. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Assigns a correlation ID to every request (echoed in `x-request-id`) and
 * writes one structured log line per completed request.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customProps: (req) => ({ requestId: typeof req.id === 'string' ? req.id : undefined }),
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Method and path only: headers and query strings may carry sensitive data.
    serializers: {
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        path: req.url?.split('?')[0],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
