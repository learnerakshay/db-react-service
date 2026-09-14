import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { createKnowledgeItem } from '../../src/modules/knowledge/knowledge.js';
import { sendStep1Message } from '../../src/modules/messaging/outbound.js';
import { processInboundMessage, replySendKey } from '../../src/modules/replies/processor.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { AiProviderError } from '../../src/providers/ai/index.js';
import { FakeAiProvider, grounded, intent, intentOutput } from '../helpers/ai.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { NY_MORNING } from '../helpers/dispatch.js';
import {
  createMessagingCampaign,
  FakeMessagingProvider,
  outboundDeps,
  queuedMembers,
} from '../helpers/messaging.js';
import {
  contactedLead,
  receive,
  REPLY_TEMPLATES,
  replyDeps,
  type ContactedLeadOptions,
} from '../helpers/replies.js';

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

async function setup(options: ContactedLeadOptions = {}) {
  const messaging = new FakeMessagingProvider();
  const ai = new FakeAiProvider();
  const context = await contactedLead(db, messaging, options);
  return { ...context, messaging, ai, deps: replyDeps(db, ai, messaging) };
}

const membershipStatus = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const processingFor = (inboundMessageId: string) =>
  db.replyProcessing.findUniqueOrThrow({ where: { inboundMessageId } });
const replies = () =>
  db.message.findMany({
    where: { purpose: 'CONVERSATIONAL_REPLY' },
    orderBy: { createdAt: 'asc' },
  });

