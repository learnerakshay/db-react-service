import type { OperatorIdentity } from '@cadentor/shared';
import { Router } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import type { Logger } from '../lib/logger.js';
import { authenticateOperators, operatorOf, requireRole } from '../middleware/auth.js';
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

/**
 * Feature routes, mounted at /api/v1.
 *
 * 1. Webhooks: provider signature verification, never operator auth.
 * 2. Everything else: operator bearer authentication (401), then roles (403):
 *    reads, campaign lifecycle, takeover and review resolution need OPERATOR;
 *    imports, knowledge writes, campaign creation and delivery recovery need ADMIN.
 */
export function apiRouter(deps: ApiRouterDependencies): Router {
  const router = Router();
  const { logger } = deps;

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

  router.use(authenticateOperators(deps.config, logger));
  router.get('/auth/me', (req, res) => {
    const body: OperatorIdentity = operatorOf(req);
    res.json(body);
  });
  router.use('/imports', requireRole('ADMIN', logger), importsRouter(deps));
  router.use('/knowledge', requireRole('ADMIN', logger, true), knowledgeRouter(deps));
  router.use('/campaigns', campaignsRouter(deps));
  router.use(missionControlRouter(deps));
  return router;
}
