import { Router } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import type { Logger } from '../lib/logger.js';
import type { CalendarProvider } from '../providers/calendar/index.js';
import type { IntegrationProviders } from '../providers/integrations.js';
import type { MessagingProvider } from '../providers/messaging/index.js';
import { calendarWebhooksRouter } from './calendar-webhooks.js';
import { campaignsRouter } from './campaigns.js';
import { importsRouter } from './imports.js';
import { knowledgeRouter } from './knowledge.js';
import { missionControlRouter } from './mission-control.js';
import { messagingWebhooksRouter } from './webhooks.js';

export interface ApiRouterDependencies {
  db: Database;
  config: AppConfig;
  logger: Logger;
  /** Configured messaging providers by name; webhooks are absent without one. */
  messagingProviders?: ReadonlyMap<string, MessagingProvider>;
  /** Called after a new inbound message is stored (e.g. enqueue reply processing). */
  onInboundMessage?: (messageId: string) => Promise<void>;
  /** Configured calendar providers by name; booking webhooks are absent without one. */
  calendarProviders?: ReadonlyMap<string, CalendarProvider>;
  /** Configured CRM / notification / handoff adapters, for integration health only. */
  integrationProviders?: IntegrationProviders;
}

/** Feature routes, mounted at /api/v1. */
export function apiRouter(deps: ApiRouterDependencies): Router {
  const router = Router();
  router.use('/imports', importsRouter(deps));
  router.use('/campaigns', campaignsRouter(deps));
  router.use('/knowledge', knowledgeRouter(deps));
  router.use(missionControlRouter(deps));
  if (deps.messagingProviders !== undefined && deps.messagingProviders.size > 0) {
    router.use(
      '/webhooks/messaging',
      messagingWebhooksRouter({ ...deps, providers: deps.messagingProviders }),
    );
  }
  if (deps.calendarProviders !== undefined && deps.calendarProviders.size > 0) {
    router.use(
      '/webhooks/calendar',
      calendarWebhooksRouter({ ...deps, providers: deps.calendarProviders }),
    );
  }
  return router;
}
