import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { archiveDueMembers, findArchivableMembers } from '../../src/modules/followup/archival.js';
import {
  findStep2Candidates,
  sendStep2Message,
  step2SendKey,
} from '../../src/modules/followup/step2.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { FakeAiProvider } from '../helpers/ai.js';
import { replyFromLead } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { FakeMessagingProvider, outboundDeps } from '../helpers/messaging.js';
import { receive } from '../helpers/replies.js';
import {
  nyHourAfter,
  step1Member,
  STEP2_TEMPLATE,
  TEST_OPERATIONS,
} from '../helpers/operations.js';

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
const step2Sends = (messaging: FakeMessagingProvider) =>
  messaging.calls.filter((call) => call.body === STEP2_TEMPLATE.body);
const archive = (now: Date) =>
  archiveDueMembers(db, now, TEST_OPERATIONS.tickBatchSize, TEST_OPERATIONS.transactionTimeoutMs);

async function setup(options: Parameters<typeof step1Member>[2] = {}) {
  const messaging = new FakeMessagingProvider();
  const context = await step1Member(db, messaging, options);
  const deps = outboundDeps(db, messaging);
  const due = nyHourAfter(context.step1AcceptedAt, 48);
  return { ...context, messaging, deps, due };
}

describe('step 2 follow-up', () => {
  it('becomes eligible only after the configured delay and records STEP_2_SENT on acceptance', async () => {
    const { member, messaging, deps, step1AcceptedAt, due, lead } = await setup();
    const early = nyHourAfter(step1AcceptedAt, 1);
    expect(early.getTime()).toBeLessThan(due.getTime());

    expect(await findStep2Candidates(db, early, 100)).toEqual([]);
    expect(await sendStep2Message(deps, member.id, early)).toMatchObject({
      outcome: 'SKIPPED_NOT_DUE',
    });
    expect(step2Sends(messaging)).toHaveLength(0);

    expect(await findStep2Candidates(db, due, 100)).toEqual([member.id]);
    const sent = await sendStep2Message(deps, member.id, due);

    expect(sent.outcome).toBe('ACCEPTED');
    expect(await statusOf(member.id)).toBe('STEP_2_SENT');
    expect(
      await db.message.findUniqueOrThrow({ where: { sendKey: step2SendKey(member.id) } }),
    ).toMatchObject({
      purpose: 'CAMPAIGN_STEP_2',
      status: 'ACCEPTED',
      body: STEP2_TEMPLATE.body,
      toNumber: lead.phone,
    });
    expect(step2Sends(messaging)).toHaveLength(1);
    expect(await findStep2Candidates(db, due, 100)).toEqual([]);
  });

  it('uses the campaign delay, not a hardcoded 48 hours', async () => {
    const { member, deps, step1AcceptedAt } = await setup({ followUpDelayHours: 6 });
    const at = nyHourAfter(step1AcceptedAt, 6);
    expect(await findStep2Candidates(db, at, 100)).toEqual([member.id]);
    expect((await sendStep2Message(deps, member.id, at)).outcome).toBe('ACCEPTED');
  });

  it('a reply before the delay prevents step 2, whether engaged or escalated', async () => {
    const ai = new FakeAiProvider();
    const escalated = await setup();
    await replyFromLead(
      db,
      ai,
      escalated.messaging,
      escalated.lead.phone,
      'hmm?',
      'AMBIGUOUS',
      0.2,
    );
    expect(await statusOf(escalated.member.id)).toBe('STEP_1_SENT');
    expect(await findStep2Candidates(db, escalated.due, 100)).toEqual([]);
    expect(
      (await sendStep2Message(escalated.deps, escalated.member.id, escalated.due)).outcome,
    ).toBe('SKIPPED_REPLIED');

    const engaged = await setup();
    await replyFromLead(db, ai, engaged.messaging, engaged.lead.phone, 'yes please');
    expect(await statusOf(engaged.member.id)).toBe('ENGAGED');
    expect(await findStep2Candidates(db, engaged.due, 100)).toEqual([]);
    expect((await sendStep2Message(engaged.deps, engaged.member.id, engaged.due)).outcome).toBe(
      'SKIPPED_NOT_ELIGIBLE',
    );
    expect(step2Sends(escalated.messaging)).toHaveLength(0);
    expect(step2Sends(engaged.messaging)).toHaveLength(0);
  });

  it('never sends step 2 to a suppressed lead', async () => {
    const { member, lead, messaging, deps, due } = await setup();
    await addSuppression(db, { phone: lead.phone, reason: 'DO_NOT_CONTACT', source: 'OPERATOR' });

    expect(await sendStep2Message(deps, member.id, due)).toMatchObject({
      outcome: 'CANCELLED_SUPPRESSED',
    });
    expect(step2Sends(messaging)).toHaveLength(0);
    expect(await statusOf(member.id)).toBe('OPTED_OUT');
    expect(await sendStep2Message(deps, member.id, due)).toMatchObject({
      outcome: 'ALREADY_HANDLED',
    });
  });

  it('waits for the recipient send window', async () => {
    const { member, messaging, deps, step1AcceptedAt } = await setup();
    const night = nyHourAfter(step1AcceptedAt, 49, '23:00', '24:00');

    expect(await findStep2Candidates(db, night, 100)).toEqual([]);
    expect((await sendStep2Message(deps, member.id, night)).outcome).toBe('SKIPPED_OUTSIDE_WINDOW');
    expect(step2Sends(messaging)).toHaveLength(0);

    const morning = nyHourAfter(night, 0);
    expect((await sendStep2Message(deps, member.id, morning)).outcome).toBe('ACCEPTED');
  });

  it('sends once across duplicate jobs and concurrent workers', async () => {
    const first = await setup();
    expect((await sendStep2Message(first.deps, first.member.id, first.due)).outcome).toBe(
      'ACCEPTED',
    );
    expect((await sendStep2Message(first.deps, first.member.id, first.due)).outcome).toBe(
      'ALREADY_HANDLED',
    );
    expect(step2Sends(first.messaging)).toHaveLength(1);

    const second = await setup();
    second.messaging.delayMs = 150;
    const outcomes = await Promise.all([
      sendStep2Message(second.deps, second.member.id, second.due),
      sendStep2Message(second.deps, second.member.id, second.due),
      sendStep2Message(second.deps, second.member.id, second.due),
    ]);
    const results = outcomes.map((o) => o.outcome);
    expect(results.filter((o) => o === 'ACCEPTED')).toHaveLength(1);
    // Losers see the claim in flight, or the recorded send if they locked after it finished.
    expect(
      results
        .filter((o) => o !== 'ACCEPTED')
        .every((o) => o === 'IN_FLIGHT' || o === 'ALREADY_HANDLED'),
    ).toBe(true);
    expect(step2Sends(second.messaging)).toHaveLength(1);
    expect(
      await db.message.count({
        where: { purpose: 'CAMPAIGN_STEP_2', campaignLeadId: second.member.id },
      }),
    ).toBe(1);
  });

  it('never resends an UNCERTAIN step 2 and closes it out after the archive delay', async () => {
    const { member, messaging, deps, due } = await setup();
    messaging.script({ outcome: 'UNCERTAIN', errorCode: 'TIMEOUT' });

    expect((await sendStep2Message(deps, member.id, due)).outcome).toBe('UNCERTAIN');
    expect((await sendStep2Message(deps, member.id, due)).outcome).toBe('ALREADY_HANDLED');
    expect(await findStep2Candidates(db, due, 100)).toEqual([]);
    expect(step2Sends(messaging)).toHaveLength(1);
    expect(await statusOf(member.id)).toBe('STEP_1_SENT');

    const step2 = await db.message.findUniqueOrThrow({
      where: { sendKey: step2SendKey(member.id) },
    });
    const later = new Date((step2.sendingStartedAt ?? due).getTime() + 3 * 24 * 3_600_000);
    expect(await archive(later)).toBe(1);
    expect(await statusOf(member.id)).toBe('DORMANT_ARCHIVED');
  });

  it('terminates a permanent step 2 failure instead of looping', async () => {
    const { member, messaging, deps, due } = await setup();
    messaging.script({
      outcome: 'REJECTED',
      retryable: false,
      recipientOptedOut: false,
      errorCode: '21211',
    });

    expect((await sendStep2Message(deps, member.id, due)).outcome).toBe('REJECTED');
    expect(await statusOf(member.id)).toBe('DORMANT_ARCHIVED');
    expect(await findStep2Candidates(db, due, 100)).toEqual([]);
  });

  it('skips campaigns without a step 2 template', async () => {
    const { member, deps, due } = await setup({ withStep2: false });
    expect(await findStep2Candidates(db, due, 100)).toEqual([]);
    expect((await sendStep2Message(deps, member.id, due)).outcome).toBe('SKIPPED_NO_TEMPLATE');
  });
});

