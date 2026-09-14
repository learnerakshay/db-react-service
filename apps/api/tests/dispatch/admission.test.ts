import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { hasPrismaCode } from '../../src/db/errors.js';
import { ConflictError } from '../../src/lib/errors.js';
import { applyCampaignAction } from '../../src/modules/campaigns/lifecycle.js';
import { transitionCampaignLead } from '../../src/modules/campaigns/membership.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import {
  admit,
  createCampaignWith,
  LA_MORNING,
  NY_EARLY,
  NY_MORNING,
  stageMembers,
  statusCounts,
} from '../helpers/dispatch.js';

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

const minutes = (date: Date, n: number) => new Date(date.getTime() + n * 60_000);

describe('campaign status gates admission', () => {
  it('admits nothing for a DRAFT campaign', async () => {
    const campaign = await createCampaignWith(db, { status: 'DRAFT' });
    await stageMembers(db, campaign.id, [{}, {}]);
    const result = await admit(db, campaign.id);
    expect(result).toMatchObject({ campaignStatus: 'DRAFT', admitted: 0 });
    expect(await statusCounts(db, campaign.id)).toEqual({ STAGED: 2 });
  });

  it('admits eligible STAGED members of an ACTIVE campaign to QUEUED with an audit record', async () => {
    const campaign = await createCampaignWith(db);
    const [member] = await stageMembers(db, campaign.id, [{}, {}]);
    const result = await admit(db, campaign.id, { jobId: 'job-1' });

    expect(result).toMatchObject({ admitted: 2, admittedBefore: 0, hourlyLimit: 100 });
    expect(await statusCounts(db, campaign.id)).toEqual({ QUEUED: 2 });
    const admission = await db.dispatchAdmission.findUniqueOrThrow({
      where: { campaignLeadId: member?.id ?? '' },
    });
    expect(admission).toMatchObject({
      campaignId: campaign.id,
      admittedAt: NY_MORNING,
      timezone: 'America/New_York',
      timezoneSource: 'CAMPAIGN',
      localTime: '10:00',
      sendWindowStart: '09:00',
      sendWindowEnd: '18:00',
      hourlyLimit: 100,
      priorAdmissionsInHour: 0,
      jobId: 'job-1',
    });
  });

  it('admits nothing while PAUSED and resumes admitting after resume', async () => {
    const campaign = await createCampaignWith(db);
    await stageMembers(db, campaign.id, [{}, {}]);
    await applyCampaignAction(db, campaign.id, 'pause');

    expect((await admit(db, campaign.id)).admitted).toBe(0);
    expect(await statusCounts(db, campaign.id)).toEqual({ STAGED: 2 });

    await applyCampaignAction(db, campaign.id, 'resume');
    expect((await admit(db, campaign.id)).admitted).toBe(2);
  });

  it('admits nothing for a COMPLETED campaign', async () => {
    const campaign = await createCampaignWith(db);
    await stageMembers(db, campaign.id, [{}]);
    await applyCampaignAction(db, campaign.id, 'complete');
    expect((await admit(db, campaign.id)).admitted).toBe(0);
  });
});

