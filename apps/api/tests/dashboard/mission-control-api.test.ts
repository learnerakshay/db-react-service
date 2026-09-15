import type {
  ApiErrorBody,
  AutomationState,
  CampaignOverviewResponse,
  CampaignRow,
  CampaignSummary,
  ConversationDetail,
  ConversationListItem,
  DashboardOverview,
  IntegrationHealthResponse,
  LeadDetail,
  Page,
  ReviewItem,
} from '@cadentor/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { processIntegrationDelivery } from '../../src/modules/integrations/deliveries.js';
import { apiRouter } from '../../src/routes/api.js';
import { FakeAiProvider } from '../helpers/ai.js';
import {
  APPOINTMENT_START,
  bookingEvent,
  qualifiedMember,
  replyFromLead,
} from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { stageMembers } from '../helpers/dispatch.js';
import { FakeMessagingProvider } from '../helpers/messaging.js';
import { deliveryDeps, FakeCrm } from '../helpers/operations.js';
import { contactedLead, receive } from '../helpers/replies.js';

const config = loadConfig({ NODE_ENV: 'test' });
const OPTIONS = { transactionTimeoutMs: 30_000 };
const UNKNOWN_ID = '0190d9b0-0000-7000-8000-000000000000';
/** Internal fields that must never reach Mission Control responses. */
const HIDDEN_KEYS = [
  'aiRequestIds',
  'aiModel',
  'aiProvider',
  'knowledgeItemIds',
  'rulesSnapshot',
  'payload',
];

let db: Database;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = connectTestDatabase();
  const app = createApp({
    config,
    logger: silentLogger,
    checkDatabase: () => Promise.resolve('up'),
    api: apiRouter({
      db,
      config,
      logger: silentLogger,
      // CRM configured, owner notifications and handoff not configured.
      integrationProviders: { crm: new FakeCrm(), notifications: undefined, handoff: undefined },
    }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(db);
});

/** `cast` only types the parsed JSON for the assertions that follow. */
const asJson = <T>(body: unknown, _type?: T): T => body as T;

async function get<T>(
  path: string,
  cast: (body: unknown) => T = asJson,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: cast(await res.json()) };
}

async function post<T>(
  path: string,
  body?: unknown,
  cast: (body: unknown) => T = asJson,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: cast(await res.json()) };
}

const overview = async () => (await get<DashboardOverview>('/dashboard/overview')).body.metrics;

async function confirmBooking(bookingReference: string) {
  await applyBookingEvent(
    db,
    'fakecal',
    bookingEvent({ kind: 'BOOKING_CREATED', bookingReference }),
    OPTIONS,
  );
}