describe('final archival', () => {
  async function sentStep2() {
    const context = await setup();
    await sendStep2Message(context.deps, context.member.id, context.due);
    // `due` is days in the future; inbound test messages get wall-clock timestamps.
    // Move the closeout to just before now so "reply after step 2" is real ordering.
    const sentAt = new Date(Date.now() - 1_000);
    await db.message.update({
      where: { sendKey: step2SendKey(context.member.id) },
      data: { sendingStartedAt: sentAt, acceptedAt: sentAt },
    });
    return { ...context, archiveAt: new Date(sentAt.getTime() + 3 * 24 * 3_600_000) };
  }

  it('archives only after the configured delay without a reply, keeping all history', async () => {
    const { member, lead, archiveAt } = await sentStep2();
    const messagesBefore = await db.message.count({ where: { leadId: lead.id } });

    expect(await archive(new Date(archiveAt.getTime() - 60_000))).toBe(0);
    expect(await statusOf(member.id)).toBe('STEP_2_SENT');

    expect(await archive(archiveAt)).toBe(1);
    expect(await archive(archiveAt)).toBe(0);
    expect(await statusOf(member.id)).toBe('DORMANT_ARCHIVED');
    expect(await db.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    expect(await db.message.count({ where: { leadId: lead.id } })).toBe(messagesBefore);
    expect(
      (
        await db.message.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: 'asc' } })
      ).map((m) => m.purpose),
    ).toEqual(['CAMPAIGN_STEP_1', 'CAMPAIGN_STEP_2']);
  });

  it('a reply after step 2 prevents archival and reopens the conversation', async () => {
    const { member, lead, messaging, archiveAt } = await sentStep2();
    await receive(db, lead.phone, 'wait, actually yes');
    expect(await findArchivableMembers(db, archiveAt, 100)).toEqual([]);
    expect(await archive(archiveAt)).toBe(0);

    const ai = new FakeAiProvider();
    await replyFromLead(db, ai, messaging, lead.phone, 'still interested!');
    expect(await statusOf(member.id)).toBe('ENGAGED');
    expect(await archive(archiveAt)).toBe(0);
  });

  it('concurrent archival passes archive once', async () => {
    const { member, archiveAt } = await sentStep2();
    const counts = await Promise.all([archive(archiveAt), archive(archiveAt), archive(archiveAt)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await statusOf(member.id)).toBe('DORMANT_ARCHIVED');
  });
});