describe('reply routing', () => {
  it('engages a positive reply and sends the approved continuation through the provider', async () => {
    const { lead, member, messaging, ai, deps } = await setup();
    ai.script(
      'intent_analysis',
      intent('POSITIVE_INTEREST', 0.93, { preferredTime: 'Tuesday after 3pm' }),
    );
    const inbound = await receive(db, lead.phone, 'Yes! Tuesday after 3pm works');

    const result = await processInboundMessage(deps, inbound);

    expect(result).toMatchObject({ outcome: 'COMPLETED', replyOutcome: 'ACCEPTED' });
    expect(await processingFor(inbound)).toMatchObject({
      status: 'COMPLETED',
      action: 'ENGAGE',
      classification: 'POSITIVE_INTEREST',
      confidence: 0.93,
      preferredTime: 'Tuesday after 3pm',
      escalationReason: null,
      aiProvider: 'fake-ai',
      aiModel: 'fake-model',
      aiRequestIds: ['fake-req-1'],
    });
    expect(await membershipStatus(member.id)).toBe('ENGAGED');
    expect(
      await db.campaignLead.count({ where: { status: { in: ['BOOKED', 'QUALIFIED'] } } }),
    ).toBe(0);

    const [reply] = await replies();
    expect(reply).toMatchObject({
      direction: 'OUTBOUND',
      status: 'ACCEPTED',
      body: REPLY_TEMPLATES.positive,
      toNumber: lead.phone,
      campaignLeadId: member.id,
      sendKey: replySendKey(inbound),
    });
    expect(messaging.calls.map((c) => c.body)).toEqual([
      expect.stringContaining('Hey'),
      REPLY_TEMPLATES.positive,
    ]);
  });

  it('answers a question only from approved knowledge for this campaign', async () => {
    const { lead, member, campaign, messaging, ai, deps } = await setup();
    const other = await createMessagingCampaign(db, { name: 'Other' });
    const price = await createKnowledgeItem(db, {
      campaignId: campaign.id,
      category: 'PRICING',
      content: 'A standard gutter cleaning is $149 for single-story homes.',
      keywords: ['cleaning', 'price'],
    });
    await createKnowledgeItem(db, {
      campaignId: other.id,
      category: 'PRICING',
      content: 'Other campaign cleaning is $999.',
    });
    const retired = await createKnowledgeItem(db, {
      campaignId: campaign.id,
      category: 'PRICING',
      content: 'Old cleaning price $1.',
    });
    await db.knowledgeItem.update({ where: { id: retired.id }, data: { active: false } });

    const answer = 'A standard gutter cleaning is $149 for single-story homes.';
    ai.script(
      'intent_analysis',
      intent('SPECIFIC_QUESTION', 0.9, { specificQuery: 'How much is a gutter cleaning?' }),
    );
    ai.script('grounded_answer', grounded(answer, [price.id]));
    const inbound = await receive(db, lead.phone, 'How much is a cleaning these days?');

    const result = await processInboundMessage(deps, inbound);

    expect(result).toMatchObject({ outcome: 'COMPLETED', replyOutcome: 'ACCEPTED' });
    const sentFacts = (
      JSON.parse(ai.calls('grounded_answer')[0]?.input ?? '{}') as { facts: { id: string }[] }
    ).facts;
    expect(sentFacts.map((f) => f.id)).toEqual([price.id]);
    expect(await processingFor(inbound)).toMatchObject({
      action: 'ANSWER_QUESTION',
      knowledgeItemIds: [price.id],
      specificQuery: 'How much is a gutter cleaning?',
    });
    expect((await replies())[0]?.body).toBe(answer);
    expect(messaging.calls.at(-1)?.body).toBe(answer);
    expect(await membershipStatus(member.id)).toBe('ENGAGED');
  });

  it('never sends an answer with details missing from the facts; hands off instead', async () => {
    const { lead, campaign, ai, deps } = await setup();
    const price = await createKnowledgeItem(db, {
      campaignId: campaign.id,
      category: 'PRICING',
      content: 'A standard gutter cleaning is $149.',
    });
    ai.script('intent_analysis', intent('SPECIFIC_QUESTION', 0.9));
    ai.script('grounded_answer', grounded('Cleaning is $99 and we are open 24/7!', [price.id]));
    const inbound = await receive(db, lead.phone, 'What does a cleaning cost?');

    await processInboundMessage(deps, inbound);

    expect(await processingFor(inbound)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'UNGROUNDED_ANSWER',
      errorCode: 'UNSUPPORTED_DETAIL',
    });
    expect((await replies()).map((r) => r.body)).toEqual([REPLY_TEMPLATES.handoff]);
  });

  it('escalates without asking for an answer when no approved knowledge matches', async () => {
    const { lead, member, ai, deps } = await setup();
    ai.script('intent_analysis', intent('SPECIFIC_QUESTION', 0.92));
    const inbound = await receive(db, lead.phone, 'Do you also install solar panels?');

    await processInboundMessage(deps, inbound);

    expect(ai.calls('grounded_answer')).toHaveLength(0);
    expect(await processingFor(inbound)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'MISSING_KNOWLEDGE',
    });
    expect((await replies()).map((r) => r.body)).toEqual([REPLY_TEMPLATES.handoff]);
    expect(await membershipStatus(member.id)).toBe('ENGAGED');
  });

  it('sends nothing for missing knowledge when no handoff text is configured', async () => {
    const { lead, ai, deps } = await setup({ templates: { positive: REPLY_TEMPLATES.positive } });
    ai.script('intent_analysis', intent('SPECIFIC_QUESTION', 0.92));
    const inbound = await receive(db, lead.phone, 'Are you licensed in Ohio?');
    await processInboundMessage(deps, inbound);
    expect(await processingFor(inbound)).toMatchObject({ escalationReason: 'MISSING_KNOWLEDGE' });
    expect(await replies()).toHaveLength(0);
  });

  it('closes the conversation after a polite decline', async () => {
    const { lead, member, ai, deps } = await setup();
    ai.script('intent_analysis', intent('NOT_INTERESTED', 0.9));
    const inbound = await receive(db, lead.phone, 'No thanks, already had it done');

    const result = await processInboundMessage(deps, inbound);

    expect(result).toMatchObject({ outcome: 'COMPLETED', replyOutcome: 'ACCEPTED' });
    expect(await processingFor(inbound)).toMatchObject({ action: 'CLOSE_DECLINED' });
    expect(await membershipStatus(member.id)).toBe('DORMANT_ARCHIVED');
    expect((await replies()).map((r) => r.body)).toEqual([REPLY_TEMPLATES.decline]);
  });

  it('sends one clarification for an unclear reply, then hands off to a human', async () => {
    const { lead, ai, deps } = await setup();
    ai.script('intent_analysis', intent('AMBIGUOUS', 0.9), intent('AMBIGUOUS', 0.9));
    const first = await receive(db, lead.phone, 'maybe');
    await processInboundMessage(deps, first);
    const second = await receive(db, lead.phone, 'hmm not sure');
    await processInboundMessage(deps, second);

    expect(await processingFor(first)).toMatchObject({ action: 'CLARIFY' });
    expect(await processingFor(second)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'AMBIGUOUS_REPLY',
    });
    expect((await replies()).map((r) => r.body)).toEqual([REPLY_TEMPLATES.clarify]);
  });

  it('escalates low-confidence results without any semantic action', async () => {
    const { lead, member, ai, deps } = await setup();
    ai.script('intent_analysis', intent('POSITIVE_INTEREST', 0.6));
    const inbound = await receive(db, lead.phone, 'sure i guess');
    await processInboundMessage(deps, inbound);

    expect(await processingFor(inbound)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'LOW_CONFIDENCE',
    });
    expect(await membershipStatus(member.id)).toBe('STEP_1_SENT');
    expect(await replies()).toHaveLength(0);

    const other = await setup({ name: 'Other', phone: '+16505559876' });
    other.ai.script('intent_analysis', intent('HARD_OPT_OUT', 0.5));
    const unsure = await receive(db, other.lead.phone, 'ugh enough');
    await processInboundMessage(other.deps, unsure);
    expect(await processingFor(unsure)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'LOW_CONFIDENCE',
    });
    expect(await db.suppressionEntry.count()).toBe(0);
    expect(await membershipStatus(other.member.id)).toBe('STEP_1_SENT');
  });

  it('holds further automation for a lead while a human review is pending', async () => {
    const { lead, ai, deps } = await setup();
    ai.script('intent_analysis', intent('AMBIGUOUS', 0.4), intent('POSITIVE_INTEREST', 0.95));
    await processInboundMessage(deps, await receive(db, lead.phone, 'eh'));
    const later = await receive(db, lead.phone, 'Actually yes, lets do it');
    await processInboundMessage(deps, later);
    expect(await processingFor(later)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'AWAITING_HUMAN_REVIEW',
    });
    expect(await replies()).toHaveLength(0);
  });
});