describe('dashboard overview metrics', () => {
  it('are computed from database state and count only verified bookings as booked', async () => {
    const qualified = await qualifiedMember(db);
    await contactedLead(db, new FakeMessagingProvider(), { name: 'Silent', phone: '+14155550142' });
    await stageMembers(db, qualified.campaign.id, [{ phone: '+14155550143' }]);

    const accepted = await db.message.count({
      where: { direction: 'OUTBOUND', status: { in: ['ACCEPTED', 'SENT', 'DELIVERED'] } },
    });
    const sentLink = await db.bookingOpportunity.findUniqueOrThrow({
      where: { id: qualified.opportunity.id },
    });
    expect(sentLink).toMatchObject({ status: 'OFFERED' });
    expect(sentLink.sentAt).not.toBeNull();

    expect(await overview()).toEqual({
      totalIngested: 3,
      outboundSent: accepted,
      contactedLeads: 2,
      repliedLeads: 1,
      replyRate: 0.5,
      positiveIntentLeads: 1,
      qualified: 1,
      // The booking link was sent and accepted: still not a booking.
      booked: 0,
      activeCampaigns: 2,
      openReviews: 0,
      optedOutLeads: 0,
      optOutRate: 0,
    });

    await confirmBooking(qualified.opportunity.bookingReference);
    const after = await overview();
    expect(after).toMatchObject({ booked: 1, qualified: 1 });

    const campaign = await get<CampaignOverviewResponse>(
      `/campaigns/${qualified.campaign.id}/overview`,
    );
    expect(campaign.status).toBe(200);
    expect(campaign.body.metrics).toMatchObject({ enrolled: 2, qualified: 1, booked: 1 });
    expect(campaign.body.metrics.members).toMatchObject({ BOOKED: 1, STAGED: 1 });
    const kinds = campaign.body.activity.map((item) => item.kind);
    expect(kinds).toEqual(expect.arrayContaining(['OUTBOUND', 'INBOUND', 'QUALIFIED', 'BOOKING']));
    // Activity details are identifiers and statuses, never message bodies.
    expect(JSON.stringify(campaign.body.activity)).not.toContain('gutter cleaning');
    expect((await get(`/campaigns/${UNKNOWN_ID}/overview`)).status).toBe(404);
  });

  it('computes reply rate deterministically over contacted leads only', async () => {
    const messaging = new FakeMessagingProvider();
    const replied = await contactedLead(db, messaging, { name: 'A', phone: '+14155550151' });
    await contactedLead(db, messaging, { name: 'B', phone: '+14155550152' });
    const [uncontacted] = await stageMembers(db, replied.campaign.id, [{ phone: '+14155550153' }]);
    if (uncontacted === undefined) throw new Error('no member');

    await receive(db, replied.lead.phone, 'who is this?');
    await receive(db, replied.lead.phone, 'hello?');
    // A lead who was never contacted texting in counts in neither side of the ratio.
    await receive(db, '+14155550153', 'saw your ad');

    const first = await overview();
    expect(first).toMatchObject({ contactedLeads: 2, repliedLeads: 1, replyRate: 0.5 });
    expect(await overview()).toEqual(first);
  });
});

