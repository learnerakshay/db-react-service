import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { applyCampaignAction } from '../../src/modules/campaigns/lifecycle.js';
import { transitionCampaignLead } from '../../src/modules/campaigns/membership.js';
import {
  findStep1SendCandidates,
  markInterruptedSends,
  sendStep1Message,
  step1SendKey,
} from '../../src/modules/messaging/outbound.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { NY_EARLY, NY_MORNING } from '../helpers/dispatch.js';
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

async function oneQueued(options: Parameters<typeof createMessagingCampaign>[1] = {}) {
  const campaign = await createMessagingCampaign(db, options);
  const [member] = await queuedMembers(db, campaign.id, [{ email: 'lead@example.com' }]);
  if (member === undefined) throw new Error('no member');
  const lead = await db.lead.findUniqueOrThrow({ where: { id: member.leadId } });
  return { campaign, member, lead };
}

const membershipStatus = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const step1 = (campaignLeadId: string) =>
  db.message.findUnique({ where: { sendKey: step1SendKey(campaignLeadId) } });

describe('Step 1 send', () => {
  it('sends one rendered message and marks STEP_1_SENT only after provider acceptance', async () => {
    const { member, lead } = await oneQueued();
    await db.lead.update({ where: { id: lead.id }, data: { firstName: 'Jane' } });
    const provider = new FakeMessagingProvider();

    const result = await sendStep1Message(
      outboundDeps(db, provider, { statusCallbackUrl: 'https://api.example.com/status' }),
      member.id,
      NY_MORNING,
    );

    expect(result.outcome).toBe('ACCEPTED');
    expect(provider.calls).toEqual([
      {
        to: lead.phone,
        from: OUR_NUMBER,
        body: 'Hey Jane, are you still looking to get your gutters cleaned?',
        statusCallbackUrl: 'https://api.example.com/status',
      },
    ]);
    const message = await step1(member.id);
    expect(message).toMatchObject({
      id: result.messageId,
      direction: 'OUTBOUND',
      channel: 'SMS',
      purpose: 'CAMPAIGN_STEP_1',
      status: 'ACCEPTED',
      provider: 'fake',
      leadId: lead.id,
      campaignLeadId: member.id,
      fromNumber: OUR_NUMBER,
      toNumber: lead.phone,
      body: 'Hey Jane, are you still looking to get your gutters cleaned?',
    });
    expect(message?.providerMessageId).toMatch(/^SM[0-9a-f]{32}$/);
    expect(message?.acceptedAt).not.toBeNull();
    expect(await membershipStatus(member.id)).toBe('STEP_1_SENT');
  });

  it('uses the configured fallback when the lead has no first name', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider();
    await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING);
    expect(provider.calls[0]?.body).toBe(
      'Hey there, are you still looking to get your gutters cleaned?',
    );
  });

  it('does not mark a rejected send as sent and never retries it', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider().script({
      outcome: 'REJECTED',
      retryable: false,
      recipientOptedOut: false,
      errorCode: '21211',
    });
    const deps = outboundDeps(db, provider);

    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('REJECTED');
    expect(await step1(member.id)).toMatchObject({
      status: 'FAILED',
      errorCode: '21211',
      providerMessageId: null,
    });
    // Phase 2 / Prompt 2: permanent failures no longer leave the member QUEUED.
    expect(await membershipStatus(member.id)).toBe('DORMANT_ARCHIVED');

    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('ALREADY_HANDLED');
    expect(provider.calls).toHaveLength(1);
  });

  it('keeps a retryable rejection PENDING and completes the same logical send later', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider().script({
      outcome: 'REJECTED',
      retryable: true,
      recipientOptedOut: false,
      errorCode: '20429',
    });
    const deps = outboundDeps(db, provider);

    const first = await sendStep1Message(deps, member.id, NY_MORNING);
    expect(first.outcome).toBe('RETRY_LATER');
    expect(await step1(member.id)).toMatchObject({ status: 'PENDING', errorCode: '20429' });
    expect(await findStep1SendCandidates(db, NY_MORNING, 10)).toEqual([member.id]);

    const second = await sendStep1Message(deps, member.id, NY_MORNING);
    expect(second).toEqual({ outcome: 'ACCEPTED', messageId: first.messageId });
    expect(provider.calls).toHaveLength(2);
    expect(await db.message.count()).toBe(1);
    expect(await membershipStatus(member.id)).toBe('STEP_1_SENT');
  });

  it('turns a provider-side opt-out into global suppression', async () => {
    const { member, lead } = await oneQueued();
    const provider = new FakeMessagingProvider().script({
      outcome: 'REJECTED',
      retryable: false,
      recipientOptedOut: true,
      errorCode: '21610',
    });
    await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING);

    expect(await db.suppressionEntry.findMany({ where: { phone: lead.phone } })).toMatchObject([
      { reason: 'OPT_OUT', source: 'PROVIDER' },
    ]);
    expect(await membershipStatus(member.id)).toBe('OPTED_OUT');
  });

  it('never resends when the provider outcome is uncertain', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider().script({
      outcome: 'UNCERTAIN',
      errorCode: 'ECONNABORTED',
    });
    const deps = outboundDeps(db, provider);

    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('UNCERTAIN');
    expect(await step1(member.id)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'ECONNABORTED',
    });
    expect(await membershipStatus(member.id)).toBe('QUEUED');

    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('ALREADY_HANDLED');
    expect(await findStep1SendCandidates(db, NY_MORNING, 10)).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  it('records an adapter exception as uncertain', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider().script(() =>
      Promise.reject(new Error('socket hang up')),
    );
    expect(
      (await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING)).outcome,
    ).toBe('UNCERTAIN');
    expect((await step1(member.id))?.errorCode).toBe('ADAPTER_ERROR');
  });
});

