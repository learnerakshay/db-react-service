import type { DependencyStatus } from '@cadentor/shared';
import cors from 'cors';
import express, { type Express } from 'express';
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
}

/**
 * Builds the HTTP application. No listening, no process hooks — that lives in
 * server.ts so tests can construct the app with fake dependencies.
 */
export function createApp({ config, logger, checkDatabase }: AppDependencies): Express {
  const app = express();

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: config.http.corsOrigins }));
  app.use(express.json({ limit: config.http.jsonBodyLimit }));

  app.use(systemRouter({ serviceName: SERVICE_NAME, checkDatabase }));
  // Future feature routes mount under /api/v1 here.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
