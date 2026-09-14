import { Router } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import type { Logger } from '../lib/logger.js';
import { campaignsRouter } from './campaigns.js';
import { importsRouter } from './imports.js';

export interface ApiRouterDependencies {
  db: Database;
  config: AppConfig;
  logger: Logger;
}

/** Feature routes, mounted at /api/v1. */
export function apiRouter(deps: ApiRouterDependencies): Router {
  const router = Router();
  router.use('/imports', importsRouter(deps));
  router.use('/campaigns', campaignsRouter(deps));
  return router;
}
