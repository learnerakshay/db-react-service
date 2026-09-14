import type { Database } from '../../db/client.js';
import { CampaignLeadStatus, CampaignStatus } from '../../generated/prisma/enums.js';
import { ConfigurationError, NotFoundError } from '../../lib/errors.js';
import { campaignConfigSchema } from '../campaigns/campaigns.js';
import { transitionCampaignLead } from '../campaigns/membership.js';
import { findSuppressed } from '../suppression/suppression.js';
import { evaluateDispatchEligibility, type IneligibleReason } from './eligibility.js';

/** Hourly capacity is measured over the rolling hour ending at the reference time. */
export const CAPACITY_WINDOW_MS = 60 * 60 * 1000;

export interface AdmissionOptions {
  /** Maximum STAGED memberships examined in one run. */
  scanLimit: number;
  /** Memberships read per query while scanning. */
  pageSize: number;
  transactionTimeoutMs: number;
  /**
   * Reference instant for windows and capacity. Defaults to the database
   * transaction timestamp so every worker uses one clock.
   */
  now?: Date;
  /** Background job performing the run, recorded on each admission. */
  jobId?: string | null;
}

export interface AdmissionResult {
  campaignId: string;
  campaignStatus: CampaignStatus;
  now: Date;
  hourlyLimit: number | null;
  /** Admissions already in the rolling hour when the run started. */
  admittedBefore: number;
  admitted: number;
  /** STAGED members found suppressed and moved to OPTED_OUT. */
  optedOut: number;
  scanned: number;
  skipped: Partial<Record<IneligibleReason, number>>;
}

/**
 * Admit eligible STAGED members of one campaign to QUEUED, up to its remaining
 * hourly capacity. Safe to run concurrently and repeatedly for the same
 * campaign (duplicate scheduler ticks, job retries, several processes).
 *
 * Everything happens in one transaction:
 *  1. `SELECT … FOR UPDATE` on the campaign row. Concurrent runs for the same
 *     campaign wait here, so capacity is always computed from committed
 *     admissions, and a pause/complete cannot interleave with a run.
 *  2. Stop unless the campaign is ACTIVE.
 *  3. `LOCK TABLE "SuppressionEntry" IN SHARE MODE`: new suppressions wait until
 *     this transaction ends, so the suppression check below cannot be
 *     invalidated before the admissions it allows are committed.
 *  4. Count admissions in the rolling hour (DispatchAdmission).
 *  5. Scan STAGED members oldest first (keyset pages); evaluate each with
 *     `evaluateDispatchEligibility`; admit via `transitionCampaignLead`
 *     (compare-and-set STAGED → QUEUED) plus a DispatchAdmission row
 *     (UNIQUE campaignLeadId). Suppressed members move STAGED → OPTED_OUT.
 *
 * ponytail: members outside their send window stay STAGED and are re-examined
 * every run; if more than `scanLimit` older members are all out of window,
 * newer eligible members wait until those windows open. Per-timezone candidate
 * selection is the upgrade path if campaigns mix many distant timezones.
 */
