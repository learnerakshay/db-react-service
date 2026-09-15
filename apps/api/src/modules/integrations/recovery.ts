import type { IntegrationDestination, RequeueBlockedResponse } from '@cadentor/shared';
import type { Database } from '../../db/client.js';
import { IntegrationDeliveryStatus } from '../../generated/prisma/enums.js';
import { recordOperatorAction } from '../audit/audit.js';
import type { OperatorContext } from '../reviews/resolution.js';

/** The code `processIntegrationDelivery` records when no adapter exists. */
export const NOT_CONFIGURED = 'NOT_CONFIGURED';

/**
 * Explicit recovery after a missing provider is configured: deliveries that
 * were BLOCKED only because their destination had no adapter go back to
 * PENDING (due now) for destinations that are configured in this process.
 * FAILED rows and BLOCKED rows of still-unconfigured destinations are never
 * touched. Idempotent: a repeat finds nothing to requeue and writes no audit.
 * Each requeued row keeps its idempotency key, so providers still dedupe.
 */
export async function requeueBlockedDeliveries(
  db: Database,
  configured: readonly IntegrationDestination[],
  context: OperatorContext,
): Promise<RequeueBlockedResponse> {
  return db.$transaction(
    async (tx) => {
      const byDestination: Record<IntegrationDestination, number> = {
        CRM: 0,
        OWNER_NOTIFICATION: 0,
        POST_BOOKING_HANDOFF: 0,
      };
      for (const destination of configured) {
        const { count } = await tx.integrationDelivery.updateMany({
          where: {
            destination,
            status: IntegrationDeliveryStatus.BLOCKED,
            lastErrorCode: NOT_CONFIGURED,
          },
          data: {
            status: IntegrationDeliveryStatus.PENDING,
            lastErrorCode: null,
            claimedAt: null,
            nextAttemptAt: context.now,
          },
        });
        byDestination[destination] = count;
      }
      const requeued = Object.values(byDestination).reduce((sum, n) => sum + n, 0);
      if (requeued > 0) {
        await recordOperatorAction(tx, {
          actor: context.actor,
          action: 'INTEGRATION_REQUEUE',
          targetType: 'INTEGRATION',
          targetId: 'blocked-deliveries',
          requestId: context.requestId,
          metadata: { requeued, ...byDestination },
        });
      }
      return { requeued, byDestination };
    },
    { timeout: context.transactionTimeoutMs, maxWait: context.transactionTimeoutMs },
  );
}
