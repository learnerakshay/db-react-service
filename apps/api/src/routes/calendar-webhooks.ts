import express, { Router } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { applyBookingEvent } from '../modules/conversion/booking-events.js';
import type { CalendarProvider } from '../providers/calendar/index.js';
import type { WebhookRequest } from '../providers/messaging/index.js';
import { publicApiBase } from '../providers/messaging/registry.js';

export interface CalendarWebhookDeps {
  db: Database;
  config: AppConfig;
  logger: Logger;
  providers: ReadonlyMap<string, CalendarProvider>;
}

/**
 * POST /api/v1/webhooks/calendar/:provider
 *
 * Signature first; nothing in the payload is parsed or trusted before it.
 * The raw body (any content type, including JSON) is kept as text for
 * verification: the app-level JSON parser skips webhook paths (Phase 4 / Prompt 2).
 */
export function calendarWebhooksRouter(deps: CalendarWebhookDeps): Router {
  const router = Router();
  const rawBody = express.text({
    type: () => true,
    limit: deps.config.conversion.webhookBodyLimit,
  });
  const base = publicApiBase(deps.config);

  router.post('/:provider', rawBody, async (req, res) => {
    const provider = deps.providers.get(req.params.provider);
    if (provider === undefined) throw new NotFoundError('Unknown calendar provider');

    const request: WebhookRequest = {
      url: `${base}${req.originalUrl}`,
      headers: req.headers,
      rawBody: typeof req.body === 'string' ? req.body : '',
    };
    if (!provider.verifyWebhook(request)) {
      deps.logger.warn(
        { provider: provider.name, operation: 'webhook.calendar.verify', errorCode: 'FORBIDDEN' },
        'calendar webhook rejected: invalid or missing signature',
      );
      throw new ForbiddenError('Invalid webhook signature');
    }

    const event = provider.parseBookingWebhook(request);
    if (event !== null) {
      const result = await applyBookingEvent(deps.db, provider.name, event, {
        transactionTimeoutMs: deps.config.conversion.transactionTimeoutMs,
      });
      deps.logger.info(
        {
          provider: provider.name,
          operation: 'webhook.calendar',
          status: result.duplicate ? 'DUPLICATE' : result.outcome,
          bookingOpportunityId: result.opportunityId,
        },
        'calendar webhook handled',
      );
    }

    const ack = provider.webhookAck();
    res.status(ack.status);
    if (ack.contentType !== null) res.type(ack.contentType);
    res.send(ack.body);
  });

  return router;
}
