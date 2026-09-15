import { KNOWLEDGE_CATEGORIES, type ApiErrorBody, type KnowledgeItemDto } from '@cadentor/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { ADMIN_HEADERS, authConfig } from '../helpers/auth.js';
import type { Database } from '../../src/db/client.js';
import { KnowledgeCategory } from '../../src/generated/prisma/enums.js';
import { createKnowledgeItem } from '../../src/modules/knowledge/knowledge.js';
import { rankKnowledge, retrieveRelevantKnowledge } from '../../src/modules/knowledge/retrieval.js';
import { apiRouter } from '../../src/routes/api.js';
import { connectTestDatabase, resetDatabase, silentLogger } from '../helpers/db.js';
import { createMessagingCampaign } from '../helpers/messaging.js';

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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
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

describe('knowledge retrieval', () => {
  it('returns only active facts for the campaign or business-wide, ranked by relevance', async () => {
    const campaign = await createMessagingCampaign(db, { name: 'A' });
    const other = await createMessagingCampaign(db, { name: 'B' });
    const price = await createKnowledgeItem(db, {
      campaignId: campaign.id,
      category: 'PRICING',
      content: 'A standard gutter cleaning is $149.',
      keywords: ['gutter', 'cleaning'],
    });
    const hours = await createKnowledgeItem(db, {
      category: 'HOURS',
      content: 'Open Monday to Friday, 8am to 5pm.',
    });
    await createKnowledgeItem(db, {
      campaignId: other.id,
      category: 'PRICING',
      content: 'Other campaign price is $999.',
    });
    const retired = await createKnowledgeItem(db, {
      campaignId: campaign.id,
      category: 'PRICING',
      content: 'Old price $1.',
    });
    await db.knowledgeItem.update({ where: { id: retired.id }, data: { active: false } });

    const pricing = await retrieveRelevantKnowledge(db, {
      campaignId: campaign.id,
      query: 'How much does a gutter cleaning cost?',
      limit: 8,
    });
    expect(pricing.map((f) => f.id)).toEqual([price.id]);

    const open = await retrieveRelevantKnowledge(db, {
      campaignId: campaign.id,
      query: 'Are you open on Saturday?',
      limit: 8,
    });
    expect(open.map((f) => f.id)).toEqual([hours.id]);

    expect(
      await retrieveRelevantKnowledge(db, {
        campaignId: campaign.id,
        query: 'Do you install solar panels?',
        limit: 8,
      }),
    ).toEqual([]);
    expect(
      (await retrieveRelevantKnowledge(db, { campaignId: null, query: 'how much?', limit: 8 })).map(
        (f) => f.id,
      ),
    ).toEqual([]);
  });

  it('respects the limit and orders deterministically', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      id: `id-${String(i)}`,
      category: KnowledgeCategory.FAQ,
      question: null,
      content: 'Warranty covers gutters',
      keywords: i === 3 ? ['warranty'] : [],
    }));
    const ranked = rankKnowledge(candidates, 'what warranty do you give', 3);
    expect(ranked.map((f) => f.id)).toEqual(['id-3', 'id-0', 'id-1']);
  });

  it('keeps shared categories in sync with the database enum', () => {
    expect([...KNOWLEDGE_CATEGORIES].sort()).toEqual(Object.values(KnowledgeCategory).sort());
  });
});

describe('knowledge API', () => {
  const post = (path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ADMIN_HEADERS },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('creates, lists and deactivates approved facts', async () => {
    const campaign = await createMessagingCampaign(db);
    const created = await post('', {
      campaignId: campaign.id,
      category: 'INSURANCE',
      question: 'Are you insured?',
      content: 'Yes, we are fully licensed and insured.',
      keywords: ['Insured', 'insurance', 'insured'],
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as KnowledgeItemDto;
    expect(item).toMatchObject({
      campaignId: campaign.id,
      category: 'INSURANCE',
      active: true,
      keywords: ['insured', 'insurance'],
    });

    const list = (await (
      await fetch(`${baseUrl}?campaignId=${campaign.id}`, { headers: ADMIN_HEADERS })
    ).json()) as KnowledgeItemDto[];
    expect(list.map((i) => i.id)).toEqual([item.id]);

    const deactivated = await post(`/${item.id}/deactivate`);
    expect(((await deactivated.json()) as KnowledgeItemDto).active).toBe(false);
    expect(await (await fetch(baseUrl, { headers: ADMIN_HEADERS })).json()).toEqual([]);
  });

  it('validates input and unknown references', async () => {
    const invalid = await post('', { category: 'GOSSIP', content: '' });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(
      (
        await post('', {
          category: 'FAQ',
          content: 'x',
          campaignId: '0190d9b0-0000-7000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect((await post('/not-a-uuid/deactivate')).status).toBe(404);
    expect((await fetch(`${baseUrl}?campaignId=nope`, { headers: ADMIN_HEADERS })).status).toBe(
      400,
    );
  });
});
