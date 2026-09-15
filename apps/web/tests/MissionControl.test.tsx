import type {
  CampaignRow,
  ConversationDetail,
  ConversationListItem,
  DashboardOverview,
  IntegrationHealthResponse,
  LeadDetail,
  Page,
} from '@cadentor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionControl } from '../src/pages/MissionControl';

type Reply = [status: number, body: unknown];
type Routes = Record<string, object | ((url: URL) => Reply)>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes keyed by "METHOD /path"; unknown routes answer 404 like the API. */
function mockApi(routes: Routes) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    const [status, body]: Reply =
      route === undefined
        ? [404, { error: { code: 'NOT_FOUND', message: 'Not mocked' } }]
        : typeof route === 'function'
          ? (route as (url: URL) => Reply)(url)
          : [200, route];
    return Promise.resolve(jsonResponse(status, body));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function page<T>(items: T[], total = items.length, pageSize = 25, current = 1): Page<T> {
  return { items, total, page: current, pageSize };
}

const METRICS: DashboardOverview = {
  generatedAt: '2026-09-15T10:00:00.000Z',
  metrics: {
    totalIngested: 1234,
    outboundSent: 980,
    contactedLeads: 400,
    repliedLeads: 170,
    replyRate: 0.425,
    positiveIntentLeads: 61,
    qualified: 22,
    booked: 9,
    activeCampaigns: 2,
    openReviews: 3,
    optedOutLeads: 12,
    optOutRate: 0.03,
  },
};

const HEALTH: IntegrationHealthResponse = {
  integrations: [
    {
      key: 'CRM',
      configured: true,
      state: 'FAILING',
      counts: { PENDING: 0, PROCESSING: 0, COMPLETED: 4, RETRY: 1, FAILED: 2, BLOCKED: 0 },
    },
    {
      key: 'OWNER_NOTIFICATION',
      configured: false,
      state: 'NOT_CONFIGURED',
      counts: { PENDING: 0, PROCESSING: 0, COMPLETED: 0, RETRY: 0, FAILED: 0, BLOCKED: 3 },
    },
  ],
  problems: [],
};

const members = {
  STAGED: 0,
  QUEUED: 5,
  STEP_1_SENT: 10,
  STEP_2_SENT: 0,
  ENGAGED: 2,
  QUALIFIED: 1,
  BOOKED: 1,
  OPTED_OUT: 1,
  DORMANT_ARCHIVED: 0,
};

const ACTIVE_CAMPAIGN: CampaignRow = {
  id: 'c1',
  name: 'Spring',
  status: 'ACTIVE',
  statusChangedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-09-01T10:00:00.000Z',
  hourlyLimit: 60,
  admittedLastHour: 12,
  sendWindow: { start: '09:00', end: '18:00' },
  timezone: 'America/New_York',
  lastActivityAt: null,
  members,
  enrolled: 20,
  step1Sent: 15,
  outboundSent: 18,
  repliedLeads: 4,
  qualified: 2,
  booked: 1,
};

const overviewRoutes = (campaigns: Page<CampaignRow>): Routes => ({
  'GET /api/v1/dashboard/overview': METRICS,
  'GET /api/v1/dashboard/campaigns': campaigns,
  'GET /api/v1/integrations/health': HEALTH,
});