describe('campaign table and lifecycle controls', () => {
  it('reflects lifecycle state changed through the existing campaign actions', async () => {
    const created = await post<CampaignSummary>('/campaigns', { name: 'Spring' });
    const { id } = created.body;
    await stageMembers(db, id, [{}, {}]);

    const table = await get<Page<CampaignRow>>('/dashboard/campaigns');
    expect(table.body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(table.body.items[0]).toMatchObject({
      id,
      name: 'Spring',
      status: 'DRAFT',
      enrolled: 2,
      members: { STAGED: 2, QUEUED: 0 },
      step1Sent: 0,
      repliedLeads: 0,
      qualified: 0,
      booked: 0,
      admittedLastHour: 0,
      hourlyLimit: config.campaign.hourlyDispatchLimit,
      lastActivityAt: null,
    });

    for (const [action, status] of [
      ['start', 'ACTIVE'],
      ['pause', 'PAUSED'],
      ['resume', 'ACTIVE'],
    ] as const) {
      expect((await post(`/campaigns/${id}/${action}`)).status).toBe(200);
      const filtered = await get<Page<CampaignRow>>(`/dashboard/campaigns?status=${status}`);
      expect(filtered.body.items.map((row) => [row.id, row.status])).toEqual([[id, status]]);
      expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe(status);
    }
    expect((await get<Page<CampaignRow>>('/dashboard/campaigns?status=DRAFT')).body.total).toBe(0);

    // Lifecycle rules stay authoritative: an illegal action changes nothing.
    const illegal = await post<ApiErrorBody>(`/campaigns/${id}/resume`);
    expect(illegal.status).toBe(409);
    expect(illegal.body.error.code).toBe('CONFLICT');
    expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');

    expect((await post(`/campaigns/${id}/complete`)).status).toBe(200);
    expect((await post(`/campaigns/${id}/start`)).status).toBe(409);
    expect((await get(`/dashboard/campaigns?status=NOPE`)).status).toBe(400);
  });
});

describe('conversations', () => {
  it('lists conversations newest first with bounded pagination and filters', async () => {
    const messaging = new FakeMessagingProvider();
    const leads = [];
    for (const [index, phone] of ['+14155550161', '+14155550162', '+14155550163'].entries()) {
      leads.push(await contactedLead(db, messaging, { name: `Campaign ${index}`, phone }));
    }
    const [first, second, third] = leads;
    if (first === undefined || second === undefined || third === undefined) throw new Error();
    await receive(db, first.lead.phone, 'Is this still available?');

    const page1 = await get<Page<ConversationListItem>>('/conversations?pageSize=2');
    expect(page1.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page1.body.items.map((item) => item.leadId)).toEqual([first.lead.id, third.lead.id]);
    expect(page1.body.items[0]).toMatchObject({
      phoneLast4: first.lead.phone.slice(-4),
      campaign: { id: first.campaign.id },
      membershipStatus: 'STEP_1_SENT',
      lastMessage: { direction: 'INBOUND', preview: 'Is this still available?' },
      openReviews: 0,
      automation: { mode: 'AUTOMATION_ACTIVE', pausedAt: null },
    });
    expect(JSON.stringify(page1.body)).not.toContain(first.lead.phone);

    const page2 = await get<Page<ConversationListItem>>('/conversations?page=2&pageSize=2');
    expect(page2.body.items.map((item) => item.leadId)).toEqual([second.lead.id]);

    expect((await get('/conversations?pageSize=101')).status).toBe(400);
    expect((await get('/conversations?page=0')).status).toBe(400);
    expect((await get('/conversations?campaignId=nope')).status).toBe(400);
    expect((await get<Page<ConversationListItem>>('/conversations')).body.pageSize).toBe(25);

    const inCampaign = await get<Page<ConversationListItem>>(
      `/conversations?campaignId=${second.campaign.id}`,
    );
    expect(inCampaign.body.items.map((item) => item.leadId)).toEqual([second.lead.id]);

    expect(
      (await get<Page<ConversationListItem>>('/conversations?filter=takeover')).body.total,
    ).toBe(0);
    await post(`/leads/${second.lead.id}/takeover`);
    const takeover = await get<Page<ConversationListItem>>('/conversations?filter=attention');
    expect(takeover.body.items).toHaveLength(1);
    expect(takeover.body.items[0]).toMatchObject({
      leadId: second.lead.id,
      automation: { mode: 'HUMAN_TAKEOVER' },
    });
  });

  it('returns message history in order with routed outcomes and no hidden AI internals', async () => {
    const qualified = await qualifiedMember(db);
    const { status, body } = await get<ConversationDetail>(`/conversations/${qualified.lead.id}`);
    expect(status).toBe(200);
    expect(body.hasEarlier).toBe(false);

    const times = body.messages.map((message) => Date.parse(message.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(body.messages[0]).toMatchObject({ direction: 'OUTBOUND', purpose: 'CAMPAIGN_STEP_1' });

    const inbound = body.messages.filter((message) => message.direction === 'INBOUND');
    expect(inbound).toHaveLength(2);
    expect(inbound[0]?.reply).toEqual({
      status: 'COMPLETED',
      classification: 'POSITIVE_INTEREST',
      confidence: 0.95,
      action: 'ENGAGE',
      escalationReason: null,
    });
    expect(body.messages.find((m) => m.qualification !== null)?.qualification).toEqual({
      result: 'QUALIFIED',
      missingFields: [],
    });
    expect(body.messages.find((m) => m.purpose === 'BOOKING_LINK')?.booking).toEqual({
      status: 'OFFERED',
    });

    const raw = JSON.stringify(body);
    for (const key of HIDDEN_KEYS) expect(raw).not.toContain(key);

    expect((await get(`/conversations/${UNKNOWN_ID}`)).status).toBe(404);
    expect((await get('/conversations/not-a-uuid')).status).toBe(404);
  });
});

describe('human review queue', () => {
  it('shows unresolved escalations without resolving them', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const { lead, campaign } = await contactedLead(db, messaging);
    const inboundId = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'hmm maybe?',
      'AMBIGUOUS',
      0.3,
    );

    const reviews = await get<Page<ReviewItem>>('/reviews');
    expect(reviews.body.total).toBe(1);
    expect(reviews.body.items[0]).toMatchObject({
      leadId: lead.id,
      campaign: { id: campaign.id },
      membershipStatus: 'STEP_1_SENT',
      inbound: { id: inboundId, body: 'hmm maybe?' },
      escalationReason: 'LOW_CONFIDENCE',
      classification: 'AMBIGUOUS',
      confidence: 0.3,
      automation: { mode: 'AUTOMATION_ACTIVE' },
    });
    for (const key of HIDDEN_KEYS) expect(JSON.stringify(reviews.body)).not.toContain(key);

    expect((await get<Page<ReviewItem>>('/reviews?reason=LOW_CONFIDENCE')).body.total).toBe(1);
    expect((await get<Page<ReviewItem>>('/reviews?reason=MISSING_KNOWLEDGE')).body.total).toBe(0);
    expect((await get<Page<ReviewItem>>(`/reviews?campaignId=${UNKNOWN_ID}`)).body.total).toBe(0);
    expect((await get('/reviews?reason=BAD')).status).toBe(400);

    expect(
      await db.replyProcessing.findFirstOrThrow({ where: { inboundMessageId: inboundId } }),
    ).toMatchObject({ status: 'ESCALATED' });
    expect((await overview()).openReviews).toBe(1);
  });
});

describe('lead detail', () => {
  it('returns qualification, booking and delivery state', async () => {
    const qualified = await qualifiedMember(db);
    const path = `/leads/${qualified.lead.id}`;

    let detail = (await get<LeadDetail>(path)).body;
    expect(detail).toMatchObject({
      id: qualified.lead.id,
      phone: qualified.lead.phone,
      suppression: [],
      automation: { mode: 'AUTOMATION_ACTIVE', pausedAt: null },
    });
    let membership = detail.memberships[0];
    expect(membership).toMatchObject({
      campaign: { id: qualified.campaign.id, status: 'ACTIVE' },
      status: 'QUALIFIED',
      latestEvaluation: { result: 'QUALIFIED', missingFields: [] },
      deliveries: [],
    });
    expect(membership?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'budget', value: 900, source: 'CONVERSATION' }),
        expect.objectContaining({ field: 'serviceNeeded', value: 'gutter cleaning' }),
      ]),
    );
    expect(membership?.bookings[0]).toMatchObject({ status: 'OFFERED', confirmedAt: null });
    expect(membership?.bookings[0]?.linkSentAt).not.toBeNull();

    await confirmBooking(qualified.opportunity.bookingReference);
    detail = (await get<LeadDetail>(path)).body;
    membership = detail.memberships[0];
    expect(membership?.status).toBe('BOOKED');
    expect(membership?.bookings[0]).toMatchObject({
      status: 'CONFIRMED',
      appointmentStartAt: APPOINTMENT_START.toISOString(),
      appointmentTimezone: 'America/New_York',
    });
    expect(membership?.deliveries.map((d) => [d.destination, d.status]).sort()).toEqual([
      ['CRM', 'PENDING'],
      ['OWNER_NOTIFICATION', 'PENDING'],
      ['POST_BOOKING_HANDOFF', 'PENDING'],
    ]);
    const raw = JSON.stringify(detail);
    for (const key of [...HIDDEN_KEYS, 'bookingReference', 'bookingUrl']) {
      expect(raw).not.toContain(key);
    }

    expect((await get(`/leads/${UNKNOWN_ID}`)).status).toBe(404);
  });
});

