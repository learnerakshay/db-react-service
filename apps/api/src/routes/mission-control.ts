import {
  AUDIT_TARGET_TYPES,
  CAMPAIGN_STATUSES,
  CONVERSATION_FILTERS,
  DEFAULT_PAGE_SIZE,
  ESCALATION_REASONS,
  MAX_PAGE_SIZE,
  REVIEW_RESOLUTIONS,
  REVIEW_STATES,
  type CampaignRow,
  type DashboardOverview,
  type IntegrationDestination,
  type Page,
} from '@cadentor/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { operatorOf, requireRole } from '../middleware/auth.js';
import { listAuditEvents } from '../modules/audit/audit.js';
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
import { requeueBlockedDeliveries } from '../modules/integrations/recovery.js';
import {
  resolveReview,
  resumeLeadAutomation,
  takeOverLead,
  type OperatorContext,
} from '../modules/reviews/resolution.js';
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
  state: z.enum(REVIEW_STATES).default('OPEN'),
});
const auditQuery = z.object({
  ...pageFields,
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  targetId: z.string().trim().min(1).max(64).optional(),
});
const resolveBody = z
  .object({
    resolution: z.enum(REVIEW_RESOLUTIONS),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

function parse<T extends z.ZodType>(schema: T, input: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, message);
  return parsed.data;
}

function idParam(value: string, notFound: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new NotFoundError(notFound);
  return parsed.data;
}

/**
 * Mission Control read models and operator controls. GET routes only read.
 * Every control goes through its owning service, which audits real changes.
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

  const operatorContext = (req: Request): OperatorContext => ({
    actor: operatorOf(req),
    requestId: typeof req.id === 'string' ? req.id : undefined,
    now: new Date(),
    transactionTimeoutMs: config.operations.transactionTimeoutMs,
  });

  router.get('/dashboard/overview', async (_req, res) => {
    const body: DashboardOverview = {
      metrics: await getOverviewMetrics(db, config.classifier.confidenceThreshold),
      generatedAt: new Date().toISOString(),
    };
    res.json(body);
  });

  router.get('/dashboard/campaigns', async (req, res) => {
    const query = parse(campaignsQuery, req.query, 'Invalid query parameters');
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
    res.json(
      await listConversations(db, parse(conversationsQuery, req.query, 'Invalid query parameters')),
    );
  });

  router.get('/conversations/:leadId', async (req, res) => {
    res.json(
      await getConversation(
        db,
        idParam(req.params.leadId, 'Lead not found'),
        limits.conversationMessageLimit,
      ),
    );
  });

  router.get('/reviews', async (req, res) => {
    res.json(await listReviews(db, parse(reviewsQuery, req.query, 'Invalid query parameters')));
  });

  router.post('/reviews/:id/resolve', async (req, res) => {
    const processingId = idParam(req.params.id, 'Review not found');
    const body = parse(resolveBody, req.body, 'Invalid review resolution');
    const context = operatorContext(req);
    const result = await resolveReview(
      db,
      processingId,
      {
        resolution: body.resolution,
        note: body.note === undefined || body.note === '' ? null : body.note,
      },
      context,
    );
    logger.info(
      {
        requestId: context.requestId,
        operatorId: context.actor.id,
        reviewId: processingId,
        operation: 'reviews.resolve',
        status: result.changed ? body.resolution : 'UNCHANGED',
        resolvedCount: result.resolvedCount,
      },
      'human review resolution handled',
    );
    res.json(result);
  });

  router.get('/leads/:id', async (req, res) => {
    res.json(
      await getLeadDetail(db, idParam(req.params.id, 'Lead not found'), limits.leadDetailLimit),
    );
  });

  router.post('/leads/:id/takeover', async (req, res) => {
    const leadId = idParam(req.params.id, 'Lead not found');
    const context = operatorContext(req);
    const result = await takeOverLead(db, leadId, context);
    logger.info(
      {
        requestId: context.requestId,
        operatorId: context.actor.id,
        leadId,
        operation: 'leads.takeover',
        status: result.changed ? result.automation.mode : 'UNCHANGED',
      },
      'operator human takeover handled',
    );
    res.json(result);
  });

  router.post('/leads/:id/resume-automation', async (req, res) => {
    const leadId = idParam(req.params.id, 'Lead not found');
    const context = operatorContext(req);
    const result = await resumeLeadAutomation(db, leadId, context);
    logger.info(
      {
        requestId: context.requestId,
        operatorId: context.actor.id,
        leadId,
        operation: 'leads.resume_automation',
        status: result.changed ? result.automation.mode : 'UNCHANGED',
        resolvedReviews: result.resolvedReviews,
      },
      'operator automation resume handled',
    );
    res.json(result);
  });

  router.get('/audit', async (req, res) => {
    res.json(await listAuditEvents(db, parse(auditQuery, req.query, 'Invalid query parameters')));
  });

  const availability = {
    crm: integrationProviders?.crm !== undefined,
    notifications: integrationProviders?.notifications !== undefined,
    handoff: integrationProviders?.handoff !== undefined,
    calendar: (calendarProviders?.size ?? 0) > 0,
  };

  router.get('/integrations/health', async (_req, res) => {
    res.json(await getIntegrationHealth(db, availability, limits.problemLimit));
  });

  router.post('/integrations/requeue-blocked', requireRole('ADMIN', logger), async (req, res) => {
    const configured: IntegrationDestination[] = [
      ...(availability.crm ? (['CRM'] as const) : []),
      ...(availability.notifications ? (['OWNER_NOTIFICATION'] as const) : []),
      ...(availability.handoff ? (['POST_BOOKING_HANDOFF'] as const) : []),
    ];
    const context = operatorContext(req);
    const result = await requeueBlockedDeliveries(db, configured, context);
    logger.info(
      {
        requestId: context.requestId,
        operatorId: context.actor.id,
        operation: 'integrations.requeue_blocked',
        requeued: result.requeued,
        configured,
      },
      'blocked integration deliveries requeue handled',
    );
    res.json(result);
  });

  return router;
}