function renderAt(hash: string) {
  window.location.hash = hash;
  return render(<MissionControl />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('Mission Control overview', () => {
  it('renders KPI metrics and integration states from the API', async () => {
    mockApi(overviewRoutes(page([ACTIVE_CAMPAIGN])));
    renderAt('#/overview');

    const metrics = await screen.findByRole('region', { name: 'Key metrics' });
    expect(await within(metrics).findByText('1,234')).toBeDefined();
    expect(within(metrics).getByText('42.5%')).toBeDefined();
    expect(within(metrics).getByText('170 of 400 contacted leads')).toBeDefined();
    expect(within(metrics).getByText('9')).toBeDefined();

    expect(await screen.findByText('Configured but failing — 2 failed, 1 retrying')).toBeDefined();
    expect(screen.getByText('Provider not configured — 3 blocked (not sent)')).toBeDefined();
    expect(screen.getByText('No failing or blocked deliveries.')).toBeDefined();
    expect(await screen.findByRole('link', { name: 'Spring' })).toBeDefined();
  });

  it('renders empty states safely', async () => {
    mockApi(overviewRoutes(page([])));
    renderAt('#/overview');
    expect(await screen.findByText('No campaigns yet.')).toBeDefined();
  });

  it('renders API errors instead of blank panels', async () => {
    mockApi({
      ...overviewRoutes(page([])),
      'GET /api/v1/dashboard/overview': () => [
        503,
        { error: { code: 'DATABASE_ERROR', message: 'Database is unavailable' } },
      ],
    });
    renderAt('#/overview');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toContain('Database is unavailable');
  });
});

describe('campaign controls', () => {
  it('requires confirmation before completing a campaign', async () => {
    const fetchMock = mockApi({
      ...overviewRoutes(page([ACTIVE_CAMPAIGN])),
      'POST /api/v1/campaigns/c1/complete': { ...ACTIVE_CAMPAIGN, status: 'COMPLETED' },
    });
    renderAt('#/overview');

    fireEvent.click(await screen.findByRole('button', { name: 'Complete Spring' }));
    const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts()).toHaveLength(0);

    const dialog = screen.getByRole('alertdialog', { name: 'Confirm complete' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm complete' }));
    await waitFor(() => {
      expect(posts().map(([url]) => new URL(url).pathname)).toEqual([
        '/api/v1/campaigns/c1/complete',
      ]);
    });
  });

  it('shows backend lifecycle errors', async () => {
    mockApi({
      ...overviewRoutes(page([ACTIVE_CAMPAIGN])),
      'POST /api/v1/campaigns/c1/pause': () => [
        409,
        { error: { code: 'CONFLICT', message: 'Cannot pause a PAUSED campaign' } },
      ],
    });
    renderAt('#/overview');
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Spring' }));
    expect(await screen.findByText('Cannot pause a PAUSED campaign')).toBeDefined();
  });
});

describe('conversation inspector', () => {
  const item = (leadId: string, name: string): ConversationListItem => ({
    leadId,
    leadName: name,
    phoneLast4: '0101',
    campaign: { id: 'c1', name: 'Spring' },
    membershipStatus: 'ENGAGED',
    lastMessage: {
      direction: 'INBOUND',
      purpose: 'INBOUND_REPLY',
      status: 'RECEIVED',
      preview: 'Sounds good',
      at: '2026-09-15T09:00:00.000Z',
    },
    openReviews: 0,
    automation: { mode: 'AUTOMATION_ACTIVE', pausedAt: null },
  });
  const THREAD: ConversationDetail = {
    lead: {
      id: 'l1',
      name: 'Dana Smith',
      phoneLast4: '0101',
      automation: { mode: 'AUTOMATION_ACTIVE', pausedAt: null },
    },
    hasEarlier: false,
    messages: [
      {
        id: 'm1',
        direction: 'INBOUND',
        purpose: 'INBOUND_REPLY',
        status: 'RECEIVED',
        body: 'Sounds good',
        at: '2026-09-15T09:00:00.000Z',
        deliveredAt: null,
        errorCode: null,
        campaignId: 'c1',
        reply: {
          status: 'COMPLETED',
          classification: 'POSITIVE_INTEREST',
          confidence: 0.93,
          action: 'ENGAGE',
          escalationReason: null,
        },
        qualification: null,
        booking: null,
      },
    ],
  };
  const LEAD: LeadDetail = {
    id: 'l1',
    name: 'Dana Smith',
    phone: '+14155550101',
    email: null,
    status: 'ACTIVE',
    source: 'import',
    externalId: null,
    timezone: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    importBatch: null,
    suppression: [],
    automation: { mode: 'AUTOMATION_ACTIVE', pausedAt: null },
    memberships: [],
  };

  it('paginates the list, shows history and takes over a lead', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/conversations': (url: URL): Reply => [
        200,
        page(
          [item(url.searchParams.get('page') === '2' ? 'l2' : 'l1', 'Dana Smith')],
          60,
          25,
          Number(url.searchParams.get('page')),
        ),
      ],
      'GET /api/v1/conversations/l1': THREAD,
      'GET /api/v1/leads/l1': LEAD,
      'POST /api/v1/leads/l1/takeover': {
        mode: 'HUMAN_TAKEOVER',
        pausedAt: '2026-09-15T10:00:00Z',
      },
    });
    renderAt('#/conversations/l1');

    const history = await screen.findByRole('list', { name: 'Message history' });
    expect(within(history).getByText('Sounds good')).toBeDefined();
    expect(within(history).getByText('93% confidence')).toBeDefined();
    const thread = screen.getByRole('region', { name: 'Conversation · Dana Smith' });
    expect(within(thread).getByText('AUTOMATION ACTIVE')).toBeDefined();
    expect(await screen.findByText('Not suppressed')).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => new URL(url).searchParams.get('page') === '2'),
      ).toBe(true);
    });

    fireEvent.click(within(thread).getByRole('button', { name: 'Take over' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            init?.method === 'POST' && new URL(url).pathname === '/api/v1/leads/l1/takeover',
        ),
      ).toBe(true);
    });
  });

  it('renders an empty conversation list and review queue safely', async () => {
    mockApi({
      'GET /api/v1/conversations': page([]),
      'GET /api/v1/reviews': page([]),
    });
    renderAt('#/conversations');
    expect(await screen.findByText('No conversations yet.')).toBeDefined();
    expect(screen.getByText('Select a conversation to inspect it.')).toBeDefined();

    cleanup();
    renderAt('#/reviews');
    expect(await screen.findByText('No conversations are waiting for human review.')).toBeDefined();
  });
});