describe('integration health', () => {
  it('distinguishes not-configured BLOCKED deliveries from configured FAILED ones', async () => {
    const qualified = await qualifiedMember(db);
    await confirmBooking(qualified.opportunity.bookingReference);
    const byKey = (health: IntegrationHealthResponse, key: string) =>
      health.integrations.find((integration) => integration.key === key);

    let health = (await get<IntegrationHealthResponse>('/integrations/health')).body;
    expect(byKey(health, 'CRM')).toMatchObject({
      configured: true,
      state: 'HEALTHY',
      counts: { PENDING: 1 },
    });
    expect(byKey(health, 'OWNER_NOTIFICATION')).toMatchObject({
      configured: false,
      state: 'NOT_CONFIGURED',
    });
    expect(health.problems).toEqual([]);

    const crm = new FakeCrm();
    crm.scripts.push({ outcome: 'FAILED', retryable: false, errorCode: 'HTTP_400' });
    const crmRow = await db.integrationDelivery.findFirstOrThrow({ where: { destination: 'CRM' } });
    expect(await processIntegrationDelivery(deliveryDeps(db, { crm }), crmRow.id)).toBe('FAILED');
    const ownerRow = await db.integrationDelivery.findFirstOrThrow({
      where: { destination: 'OWNER_NOTIFICATION' },
    });
    expect(await processIntegrationDelivery(deliveryDeps(db), ownerRow.id)).toBe('BLOCKED');

    health = (await get<IntegrationHealthResponse>('/integrations/health')).body;
    expect(byKey(health, 'CRM')).toMatchObject({
      configured: true,
      state: 'FAILING',
      counts: { FAILED: 1, BLOCKED: 0, COMPLETED: 0 },
    });
    expect(byKey(health, 'OWNER_NOTIFICATION')).toMatchObject({
      configured: false,
      state: 'NOT_CONFIGURED',
      counts: { BLOCKED: 1, FAILED: 0, COMPLETED: 0 },
    });
    expect(byKey(health, 'CALENDAR')).toMatchObject({ configured: false, state: 'NOT_CONFIGURED' });
    expect(health.problems.map((p) => [p.destination, p.status, p.lastErrorCode]).sort()).toEqual([
      ['CRM', 'FAILED', 'HTTP_400'],
      ['OWNER_NOTIFICATION', 'BLOCKED', 'NOT_CONFIGURED'],
    ]);
  });
});

