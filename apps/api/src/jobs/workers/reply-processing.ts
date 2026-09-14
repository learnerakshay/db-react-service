import { z } from 'zod';
import type { Logger } from '../../lib/logger.js';
import type { OutboundDependencies } from '../../modules/messaging/outbound.js';
import { processInboundMessage, type ReplyDependencies } from '../../modules/replies/processor.js';
import { sendConversationalReply } from '../../modules/replies/reply-sender.js';
import type { JobHandler } from '../queue.js';

const messagePayload = z.object({ messageId: z.uuid() });

/** Processes one inbound message. Duplicate or retried jobs are harmless. */
export function createReplyProcessWorker(deps: ReplyDependencies): JobHandler<unknown> {
  return async (job) => {
    const payload = messagePayload.safeParse(job.payload);
    if (!payload.success) {
      deps.logger.error(
        { jobId: job.id, operation: 'replies.process', errorCode: 'VALIDATION_ERROR' },
        'invalid reply processing payload; job discarded',
      );
      return;
    }
    try {
      const result = await processInboundMessage(deps, payload.data.messageId);
      deps.logger.info(
        {
          jobId: job.id,
          messageId: payload.data.messageId,
          operation: 'replies.process',
          status: result.outcome,
          replyOutcome: result.replyOutcome,
          attempt: job.attempt,
        },
        'reply processing job finished',
      );
    } catch (err) {
      deps.logger.error(
        {
          err,
          jobId: job.id,
          messageId: payload.data.messageId,
          operation: 'replies.process',
          attempt: job.attempt,
        },
        'reply processing failed',
      );
      throw err;
    }
  };
}

/** Sends one persisted reply. Duplicate or retried jobs are harmless. */
export function createReplySendWorker(
  outbound: OutboundDependencies,
  logger: Logger,
): JobHandler<unknown> {
  return async (job) => {
    const payload = messagePayload.safeParse(job.payload);
    if (!payload.success) {
      logger.error(
        { jobId: job.id, operation: 'replies.send', errorCode: 'VALIDATION_ERROR' },
        'invalid reply send payload; job discarded',
      );
      return;
    }
    const result = await sendConversationalReply(outbound, payload.data.messageId);
    logger.info(
      {
        jobId: job.id,
        messageId: payload.data.messageId,
        operation: 'replies.send',
        status: result.outcome,
      },
      'reply send job finished',
    );
  };
}