describe('hard opt-outs and safety gates', () => {
  it('suppresses globally on a confident semantic opt-out and stops all future sends', async () => {
    const { lead, member, messaging, ai, deps } = await setup();
    const other = await createMessagingCampaign(db, { name: 'Second campaign' });
    const [queued] = await queuedMembers(db, other.id, [{ phone: lead.phone }]);
    if (queued === undefined) throw new Error('no queued member');

    ai.script('intent_analysis', intent('HARD_OPT_OUT', 0.97));
    const inbound = await receive(db, lead.phone, 'please stop texting me');
    const result = await processInboundMessage(deps, inbound);

    expect(result).toMatchObject({ outcome: 'COMPLETED', replyOutcome: null });
    expect(await processingFor(inbound)).toMatchObject({
      action: 'OPT_OUT',
      classification: 'HARD_OPT_OUT',
    });
    expect(await db.suppressionEntry.findMany({ where: { phone: lead.phone } })).toMatchObject([
      { reason: 'OPT_OUT', source: 'INBOUND_MESSAGE', reference: `ai:${inbound}` },
    ]);
    expect(await membershipStatus(member.id)).toBe('OPTED_OUT');
    expect(await membershipStatus(queued.id)).toBe('OPTED_OUT');
    expect(await replies()).toHaveLength(0);

    const attempt = await sendStep1Message(outboundDeps(db, messaging), queued.id, NY_MORNING);
    expect(attempt.outcome).toBe('SKIPPED_NOT_QUEUED');
    expect(messaging.calls).toHaveLength(1);
  });

  it('bypasses the model entirely for exact STOP commands', async () => {
    const { lead, ai, deps } = await setup();
    const inbound = await receive(db, lead.phone, 'STOP');
    expect((await processInboundMessage(deps, inbound)).outcome).toBe('SKIPPED');
    expect(ai.requests).toHaveLength(0);
    expect(await db.suppressionEntry.count({ where: { phone: lead.phone } })).toBe(1);
  });

  it('does not classify or reply to messages from suppressed leads', async () => {
    const { lead, ai, deps } = await setup();
    await addSuppression(db, { phone: lead.phone, reason: 'DO_NOT_CONTACT', source: 'OPERATOR' });
    const inbound = await receive(db, lead.phone, 'Actually I want a quote');
    expect((await processInboundMessage(deps, inbound)).outcome).toBe('ESCALATED');
    expect(await processingFor(inbound)).toMatchObject({ escalationReason: 'LEAD_SUPPRESSED' });
    expect(ai.requests).toHaveLength(0);
  });

  it('escalates stale inbound messages instead of answering them late', async () => {
    const { lead, ai, deps } = await setup();
    const inbound = await receive(db, lead.phone, 'yes please');
    const later = new Date(Date.now() + 25 * 60 * 60_000);
    await processInboundMessage(deps, inbound, later);
    expect(await processingFor(inbound)).toMatchObject({ escalationReason: 'INBOUND_TOO_OLD' });
    expect(ai.requests).toHaveLength(0);
  });

  it('suppresses an unknown sender on a confident semantic opt-out but never replies to unknown senders', async () => {
    const ai = new FakeAiProvider();
    const messaging = new FakeMessagingProvider();
    const deps = replyDeps(db, ai, messaging);
    ai.script('intent_analysis', intent('HARD_OPT_OUT', 0.95), intent('POSITIVE_INTEREST', 0.95));

    const optOut = await receive(db, '+14155550123', 'remove me from your list');
    await processInboundMessage(deps, optOut);
    expect(await db.suppressionEntry.count({ where: { phone: '+14155550123' } })).toBe(1);

    const hello = await receive(db, '+14155550124', 'yes interested');
    await processInboundMessage(deps, hello);
    expect(await processingFor(hello)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'UNKNOWN_SENDER',
    });
    expect(messaging.calls).toHaveLength(0);
  });
});

