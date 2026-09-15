import type { DependencyStatus } from '@cadentor/shared';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { SERVICE_NAME, type AppConfig } from './config/index.js';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { systemRouter } from './routes/system.js';

/** Webhook routers parse their own raw bodies so providers can sign raw payloads. */
export const WEBHOOK_PATH_PREFIX = '/api/v1/webhooks/';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  checkDatabase: () => Promise<DependencyStatus>;
  /** Job queue readiness; absent when this process runs no workers. */
  checkJobs?: () => DependencyStatus;
  /** Feature routes mounted at /api/v1. Absent when no database is configured. */
  api?: Router;
}

/**
 * Builds the HTTP application. No listening, no process hooks — that lives in
 * server.ts so tests can construct the app with fake dependencies.
 */
export function createApp({
  config,
  logger,
  checkDatabase,
  checkJobs,
  api,
}: AppDependencies): Express {
  const app = express();
  // Client IPs (rate limiting) come from X-Forwarded-For only through trusted hops.
  app.set('trust proxy', config.http.trustProxy);

  app.use(requestLogger(logger));
  // Defaults include HSTS, nosniff, frameguard and a restrictive CSP for API responses.
  app.use(helmet());
  app.use(cors({ origin: config.http.corsOrigins }));

  const json = express.json({ limit: config.http.jsonBodyLimit, strict: true });
  app.use((req, res, next) => {
    if (req.path.startsWith(WEBHOOK_PATH_PREFIX)) {
      next();
      return;
    }
    json(req, res, next);
  });

  app.use(
    systemRouter({
      serviceName: SERVICE_NAME,
      checkDatabase,
      ...(checkJobs === undefined ? {} : { checkJobs }),
    }),
  );
  if (api !== undefined) app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