describe('recipient local time', () => {
  it('admits inside the window and holds members outside it', async () => {
    const campaign = await createCampaignWith(db);
    await stageMembers(db, campaign.id, [{}]);

    const early = await admit(db, campaign.id, { now: NY_EARLY });
    expect(early).toMatchObject({ admitted: 0, skipped: { OUTSIDE_SEND_WINDOW: 1 } });
    expect(await statusCounts(db, campaign.id)).toEqual({ STAGED: 1 });

    expect((await admit(db, campaign.id, { now: NY_MORNING })).admitted).toBe(1);
  });

  it('uses the lead timezone before the campaign fallback', async () => {
    const campaign = await createCampaignWith(db, { timezone: 'America/New_York' });
    const [laLead, nyFallback] = await stageMembers(db, campaign.id, [
      { timezone: 'America/Los_Angeles' },
      {},
    ]);

    // 10:00 NY / 07:00 LA: only the fallback (NY) member is in window.
    const morning = await admit(db, campaign.id, { now: NY_MORNING });
    expect(morning).toMatchObject({ admitted: 1, skipped: { OUTSIDE_SEND_WINDOW: 1 } });
    const queued = await db.campaignLead.findMany({ where: { status: 'QUEUED' } });
    expect(queued.map((m) => m.id)).toEqual([nyFallback?.id]);

    // 10:00 LA: now the LA member is eligible, judged by its own timezone.
    expect((await admit(db, campaign.id, { now: LA_MORNING })).admitted).toBe(1);
    const admission = await db.dispatchAdmission.findUniqueOrThrow({
      where: { campaignLeadId: laLead?.id ?? '' },
    });
    expect(admission).toMatchObject({
      timezone: 'America/Los_Angeles',
      timezoneSource: 'LEAD',
      localTime: '10:00',
    });
  });

  it('uses an explicit campaign fallback timezone for leads without one', async () => {
    const campaign = await createCampaignWith(db, { timezone: 'Europe/London' });
    await stageMembers(db, campaign.id, [{}]);
    // 14:00Z = 15:00 London (BST).
    const result = await admit(db, campaign.id, { now: NY_MORNING });
    expect(result.admitted).toBe(1);
    expect(await db.dispatchAdmission.findFirstOrThrow()).toMatchObject({
      timezone: 'Europe/London',
      timezoneSource: 'CAMPAIGN',
      localTime: '15:00',
    });
  });

  it('never admits a lead with no timezone when the campaign has no fallback', async () => {
    const campaign = await createCampaignWith(db, { timezone: null });
    await stageMembers(db, campaign.id, [{}, { timezone: 'America/Los_Angeles' }, {}]);

    const result = await admit(db, campaign.id, { now: LA_MORNING });
    expect(result.admitted).toBe(1);
    expect(await statusCounts(db, campaign.id)).toEqual({ QUEUED: 1, STAGED: 2 });
  });

  it('follows DST: the same UTC instant is outside the window before the change and inside after', async () => {
    const campaign = await createCampaignWith(db, { timezone: 'America/New_York' });
    await stageMembers(db, campaign.id, [{}]);

    // 13:30Z is 08:30 EST on 2026-03-07 but 09:30 EDT on 2026-03-08.
    expect((await admit(db, campaign.id, { now: new Date('2026-03-07T13:30:00Z') })).admitted).toBe(
      0,
    );
    const after = await admit(db, campaign.id, { now: new Date('2026-03-08T13:30:00Z') });
    expect(after.admitted).toBe(1);
    expect((await db.dispatchAdmission.findFirstOrThrow()).localTime).toBe('09:30');
  });
});

describe('suppression re-check at admission', () => {
  it('never queues a member suppressed after import; retires it as OPTED_OUT', async () => {
    const campaign = await createCampaignWith(db);
    const [byPhone, byEmail, clean] = await stageMembers(db, campaign.id, [
      { phone: '+16505550001' },
      { phone: '+16505550002', email: 'blocked@example.com' },
      { phone: '+16505550003' },
    ]);
    await addSuppression(db, {
      phone: '+16505550001',
      reason: 'OPT_OUT',
      source: 'INBOUND_MESSAGE',
    });
    await addSuppression(db, {
      email: 'blocked@example.com',
      reason: 'DO_NOT_CONTACT',
      source: 'OPERATOR',
    });

    const result = await admit(db, campaign.id);
    expect(result).toMatchObject({ admitted: 1, optedOut: 2 });

    const statuses = Object.fromEntries(
      (await db.campaignLead.findMany()).map((m) => [m.id, m.status]),
    );
    expect(statuses).toEqual({
      [byPhone?.id ?? '']: 'OPTED_OUT',
      [byEmail?.id ?? '']: 'OPTED_OUT',
      [clean?.id ?? '']: 'QUEUED',
    });
    expect(await db.dispatchAdmission.count()).toBe(1);
  });

  it('retires suppressed members even outside the send window', async () => {
    const campaign = await createCampaignWith(db);
    await stageMembers(db, campaign.id, [{ phone: '+16505550009' }]);
    await addSuppression(db, { phone: '+16505550009', reason: 'COMPLAINT', source: 'OPERATOR' });
    expect(await admit(db, campaign.id, { now: NY_EARLY })).toMatchObject({
      admitted: 0,
      optedOut: 1,
    });
  });
});

