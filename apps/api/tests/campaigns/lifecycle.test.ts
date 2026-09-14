import { CAMPAIGN_ACTIONS } from '@cadentor/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { CampaignStatus } from '../../src/generated/prisma/enums.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/lib/errors.js';
import {
  applyCampaignAction,
  CAMPAIGN_ACTION_RULES,
  canTransitionCampaign,
} from '../../src/modules/campaigns/lifecycle.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { createCampaignWith } from '../helpers/dispatch.js';

describe('campaign transition map', () => {
  it('allows exactly the documented transitions', () => {
    const allowed = Object.values(CampaignStatus).flatMap((from) =>
      Object.values(CampaignStatus)
        .filter((to) => canTransitionCampaign(from, to))
        .map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'DRAFT->ACTIVE',
        'ACTIVE->PAUSED',
        'PAUSED->ACTIVE',
        'ACTIVE->COMPLETED',
        'PAUSED->COMPLETED',
      ].sort(),
    );
  });

  it('only defines actions that are legal transitions', () => {
    for (const action of CAMPAIGN_ACTIONS) {
      const rule = CAMPAIGN_ACTION_RULES[action];
      for (const from of rule.from) expect(canTransitionCampaign(from, rule.to)).toBe(true);
    }
  });
});

describe('applyCampaignAction', () => {
  let db: Database;

  beforeAll(() => {
    db = connectTestDatabase();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('runs DRAFT → ACTIVE → PAUSED → ACTIVE → COMPLETED', async () => {
    const campaign = await createCampaignWith(db, { status: 'DRAFT' });
    const at = new Date('2026-07-15T14:00:00Z');
    expect((await applyCampaignAction(db, campaign.id, 'start', at)).status).toBe('ACTIVE');
    expect((await applyCampaignAction(db, campaign.id, 'pause')).status).toBe('PAUSED');
    expect((await applyCampaignAction(db, campaign.id, 'resume')).status).toBe('ACTIVE');
    const completed = await applyCampaignAction(db, campaign.id, 'complete');
    expect(completed.status).toBe('COMPLETED');
    expect(completed.statusChangedAt.getTime()).toBeGreaterThan(at.getTime());
  });

  it('completes a PAUSED campaign', async () => {
    const campaign = await createCampaignWith(db, { status: 'PAUSED' });
    expect((await applyCampaignAction(db, campaign.id, 'complete')).status).toBe('COMPLETED');
  });

  it.each([
    ['DRAFT', 'pause'],
    ['DRAFT', 'resume'],
    ['DRAFT', 'complete'],
    ['ACTIVE', 'start'],
    ['ACTIVE', 'resume'],
    ['PAUSED', 'start'],
    ['PAUSED', 'pause'],
    ['COMPLETED', 'start'],
    ['COMPLETED', 'resume'],
    ['COMPLETED', 'pause'],
    ['COMPLETED', 'complete'],
  ] as const)('rejects %s + %s without changing status', async (status, action) => {
    const campaign = await createCampaignWith(db, { status });
    await expect(applyCampaignAction(db, campaign.id, action)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      status,
    );
  });

  it('refuses to activate a campaign with invalid stored config', async () => {
    const campaign = await db.campaign.create({
      data: { name: 'Broken', config: { sendWindow: { start: '18:00', end: '09:00' } } },
    });
    await expect(applyCampaignAction(db, campaign.id, 'start')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      'DRAFT',
    );
  });

  it('returns NotFound for an unknown campaign', async () => {
    await expect(
      applyCampaignAction(db, '0190d9b0-0000-7000-8000-000000000000', 'start'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets exactly one of two concurrent conflicting actions win', async () => {
    const campaign = await createCampaignWith(db, { status: 'ACTIVE' });
    const outcomes = await Promise.allSettled([
      applyCampaignAction(db, campaign.id, 'pause'),
      applyCampaignAction(db, campaign.id, 'complete'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
});
