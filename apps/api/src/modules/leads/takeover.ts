import type { AutomationState } from '@cadentor/shared';
import type { DbClient } from '../../db/client.js';
import { NotFoundError } from '../../lib/errors.js';

export function automationState(pausedAt: Date | null): AutomationState {
  return pausedAt === null
    ? { mode: 'AUTOMATION_ACTIVE', pausedAt: null }
    : { mode: 'HUMAN_TAKEOVER', pausedAt: pausedAt.toISOString() };
}

/**
 * The single write path for operator human takeover (Lead.automationPausedAt).
 *
 * Durable and lead-wide: it applies to every campaign membership of the lead
 * and survives restarts. Every automated send path reads it under a SHARE lock
 * on the lead row immediately before claiming a send, so this UPDATE waits for
 * a claim in progress and no new automated claim starts after it commits.
 *
 * Takeover never changes suppression, membership, booking or review state:
 * opt-outs still apply while paused, and resuming never makes a suppressed
 * lead sendable. Repeating the current mode is a no-op (the original
 * takeover time is kept).
 */
export async function setHumanTakeover(
  db: DbClient,
  leadId: string,
  takeover: boolean,
  now: Date,
): Promise<AutomationState> {
  await db.lead.updateMany({
    where: { id: leadId, automationPausedAt: takeover ? null : { not: null } },
    data: { automationPausedAt: takeover ? now : null },
  });
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { automationPausedAt: true },
  });
  if (lead === null) throw new NotFoundError('Lead not found');
  return automationState(lead.automationPausedAt);
}
