import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { hasPrismaCode } from '../../src/db/errors.js';
import { stageLeadsForCampaign } from '../../src/modules/campaigns/membership.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import {
  connectTestDatabase,
  createTestCampaign,
  importRows,
  resetDatabase,
} from '../helpers/db.js';

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

const JANE = {
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '+14155552671',
  email: 'jane@example.com',
};
const OLIVER = { firstName: 'Oliver', phone: '+447911123456' };

describe('lead ingestion', () => {
  it('records a deterministic outcome for every row with accurate statistics', async () => {
    const result = await importRows(
      db,
      [
        JANE, // 1 CREATED
        OLIVER, // 2 CREATED
        { phone: 'not-a-phone' }, // 3 INVALID
        'malformed', // 4 INVALID
        { phone: '(415) 555-2671' }, // 5 INVALID: no country context
        { phone: '+1 415 555 2671', firstName: 'Janet' }, // 6 DUPLICATE of row 1
        { phone: '+16502530000', email: 'broken@' }, // 7 CREATED, email ignored
        { firstName: 'No phone' }, // 8 INVALID
      ],
      { chunkSize: 3 },
    );

    expect(result.batch.status).toBe('COMPLETED');
    expect(result.batch).toMatchObject({
      totalRows: 8,
      acceptedCount: 3,
      newLeadCount: 3,
      duplicateCount: 1,
      suppressedCount: 0,
      invalidCount: 4,
      failedCount: 0,
    });
    expect(result.rows.map((r) => [r.rowNumber, r.outcome, r.reason])).toEqual([
      [1, 'CREATED', null],
      [2, 'CREATED', null],
      [3, 'INVALID', 'INVALID_PHONE'],
      [4, 'INVALID', 'MALFORMED_ROW'],
      [5, 'INVALID', 'PHONE_COUNTRY_REQUIRED'],
      [6, 'DUPLICATE', 'DUPLICATE_IN_BATCH'],
      [7, 'CREATED', null],
      [8, 'INVALID', 'MISSING_PHONE'],
    ]);
    expect(result.rows[6]?.ignoredFields).toEqual(['email']);

    // Counts always agree with row results and the lead table.
    const b = result.batch;
    expect(
      b.acceptedCount + b.duplicateCount + b.suppressedCount + b.invalidCount + b.failedCount,
    ).toBe(b.totalRows);
    expect(result.rows).toHaveLength(b.totalRows);
    expect(await db.lead.count()).toBe(3);
    expect(result.issues.map((i) => i.rowNumber)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('normalizes national numbers when the import supplies a country', async () => {
    const result = await importRows(db, [{ phone: '(415) 555-2671' }], { defaultCountry: 'US' });
    expect(result.rows[0]?.outcome).toBe('CREATED');
    expect(await db.lead.findUnique({ where: { phone: '+14155552671' } })).not.toBeNull();
  });

  it('never creates two leads for the same phone within one import', async () => {
    const result = await importRows(db, [
      JANE,
      { phone: '+14155552671' },
      { phone: '+1 (415) 555-2671' },
    ]);
    expect(result.rows.map((r) => r.outcome)).toEqual(['CREATED', 'DUPLICATE', 'DUPLICATE']);
    expect(await db.lead.count()).toBe(1);
  });

  it('reuses a lead that already exists instead of recreating it', async () => {
    await importRows(db, [JANE]);
    const second = await importRows(db, [JANE]);

    expect(second.rows[0]?.outcome).toBe('EXISTING');
    expect(second.batch).toMatchObject({ acceptedCount: 1, newLeadCount: 0, duplicateCount: 0 });
    expect(await db.lead.count()).toBe(1);
    const lead = await db.lead.findUniqueOrThrow({ where: { phone: JANE.phone } });
    expect(second.rows[0]?.leadId).toBe(lead.id);
  });

  it('enriches empty fields on an existing lead but never overwrites stored values', async () => {
    await importRows(db, [{ phone: '+14155552671', firstName: 'Jane' }]);
    const original = await db.lead.findUniqueOrThrow({ where: { phone: '+14155552671' } });

    await importRows(db, [
      {
        phone: '+14155552671',
        firstName: 'Janet',
        lastName: 'Doe',
        email: 'jane@example.com',
        source: 'crm-export',
        lastServiceDate: '2022-11-05',
      },
    ]);
    const merged = await db.lead.findUniqueOrThrow({ where: { phone: '+14155552671' } });

    expect(merged.firstName).toBe('Jane');
    expect(merged.lastName).toBe('Doe');
    expect(merged.email).toBe('jane@example.com');
    expect(merged.lastServiceAt?.toISOString()).toBe('2022-11-05T00:00:00.000Z');
    expect(merged.source).toBe(original.source);
    expect(merged.firstImportBatchId).toBe(original.firstImportBatchId);

    await importRows(db, [{ phone: '+14155552671', email: 'other@example.com' }]);
    const unchanged = await db.lead.findUniqueOrThrow({ where: { phone: '+14155552671' } });
    expect(unchanged.email).toBe('jane@example.com');
  });

  it('blocks suppressed phones and emails and creates no lead for them', async () => {
    await addSuppression(db, { phone: '+14155552671', reason: 'OPT_OUT', source: 'OPERATOR' });
    await addSuppression(db, {
      email: 'Blocked@Example.com',
      reason: 'DO_NOT_CONTACT',
      source: 'OPERATOR',
    });

    const result = await importRows(
      db,
      [
        { phone: '(415) 555-2671' },
        { phone: '+447911123456', email: 'blocked@example.com' },
        { phone: '+16502530000' },
      ],
      { defaultCountry: 'US' },
    );

    expect(result.rows.map((r) => [r.outcome, r.reason])).toEqual([
      ['SUPPRESSED', 'SUPPRESSED_PHONE'],
      ['SUPPRESSED', 'SUPPRESSED_EMAIL'],
      ['CREATED', null],
    ]);
    expect(result.batch).toMatchObject({ suppressedCount: 2, acceptedCount: 1 });
    expect(await db.lead.count()).toBe(1);
  });

  it('keeps suppression in force across later imports and every campaign', async () => {
    const campaignA = await createTestCampaign(db, 'A');
    const campaignB = await createTestCampaign(db, 'B');

    const first = await importRows(db, [JANE], { campaignId: campaignA.id });
    expect(first.batch.stagedCount).toBe(1);
    const lead = await db.lead.findUniqueOrThrow({ where: { phone: JANE.phone } });

    await addSuppression(db, { phone: JANE.phone, reason: 'OPT_OUT', source: 'INBOUND_MESSAGE' });

    const intoB = await importRows(db, [JANE], { campaignId: campaignB.id });
    expect(intoB.rows[0]?.outcome).toBe('SUPPRESSED');
    expect(intoB.batch.stagedCount).toBe(0);

    const again = await importRows(db, [JANE], { campaignId: campaignA.id });
    expect(again.rows[0]?.outcome).toBe('SUPPRESSED');

    // Direct staging is refused too.
    expect(
      await stageLeadsForCampaign(db, {
        campaignId: campaignB.id,
        leadIds: [lead.id],
        importBatchId: null,
      }),
    ).toBe(0);
    expect(await db.campaignLead.count({ where: { campaignId: campaignB.id } })).toBe(0);

    // Import never weakens suppression.
    expect(await db.suppressionEntry.count({ where: { phone: JANE.phone } })).toBe(1);
  });

  it('stages accepted leads into a campaign exactly once', async () => {
    const campaign = await createTestCampaign(db);
    const first = await importRows(db, [JANE, OLIVER, { phone: 'bad' }], {
      campaignId: campaign.id,
    });
    expect(first.batch.stagedCount).toBe(2);

    const second = await importRows(db, [JANE, OLIVER], { campaignId: campaign.id });
    expect(second.batch).toMatchObject({ acceptedCount: 2, stagedCount: 0 });

    const members = await db.campaignLead.findMany({ where: { campaignId: campaign.id } });
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.status === 'STAGED')).toBe(true);
  });

  it('keeps leads unique when imports of the same phones run concurrently', async () => {
    const phones = Array.from({ length: 40 }, (_, i) => ({
      phone: `+1650253${String(1000 + i).padStart(4, '0')}`,
    }));
    const reversed = [...phones].reverse();

    const results = await Promise.all([
      importRows(db, phones, { chunkSize: 7 }),
      importRows(db, reversed, { chunkSize: 5 }),
      importRows(db, phones, { chunkSize: 40 }),
    ]);

    expect(await db.lead.count()).toBe(40);
    const created = results.reduce((sum, r) => sum + r.batch.newLeadCount, 0);
    expect(created).toBe(40);
    for (const r of results) {
      expect(r.batch).toMatchObject({
        status: 'COMPLETED',
        totalRows: 40,
        acceptedCount: 40,
        failedCount: 0,
      });
    }
  });

  it('enforces phone uniqueness in the database itself', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        db.lead.create({ data: { phone: '+14155552671', source: 'race' } }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(rejected).toHaveLength(4);
    expect(rejected.every((a) => hasPrismaCode(a.reason, 'P2002'))).toBe(true);
  });
});