describe('hourly capacity', () => {
  it('enforces the limit exactly over a rolling hour', async () => {
    const campaign = await createCampaignWith(db, { hourlyDispatchLimit: 3 });
    await stageMembers(db, campaign.id, [{}, {}, {}, {}, {}]);

    expect(await admit(db, campaign.id, { now: NY_MORNING })).toMatchObject({
      admitted: 3,
      admittedBefore: 0,
    });
    expect(await admit(db, campaign.id, { now: minutes(NY_MORNING, 30) })).toMatchObject({
      admitted: 0,
      admittedBefore: 3,
    });
    expect(await admit(db, campaign.id, { now: minutes(NY_MORNING, 59) })).toMatchObject({
      admitted: 0,
    });
    expect(await admit(db, campaign.id, { now: minutes(NY_MORNING, 61) })).toMatchObject({
      admitted: 2,
      admittedBefore: 0,
    });

    const priors = (
      await db.dispatchAdmission.findMany({ orderBy: { priorAdmissionsInHour: 'asc' } })
    ).map((a) => a.priorAdmissionsInHour);
    expect(priors).toEqual([0, 0, 1, 1, 2]);
  });

  it('cannot be exceeded by concurrent workers on separate connections', async () => {
    const campaign = await createCampaignWith(db, { hourlyDispatchLimit: 4 });
    await stageMembers(
      db,
      campaign.id,
      Array.from({ length: 20 }, () => ({})),
    );

    const workers = Array.from({ length: 4 }, () => connectTestDatabase());
    try {
      // Open the pooled connections first, a few at a time, so the race below
      // measures locking rather than connection setup (each PostgreSQL
      // connection is a new server process, which is slow on Windows).
      for (const worker of workers) {
        await Promise.all([1, 2, 3].map(() => worker.$queryRaw`SELECT 1`));
      }
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          admit(workers[i % workers.length] as Database, campaign.id),
        ),
      );
      expect(results.reduce((sum, r) => sum + r.admitted, 0)).toBe(4);
    } finally {
      await Promise.all(workers.map((w) => w.$disconnect()));
    }

    expect(await statusCounts(db, campaign.id)).toEqual({ QUEUED: 4, STAGED: 16 });
    expect(await db.dispatchAdmission.count({ where: { campaignId: campaign.id } })).toBe(4);
  });

  it('keeps separate capacity per campaign', async () => {
    const a = await createCampaignWith(db, { hourlyDispatchLimit: 2, name: 'A' });
    const b = await createCampaignWith(db, { hourlyDispatchLimit: 3, name: 'B' });
    await stageMembers(db, a.id, [{}, {}, {}, {}, {}]);
    await stageMembers(db, b.id, [{}, {}, {}, {}, {}]);

    const [ra, rb] = await Promise.all([admit(db, a.id), admit(db, b.id)]);
    expect([ra.admitted, rb.admitted]).toEqual([2, 3]);
  });

  it('survives a process restart: capacity and states come from the database', async () => {
    const campaign = await createCampaignWith(db, { hourlyDispatchLimit: 3 });
    await stageMembers(db, campaign.id, [{}, {}, {}, {}, {}]);

    const before = connectTestDatabase();
    expect((await admit(before, campaign.id)).admitted).toBe(2 + 1);
    await before.$disconnect();

    const after = connectTestDatabase();
    try {
      expect(await admit(after, campaign.id, { now: minutes(NY_MORNING, 10) })).toMatchObject({
        admitted: 0,
        admittedBefore: 3,
      });
      await applyCampaignAction(after, campaign.id, 'pause');
    } finally {
      await after.$disconnect();
    }

    const again = connectTestDatabase();
    try {
      expect((await again.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
        'PAUSED',
      );
      expect((await admit(again, campaign.id, { now: minutes(NY_MORNING, 90) })).admitted).toBe(0);
      expect(await statusCounts(again, campaign.id)).toEqual({ QUEUED: 3, STAGED: 2 });
    } finally {
      await again.$disconnect();
    }
  });
});

