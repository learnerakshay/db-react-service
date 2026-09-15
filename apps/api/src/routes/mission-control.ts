import {
  CAMPAIGN_STATUSES,
  CONVERSATION_FILTERS,
  DEFAULT_PAGE_SIZE,
  ESCALATION_REASONS,
  MAX_PAGE_SIZE,
  type CampaignRow,
  type DashboardOverview,
  type Page,
} from '@cadentor/shared';
import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { campaignConfigSchema } from '../modules/campaigns/campaigns.js';
import {
  getConversation,
  getLeadDetail,
  listConversations,
  listReviews,
} from '../modules/dashboard/conversations.js';
import { getIntegrationHealth } from '../modules/dashboard/integrations.js';
import {
  getCampaignMetrics,
  getOverviewMetrics,
  listCampaigns,
} from '../modules/dashboard/metrics.js';
import { setHumanTakeover } from '../modules/leads/takeover.js';
import type { ApiRouterDependencies } from './api.js';

const uuid = z.uuid();
const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};
const campaignsQuery = z.object({ ...pageFields, status: z.enum(CAMPAIGN_STATUSES).optional() });
const conversationsQuery = z.object({
  ...pageFields,
  campaignId: uuid.optional(),
  filter: z.enum(CONVERSATION_FILTERS).default('all'),
});
const reviewsQuery = z.object({
  ...pageFields,
  campaignId: uuid.optional(),
  reason: z.enum(ESCALATION_REASONS).optional(),
});

function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid query parameters');
  return parsed.data;
}

function leadIdParam(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new NotFoundError('Lead not found');
  return parsed.data;
}

/**
 * Mission Control read models plus the human takeover control. GET routes
 * only read; the only writes are POST /leads/:id/takeover and
 * /leads/:id/resume-automation.
 */
export function missionControlRouter({
  db,
  config,
  logger,
  integrationProviders,
  calendarProviders,
}: ApiRouterDependencies): Router {
  const router = Router();
  const limits = config.dashboard;

  router.get('/dashboard/overview', async (_req, res) => {
    const body: DashboardOverview = {
      metrics: await getOverviewMetrics(db, config.classifier.confidenceThreshold),
      generatedAt: new Date().toISOString(),
    };
    res.json(body);
  });

  router.get('/dashboard/campaigns', async (req, res) => {
    const query = parseQuery(campaignsQuery, req.query);
    const now = new Date();
    const { campaigns, total } = await listCampaigns(db, query);
    const metrics = await getCampaignMetrics(
      db,
      campaigns.map((campaign) => campaign.id),
      now,
    );
    const body: Page<CampaignRow> = {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: campaigns.flatMap((campaign) => {
        const row = metrics.get(campaign.id);
        if (row === undefined) return [];
        const { admittedLastHour, lastActivityAt, ...campaignMetrics } = row;
        const settings = campaignConfigSchema.parse(campaign.config);
        return [
          {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            statusChangedAt: campaign.statusChangedAt.toISOString(),
            createdAt: campaign.createdAt.toISOString(),
            hourlyLimit: settings.hourlyDispatchLimit,
            admittedLastHour,
            sendWindow: settings.sendWindow,
            timezone: settings.timezone,
            lastActivityAt: lastActivityAt?.toISOString() ?? null,
            ...campaignMetrics,
          },
        ];
      }),
    };
    res.json(body);
  });

  router.get('/conversations', async (req, res) => {
    res.json(await listConversations(db, parseQuery(conversationsQuery, req.query)));
  });

  router.get('/conversations/:leadId', async (req, res) => {
    res.json(
      await getConversation(db, leadIdParam(req.params.leadId), limits.conversationMessageLimit),
    );
  });

  router.get('/reviews', async (req, res) => {
    res.json(await listReviews(db, parseQuery(reviewsQuery, req.query)));
  });

  router.get('/leads/:id', async (req, res) => {
    res.json(await getLeadDetail(db, leadIdParam(req.params.id), limits.leadDetailLimit));
  });

  for (const [path, takeover] of [
    ['takeover', true],
    ['resume-automation', false],
  ] as const) {
    router.post(`/leads/:id/${path}`, async (req, res) => {
      const leadId = leadIdParam(req.params.id);
      const state = await setHumanTakeover(db, leadId, takeover, new Date());
      logger.info(
        { operation: 'leads.automation', leadId, status: state.mode },
        takeover ? 'operator human takeover' : 'operator resumed automation',
      );
      res.json(state);
    });
  }

  router.get('/integrations/health', async (_req, res) => {
    res.json(
      await getIntegrationHealth(
        db,
        {
          crm: integrationProviders?.crm !== undefined,
          notifications: integrationProviders?.notifications !== undefined,
          handoff: integrationProviders?.handoff !== undefined,
          calendar: (calendarProviders?.size ?? 0) > 0,
        },
        limits.problemLimit,
      ),
    );
  });

  return router;
}
