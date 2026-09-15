import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { hasOutstandingQualificationQuestion } from '../../src/modules/conversion/outstanding.js';
import { processQualification } from '../../src/modules/conversion/qualification.js';
import type { IntentAnalysis } from '../../src/modules/replies/classifier.js';
import { routeReply, type RouterInput } from '../../src/modules/replies/router.js';
import { FakeAiProvider } from '../helpers/ai.js';
import {
  conversionDeps,
  engagedMember,
  extracted,
  qualifiedMember,
  QUALIFICATION,
  replyFromLead,
} from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { FakeMessagingProvider } from '../helpers/messaging.js';
import { contactedLead, REPLY_TEMPLATES } from '../helpers/replies.js';

function analysis(
  classification: IntentAnalysis['classification'],
  confidence = 0.9,
): IntentAnalysis {
  return {
    classification,
    confidence,
    extractedDetails: { preferredTime: null, specificQuery: null },
  };
}

const outstanding: RouterInput = {
  analysis: analysis('AMBIGUOUS'),
  confidenceThreshold: 0.75,
  resolution: 'MATCHED',
  membershipStatus: 'ENGAGED',
  awaitingHumanReview: false,
  clarificationAlreadySent: false,
  templates: REPLY_TEMPLATES,
  qualificationQuestionOutstanding: true,
};

describe('router: outstanding qualification question', () => {
  it('routes likely answers to qualification instead of clarification or low-confidence review', () => {
    expect(routeReply(outstanding)).toEqual({ action: 'QUALIFICATION_ANSWER' });
    expect(routeReply({ ...outstanding, analysis: analysis('AMBIGUOUS', 0.3) })).toEqual({
      action: 'QUALIFICATION_ANSWER',
    });
    expect(routeReply({ ...outstanding, analysis: analysis('POSITIVE_INTEREST') })).toEqual({
      action: 'QUALIFICATION_ANSWER',
    });
    expect(routeReply({ ...outstanding, analysis: analysis('SPECIFIC_QUESTION', 0.5) })).toEqual({
      action: 'QUALIFICATION_ANSWER',
    });
  });

  it('keeps opt-out, decline, confident question and human-review safety rules', () => {
    expect(routeReply({ ...outstanding, analysis: analysis('HARD_OPT_OUT') })).toEqual({
      action: 'OPT_OUT',
    });
    expect(routeReply({ ...outstanding, analysis: analysis('HARD_OPT_OUT', 0.5) })).toMatchObject({
      reason: 'LOW_CONFIDENCE',
    });
    expect(routeReply({ ...outstanding, analysis: analysis('NOT_INTERESTED') })).toMatchObject({
      action: 'CLOSE_DECLINED',
    });
    expect(routeReply({ ...outstanding, analysis: analysis('NOT_INTERESTED', 0.5) })).toMatchObject(
      { reason: 'LOW_CONFIDENCE' },
    );
    expect(routeReply({ ...outstanding, analysis: analysis('SPECIFIC_QUESTION') })).toEqual({
      action: 'ANSWER_QUESTION',
    });
    expect(routeReply({ ...outstanding, awaitingHumanReview: true })).toMatchObject({
      reason: 'AWAITING_HUMAN_REVIEW',
    });
    expect(routeReply({ ...outstanding, resolution: 'AMBIGUOUS_CAMPAIGN' })).toMatchObject({
      reason: 'AMBIGUOUS_CAMPAIGN',
    });
  });

  it('is unchanged without an outstanding question (frozen behavior)', () => {
    for (const flag of [false, undefined]) {
      const input = { ...outstanding, qualificationQuestionOutstanding: flag };
      expect(routeReply(input)).toEqual({ action: 'CLARIFY', reply: REPLY_TEMPLATES.clarify });
      expect(routeReply({ ...input, analysis: analysis('AMBIGUOUS', 0.3) })).toMatchObject({
        reason: 'LOW_CONFIDENCE',
      });
      expect(routeReply({ ...input, analysis: analysis('POSITIVE_INTEREST') })).toMatchObject({
        action: 'ENGAGE',
      });
    }
  });

  it('treats STEP_2_SENT and QUALIFIED as open conversations; BOOKED stays closed', () => {
    const base = {
      ...outstanding,
      qualificationQuestionOutstanding: false,
      analysis: analysis('POSITIVE_INTEREST'),
    };
    expect(routeReply({ ...base, membershipStatus: 'STEP_2_SENT' }).action).toBe('ENGAGE');
    expect(routeReply({ ...base, membershipStatus: 'QUALIFIED' }).action).toBe('ENGAGE');
    expect(routeReply({ ...base, membershipStatus: 'BOOKED' })).toMatchObject({
      reason: 'CONVERSATION_CLOSED',
    });
    // The answer route never applies outside ENGAGED.
    expect(routeReply({ ...outstanding, membershipStatus: 'QUALIFIED' }).action).toBe('CLARIFY');
  });
});

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

