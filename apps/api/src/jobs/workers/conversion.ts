import { z } from 'zod';
import type { Logger } from '../../lib/logger.js';
import {
  processQualification,
  type QualificationDependencies,
} from '../../modules/conversion/qualification.js';
import { sendConversionMessage } from '../../modules/conversion/sender.js';
import type { OutboundDependencies } from '../../modules/messaging/outbound.js';
import type { JobHandler } from '../queue.js';

const messagePayload = z.object({ messageId: z.uuid() });

/**
 * Qualifies from one inbound message. Duplicate or retried jobs are harmless.
 * Transient AI failures are rethrown for bounded job retries; on the final
 * attempt the evaluation is recorded without new facts instead.
 */
export function createQualificationWorker(deps: QualificationDependencies): JobHandler<unknown> {
  return async (job) => {
    const payload = messagePayload.safeParse(job.payload);
    if (!payload.success) {
      deps.logger.error(
        { jobId: job.id, operation: 'qualification.process', errorCode: 'VALIDATION_ERROR' },
        'invalid qualification payload; job discarded',
      );
      return;
    }
    const { messageId } = payload.data;
    try {
      const result = await processQualification(deps, messageId, {
        finalAttempt: job.attempt > deps.conversion.jobRetryLimit,
      });
      deps.logger.info(
        {
          jobId: job.id,
          messageId,
          operation: 'qualification.process',
          status: result.outcome,
          result: result.result,
          attempt: job.attempt,
        },
        'qualification job finished',
      );
    } catch (err) {
      deps.logger.error(
        { err, jobId: job.id, messageId, operation: 'qualification.process', attempt: job.attempt },
        'qualification failed',
      );
      throw err;
    }
  };
}

/** Sends one persisted question or booking link. Duplicate or retried jobs are harmless. */
export function createConversionSendWorker(
  outbound: OutboundDependencies,
  logger: Logger,
): JobHandler<unknown> {
  return async (job) => {
    const payload = messagePayload.safeParse(job.payload);
    if (!payload.success) {
      logger.error(
        { jobId: job.id, operation: 'conversion.send', errorCode: 'VALIDATION_ERROR' },
        'invalid conversion send payload; job discarded',
      );
      return;
    }
    const result = await sendConversionMessage(outbound, payload.data.messageId);
    logger.info(
      {
        jobId: job.id,
        messageId: payload.data.messageId,
        operation: 'conversion.send',
        status: result.outcome,
      },
      'conversion send job finished',
    );
  };
}