describe('idempotency', () => {
  it('never admits the same membership twice', async () => {
    const campaign = await createCampaignWith(db);
    const [member] = await stageMembers(db, campaign.id, [{}]);
    const id = member?.id ?? '';

    expect((await admit(db, campaign.id)).admitted).toBe(1);
    expect((await admit(db, campaign.id)).admitted).toBe(0);

    await expect(
      transitionCampaignLead(db, { campaignLeadId: id, from: 'STAGED', to: 'QUEUED' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      db.dispatchAdmission.create({
        data: {
          campaignId: campaign.id,
          campaignLeadId: id,
          admittedAt: NY_MORNING,
          timezone: 'America/New_York',
          timezoneSource: 'CAMPAIGN',
          localTime: '10:00',
          sendWindowStart: '09:00',
          sendWindowEnd: '18:00',
          hourlyLimit: 100,
          priorAdmissionsInHour: 1,
        },
      }),
    ).rejects.toSatisfy((err: unknown) => hasPrismaCode(err, 'P2002'));
  });

  it('treats a retried run (same job) as a no-op for already admitted members', async () => {
    const campaign = await createCampaignWith(db, { hourlyDispatchLimit: 2 });
    await stageMembers(db, campaign.id, [{}, {}, {}]);

    const first = await admit(db, campaign.id, { jobId: 'job-retry' });
    const retry = await admit(db, campaign.id, { jobId: 'job-retry' });
    expect([first.admitted, retry.admitted]).toEqual([2, 0]);
    expect(await statusCounts(db, campaign.id)).toEqual({ QUEUED: 2, STAGED: 1 });
  });

  it('admission stops at QUEUED; nothing becomes STEP_1_SENT', async () => {
    const campaign = await createCampaignWith(db, { hourlyDispatchLimit: 5 });
    await stageMembers(
      db,
      campaign.id,
      Array.from({ length: 8 }, () => ({})),
    );
    for (let i = 0; i < 4; i++) await admit(db, campaign.id, { now: minutes(NY_MORNING, i * 61) });

    expect(await statusCounts(db, campaign.id)).toEqual({ QUEUED: 8 });
    expect(
      await db.campaignLead.count({ where: { status: { in: ['STEP_1_SENT', 'STEP_2_SENT'] } } }),
    ).toBe(0);
  });
});

describe('database invariants', () => {
  it('rejects admission records over the recorded limit or outside the recorded window', async () => {
    const campaign = await createCampaignWith(db);
    const [m1, m2] = await stageMembers(db, campaign.id, [{}, {}]);
    const base = {
      campaignId: campaign.id,
      admittedAt: NY_MORNING,
      timezone: 'America/New_York',
      timezoneSource: 'CAMPAIGN' as const,
      sendWindowStart: '09:00',
      sendWindowEnd: '18:00',
      hourlyLimit: 2,
    };
    await expect(
      db.dispatchAdmission.create({
        data: {
          ...base,
          campaignLeadId: m1?.id ?? '',
          localTime: '10:00',
          priorAdmissionsInHour: 2,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.dispatchAdmission.create({
        data: {
          ...base,
          campaignLeadId: m2?.id ?? '',
          localTime: '18:00',
          priorAdmissionsInHour: 0,
        },
      }),
    ).rejects.toThrow();
  });
});
