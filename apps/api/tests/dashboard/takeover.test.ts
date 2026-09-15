import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { processQualification } from '../../src/modules/conversion/qualification.js';
import { sendConversionMessage } from '../../src/modules/conversion/sender.js';
import { archiveDueMembers, findArchivableMembers } from '../../src/modules/followup/archival.js';
import {
  findStep2Candidates,
  sendStep2Message,
  step2SendKey,
} from '../../src/modules/followup/step2.js';
import { setHumanTakeover } from '../../src/modules/leads/takeover.js';
import { findStep1SendCandidates, sendStep1Message } from '../../src/modules/messaging/outbound.js';
import { sendConversationalReply } from '../../src/modules/replies/reply-sender.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { FakeAiProvider } from '../helpers/ai.js';
import { conversionDeps, engagedMember, extracted, replyFromLead } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { NY_MORNING } from '../helpers/dispatch.js';
import {
  createMessagingCampaign,
  FakeMessagingProvider,
  outboundDeps,
  queuedMembers,
} from '../helpers/messaging.js';
import { nyHourAfter, step1Member, TEST_OPERATIONS } from '../helpers/operations.js';
import { contactedLead, receive } from '../helpers/replies.js';

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

const DAY_MS = 86_400_000;
const RETRYABLE_REJECTION = {
  outcome: 'REJECTED',
  retryable: true,
  recipientOptedOut: false,
  errorCode: '30001',
} as const;

const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const pause = (leadId: string, at = new Date()) => setHumanTakeover(db, leadId, true, at);
const resume = (leadId: string, at = new Date()) => setHumanTakeover(db, leadId, false, at);

async function queuedMember() {
  const messaging = new FakeMessagingProvider();
  const campaign = await createMessagingCampaign(db);
  const [member] = await queuedMembers(db, campaign.id, [{}]);
  if (member === undefined) throw new Error('no member');
  const lead = await db.lead.findUniqueOrThrow({ where: { id: member.leadId } });
  return { messaging, member, lead, deps: outboundDeps(db, messaging) };
}

