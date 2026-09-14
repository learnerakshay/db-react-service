import { Router } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import type { Logger } from '../lib/logger.js';
import type { MessagingProvider } from '../providers/messaging/index.js';
import { campaignsRouter } from './campaigns.js';
import { importsRouter } from './imports.js';
import { knowledgeRouter } from './knowledge.js';
import { messagingWebhooksRouter } from './webhooks.js';

export interface ApiRouterDependencies {
  db: Database;
  config: AppConfig;
  logger: Logger;
  /** Configured messaging providers by name; webhooks are absent without one. */
  messagingProviders?: ReadonlyMap<string, MessagingProvider>;
  /** Called after a new inbound message is stored (e.g. enqueue reply processing). */
  onInboundMessage?: (messageId: string) => Promise<void>;
}

/** Feature routes, mounted at /api/v1. */
export function apiRouter(deps: ApiRouterDependencies): Router {
  const router = Router();
  router.use('/imports', importsRouter(deps));
  router.use('/campaigns', campaignsRouter(deps));
  router.use('/knowledge', knowledgeRouter(deps));
  if (deps.messagingProviders !== undefined && deps.messagingProviders.size > 0) {
    router.use(
      '/webhooks/messaging',
      messagingWebhooksRouter({ ...deps, providers: deps.messagingProviders }),
    );
  }
  return router;
}
