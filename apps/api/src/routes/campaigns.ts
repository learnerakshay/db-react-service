import {
  CAMPAIGN_ACTIONS,
  type CampaignAction,
  type CampaignDetail,
  type CampaignOverviewResponse,
  type CampaignSummary,
  type OperatorAction,
} from '@cadentor/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Campaign } from '../generated/prisma/client.js';
import { NotFoundError } from '../lib/errors.js';
import { operatorOf, requireRole } from '../middleware/auth.js';
import { recordOperatorAction } from '../modules/audit/audit.js';
import { campaignConfigSchema, createCampaign } from '../modules/campaigns/campaigns.js';
import { applyCampaignAction } from '../modules/campaigns/lifecycle.js';
import { getCampaignOverview } from '../modules/campaigns/overview.js';
import { getCampaignActivity, getCampaignMetrics } from '../modules/dashboard/metrics.js';
import type { ApiRouterDependencies } from './api.js';

const campaignIdSchema = z.uuid();

function campaignIdParam(value: string): string {
  const parsed = campaignIdSchema.safeParse(value);
  if (!parsed.success) throw new NotFoundError('Campaign not found');
  return parsed.data;
}

const CAMPAIGN_AUDIT_ACTION: Readonly<Record<CampaignAction, OperatorAction>> = {
  start: 'CAMPAIGN_START',
  pause: 'CAMPAIGN_PAUSE',
  resume: 'CAMPAIGN_RESUME',
  complete: 'CAMPAIGN_COMPLETE',
};

export function campaignsRouter({ db, config, logger }: ApiRouterDependencies): Router {
  const router = Router();

  // Creating a campaign fixes its messaging and qualification config: ADMIN only.
  router.post('/', requireRole('ADMIN', logger), async (req, res) => {
    const campaign = await createCampaign(db, config.campaign, req.body);
    res.status(201).json(toCampaignSummary(campaign));
  });

  router.get('/:id', async (req, res) => {
    const overview = await getCampaignOverview(db, campaignIdParam(req.params.id), new Date());
    const summary = toCampaignSummary(overview.campaign);
    const hourlyLimit = summary.config.hourlyDispatchLimit;
    const body: CampaignDetail = {
      ...summary,
      members: overview.members,
      dispatch: {
        hourlyLimit,
        admittedLastHour: overview.admittedLastHour,
        remainingThisHour: Math.max(0, hourlyLimit - overview.admittedLastHour),
      },
    };
    res.json(body);
  });

  // Mission Control campaign detail (Phase 4): lifecycle, metrics, capacity, activity.
  router.get('/:id/overview', async (req, res) => {
    const now = new Date();
    const overview = await getCampaignOverview(db, campaignIdParam(req.params.id), now);
    const { id } = overview.campaign;
    const [metrics, activity] = await Promise.all([
      getCampaignMetrics(db, [id], now),
      getCampaignActivity(db, id, config.dashboard.activityLimit),
    ]);
    const row = metrics.get(id);
    if (row === undefined) throw new NotFoundError('Campaign not found');
    const { admittedLastHour, members, enrolled, step1Sent, outboundSent, repliedLeads } = row;
    const campaignMetrics = {
      members,
      enrolled,
      step1Sent,
      outboundSent,
      repliedLeads,
      qualified: row.qualified,
      booked: row.booked,
    };
    const campaign = toCampaignSummary(overview.campaign);
    const hourlyLimit = campaign.config.hourlyDispatchLimit;
    const body: CampaignOverviewResponse = {
      campaign,
      metrics: campaignMetrics,
      dispatch: {
        hourlyLimit,
        admittedLastHour,
        remainingThisHour: Math.max(0, hourlyLimit - admittedLastHour),
      },
      activity,
    };
    res.json(body);
  });

  // POST /:id/start | /:id/pause | /:id/resume | /:id/complete (OPERATOR+).
  // The lifecycle service decides legality; the audit row commits with the change,
  // so a rejected or repeated action (409) leaves no audit record.
  for (const action of CAMPAIGN_ACTIONS) {
    router.post(`/:id/${action}`, async (req, res) => {
      const campaignId = campaignIdParam(req.params.id);
      const actor = operatorOf(req);
      const requestId = typeof req.id === 'string' ? req.id : undefined;
      const campaign = await db.$transaction(async (tx) => {
        const updated = await applyCampaignAction(tx, campaignId, action);
        await recordOperatorAction(tx, {
          actor,
          action: CAMPAIGN_AUDIT_ACTION[action],
          targetType: 'CAMPAIGN',
          targetId: campaignId,
          requestId,
          metadata: { status: updated.status },
        });
        return updated;
      });
      logger.info(
        {
          requestId,
          campaignId,
          operatorId: actor.id,
          operation: `campaign.${action}`,
          status: campaign.status,
        },
        'campaign lifecycle action applied',
      );
      res.json(toCampaignSummary(campaign));
    });
  }

  return router;
}

function toCampaignSummary(campaign: Campaign): CampaignSummary {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    config: campaignConfigSchema.parse(campaign.config),
    statusChangedAt: campaign.statusChangedAt.toISOString(),
    createdAt: campaign.createdAt.toISOString(),
  };
}