const processingFor = (inboundMessageId: string) =>
  db.replyProcessing.findUniqueOrThrow({ where: { inboundMessageId } });
const conversationalReplies = () =>
  db.message.count({ where: { purpose: 'CONVERSATIONAL_REPLY' } });
const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;

/** Engaged member who has been asked the first qualification question. */
async function asked() {
  const messaging = new FakeMessagingProvider();
  const ai = new FakeAiProvider();
  const context = await engagedMember(db, ai, messaging);
  ai.script('qualification_extraction', extracted({}));
  await processQualification(conversionDeps(db, ai, messaging), context.inbound);
  return { ...context, ai, messaging, deps: conversionDeps(db, ai, messaging) };
}

describe('processing answers to qualification questions', () => {
  it('sends no generic clarification and qualifies from the answers', async () => {
    const { member, lead, ai, messaging, deps } = await asked();
    expect(await hasOutstandingQualificationQuestion(db, member.id)).toBe(true);
    const repliesBefore = await conversationalReplies();

    const first = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'gutter cleaning',
      'AMBIGUOUS',
    );
    expect(await processingFor(first)).toMatchObject({
      status: 'COMPLETED',
      action: 'QUALIFICATION_ANSWER',
      replyMessageId: null,
    });
    expect(await conversationalReplies()).toBe(repliesBefore);

    ai.script(
      'qualification_extraction',
      extracted({ serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' } }),
    );
    expect(await processQualification(deps, first)).toMatchObject({
      result: 'PENDING_INFORMATION',
      sends: ['ACCEPTED'],
    });
    expect(messaging.calls.at(-1)?.body).toBe(QUALIFICATION.fields[1]?.question);

    const second = await replyFromLead(db, ai, messaging, lead.phone, '$700', 'AMBIGUOUS', 0.4);
    expect((await processingFor(second)).action).toBe('QUALIFICATION_ANSWER');
    ai.script('qualification_extraction', extracted({ budget: { value: 700, evidence: '$700' } }));
    expect(await processQualification(deps, second)).toMatchObject({ result: 'QUALIFIED' });

    expect(await statusOf(member.id)).toBe('QUALIFIED');
    expect(await conversationalReplies()).toBe(repliesBefore);
    expect(await db.replyProcessing.count({ where: { action: 'CLARIFY' } })).toBe(0);
    expect(await hasOutstandingQualificationQuestion(db, member.id)).toBe(false);
  });

  it('still opts out a lead who says stop while a question is outstanding', async () => {
    const { member, lead, ai, messaging } = await asked();
    const stop = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'stop texting me',
      'HARD_OPT_OUT',
    );
    expect((await processingFor(stop)).action).toBe('OPT_OUT');
    expect(await statusOf(member.id)).toBe('OPTED_OUT');
    expect(await db.suppressionEntry.count({ where: { phone: lead.phone } })).toBe(1);
  });

  it('keeps generic ambiguity handling when no question is outstanding', async () => {
    const messaging = new FakeMessagingProvider();
    const ai = new FakeAiProvider();
    const { lead } = await contactedLead(db, messaging);
    const unclear = await replyFromLead(db, ai, messaging, lead.phone, 'who is this?', 'AMBIGUOUS');
    expect((await processingFor(unclear)).action).toBe('CLARIFY');
    expect(messaging.calls.at(-1)?.body).toBe(REPLY_TEMPLATES.clarify);

    const engaged = await engagedMember(db, ai, new FakeMessagingProvider());
    expect(await hasOutstandingQualificationQuestion(db, engaged.member.id)).toBe(false);
    const other = await replyFromLead(
      db,
      ai,
      new FakeMessagingProvider(),
      engaged.lead.phone,
      'maybe',
      'AMBIGUOUS',
    );
    expect((await processingFor(other)).action).toBe('CLARIFY');
  });

  it('handles replies from QUALIFIED members instead of closing the conversation', async () => {
    const { member, lead, ai, messaging } = await qualifiedMember(db);
    const reply = await replyFromLead(db, ai, messaging, lead.phone, 'great, thanks!');
    expect(await processingFor(reply)).toMatchObject({ status: 'COMPLETED', action: 'ENGAGE' });
    expect(messaging.calls.at(-1)?.body).toBe(REPLY_TEMPLATES.positive);
    expect(await statusOf(member.id)).toBe('QUALIFIED');
  });
});