describe('human takeover is enforced server-side', () => {
  it('holds Step 1 while paused and sends it after automation resumes', async () => {
    const { messaging, member, deps } = await queuedMember();
    await pause(member.leadId, NY_MORNING);

    expect(await findStep1SendCandidates(db, NY_MORNING, 100)).toEqual([]);
    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe(
      'SKIPPED_HUMAN_TAKEOVER',
    );
    expect(messaging.calls).toHaveLength(0);
    expect(await statusOf(member.id)).toBe('QUEUED');

    await resume(member.leadId, NY_MORNING);
    expect(await findStep1SendCandidates(db, NY_MORNING, 100)).toEqual([member.id]);
    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('ACCEPTED');
    expect(await statusOf(member.id)).toBe('STEP_1_SENT');
  });

  it('keeps suppression stronger than takeover, before and after resuming', async () => {
    const { messaging, member, lead, deps } = await queuedMember();
    await pause(lead.id, NY_MORNING);
    await addSuppression(db, { phone: lead.phone, reason: 'DO_NOT_CONTACT', source: 'OPERATOR' });

    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe(
      'CANCELLED_SUPPRESSED',
    );
    expect(await statusOf(member.id)).toBe('OPTED_OUT');

    await resume(lead.id, NY_MORNING);
    expect((await sendStep1Message(deps, member.id, NY_MORNING)).outcome).toBe('ALREADY_HANDLED');
    expect(messaging.calls).toHaveLength(0);
    expect(await statusOf(member.id)).toBe('OPTED_OUT');
  });

  it('escalates inbound replies to the human instead of answering automatically', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const { lead, member } = await contactedLead(db, messaging);
    await pause(lead.id);
    const sendsBefore = messaging.calls.length;

    const inboundId = await replyFromLead(db, ai, messaging, lead.phone, 'Yes please, call me!');

    expect(
      await db.replyProcessing.findUniqueOrThrow({ where: { inboundMessageId: inboundId } }),
    ).toMatchObject({
      status: 'ESCALATED',
      action: 'HUMAN_REVIEW',
      escalationReason: 'HUMAN_TAKEOVER',
      classification: 'POSITIVE_INTEREST',
      replyMessageId: null,
    });
    expect(messaging.calls).toHaveLength(sendsBefore);
    expect(await statusOf(member.id)).toBe('STEP_1_SENT');
  });

  it('still applies exact and classified opt-outs while paused', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const exact = await contactedLead(db, messaging, { name: 'Exact', phone: '+14155550171' });
    const semantic = await contactedLead(db, messaging, { name: 'AI', phone: '+14155550172' });
    await pause(exact.lead.id);
    await pause(semantic.lead.id);

    await receive(db, exact.lead.phone, 'STOP');
    await replyFromLead(
      db,
      ai,
      messaging,
      semantic.lead.phone,
      'please never text me again',
      'HARD_OPT_OUT',
      0.95,
    );

    for (const { member, lead } of [exact, semantic]) {
      expect(await statusOf(member.id)).toBe('OPTED_OUT');
      expect(await db.suppressionEntry.count({ where: { phone: lead.phone } })).toBe(1);
    }
  });

  it('cancels persisted automated replies and conversion messages instead of sending them later', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const context = await engagedMember(db, ai, messaging);

    // A reply left PENDING by a retryable provider rejection.
    messaging.script(RETRYABLE_REJECTION);
    const inbound = await replyFromLead(
      db,
      ai,
      messaging,
      context.lead.phone,
      'I need gutter cleaning',
    );
    const processing = await db.replyProcessing.findUniqueOrThrow({
      where: { inboundMessageId: inbound },
    });
    if (processing.replyMessageId === null) throw new Error('no reply persisted');
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: processing.replyMessageId } })).status,
    ).toBe('PENDING');

    // A qualification question left PENDING the same way.
    messaging.script(RETRYABLE_REJECTION);
    ai.script(
      'qualification_extraction',
      extracted({ serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' } }),
    );
    const run = await processQualification(conversionDeps(db, ai, messaging), inbound);
    expect(run).toMatchObject({ outcome: 'EVALUATED', result: 'PENDING_INFORMATION' });
    const question = await db.message.findFirstOrThrow({
      where: { campaignLeadId: context.member.id, purpose: 'QUALIFICATION_QUESTION' },
    });
    expect(question.status).toBe('PENDING');

    await pause(context.lead.id);
    const sendsBefore = messaging.calls.length;
    const deps = outboundDeps(db, messaging);
    expect(await sendConversationalReply(deps, processing.replyMessageId)).toEqual({
      outcome: 'CANCELLED',
    });
    expect(await sendConversionMessage(deps, question.id)).toEqual({ outcome: 'CANCELLED' });
    expect(messaging.calls).toHaveLength(sendsBefore);
    expect(
      await db.message.findMany({
        where: { id: { in: [processing.replyMessageId, question.id] } },
        select: { status: true, errorCode: true },
      }),
    ).toEqual([
      { status: 'CANCELLED', errorCode: 'HUMAN_TAKEOVER' },
      { status: 'CANCELLED', errorCode: 'HUMAN_TAKEOVER' },
    ]);
  });

  it('does not evaluate qualification while paused', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const context = await engagedMember(db, ai, messaging);
    const inbound = await replyFromLead(
      db,
      ai,
      messaging,
      context.lead.phone,
      'gutter cleaning, $900',
    );
    await pause(context.lead.id);

    expect(await processQualification(conversionDeps(db, ai, messaging), inbound)).toMatchObject({
      outcome: 'NOT_ELIGIBLE',
    });
    expect(ai.calls('qualification_extraction')).toHaveLength(0);
    expect(await db.qualificationEvaluation.count()).toBe(0);
    expect(await statusOf(context.member.id)).toBe('ENGAGED');
  });

  it('holds Step 2 and final archival while paused', async () => {
    const messaging = new FakeMessagingProvider();
    const context = await step1Member(db, messaging);
    const deps = outboundDeps(db, messaging);
    const due = nyHourAfter(context.step1AcceptedAt, 48);

    await pause(context.lead.id, due);
    expect(await findStep2Candidates(db, due, 100)).toEqual([]);
    expect((await sendStep2Message(deps, context.member.id, due)).outcome).toBe(
      'SKIPPED_HUMAN_TAKEOVER',
    );
    expect(await statusOf(context.member.id)).toBe('STEP_1_SENT');

    await resume(context.lead.id, due);
    expect((await sendStep2Message(deps, context.member.id, due)).outcome).toBe('ACCEPTED');
    expect(await statusOf(context.member.id)).toBe('STEP_2_SENT');

    const step2 = await db.message.findUniqueOrThrow({
      where: { sendKey: step2SendKey(context.member.id) },
    });
    const archiveAt = new Date((step2.sendingStartedAt ?? due).getTime() + 3 * DAY_MS + 60_000);
    const archive = () =>
      archiveDueMembers(
        db,
        archiveAt,
        TEST_OPERATIONS.tickBatchSize,
        TEST_OPERATIONS.transactionTimeoutMs,
      );

    await pause(context.lead.id, archiveAt);
    expect(await findArchivableMembers(db, archiveAt, 100)).toEqual([]);
    expect(await archive()).toBe(0);
    expect(await statusOf(context.member.id)).toBe('STEP_2_SENT');

    await resume(context.lead.id, archiveAt);
    expect(await archive()).toBe(1);
    expect(await statusOf(context.member.id)).toBe('DORMANT_ARCHIVED');
  });
});
