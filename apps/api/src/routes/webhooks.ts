import express, { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { applyDeliveryStatus } from '../modules/messaging/delivery.js';
import { recordInboundMessage } from '../modules/messaging/inbound.js';
import type {
  MessagingProvider,
  WebhookAck,
  WebhookRequest,
} from '../providers/messaging/index.js';
import { publicApiBase } from '../providers/messaging/registry.js';

export interface MessagingWebhookDeps {
  db: Database;
  config: AppConfig;
  logger: Logger;
  providers: ReadonlyMap<string, MessagingProvider>;
  /** Called once per newly stored inbound message (not for duplicates). */
  onInboundMessage?: (messageId: string) => Promise<void>;
}

/**
 * POST /api/v1/webhooks/messaging/:provider/inbound
 * POST /api/v1/webhooks/messaging/:provider/status
 *
 * The raw form body is kept as text for signature verification. Nothing in the
 * payload is parsed or trusted until the provider signature has been verified.
 */
export function messagingWebhooksRouter(deps: MessagingWebhookDeps): Router {
  const router = Router();
  const rawForm = express.text({
    type: 'application/x-www-form-urlencoded',
    limit: deps.config.messaging.webhookBodyLimit,
  });
  const base = publicApiBase(deps.config);
  const { transactionTimeoutMs } = deps.config.messaging;

  function authenticate(req: Request): { provider: MessagingProvider; request: WebhookRequest } {
    const providerName = String(req.params.provider);
    const provider = deps.providers.get(providerName);
    if (provider === undefined) throw new NotFoundError('Unknown messaging provider');

    const request: WebhookRequest = {
      url: `${base}${req.originalUrl}`,
      headers: req.headers,
      rawBody: typeof req.body === 'string' ? req.body : '',
    };
    if (!provider.verifyWebhook(request)) {
      deps.logger.warn(
        { provider: provider.name, operation: 'webhook.verify', errorCode: 'FORBIDDEN' },
        'webhook rejected: invalid or missing signature',
      );
      throw new ForbiddenError('Invalid webhook signature');
    }
    return { provider, request };
  }

  router.post('/:provider/inbound', rawForm, async (req, res) => {
    const { provider, request } = authenticate(req);
    const event = provider.parseInboundWebhook(request);
    const result = await recordInboundMessage(deps.db, provider.name, event, {
      transactionTimeoutMs,
    });
    deps.logger.info(
      {
        provider: provider.name,
        operation: 'webhook.inbound',
        messageId: result.messageId,
        status: result.duplicate ? 'DUPLICATE' : result.resolution,
        hardOptOut: result.hardOptOut,
      },
      'inbound message webhook handled',
    );
    if (!result.duplicate && result.messageId !== null && deps.onInboundMessage !== undefined) {
      const messageId = result.messageId;
      // The message is already stored; if enqueueing fails the reply tick picks it up.
      await deps.onInboundMessage(messageId).catch((err: unknown) => {
        deps.logger.warn(
          { err, operation: 'webhook.inbound', messageId },
          'could not enqueue reply processing; the reply tick will retry',
        );
      });
    }
    sendAck(res, provider.webhookAck('INBOUND_MESSAGE'));
  });

  router.post('/:provider/status', rawForm, async (req, res) => {
    const { provider, request } = authenticate(req);
    const event = provider.parseStatusWebhook(request);
    const result = await applyDeliveryStatus(deps.db, provider.name, event, {
      transactionTimeoutMs,
    });
    deps.logger.info(
      {
        provider: provider.name,
        operation: 'webhook.status',
        messageId: result.messageId,
        status: result.duplicate ? 'DUPLICATE' : result.outcome,
      },
      'delivery status webhook handled',
    );
    sendAck(res, provider.webhookAck('DELIVERY_STATUS'));
  });

  return router;
}

function sendAck(res: Response, ack: WebhookAck): void {
  res.status(ack.status);
  if (ack.contentType !== null) res.type(ack.contentType);
  res.send(ack.body);
}