export async function admitEligibleMembers(
  db: Database,
  campaignId: string,
  options: AdmissionOptions,
): Promise<AdmissionResult> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ status: CampaignStatus; config: unknown; now: Date }[]>`
        SELECT "status", "config", transaction_timestamp() AS "now"
        FROM "Campaign" WHERE "id" = ${campaignId}::uuid
        FOR UPDATE`;
      const campaign = rows[0];
      if (campaign === undefined) throw new NotFoundError('Campaign not found');

      const now = options.now ?? campaign.now;
      const result: AdmissionResult = {
        campaignId,
        campaignStatus: campaign.status,
        now,
        hourlyLimit: null,
        admittedBefore: 0,
        admitted: 0,
        optedOut: 0,
        scanned: 0,
        skipped: {},
      };
      if (campaign.status !== CampaignStatus.ACTIVE) return result;

      const parsed = campaignConfigSchema.safeParse(campaign.config);
      if (!parsed.success) {
        throw new ConfigurationError(`Campaign ${campaignId} has an invalid config`, parsed.error);
      }
      const config = parsed.data;
      result.hourlyLimit = config.hourlyDispatchLimit;

      await tx.$executeRaw`LOCK TABLE "SuppressionEntry" IN SHARE MODE`;

      result.admittedBefore = await tx.dispatchAdmission.count({
        where: { campaignId, admittedAt: { gt: new Date(now.getTime() - CAPACITY_WINDOW_MS) } },
      });
      let remaining = config.hourlyDispatchLimit - result.admittedBefore;

      let cursor: { createdAt: Date; id: string } | undefined;
      while (remaining > 0 && result.scanned < options.scanLimit) {
        const page = await tx.campaignLead.findMany({
          where: {
            campaignId,
            status: CampaignLeadStatus.STAGED,
            // Without a campaign fallback, leads lacking a timezone can never be
            // eligible; leave them out so they cannot crowd out eligible members.
            ...(config.timezone === null ? { lead: { is: { timezone: { not: null } } } } : {}),
            ...(cursor === undefined
              ? {}
              : {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                }),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: Math.min(options.pageSize, options.scanLimit - result.scanned),
          select: {
            id: true,
            status: true,
            createdAt: true,
            lead: { select: { phone: true, email: true, timezone: true } },
          },
        });
        const last = page.at(-1);
        if (last === undefined) break;
        cursor = { createdAt: last.createdAt, id: last.id };
        result.scanned += page.length;

        const suppressed = await findSuppressed(tx, {
          phones: page.map((member) => member.lead.phone),
          emails: page.flatMap((member) => (member.lead.email === null ? [] : [member.lead.email])),
        });

        for (const member of page) {
          if (remaining <= 0) break;
          const { phone, email, timezone } = member.lead;
          const decision = evaluateDispatchEligibility({
            campaignStatus: campaign.status,
            sendWindow: config.sendWindow,
            campaignTimezone: config.timezone,
            membershipStatus: member.status,
            leadTimezone: timezone,
            suppressed:
              suppressed.phones.has(phone) || (email !== null && suppressed.emails.has(email)),
            remainingCapacity: remaining,
            now,
          });

          if (decision.eligible) {
            await transitionCampaignLead(
              tx,
              {
                campaignLeadId: member.id,
                from: CampaignLeadStatus.STAGED,
                to: CampaignLeadStatus.QUEUED,
              },
              now,
            );
            await tx.dispatchAdmission.create({
              data: {
                campaignId,
                campaignLeadId: member.id,
                admittedAt: now,
                timezone: decision.timezone,
                timezoneSource: decision.timezoneSource,
                localTime: decision.localTime,
                sendWindowStart: config.sendWindow.start,
                sendWindowEnd: config.sendWindow.end,
                hourlyLimit: config.hourlyDispatchLimit,
                priorAdmissionsInHour: config.hourlyDispatchLimit - remaining,
                jobId: options.jobId ?? null,
              },
            });
            remaining--;
            result.admitted++;
          } else if (decision.reason === 'SUPPRESSED') {
            // Global suppression is authoritative and permanent: retire the membership.
            await transitionCampaignLead(
              tx,
              {
                campaignLeadId: member.id,
                from: CampaignLeadStatus.STAGED,
                to: CampaignLeadStatus.OPTED_OUT,
              },
              now,
            );
            result.optedOut++;
          } else {
            result.skipped[decision.reason] = (result.skipped[decision.reason] ?? 0) + 1;
          }
        }
      }

      return result;
    },
    // maxWait covers acquiring a pooled connection; under many concurrent
    // workers Prisma's 2s default is too short for connection setup.
    { timeout: options.transactionTimeoutMs, maxWait: options.transactionTimeoutMs },
  );
}
