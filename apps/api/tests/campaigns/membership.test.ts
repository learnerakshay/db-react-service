import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { hasPrismaCode } from '../../src/db/errors.js';
import { ConflictError, ValidationError } from '../../src/lib/errors.js';
import { transitionCampaignLead } from '../../src/modules/campaigns/membership.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { connectTestDatabase, createTestCampaign, resetDatabase } from '../helpers/db.js';

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

async function member() {
  const campaign = await createTestCampaign(db);
  const lead = await db.lead.create({ data: { phone: '+14155552671', source: 'test' } });
  const membership = await db.campaignLead.create({
    data: { campaignId: campaign.id, leadId: lead.id },
  });
  return { campaign, lead, membership };
}

describe('campaign membership', () => {
  it('rejects enrolling the same lead twice in one campaign', async () => {
    const { campaign, lead } = await member();
    const duplicate = db.campaignLead.create({
      data: { campaignId: campaign.id, leadId: lead.id },
    });
    await expect(duplicate).rejects.toSatisfy((err: unknown) => hasPrismaCode(err, 'P2002'));
  });

  it('allows the same lead in different campaigns', async () => {
    const { lead } = await member();
    const other = await createTestCampaign(db, 'Other');
    await expect(
      db.campaignLead.create({ data: { campaignId: other.id, leadId: lead.id } }),
    ).resolves.toBeDefined();
  });

  it('applies legal transitions', async () => {
    const { membership } = await member();
    await transitionCampaignLead(db, {
      campaignLeadId: membership.id,
      from: 'STAGED',
      to: 'QUEUED',
    });
    const updated = await db.campaignLead.findUniqueOrThrow({ where: { id: membership.id } });
    expect(updated.status).toBe('QUEUED');
  });

  it('rejects illegal transitions without writing', async () => {
    const { membership } = await member();
    await expect(
      transitionCampaignLead(db, { campaignLeadId: membership.id, from: 'STAGED', to: 'BOOKED' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await db.campaignLead.findUniqueOrThrow({ where: { id: membership.id } })).status).toBe(
      'STAGED',
    );
  });

  it('rejects a transition from a stale expected state', async () => {
    const { membership } = await member();
    await transitionCampaignLead(db, {
      campaignLeadId: membership.id,
      from: 'STAGED',
      to: 'QUEUED',
    });
    await expect(
      transitionCampaignLead(db, { campaignLeadId: membership.id, from: 'STAGED', to: 'QUEUED' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('suppression entries', () => {
  it('normalizes identities before storing', async () => {
    const entry = await addSuppression(db, {
      phone: '(415) 555-2671',
      defaultCountry: 'US',
      email: ' JANE@Example.com ',
      reason: 'OPT_OUT',
      source: 'OPERATOR',
    });
    expect(entry).toMatchObject({ phone: '+14155552671', email: 'jane@example.com' });
  });

  it('requires a valid phone or email', async () => {
    await expect(
      addSuppression(db, { reason: 'OPT_OUT', source: 'OPERATOR' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addSuppression(db, { phone: '123', reason: 'OPT_OUT', source: 'OPERATOR' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('cannot be updated or deleted', async () => {
    const entry = await addSuppression(db, {
      phone: '+14155552671',
      reason: 'OPT_OUT',
      source: 'OPERATOR',
    });
    await expect(
      db.suppressionEntry.update({ where: { id: entry.id }, data: { note: 'lifted' } }),
    ).rejects.toThrow();
    await expect(db.suppressionEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
    expect(await db.suppressionEntry.count()).toBe(1);
  });
});

describe('database invariants', () => {
  it('rejects non-E.164 phones and non-lowercase emails', async () => {
    await expect(db.lead.create({ data: { phone: '4155552671', source: 'x' } })).rejects.toThrow();
    await expect(
      db.lead.create({ data: { phone: '+14155552671', email: 'Jane@Example.com', source: 'x' } }),
    ).rejects.toThrow();
  });

  it('rejects suppression entries without any identity', async () => {
    await expect(
      db.suppressionEntry.create({ data: { reason: 'OPT_OUT', source: 'OPERATOR' } }),
    ).rejects.toThrow();
  });

  it('rejects import counters that do not add up', async () => {
    const batch = await db.importBatch.create({
      data: { sourceType: 'CSV', sourceLabel: 'x', contentHash: 'a'.repeat(64) },
    });
    await expect(
      db.importBatch.update({ where: { id: batch.id }, data: { totalRows: 5 } }),
    ).rejects.toThrow();
  });

  it('allows only one PROCESSING batch per content hash', async () => {
    const data = { sourceType: 'CSV' as const, sourceLabel: 'x', contentHash: 'b'.repeat(64) };
    const first = await db.importBatch.create({ data });
    await expect(db.importBatch.create({ data })).rejects.toSatisfy((err: unknown) =>
      hasPrismaCode(err, 'P2002'),
    );
    await db.importBatch.update({ where: { id: first.id }, data: { status: 'COMPLETED' } });
    await expect(db.importBatch.create({ data })).resolves.toBeDefined();
  });
});
