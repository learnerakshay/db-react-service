import type { ApiErrorBody, CampaignDetail, CampaignSummary } from '@cadentor/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { ADMIN_HEADERS, authConfig } from '../helpers/auth.js';
import type { Database } from '../../src/db/client.js';
import { apiRouter } from '../../src/routes/api.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { admit, stageMembers } from '../helpers/dispatch.js';

let db: Database;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = connectTestDatabase();
  const config = authConfig();
  const app = createApp({
    config,
    logger: silentLogger,
    checkDatabase: () => Promise.resolve('up'),
    api: apiRouter({ db, config, logger: silentLogger }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/campaigns`;
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

async function post(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ADMIN_HEADERS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('campaign control API', () => {
  it('runs a campaign through its lifecycle', async () => {
    const created = (await (
      await post('', { name: 'Spring', config: { hourlyDispatchLimit: 30, timezone: null } })
    ).json()) as CampaignSummary;
    expect(created).toMatchObject({
      status: 'DRAFT',
      config: { hourlyDispatchLimit: 30, timezone: null },
    });

    for (const [action, status] of [
      ['start', 'ACTIVE'],
      ['pause', 'PAUSED'],
      ['resume', 'ACTIVE'],
      ['complete', 'COMPLETED'],
    ] as const) {
      const res = await post(`/${created.id}/${action}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as CampaignSummary).status).toBe(status);
    }
  });

  it('rejects illegal actions with 409 and unknown campaigns with 404', async () => {
    const created = (await (await post('', { name: 'Draft' })).json()) as CampaignSummary;

    const illegal = await post(`/${created.id}/pause`);
    expect(illegal.status).toBe(409);
    expect(((await illegal.json()) as ApiErrorBody).error.code).toBe('CONFLICT');

    expect((await post('/0190d9b0-0000-7000-8000-000000000000/start')).status).toBe(404);
    expect((await post('/not-a-uuid/start')).status).toBe(404);
    expect((await fetch(`${baseUrl}/not-a-uuid`, { headers: ADMIN_HEADERS })).status).toBe(404);
  });

  it('reports membership counts and hourly usage', async () => {
    const created = (await (
      await post('', { name: 'Detail', config: { hourlyDispatchLimit: 2 } })
    ).json()) as CampaignSummary;
    await post(`/${created.id}/start`);
    await stageMembers(db, created.id, [{}, {}, {}]);
    await admit(db, created.id, { now: new Date(), scanLimit: 10 });

    const detail = (await (
      await fetch(`${baseUrl}/${created.id}`, { headers: ADMIN_HEADERS })
    ).json()) as CampaignDetail;
    expect(detail.status).toBe('ACTIVE');
    expect(detail.members.STAGED + detail.members.QUEUED).toBe(3);
    expect(detail.dispatch.hourlyLimit).toBe(2);
    expect(detail.dispatch.admittedLastHour).toBe(detail.members.QUEUED);
    expect(detail.dispatch.remainingThisHour).toBe(2 - detail.members.QUEUED);
  });
});