describe('Step 1 idempotency', () => {
  it('sends once when the same job runs repeatedly', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider();
    const deps = outboundDeps(db, provider);
    const outcomes = [];
    for (let i = 0; i < 3; i++)
      outcomes.push((await sendStep1Message(deps, member.id, NY_MORNING)).outcome);
    expect(outcomes).toEqual(['ACCEPTED', 'ALREADY_HANDLED', 'ALREADY_HANDLED']);
    expect(provider.calls).toHaveLength(1);
  });

  it('sends once when concurrent workers race for the same membership', async () => {
    const { member } = await oneQueued();
    const provider = new FakeMessagingProvider();
    provider.delayMs = 300;

    const workers = Array.from({ length: 3 }, () => connectTestDatabase());
    try {
      for (const worker of workers) {
        await Promise.all([1, 2, 3].map(() => worker.$queryRaw`SELECT 1`));
      }
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          sendStep1Message(
            outboundDeps(workers[i % workers.length] as Database, provider),
            member.id,
            NY_MORNING,
          ),
        ),
      );
      expect(results.filter((r) => r.outcome === 'ACCEPTED')).toHaveLength(1);
      expect(
        results.every((r) => ['ACCEPTED', 'IN_FLIGHT', 'ALREADY_HANDLED'].includes(r.outcome)),
      ).toBe(true);
    } finally {
      await Promise.all(workers.map((worker) => worker.$disconnect()));
    }
    expect(provider.calls).toHaveLength(1);
    expect(await db.message.count()).toBe(1);
    expect(await membershipStatus(member.id)).toBe('STEP_1_SENT');
  });

  it('does not resend after a restart or an interrupted send', async () => {
    const { member, lead, campaign } = await oneQueued();
    const provider = new FakeMessagingProvider();

    // A claimed send that never recorded an outcome (process died mid-call).
    await db.message.create({
      data: {
        direction: 'OUTBOUND',
        purpose: 'CAMPAIGN_STEP_1',
        status: 'SENDING',
        provider: 'fake',
        leadId: lead.id,
        campaignId: campaign.id,
        campaignLeadId: member.id,
        fromNumber: OUR_NUMBER,
        toNumber: lead.phone,
        body: 'Hey there',
        sendKey: step1SendKey(member.id),
        sendingStartedAt: new Date(NY_MORNING.getTime() - 60_000),
      },
    });

    const restarted = connectTestDatabase();
    try {
      expect(
        (await sendStep1Message(outboundDeps(restarted, provider), member.id, NY_MORNING)).outcome,
      ).toBe('IN_FLIGHT');
      const later = new Date(NY_MORNING.getTime() + 20 * 60_000);
      expect(
        (await sendStep1Message(outboundDeps(restarted, provider), member.id, later)).outcome,
      ).toBe('UNCERTAIN');
      expect(
        (await sendStep1Message(outboundDeps(restarted, provider), member.id, later)).outcome,
      ).toBe('ALREADY_HANDLED');
    } finally {
      await restarted.$disconnect();
    }
    expect(provider.calls).toHaveLength(0);
    expect(await step1(member.id)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'SENDING_INTERRUPTED',
    });
  });

  it('sweeps stale SENDING messages to UNCERTAIN', async () => {
    const { member, lead, campaign } = await oneQueued();
    await db.message.create({
      data: {
        direction: 'OUTBOUND',
        purpose: 'CAMPAIGN_STEP_1',
        status: 'SENDING',
        provider: 'fake',
        leadId: lead.id,
        campaignId: campaign.id,
        campaignLeadId: member.id,
        fromNumber: OUR_NUMBER,
        toNumber: lead.phone,
        body: 'Hey there',
        sendKey: step1SendKey(member.id),
        sendingStartedAt: NY_MORNING,
      },
    });
    expect(
      await markInterruptedSends(db, new Date(NY_MORNING.getTime() + 5 * 60_000), 10 * 60_000),
    ).toBe(0);
    expect(
      await markInterruptedSends(db, new Date(NY_MORNING.getTime() + 11 * 60_000), 10 * 60_000),
    ).toBe(1);
  });
});