describe('structured output enforcement', () => {
  const valid = {
    classification: 'POSITIVE_INTEREST',
    confidence: 0.9,
    extractedDetails: { preferredTime: null, specificQuery: null },
  };

  it.each([
    ['an unknown classification', { ...valid, classification: 'VERY_INTERESTED' }],
    ['confidence out of range', { ...valid, confidence: 7 }],
    ['a missing field', { classification: 'POSITIVE_INTEREST', confidence: 0.9 }],
    ['an extra field', { ...valid, sendReply: 'Book now!' }],
    ['a non-object', 'POSITIVE_INTEREST'],
  ])('escalates %s without acting', async (_label, output) => {
    const { lead, member, ai, deps } = await setup();
    ai.script('intent_analysis', { output });
    const inbound = await receive(db, lead.phone, 'yes');

    expect((await processInboundMessage(deps, inbound)).outcome).toBe('ESCALATED');
    expect(await processingFor(inbound)).toMatchObject({
      escalationReason: 'INVALID_AI_OUTPUT',
      classification: null,
    });
    expect(await membershipStatus(member.id)).toBe('STEP_1_SENT');
    expect(await replies()).toHaveLength(0);
    expect(await db.suppressionEntry.count()).toBe(0);
  });

  it('escalates a malformed grounded answer', async () => {
    const { lead, campaign, ai, deps } = await setup();
    await createKnowledgeItem(db, {
      campaignId: campaign.id,
      category: 'PRICING',
      content: 'Cleaning is $149.',
    });
    ai.script('intent_analysis', intent('SPECIFIC_QUESTION', 0.9));
    ai.script('grounded_answer', { output: { answerable: 'yes', answer: 'Cleaning is $149.' } });
    const inbound = await receive(db, lead.phone, 'cleaning price?');
    await processInboundMessage(deps, inbound);
    expect(await processingFor(inbound)).toMatchObject({ escalationReason: 'INVALID_AI_OUTPUT' });
    expect(await replies()).toHaveLength(0);
  });

  it('retries transient AI failures and escalates after the attempt limit', async () => {
    const { lead, ai, deps } = await setup();
    const timeout = () => ({ error: new AiProviderError('fake-ai', 'TIMEOUT') });
    ai.script('intent_analysis', timeout(), timeout(), timeout());
    const inbound = await receive(db, lead.phone, 'yes');

    expect((await processInboundMessage(deps, inbound)).outcome).toBe('RETRY');
    expect(await processingFor(inbound)).toMatchObject({
      status: 'RETRY',
      attempts: 1,
      errorCode: 'TIMEOUT',
    });
    expect((await processInboundMessage(deps, inbound)).outcome).toBe('RETRY');
    expect((await processInboundMessage(deps, inbound)).outcome).toBe('ESCALATED');
    expect(await processingFor(inbound)).toMatchObject({
      status: 'ESCALATED',
      attempts: 3,
      escalationReason: 'AI_UNAVAILABLE',
    });
    expect((await processInboundMessage(deps, inbound)).outcome).toBe('ALREADY_PROCESSED');
    expect(ai.calls('intent_analysis')).toHaveLength(3);
  });
});

