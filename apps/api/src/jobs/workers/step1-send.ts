import { z } from 'zod';
import { sendStep1Message, type OutboundDependencies } from '../../modules/messaging/outbound.js';
import type { JobHandler } from '../queue.js';

export const step1SendPayload = z.object({ campaignLeadId: z.uuid() });

/**
 * Sends Step 1 for one membership. Duplicate or retried jobs are harmless:
 * the logical send key and the membership row lock allow at most one provider
 * call per membership. Unexpected errors are rethrown for bounded retries.
 */
export function createStep1SendWorker(deps: OutboundDependencies): JobHandler<unknown> {
  return async (job) => {
    const payload = step1SendPayload.safeParse(job.payload);
    if (!payload.success) {
      deps.logger.error(
        { jobId: job.id, operation: 'messaging.step1', errorCode: 'VALIDATION_ERROR' },
        'invalid step 1 send payload; job discarded',
      );
      return;
    }
    const { campaignLeadId } = payload.data;

    try {
      const result = await sendStep1Message(deps, campaignLeadId);
      deps.logger.info(
        {
          jobId: job.id,
          campaignLeadId,
          messageId: result.messageId,
          provider: deps.provider.name,
          operation: 'messaging.step1',
          status: result.outcome,
          attempt: job.attempt,
        },
        'step 1 send processed',
      );
    } catch (err) {
      deps.logger.error(
        { err, jobId: job.id, campaignLeadId, operation: 'messaging.step1', attempt: job.attempt },
        'step 1 send failed',
      );
      throw err;
    }
  };
}
