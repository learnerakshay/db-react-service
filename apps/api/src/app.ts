import type { DependencyStatus } from '@cadentor/shared';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { SERVICE_NAME, type AppConfig } from './config/index.js';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { systemRouter } from './routes/system.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  checkDatabase: () => Promise<DependencyStatus>;
  /** Feature routes mounted at /api/v1. Absent when no database is configured. */
  api?: Router;
}

/**
 * Builds the HTTP application. No listening, no process hooks — that lives in
 * server.ts so tests can construct the app with fake dependencies.
 */
export function createApp({ config, logger, checkDatabase, api }: AppDependencies): Express {
  const app = express();

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: config.http.corsOrigins }));
  app.use(express.json({ limit: config.http.jsonBodyLimit }));

  app.use(systemRouter({ serviceName: SERVICE_NAME, checkDatabase }));
  if (api !== undefined) app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
