import { z } from 'zod';
import { sendStep2Message } from '../../modules/followup/step2.js';
import {
  processIntegrationDelivery,
  type DeliveryDependencies,
} from '../../modules/integrations/deliveries.js';
import type { OutboundDependencies } from '../../modules/messaging/outbound.js';
import type { JobHandler } from '../queue.js';

const step2Payload = z.object({ campaignLeadId: z.uuid() });
const deliveryPayload = z.object({ deliveryId: z.uuid() });

/** Sends Step 2 for one membership. Duplicate or retried jobs send at most once. */
export function createStep2SendWorker(deps: OutboundDependencies): JobHandler<unknown> {
  return async (job) => {
    const payload = step2Payload.safeParse(job.payload);
    if (!payload.success) {
      deps.logger.error(
        { jobId: job.id, operation: 'messaging.step2', errorCode: 'VALIDATION_ERROR' },
        'invalid step 2 send payload; job discarded',
      );
      return;
    }
    const { campaignLeadId } = payload.data;
    try {
      const result = await sendStep2Message(deps, campaignLeadId);
      deps.logger.info(
        {
          jobId: job.id,
          campaignLeadId,
          messageId: result.messageId,
          provider: deps.provider.name,
          operation: 'messaging.step2',
          status: result.outcome,
          attempt: job.attempt,
        },
        'step 2 send processed',
      );
    } catch (err) {
      deps.logger.error(
        { err, jobId: job.id, campaignLeadId, operation: 'messaging.step2', attempt: job.attempt },
        'step 2 send failed',
      );
      throw err;
    }
  };
}

/**
 * Attempts one integration delivery. Provider failures are recorded on the
 * delivery row (RETRY/FAILED), not thrown; unexpected errors are rethrown for
 * bounded job retries.
 */
export function createDeliveryWorker(deps: DeliveryDependencies): JobHandler<unknown> {
  return async (job) => {
    const payload = deliveryPayload.safeParse(job.payload);
    if (!payload.success) {
      deps.logger.error(
        { jobId: job.id, operation: 'integrations.deliver', errorCode: 'VALIDATION_ERROR' },
        'invalid delivery payload; job discarded',
      );
      return;
    }
    const { deliveryId } = payload.data;
    try {
      const outcome = await processIntegrationDelivery(deps, deliveryId);
      deps.logger.info(
        { jobId: job.id, deliveryId, operation: 'integrations.deliver', status: outcome },
        'integration delivery job finished',
      );
    } catch (err) {
      deps.logger.error(
        { err, jobId: job.id, deliveryId, operation: 'integrations.deliver', attempt: job.attempt },
        'integration delivery failed',
      );
      throw err;
    }
  };
}
