import type {
  ApiErrorBody,
  AuditEventDto,
  OperatorIdentity,
  Page,
  ReadinessResponse,
} from '@cadentor/shared';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config/index.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { apiRouter } from '../../src/routes/api.js';
import { ADMIN_HEADERS, authConfig, OPERATOR_HEADERS } from '../helpers/auth.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { createMessagingCampaign } from '../helpers/messaging.js';
import { FakeCrm } from '../helpers/operations.js';

let db: Database;
const servers: Server[] = [];

beforeAll(() => {
  db = connectTestDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(db);
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function buildApp(config: AppConfig = authConfig(), database: Database = db): Express {
  return createApp({
    config,
    logger: silentLogger,
    checkDatabase: () => Promise.resolve('up'),
    api: apiRouter({
      db: database,
      config,
      logger: silentLogger,
      integrationProviders: { crm: new FakeCrm(), notifications: undefined, handoff: undefined },
    }),
  });
}

async function serve(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function send(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body,
  });
}

const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;

describe('operator authentication', () => {
  it('keeps /health and /ready open to infrastructure probes', async () => {
    const base = await serve(buildApp());
    expect((await send(base, '/health')).status).toBe(200);
    const ready = await send(base, '/ready');
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as ReadinessResponse).checks.database).toBe('up');
  });

  it('answers 401 for missing, malformed and invalid credentials on every protected surface', async () => {
    const base = await serve(buildApp());
    const protectedPaths = [
      '/api/v1/dashboard/overview',
      '/api/v1/dashboard/campaigns',
      '/api/v1/conversations',
      '/api/v1/reviews',
      '/api/v1/audit',
      '/api/v1/integrations/health',
      '/api/v1/leads/0190d9b0-0000-7000-8000-000000000000',
      '/api/v1/campaigns/0190d9b0-0000-7000-8000-000000000000',
      '/api/v1/knowledge',
      '/api/v1/auth/me',
    ];
    for (const path of protectedPaths) {
      const res = await send(base, path);
      expect(res.status, path).toBe(401);
      const error = await errorOf(res);
      expect(error.code).toBe('UNAUTHORIZED');
      expect(error.requestId).toBe(res.headers.get('x-request-id'));
    }
    for (const authorization of [
      'Basic b3BzOnNlY3JldA==',
      'Bearer',
      'Bearer wrong-token-0123456789',
    ]) {
      expect(
        (await send(base, '/api/v1/dashboard/overview', { headers: { authorization } })).status,
      ).toBe(401);
    }
    const mutation = await send(
      base,
      '/api/v1/leads/0190d9b0-0000-7000-8000-000000000000/takeover',
      {
        method: 'POST',
      },
    );
    expect(mutation.status).toBe(401);
  });

  it('identifies the operator and allows reads and lifecycle actions', async () => {
    const base = await serve(buildApp());
    const me = await send(base, '/api/v1/auth/me', { headers: OPERATOR_HEADERS });
    expect((await me.json()) as OperatorIdentity).toEqual({ id: 'ops', role: 'OPERATOR' });
    expect(
      (await send(base, '/api/v1/dashboard/overview', { headers: OPERATOR_HEADERS })).status,
    ).toBe(200);

    const campaign = await createMessagingCampaign(db);
    const paused = await send(base, `/api/v1/campaigns/${campaign.id}/pause`, {
      method: 'POST',
      headers: OPERATOR_HEADERS,
    });
    expect(paused.status).toBe(200);
  });

  it('blocks a client after repeated invalid tokens, even with a valid one', async () => {
    const base = await serve(buildApp());
    const invalid = { authorization: 'Bearer definitely-not-a-valid-token' };
    for (let i = 0; i < 10; i++) {
      expect((await send(base, '/api/v1/auth/me', { headers: invalid })).status).toBe(401);
    }
    const blocked = await send(base, '/api/v1/auth/me', { headers: invalid });
    expect(blocked.status).toBe(429);
    expect((await errorOf(blocked)).code).toBe('RATE_LIMITED');
    expect((await send(base, '/api/v1/auth/me', { headers: OPERATOR_HEADERS })).status).toBe(429);
    // Probes are never rate limited by operator auth.
    expect((await send(base, '/health')).status).toBe(200);
  });

  it('rate limits operator mutations per operator', async () => {
    const config = authConfig();
    const base = await serve(buildApp({ ...config, auth: { ...config.auth, mutationLimit: 2 } }));
    const campaign = await createMessagingCampaign(db);
    const statuses: number[] = [];
    for (const action of ['pause', 'resume', 'pause']) {
      statuses.push(
        (
          await send(base, `/api/v1/campaigns/${campaign.id}/${action}`, {
            method: 'POST',
            headers: OPERATOR_HEADERS,
          })
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      'ACTIVE',
    );
    // Reads are not mutation-limited.
    expect((await send(base, '/api/v1/audit', { headers: OPERATOR_HEADERS })).status).toBe(200);
  });
});

describe('operator authorization', () => {
  it('answers 403 when an OPERATOR attempts ADMIN actions, and ADMIN succeeds', async () => {
    const base = await serve(buildApp());
    const adminOnly: [string, string, string | undefined][] = [
      ['POST', '/api/v1/campaigns', JSON.stringify({ name: 'Spring' })],
      ['POST', '/api/v1/integrations/requeue-blocked', undefined],
      ['POST', '/api/v1/knowledge', JSON.stringify({ category: 'FAQ', content: 'x' })],
      ['POST', '/api/v1/imports/csv', undefined],
    ];
    for (const [method, path, body] of adminOnly) {
      const res = await send(base, path, { method, headers: OPERATOR_HEADERS, body });
      expect(res.status, path).toBe(403);
      expect((await errorOf(res)).code).toBe('FORBIDDEN');
    }
    expect(await db.campaign.count()).toBe(0);
    expect((await send(base, '/api/v1/knowledge', { headers: OPERATOR_HEADERS })).status).toBe(200);

    const created = await send(base, '/api/v1/campaigns', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ name: 'Spring' }),
    });
    expect(created.status).toBe(201);
    const requeue = await send(base, '/api/v1/integrations/requeue-blocked', {
      method: 'POST',
      headers: ADMIN_HEADERS,
    });
    expect(requeue.status).toBe(200);
  });
});