describe('processing and reply idempotency', () => {
  it('classifies and replies once when the same job runs repeatedly', async () => {
    const { lead, messaging, ai, deps } = await setup();
    ai.script('intent_analysis', intent('POSITIVE_INTEREST'));
    const inbound = await receive(db, lead.phone, 'yes please');

    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push((await processInboundMessage(deps, inbound)).outcome);

    expect(outcomes).toEqual(['COMPLETED', 'ALREADY_PROCESSED', 'ALREADY_PROCESSED']);
    expect(ai.calls('intent_analysis')).toHaveLength(1);
    expect(await replies()).toHaveLength(1);
    expect(messaging.calls).toHaveLength(2);
  });

  it('does not duplicate classification or replies when workers race', async () => {
    const { lead, messaging, ai, deps } = await setup();
    ai.script('intent_analysis', intent('POSITIVE_INTEREST'));
    ai.delayMs = 300;
    const inbound = await receive(db, lead.phone, 'yes please');

    const workers = Array.from({ length: 3 }, () => connectTestDatabase());
    try {
      for (const worker of workers) {
        await Promise.all([1, 2, 3].map(() => worker.$queryRaw`SELECT 1`));
      }
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          processInboundMessage(
            {
              ...deps,
              db: workers[i % workers.length] as Database,
              outbound: outboundDeps(workers[i % workers.length] as Database, messaging),
            },
            inbound,
          ),
        ),
      );
      expect(results.filter((r) => r.outcome === 'COMPLETED')).toHaveLength(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.$disconnect()));
    }

    expect(ai.calls('intent_analysis')).toHaveLength(1);
    expect(await replies()).toHaveLength(1);
    expect(messaging.calls).toHaveLength(2);
  });

  it('resumes an unsent reply after a restart without classifying again', async () => {
    const { lead, messaging, ai, deps } = await setup();
    ai.script('intent_analysis', intent('POSITIVE_INTEREST'));
    messaging.script({
      outcome: 'REJECTED',
      retryable: true,
      recipientOptedOut: false,
      errorCode: '20429',
    });
    const inbound = await receive(db, lead.phone, 'yes please');

    expect(await processInboundMessage(deps, inbound)).toMatchObject({
      outcome: 'COMPLETED',
      replyOutcome: 'RETRY_LATER',
    });
    expect((await replies())[0]?.status).toBe('PENDING');

    const restarted = connectTestDatabase();
    try {
      const resumed = await processInboundMessage(
        { ...deps, db: restarted, outbound: outboundDeps(restarted, messaging) },
        inbound,
      );
      expect(resumed).toMatchObject({ outcome: 'ALREADY_PROCESSED', replyOutcome: 'ACCEPTED' });
    } finally {
      await restarted.$disconnect();
    }
    expect(ai.calls('intent_analysis')).toHaveLength(1);
    expect(await replies()).toHaveLength(1);
    expect(messaging.calls).toHaveLength(3);
  });

  it('leaves a live claim alone but reclaims one abandoned by a crashed worker', async () => {
    const { lead, ai, deps } = await setup();
    ai.script('intent_analysis', intent('POSITIVE_INTEREST'));
    const inbound = await receive(db, lead.phone, 'yes please');
    await db.replyProcessing.create({
      data: {
        inboundMessageId: inbound,
        leadId: lead.id,
        status: 'PROCESSING',
        attempts: 1,
        claimedAt: new Date(),
      },
    });

    expect((await processInboundMessage(deps, inbound)).outcome).toBe('IN_FLIGHT');
    expect(ai.requests).toHaveLength(0);

    await db.replyProcessing.update({
      where: { inboundMessageId: inbound },
      data: { claimedAt: new Date(Date.now() - 10 * 60_000) },
    });
    expect((await processInboundMessage(deps, inbound)).outcome).toBe('COMPLETED');
    expect(await processingFor(inbound)).toMatchObject({ attempts: 2, status: 'COMPLETED' });
    expect(ai.requests).toHaveLength(1);
  });

  it('cancels a persisted reply if the lead was suppressed before it went out', async () => {
    const { lead, member, messaging, ai, deps } = await setup();
    ai.script('intent_analysis', intent('POSITIVE_INTEREST'));
    messaging.script({
      outcome: 'REJECTED',
      retryable: true,
      recipientOptedOut: false,
      errorCode: '20429',
    });
    const inbound = await receive(db, lead.phone, 'yes please');
    await processInboundMessage(deps, inbound);

    await addSuppression(db, { phone: lead.phone, reason: 'OPT_OUT', source: 'OPERATOR' });
    expect((await processInboundMessage(deps, inbound)).replyOutcome).toBe('CANCELLED');
    expect((await replies())[0]).toMatchObject({ status: 'CANCELLED', errorCode: 'SUPPRESSED' });
    expect(await membershipStatus(member.id)).toBe('OPTED_OUT');
    expect(messaging.calls).toHaveLength(2);
  });
});

