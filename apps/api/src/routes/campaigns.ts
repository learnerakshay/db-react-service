import type { CampaignSummary } from '@cadentor/shared';
import { Router } from 'express';
import { campaignConfigSchema, createCampaign } from '../modules/campaigns/campaigns.js';
import type { ApiRouterDependencies } from './api.js';

export function campaignsRouter({ db, config }: ApiRouterDependencies): Router {
  const router = Router();

  // Creates a DRAFT campaign so imports can stage leads into it.
  // Campaign execution is out of scope until Phase 1 Prompt 2.
  router.post('/', async (req, res) => {
    const campaign = await createCampaign(db, config.campaign, req.body);
    const body: CampaignSummary = {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      config: campaignConfigSchema.parse(campaign.config),
      createdAt: campaign.createdAt.toISOString(),
    };
    res.status(201).json(body);
  });

  return router;
}