describe('operator audit and duplicate mutations', () => {
  it('records one audit event per real lifecycle change and none for rejected repeats', async () => {
    const base = await serve(buildApp());
    const campaign = await createMessagingCampaign(db);
    const pause = () =>
      send(base, `/api/v1/campaigns/${campaign.id}/pause`, {
        method: 'POST',
        headers: { ...OPERATOR_HEADERS, 'x-request-id': 'req-pause-000001' },
      });

    expect((await pause()).status).toBe(200);
    const repeat = await pause();
    expect(repeat.status).toBe(409);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      'PAUSED',
    );

    const audit = await send(base, `/api/v1/audit?targetType=CAMPAIGN&targetId=${campaign.id}`, {
      headers: OPERATOR_HEADERS,
    });
    const page = (await audit.json()) as Page<AuditEventDto>;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      actorId: 'ops',
      actorRole: 'OPERATOR',
      action: 'CAMPAIGN_PAUSE',
      targetType: 'CAMPAIGN',
      targetId: campaign.id,
      metadata: { status: 'PAUSED' },
    });
    const stored = await db.operatorAuditEvent.findFirstOrThrow();
    expect(stored.requestId).toBe('req-pause-000001');
    expect(JSON.stringify(stored)).not.toContain('Bearer');

    // Append-only: the database refuses to rewrite or delete history.
    await expect(
      db.operatorAuditEvent.update({ where: { id: stored.id }, data: { actorId: 'someone' } }),
    ).rejects.toThrow();
    await expect(db.operatorAuditEvent.delete({ where: { id: stored.id } })).rejects.toThrow();
  });
});

describe('request safety', () => {
  it('returns safe 400s for malformed and invalid operator input', async () => {
    const base = await serve(buildApp());
    const path = '/api/v1/reviews/0190d9b0-0000-7000-8000-000000000000/resolve';
    const malformed = await send(base, path, {
      method: 'POST',
      headers: OPERATOR_HEADERS,
      body: '{"resolution":',
    });
    expect(malformed.status).toBe(400);
    expect((await errorOf(malformed)).code).toBe('VALIDATION_ERROR');

    for (const body of [
      { resolution: 'DELETE_EVERYTHING' },
      { resolution: 'MARK_HANDLED', note: 'x'.repeat(501) },
      { resolution: 'MARK_HANDLED', status: 'COMPLETED' },
    ]) {
      const res = await send(base, path, {
        method: 'POST',
        headers: OPERATOR_HEADERS,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const unknown = await send(base, path, {
      method: 'POST',
      headers: OPERATOR_HEADERS,
      body: JSON.stringify({ resolution: 'MARK_HANDLED' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('maps an unreachable database to 503 DATABASE_ERROR without leaking details', async () => {
    // Nothing listens on port 1: every query fails to connect.
    const unreachable = createDatabase('postgresql://127.0.0.1:1/cadentor_test');
    try {
      const base = await serve(buildApp(authConfig(), unreachable));
      const res = await send(base, '/api/v1/dashboard/overview', { headers: OPERATOR_HEADERS });
      const text = await res.text();
      expect(res.status).toBe(503);
      const { error } = JSON.parse(text) as ApiErrorBody;
      expect(error.code).toBe('DATABASE_ERROR');
      expect(error.message).toBe('Database is unavailable');
      expect(error.requestId).toBe(res.headers.get('x-request-id'));
      expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|postgres|stack/i);
    } finally {
      await unreachable.$disconnect();
    }
  });
});
