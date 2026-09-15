import { z } from 'zod';
import type { AppConfig } from '../../config/index.js';
import { timeOfDay, timezone } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { CampaignStatus } from '../../generated/prisma/enums.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { bookingConfigSchema, qualificationConfigSchema } from '../conversion/config.js';
import { step1TemplateSchema } from '../messaging/template.js';
import { replyTemplatesSchema } from '../replies/reply-templates.js';

export const campaignConfigSchema = z
  .object({
    /**
     * Explicit fallback for leads without a stored timezone. `null` means no
     * fallback: such leads are never dispatch-eligible for this campaign.
     */
    timezone: timezone.nullable(),
    sendWindow: z.object({ start: timeOfDay, end: timeOfDay }),
    hourlyDispatchLimit: z.int().positive(),
    followUpDelayHours: z.number().positive(),
    archiveDelayDays: z.number().positive(),
    /** Outbound copy. Step 1 is not sent for campaigns without it. */
    messages: z
      .object({
        step1: step1TemplateSchema,
        /** No-response closeout (Phase 3). Absent: no Step 2 and no follow-up archival. */
        step2: step1TemplateSchema.optional(),
        replies: replyTemplatesSchema.optional(),
      })
      .optional(),
    /** Deterministic qualification rules (Phase 3). Absent: members stay ENGAGED. */
    qualification: qualificationConfigSchema.optional(),
    /** Operator-supplied booking link (Phase 3). Absent: qualified members get no link. */
    booking: bookingConfigSchema.optional(),
  })
  .refine((config) => config.sendWindow.start < config.sendWindow.end, {
    path: ['sendWindow', 'end'],
    message: 'must be later than sendWindow.start',
  });

export type CampaignConfigSnapshot = z.infer<typeof campaignConfigSchema>;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  config: z
    .object({
      timezone: z.string().nullable(),
      sendWindow: z.object({ start: z.string(), end: z.string() }),
      hourlyDispatchLimit: z.number(),
      followUpDelayHours: z.number(),
      archiveDelayDays: z.number(),
      // Validated by campaignConfigSchema after merging with defaults.
      messages: z.unknown(),
      qualification: z.unknown(),
      booking: z.unknown(),
    })
    .partial()
    .optional(),
});

/** Statuses whose campaigns may still receive new members. */
const STAGEABLE_STATUSES: readonly CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.ACTIVE,
  CampaignStatus.PAUSED,
];

/**
 * Create a DRAFT campaign. Unspecified settings are copied from the current
 * operational defaults; the merged result is validated and stored as a snapshot.
 */
export async function createCampaign(
  db: DbClient,
  defaults: AppConfig['campaign'],
  input: unknown,
) {
  const parsed = createCampaignSchema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);

  const config = campaignConfigSchema.safeParse({
    timezone: defaults.defaultTimezone,
    sendWindow: defaults.sendWindow,
    hourlyDispatchLimit: defaults.hourlyDispatchLimit,
    followUpDelayHours: defaults.followUpDelayHours,
    archiveDelayDays: defaults.archiveDelayDays,
    ...parsed.data.config,
  });
  if (!config.success) throw ValidationError.fromZod(config.error, 'Invalid campaign config');

  return db.campaign.create({ data: { name: parsed.data.name, config: config.data } });
}

/** Throws unless the campaign exists and can still accept new members. */
export async function requireStageableCampaign(db: DbClient, campaignId: string): Promise<void> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (campaign === null) throw new NotFoundError('Campaign not found');
  if (!STAGEABLE_STATUSES.includes(campaign.status)) {
    throw new ConflictError(`Campaign is ${campaign.status} and cannot accept new leads`);
  }
}
