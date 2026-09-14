import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import {
  archivePermanentSendFailures,
  findStep1SendCandidates,
  sendStep1Message,
  step1SendKey,
} from '../../src/modules/messaging/outbound.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { NY_MORNING } from '../helpers/dispatch.js';
import {
  createMessagingCampaign,
  FakeMessagingProvider,
  OUR_NUMBER,
  outboundDeps,
  queuedMembers,
} from '../helpers/messaging.js';

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

const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;

describe('permanent Step 1 failures', () => {
  it('archives the membership after a permanent provider rejection, but not after temporary ones', async () => {
    const campaign = await createMessagingCampaign(db);
    const [permanent, retryable, uncertain] = await queuedMembers(db, campaign.id, [{}, {}, {}]);
    if (!permanent || !retryable || !uncertain) throw new Error('members missing');
    const provider = new FakeMessagingProvider().script(
      { outcome: 'REJECTED', retryable: false, recipientOptedOut: false, errorCode: '21211' },
      { outcome: 'REJECTED', retryable: true, recipientOptedOut: false, errorCode: '20429' },
      { outcome: 'UNCERTAIN', errorCode: 'ECONNABORTED' },
    );
    for (const member of [permanent, retryable, uncertain]) {
      await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING);
    }

    expect(await statusOf(permanent.id)).toBe('DORMANT_ARCHIVED');
    expect(await statusOf(retryable.id)).toBe('QUEUED');
    expect(await statusOf(uncertain.id)).toBe('QUEUED');
    expect(await findStep1SendCandidates(db, NY_MORNING, 10)).toEqual([retryable.id]);
  });

  it('archives the membership when the template can never render within limits', async () => {
    const campaign = await db.campaign.create({
      data: {
        name: 'Oversized template',
        status: 'ACTIVE',
        config: {
          timezone: 'America/New_York',
          sendWindow: { start: '09:00', end: '18:00' },
          hourlyDispatchLimit: 10,
          followUpDelayHours: 48,
          archiveDelayDays: 14,
          messages: {
            step1: {
              body: '{{a}} {{b}} {{c}} {{d}}',
              variables: {
                a: 'a'.repeat(200),
                b: 'b'.repeat(200),
                c: 'c'.repeat(200),
                d: 'd'.repeat(200),
              },
              fallbacks: {},
            },
          },
        },
      },
    });
    const [member] = await queuedMembers(db, campaign.id, [{}]);
    const provider = new FakeMessagingProvider();

    const result = await sendStep1Message(outboundDeps(db, provider), member?.id ?? '', NY_MORNING);
    expect(result.outcome).toBe('CANCELLED_TEMPLATE');
    expect(provider.calls).toHaveLength(0);
    expect(await statusOf(member?.id ?? '')).toBe('DORMANT_ARCHIVED');
  });

  it('sweeps memberships left QUEUED by earlier permanent failures, never temporary ones', async () => {
    const campaign = await createMessagingCampaign(db);
    const members = await queuedMembers(db, campaign.id, [{}, {}, {}, {}]);
    const statuses = ['FAILED', 'CANCELLED', 'UNCERTAIN', 'PENDING'] as const;
    for (const [index, member] of members.entries()) {
      const lead = await db.lead.findUniqueOrThrow({ where: { id: member.leadId } });
      const status = statuses[index] ?? 'PENDING';
      await db.message.create({
        data: {
          direction: 'OUTBOUND',
          purpose: 'CAMPAIGN_STEP_1',
          status,
          provider: 'fake',
          leadId: lead.id,
          campaignId: campaign.id,
          campaignLeadId: member.id,
          fromNumber: OUR_NUMBER,
          toNumber: lead.phone,
          body: status === 'CANCELLED' ? null : 'Hey there',
          sendKey: step1SendKey(member.id),
          errorCode:
            status === 'CANCELLED'
              ? 'TEMPLATE_RENDER_FAILED'
              : status === 'FAILED'
                ? '21211'
                : null,
        },
      });
    }

    expect(await archivePermanentSendFailures(db, NY_MORNING, 50)).toBe(2);
    expect(await Promise.all(members.map((m) => statusOf(m.id)))).toEqual([
      'DORMANT_ARCHIVED',
      'DORMANT_ARCHIVED',
      'QUEUED',
      'QUEUED',
    ]);
    expect(await archivePermanentSendFailures(db, NY_MORNING, 50)).toBe(0);
  });
});
