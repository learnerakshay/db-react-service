import { z } from 'zod';
import type { AppConfig } from '../../config/index.js';
import type { Database } from '../../db/client.js';
import { NotFoundError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { admitEligibleMembers } from '../../modules/dispatch/admission.js';
import type { JobHandler } from '../queue.js';

export const campaignAdmissionPayload = z.object({ campaignId: z.uuid() });

export interface CampaignAdmissionWorkerDeps {
  db: Database;
  logger: Logger;
  dispatch: AppConfig['dispatch'];
}

/**
 * Runs one admission pass for one campaign. Safe to run more than once for the
 * same campaign at the same time; all guarantees come from the database
 * transaction in `admitEligibleMembers`. Unexpected errors are rethrown so
 * pg-boss retries them (bounded by the queue's retryLimit).
 */
export function createCampaignAdmissionWorker(
  deps: CampaignAdmissionWorkerDeps,
): JobHandler<unknown> {
  return async (job) => {
    const payload = campaignAdmissionPayload.safeParse(job.payload);
    if (!payload.success) {
      // Retrying cannot fix a malformed payload; record it and complete the job.
      deps.logger.error(
        { jobId: job.id, operation: 'dispatch.admit', errorCode: 'VALIDATION_ERROR' },
        'invalid campaign admission payload; job discarded',
      );
      return;
    }
    const { campaignId } = payload.data;

    try {
      const result = await admitEligibleMembers(deps.db, campaignId, {
        ...deps.dispatch,
        jobId: job.id,
      });
      deps.logger.info(
        {
          jobId: job.id,
          campaignId,
          operation: 'dispatch.admit',
          status: result.campaignStatus,
          attempt: job.attempt,
          admitted: result.admitted,
          optedOut: result.optedOut,
          scanned: result.scanned,
          admittedBefore: result.admittedBefore,
          hourlyLimit: result.hourlyLimit,
          skipped: result.skipped,
        },
        'campaign admission run',
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        deps.logger.warn(
          { jobId: job.id, campaignId, operation: 'dispatch.admit', errorCode: err.code },
          'campaign no longer exists; job discarded',
        );
        return;
      }
      deps.logger.error(
        { err, jobId: job.id, campaignId, operation: 'dispatch.admit', attempt: job.attempt },
        'campaign admission failed',
      );
      throw err;
    }
  };
}
