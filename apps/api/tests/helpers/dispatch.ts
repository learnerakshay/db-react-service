import type { Database } from '../../src/db/client.js';
import type { CampaignStatus } from '../../src/generated/prisma/enums.js';
import {
  admitEligibleMembers,
  type AdmissionOptions,
} from '../../src/modules/dispatch/admission.js';

export const ADMISSION_OPTIONS = { scanLimit: 500, pageSize: 50, transactionTimeoutMs: 30_000 };

/** 10:00 in New York, 07:00 in Los Angeles (EDT/PDT). */
export const NY_MORNING = new Date('2026-07-15T14:00:00Z');
/** 08:00 in New York: before a 09:00 window opens. */
export const NY_EARLY = new Date('2026-07-15T12:00:00Z');
/** 10:00 in Los Angeles, 13:00 in New York. */
export const LA_MORNING = new Date('2026-07-15T17:00:00Z');

export interface CampaignOptions {
  status?: CampaignStatus;
  timezone?: string | null;
  hourlyDispatchLimit?: number;
  sendWindow?: { start: string; end: string };
  name?: string;
}

export async function createCampaignWith(db: Database, options: CampaignOptions = {}) {
  return db.campaign.create({
    data: {
      name: options.name ?? 'Dispatch test',
      status: options.status ?? 'ACTIVE',
      config: {
        timezone: options.timezone === undefined ? 'America/New_York' : options.timezone,
        sendWindow: options.sendWindow ?? { start: '09:00', end: '18:00' },
        hourlyDispatchLimit: options.hourlyDispatchLimit ?? 100,
        followUpDelayHours: 48,
        archiveDelayDays: 14,
      },
    },
  });
}

let phoneSequence = 0;

export interface MemberSpec {
  timezone?: string | null;
  email?: string;
  phone?: string;
}

/** Create leads and STAGED memberships with strictly increasing createdAt. */
export async function stageMembers(db: Database, campaignId: string, specs: readonly MemberSpec[]) {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const members = [];
  for (const spec of specs) {
    phoneSequence++;
    const phone = spec.phone ?? `+1650555${String(phoneSequence % 10_000).padStart(4, '0')}`;
    const lead = await db.lead.upsert({
      where: { phone },
      update: {},
      create: { phone, source: 'test', timezone: spec.timezone ?? null, email: spec.email ?? null },
    });
    members.push(
      await db.campaignLead.create({
        data: { campaignId, leadId: lead.id, createdAt: new Date(base + phoneSequence * 1000) },
      }),
    );
  }
  return members;
}

export function admit(db: Database, campaignId: string, overrides: Partial<AdmissionOptions> = {}) {
  return admitEligibleMembers(db, campaignId, {
    ...ADMISSION_OPTIONS,
    now: NY_MORNING,
    ...overrides,
  });
}

export async function statusCounts(db: Database, campaignId: string) {
  const rows = await db.campaignLead.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}