describe('read-only guarantees and takeover control', () => {
  it('read endpoints never mutate domain state', async () => {
    const qualified = await qualifiedMember(db);
    await confirmBooking(qualified.opportunity.bookingReference);
    const snapshot = async () => ({
      campaigns: await db.campaign.findMany({ orderBy: { id: 'asc' } }),
      members: await db.campaignLead.findMany({ orderBy: { id: 'asc' } }),
      leads: await db.lead.findMany({ orderBy: { id: 'asc' } }),
      messages: await db.message.findMany({ orderBy: { id: 'asc' } }),
      processing: await db.replyProcessing.findMany({ orderBy: { id: 'asc' } }),
      evaluations: await db.qualificationEvaluation.findMany({ orderBy: { id: 'asc' } }),
      bookings: await db.bookingOpportunity.findMany({ orderBy: { id: 'asc' } }),
      deliveries: await db.integrationDelivery.findMany({ orderBy: { id: 'asc' } }),
      suppression: await db.suppressionEntry.count(),
    });
    const before = await snapshot();

    for (const path of [
      '/dashboard/overview',
      '/dashboard/campaigns',
      `/campaigns/${qualified.campaign.id}/overview`,
      '/conversations?filter=attention',
      `/conversations/${qualified.lead.id}`,
      '/reviews',
      `/leads/${qualified.lead.id}`,
      '/integrations/health',
    ]) {
      expect((await get(path)).status, path).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('persists human takeover durably and resumes automation on request', async () => {
    const { lead } = await contactedLead(db, new FakeMessagingProvider());

    const taken = await post<AutomationState>(`/leads/${lead.id}/takeover`);
    expect(taken.status).toBe(200);
    expect(taken.body.mode).toBe('HUMAN_TAKEOVER');
    expect(taken.body.pausedAt).not.toBeNull();
    // Repeating the takeover keeps the original time.
    expect((await post<AutomationState>(`/leads/${lead.id}/takeover`)).body).toEqual(taken.body);

    // Durable: a separate connection (as after a restart) sees the same state.
    const restarted = connectTestDatabase();
    try {
      const stored = await restarted.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(stored.automationPausedAt?.toISOString()).toBe(taken.body.pausedAt);
    } finally {
      await restarted.$disconnect();
    }
    expect((await get<LeadDetail>(`/leads/${lead.id}`)).body.automation).toEqual(taken.body);
    expect(
      (await get<ConversationDetail>(`/conversations/${lead.id}`)).body.lead.automation,
    ).toEqual(taken.body);

    const resumed = await post<AutomationState>(`/leads/${lead.id}/resume-automation`);
    expect(resumed.body).toEqual({ mode: 'AUTOMATION_ACTIVE', pausedAt: null });
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).automationPausedAt,
    ).toBeNull();

    expect((await post(`/leads/${UNKNOWN_ID}/takeover`)).status).toBe(404);
    expect((await post('/leads/not-a-uuid/takeover')).status).toBe(404);
  });
});