describe('final safety checks before the provider call', () => {
  it('cancels a send when the phone was suppressed after queue admission', async () => {
    const { member, lead } = await oneQueued();
    await addSuppression(db, { phone: lead.phone, reason: 'OPT_OUT', source: 'OPERATOR' });
    const provider = new FakeMessagingProvider();

    expect(
      (await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING)).outcome,
    ).toBe('CANCELLED_SUPPRESSED');
    expect(provider.calls).toHaveLength(0);
    expect(await step1(member.id)).toMatchObject({
      status: 'CANCELLED',
      errorCode: 'SUPPRESSED',
      body: null,
    });
    expect(await membershipStatus(member.id)).toBe('OPTED_OUT');
  });

  it('cancels a send when the email was suppressed after queue admission', async () => {
    const { member } = await oneQueued();
    await addSuppression(db, {
      email: 'lead@example.com',
      reason: 'DO_NOT_CONTACT',
      source: 'OPERATOR',
    });
    const provider = new FakeMessagingProvider();
    expect(
      (await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING)).outcome,
    ).toBe('CANCELLED_SUPPRESSED');
    expect(provider.calls).toHaveLength(0);
  });

  it('does not send for paused or completed campaigns, and resumes cleanly', async () => {
    const { campaign, member } = await oneQueued();
    const provider = new FakeMessagingProvider();
    const deps = outboundDeps(db, provider);

    await applyCampaignAction(db, campaign.id, 'pause');
    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe(
      'SKIPPED_CAMPAIGN_NOT_ACTIVE',
    );
    expect(await step1(member.id)).toBeNull();
    expect(await membershipStatus(member.id)).toBe('QUEUED');

    await applyCampaignAction(db, campaign.id, 'resume');
    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('ACCEPTED');

    const other = await oneQueued({ name: 'completed' });
    await applyCampaignAction(db, other.campaign.id, 'complete');
    expect((await sendStep1Message(deps, other.member.id, NY_MORNING)).outcome).toBe(
      'SKIPPED_CAMPAIGN_NOT_ACTIVE',
    );
    expect(provider.calls).toHaveLength(1);
  });

  it('does not send outside the recipient send window or without a template', async () => {
    const provider = new FakeMessagingProvider();
    const windowed = await oneQueued();
    expect(
      (await sendStep1Message(outboundDeps(db, provider), windowed.member.id, NY_EARLY)).outcome,
    ).toBe('SKIPPED_OUTSIDE_WINDOW');

    const untemplated = await oneQueued({ withTemplate: false, name: 'no template' });
    expect(
      (await sendStep1Message(outboundDeps(db, provider), untemplated.member.id, NY_MORNING))
        .outcome,
    ).toBe('SKIPPED_NO_TEMPLATE');
    expect(provider.calls).toHaveLength(0);
  });

  it('does not send to a membership that is no longer QUEUED', async () => {
    const { member } = await oneQueued();
    await transitionCampaignLead(db, {
      campaignLeadId: member.id,
      from: 'QUEUED',
      to: 'OPTED_OUT',
    });
    const provider = new FakeMessagingProvider();
    expect(
      (await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING)).outcome,
    ).toBe('SKIPPED_NOT_QUEUED');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('dispatch candidates', () => {
  it('selects only QUEUED members that still need a first attempt', async () => {
    const provider = new FakeMessagingProvider();
    const campaign = await createMessagingCampaign(db);
    const [fresh, retrying, accepted, uncertain] = await queuedMembers(db, campaign.id, [
      {},
      {},
      {},
      {},
    ]);
    if (!fresh || !retrying || !accepted || !uncertain) throw new Error('members missing');

    provider.script(
      { outcome: 'REJECTED', retryable: true, recipientOptedOut: false, errorCode: '20429' },
      {
        outcome: 'ACCEPTED',
        providerMessageId: 'SM00000000000000000000000000000002',
        providerStatus: 'queued',
      },
      { outcome: 'UNCERTAIN', errorCode: 'ECONNABORTED' },
    );
    for (const member of [retrying, accepted, uncertain]) {
      await sendStep1Message(outboundDeps(db, provider), member.id, NY_MORNING);
    }

    const paused = await createMessagingCampaign(db, { name: 'paused' });
    await queuedMembers(db, paused.id, [{}]);
    await applyCampaignAction(db, paused.id, 'pause');
    const untemplated = await createMessagingCampaign(db, {
      withTemplate: false,
      name: 'no template',
    });
    await queuedMembers(db, untemplated.id, [{}]);

    const candidates = await findStep1SendCandidates(db, NY_MORNING, 50);
    expect(candidates.sort()).toEqual([fresh.id, retrying.id].sort());
    expect(await findStep1SendCandidates(db, NY_EARLY, 50)).toEqual([]);
  });
});
