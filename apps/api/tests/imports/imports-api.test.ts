import type { ApiErrorBody, CampaignSummary, ImportBatchDetail } from '@cadentor/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import type { Database } from '../../src/db/client.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { apiRouter } from '../../src/routes/api.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';

let db: Database;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = connectTestDatabase();
  const config = loadConfig({ NODE_ENV: 'test', IMPORT_MAX_FILE_BYTES: '4096' });
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

function uploadCsv(csv: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'leads.csv');
  return fetch(`${baseUrl}/api/v1/imports/csv`, { method: 'POST', body: form });
}

const CSV = [
  'First Name,Last Name,Mobile,Email',
  'Jane,Doe,(415) 555-2671,JANE@example.com',
  'Oliver,Smith,+44 7911 123456,',
  'Bad,Row,12345,',
  'Short,Row',
  'Jane,Again,+1 415 555 2671,',
  'Sam,Blocked,+1 650 253 0000,',
].join('\n');

describe('POST /api/v1/imports/csv', () => {
  it('imports a CSV end to end and reports per-row outcomes', async () => {
    await addSuppression(db, { phone: '+16502530000', reason: 'OPT_OUT', source: 'OPERATOR' });

    const res = await uploadCsv(CSV, { defaultCountry: 'us', source: 'legacy-crm' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportBatchDetail;

    expect(body.status).toBe('COMPLETED');
    expect(body.sourceReference).toBe('leads.csv');
    expect(body.counts).toEqual({
      total: 6,
      accepted: 2,
      newLeads: 2,
      duplicates: 1,
      suppressed: 1,
      invalid: 2,
      failed: 0,
      staged: 0,
    });
    expect(body.issues).toEqual([
      { rowNumber: 3, outcome: 'INVALID', reason: 'INVALID_PHONE', ignoredFields: [] },
      { rowNumber: 4, outcome: 'INVALID', reason: 'MALFORMED_ROW', ignoredFields: [] },
      { rowNumber: 5, outcome: 'DUPLICATE', reason: 'DUPLICATE_IN_BATCH', ignoredFields: [] },
      { rowNumber: 6, outcome: 'SUPPRESSED', reason: 'SUPPRESSED_PHONE', ignoredFields: [] },
    ]);

    const leads = await db.lead.findMany({ orderBy: { phone: 'asc' } });
    expect(leads.map((l) => [l.phone, l.email, l.source])).toEqual([
      ['+14155552671', 'jane@example.com', 'legacy-crm'],
      ['+447911123456', null, 'legacy-crm'],
    ]);

    const fetched = await fetch(`${baseUrl}/api/v1/imports/${body.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(body);
  });

  it('stages accepted leads into a campaign created through the API', async () => {
    const created = await fetch(`${baseUrl}/api/v1/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Spring reactivation', config: { hourlyDispatchLimit: 30 } }),
    });
    expect(created.status).toBe(201);
    const campaign = (await created.json()) as CampaignSummary;
    expect(campaign).toMatchObject({
      status: 'DRAFT',
      config: { hourlyDispatchLimit: 30, timezone: 'America/New_York' },
    });

    const res = await uploadCsv('phone\n+14155552671\n+447911123456\n', {
      campaignId: campaign.id,
    });
    const body = (await res.json()) as ImportBatchDetail;
    expect(body.counts.staged).toBe(2);
    expect(
      await db.campaignLead.count({ where: { campaignId: campaign.id, status: 'STAGED' } }),
    ).toBe(2);
  });

  it('uses an explicit column mapping', async () => {
    const res = await uploadCsv('Cell #,Contact\n+14155552671,jane@example.com\n', {
      mapping: JSON.stringify({ phone: 'Cell #', email: 'Contact' }),
    });
    expect(res.status).toBe(201);
    expect(await db.lead.findFirst({ select: { email: true } })).toEqual({
      email: 'jane@example.com',
    });
  });

  it('rejects a CSV without a phone column and creates no batch', async () => {
    const res = await uploadCsv('First Name,Email\nJane,jane@example.com\n');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.issues).toEqual([
      { path: 'header', message: 'required phone column not found' },
    ]);
    expect(await db.importBatch.count()).toBe(0);
  });

  it('rejects invalid options', async () => {
    const badCountry = await uploadCsv('phone\n+14155552671\n', { defaultCountry: 'ZZ' });
    expect(badCountry.status).toBe(400);
    const badMapping = await uploadCsv('phone\n+14155552671\n', { mapping: '{not json' });
    expect(badMapping.status).toBe(400);
    const unknownCampaign = await uploadCsv('phone\n+14155552671\n', {
      campaignId: '0190d9b0-0000-7000-8000-000000000000',
    });
    expect(unknownCampaign.status).toBe(404);
    expect(await db.importBatch.count()).toBe(0);
  });

  it('rejects empty files, missing files and non-multipart requests', async () => {
    expect((await uploadCsv('')).status).toBe(400);

    const noFile = new FormData();
    noFile.append('source', 'x');
    expect(
      (await fetch(`${baseUrl}/api/v1/imports/csv`, { method: 'POST', body: noFile })).status,
    ).toBe(400);

    const json = await fetch(`${baseUrl}/api/v1/imports/csv`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(400);
  });

  it('rejects uploads over the configured size limit', async () => {
    const res = await uploadCsv(`phone\n${'+14155552671\n'.repeat(500)}`);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await db.importBatch.count()).toBe(0);
  });

  it('rejects CSV syntax errors before writing anything', async () => {
    const res = await uploadCsv('phone\n+14155552671\n"+447911123456\n');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.issues).toEqual([{ path: 'line 3', message: 'CSV_QUOTE_NOT_CLOSED' }]);
    expect(await db.importBatch.count()).toBe(0);
    expect(await db.lead.count()).toBe(0);
  });
});

describe('GET /api/v1/imports/:id', () => {
  it('returns 404 for unknown or malformed ids', async () => {
    expect(
      (await fetch(`${baseUrl}/api/v1/imports/0190d9b0-0000-7000-8000-000000000000`)).status,
    ).toBe(404);
    expect((await fetch(`${baseUrl}/api/v1/imports/not-a-uuid`)).status).toBe(404);
  });
});