describe('conversation context', () => {
  it('passes only a bounded history of the same conversation to the model', async () => {
    const { lead, member, campaign, ai, deps } = await setup();

    for (let i = 0; i < 12; i++) await receive(db, lead.phone, `earlier message ${String(i)}`);

    // Same lead, different campaign: must never appear.
    const otherCampaign = await createMessagingCampaign(db, { name: 'Other campaign' });
    const [otherMembership] = await queuedMembers(db, otherCampaign.id, [{ phone: lead.phone }]);
    await db.message.create({
      data: {
        direction: 'INBOUND',
        purpose: 'INBOUND_REPLY',
        status: 'RECEIVED',
        provider: 'fake',
        providerMessageId: 'SM0000000000000000000000000000beef',
        leadId: lead.id,
        campaignId: otherCampaign.id,
        campaignLeadId: otherMembership?.id ?? null,
        fromNumber: lead.phone,
        toNumber: '+15005550006',
        body: 'OTHER CAMPAIGN SECRET',
        inboundResolution: 'MATCHED',
        receivedAt: new Date(),
      },
    });
    // Different lead in the same campaign: must never appear.
    const [neighbour] = await queuedMembers(db, campaign.id, [{ phone: '+16505554321' }]);
    await receive(db, '+16505554321', 'OTHER LEAD SECRET');
    expect(neighbour).toBeDefined();

    let captured:
      { recentConversation: { from: string; text: string }[]; latestMessage: string } | undefined;
    ai.script('intent_analysis', {
      run: (request) => {
        captured = JSON.parse(request.input) as typeof captured;
        return intentOutput('AMBIGUOUS', 0.3);
      },
    });
    const latest = await receive(db, lead.phone, 'is this still available?');
    await processInboundMessage(deps, latest);

    expect(captured?.latestMessage).toBe('is this still available?');
    expect(captured?.recentConversation).toHaveLength(10);
    expect(captured?.recentConversation.map((t) => t.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `earlier message ${String(i + 2)}`),
    );
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('OTHER CAMPAIGN SECRET');
    expect(serialized).not.toContain('OTHER LEAD SECRET');
    expect(member.id).toBeDefined();
  });

  it('does not guess the campaign when association is ambiguous', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const deps = replyDeps(db, ai, messaging);
    const first = await contactedLead(db, messaging, { name: 'A', phone: '+16505551212' });
    const second = await contactedLead(db, messaging, { name: 'B', phone: '+16505551212' });

    let history: unknown;
    ai.script(
      'intent_analysis',
      {
        run: (request) => {
          history = (JSON.parse(request.input) as { recentConversation: unknown })
            .recentConversation;
          return intentOutput('POSITIVE_INTEREST', 0.95);
        },
      },
      intent('HARD_OPT_OUT', 0.95),
    );

    const positive = await receive(db, first.lead.phone, 'yes interested');
    await processInboundMessage(deps, positive);
    expect(await processingFor(positive)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'AMBIGUOUS_CAMPAIGN',
    });
    expect(history).toEqual([]);
    expect(await replies()).toHaveLength(0);
    expect(await membershipStatus(first.member.id)).toBe('STEP_1_SENT');
    expect(await membershipStatus(second.member.id)).toBe('STEP_1_SENT');

    const optOut = await receive(db, first.lead.phone, 'dont message this number again');
    await processInboundMessage(deps, optOut);
    expect(await membershipStatus(first.member.id)).toBe('OPTED_OUT');
    expect(await membershipStatus(second.member.id)).toBe('OPTED_OUT');
    expect(await db.suppressionEntry.count({ where: { phone: first.lead.phone } })).toBe(1);
  });
});
