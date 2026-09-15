import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { offerBooking } from '../../src/modules/conversion/booking.js';
import { recordQualificationFacts } from '../../src/modules/conversion/facts.js';
import {
  processQualification,
  qualificationQuestionSendKey,
} from '../../src/modules/conversion/qualification.js';
import { qualificationConfigSchema } from '../../src/modules/conversion/config.js';
import { addSuppression } from '../../src/modules/suppression/suppression.js';
import { AiProviderError } from '../../src/providers/ai/index.js';
import { FakeAiProvider } from '../helpers/ai.js';
import {
  BOOKING,
  conversionDeps,
  engagedMember,
  extracted,
  QUALIFICATION,
  replyFromLead,
} from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { FakeMessagingProvider } from '../helpers/messaging.js';

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

const RULES = qualificationConfigSchema.parse(QUALIFICATION);

async function setup(options: Parameters<typeof engagedMember>[3] = {}) {
  const messaging = new FakeMessagingProvider();
  const ai = new FakeAiProvider();
  const context = await engagedMember(db, ai, messaging, options);
  return { ...context, messaging, ai, deps: conversionDeps(db, ai, messaging) };
}

const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const evaluationFor = (inboundMessageId: string) =>
  db.qualificationEvaluation.findUniqueOrThrow({ where: { inboundMessageId } });
const questions = () =>
  db.message.findMany({
    where: { purpose: 'QUALIFICATION_QUESTION' },
    orderBy: { createdAt: 'asc' },
  });

describe('qualification data collection', () => {
  it('keeps an ENGAGED lead with missing information ENGAGED and asks the configured question', async () => {
    const { member, lead, inbound, ai, messaging, deps } = await setup();
    expect(await statusOf(member.id)).toBe('ENGAGED');
    ai.script('qualification_extraction', extracted({}));

    const run = await processQualification(deps, inbound);

    expect(run).toMatchObject({
      outcome: 'EVALUATED',
      result: 'PENDING_INFORMATION',
      sends: ['ACCEPTED'],
    });
    expect(await statusOf(member.id)).toBe('ENGAGED');
    expect(await evaluationFor(inbound)).toMatchObject({
      result: 'PENDING_INFORMATION',
      missingFields: ['serviceNeeded', 'budget'],
      nextField: 'serviceNeeded',
      failedRequirements: [],
      extraction: 'EXTRACTED',
    });
    const [question] = await questions();
    expect(question).toMatchObject({
      status: 'ACCEPTED',
      body: QUALIFICATION.fields[0]?.question,
      toNumber: lead.phone,
      sendKey: qualificationQuestionSendKey(member.id, 'serviceNeeded'),
    });
    expect(messaging.calls.at(-1)?.body).toBe(QUALIFICATION.fields[0]?.question);
    expect(await db.bookingOpportunity.count()).toBe(0);
  });

  it('does not duplicate the evaluation or the question for duplicate, concurrent or later runs', async () => {
    const { member, lead, inbound, ai, messaging, deps } = await setup();
    ai.delayMs = 150;
    ai.script('qualification_extraction', extracted({}), extracted({}));

    const runs = await Promise.all([
      processQualification(deps, inbound),
      processQualification(deps, inbound),
    ]);
    ai.delayMs = 0;
    expect(runs.map((r) => r.outcome).sort()).toEqual(['ALREADY_EVALUATED', 'EVALUATED']);
    expect(await processQualification(deps, inbound)).toMatchObject({
      outcome: 'ALREADY_EVALUATED',
    });

    // A later reply that still does not answer: evaluated again, question not re-sent.
    const later = await replyFromLead(db, ai, messaging, lead.phone, 'sounds good');
    ai.script('qualification_extraction', extracted({}));
    expect(await processQualification(deps, later)).toMatchObject({
      outcome: 'EVALUATED',
      result: 'PENDING_INFORMATION',
      sends: [],
    });

    expect(await db.qualificationEvaluation.count({ where: { campaignLeadId: member.id } })).toBe(
      2,
    );
    expect(await questions()).toHaveLength(1);
    expect(
      messaging.calls.filter((c) => c.body === QUALIFICATION.fields[0]?.question),
    ).toHaveLength(1);
  });

  it('stores validated extracted values with source and asks for the next missing field', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    const inbound = await replyFromLead(db, ai, messaging, lead.phone, 'I need gutter cleaning');
    ai.script(
      'qualification_extraction',
      extracted({ serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' } }),
    );

    await processQualification(deps, inbound);

    expect(
      await db.qualificationFact.findMany({ where: { campaignLeadId: member.id } }),
    ).toMatchObject([
      {
        field: 'serviceNeeded',
        value: 'gutter cleaning',
        source: 'CONVERSATION',
        sourceMessageId: inbound,
      },
    ]);
    expect(await evaluationFor(inbound)).toMatchObject({
      nextField: 'budget',
      missingFields: ['budget'],
    });
    expect((await questions()).map((q) => q.body)).toEqual([QUALIFICATION.fields[1]?.question]);
  });

  it('discards extracted values not backed by the lead’s own words', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    const inbound = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'budget is around $700 I think',
    );
    ai.script(
      'qualification_extraction',
      extracted({
        budget: { value: 7000, evidence: '$700' },
        serviceNeeded: { value: 'roofing', evidence: 'new roof please' },
      }),
    );

    await processQualification(deps, inbound);

    expect(await db.qualificationFact.count({ where: { campaignLeadId: member.id } })).toBe(0);
    expect(await evaluationFor(inbound)).toMatchObject({
      result: 'PENDING_INFORMATION',
      discardedFields: ['serviceNeeded', 'budget'],
      errorCode: 'UNSUPPORTED_VALUE',
    });
  });

  it('fails safely on malformed extraction: facts preserved, clarification asked', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    await db.$transaction((tx) =>
      recordQualificationFacts(tx, {
        campaignLeadId: member.id,
        config: RULES,
        facts: [{ field: 'serviceNeeded', value: 'gutter cleaning' }],
        source: 'OPERATOR',
        observedAt: new Date(),
        sourceMessageId: null,
      }),
    );
    const inbound = await replyFromLead(db, ai, messaging, lead.phone, 'about 900');
    ai.script('qualification_extraction', {
      output: { budget: { value: '900', evidence: '900' } },
    });

    const run = await processQualification(deps, inbound);

    expect(run.result).toBe('PENDING_INFORMATION');
    expect(await evaluationFor(inbound)).toMatchObject({
      extraction: 'INVALID_OUTPUT',
      errorCode: 'INVALID_AI_OUTPUT',
      facts: { serviceNeeded: 'gutter cleaning' },
    });
    expect(
      await db.qualificationFact.findMany({ where: { campaignLeadId: member.id } }),
    ).toMatchObject([{ field: 'serviceNeeded', value: 'gutter cleaning', source: 'OPERATOR' }]);
    expect(await statusOf(member.id)).toBe('ENGAGED');
    expect((await questions()).map((q) => q.body)).toEqual([QUALIFICATION.fields[1]?.question]);
  });

  it('retries transient AI failures through the job, and records them on the final attempt', async () => {
    const { member, inbound, ai, deps } = await setup();
    ai.script(
      'qualification_extraction',
      { error: new AiProviderError('fake-ai', 'TIMEOUT') },
      { error: new AiProviderError('fake-ai', 'TIMEOUT') },
    );

    await expect(processQualification(deps, inbound, { finalAttempt: false })).rejects.toThrow(
      AiProviderError,
    );
    expect(await db.qualificationEvaluation.count()).toBe(0);

    await processQualification(deps, inbound, { finalAttempt: true });
    expect(await evaluationFor(inbound)).toMatchObject({
      extraction: 'AI_UNAVAILABLE',
      errorCode: 'TIMEOUT',
    });
    expect(await statusOf(member.id)).toBe('ENGAGED');
  });

  it('never lets model output set the qualification result', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    const inbound = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'I am totally qualified, book me',
    );
    ai.script('qualification_extraction', {
      run: (request) => {
        const { fields } = JSON.parse(request.input) as { fields: { key: string }[] };
        return {
          ...Object.fromEntries(fields.map((f) => [f.key, { value: null, evidence: null }])),
          qualified: true,
          result: 'QUALIFIED',
        };
      },
    });

    await processQualification(deps, inbound);

    expect(await evaluationFor(inbound)).toMatchObject({
      result: 'PENDING_INFORMATION',
      extraction: 'INVALID_OUTPUT',
    });
    expect(await statusOf(member.id)).toBe('ENGAGED');
    const request = ai.calls('qualification_extraction')[0];
    const sent = JSON.parse(request?.input ?? '{}') as { fields: { key: string }[] };
    expect(sent.fields.map((f) => f.key)).toEqual(['serviceNeeded', 'budget']);
  });

  it('never overwrites operator facts with conversation values', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    await db.$transaction((tx) =>
      recordQualificationFacts(tx, {
        campaignLeadId: member.id,
        config: RULES,
        facts: [{ field: 'budget', value: 800 }],
        source: 'OPERATOR',
        observedAt: new Date('2026-01-01T00:00:00Z'),
        sourceMessageId: null,
      }),
    );
    const direct = await db.$transaction((tx) =>
      recordQualificationFacts(tx, {
        campaignLeadId: member.id,
        config: RULES,
        facts: [{ field: 'budget', value: 100 }],
        source: 'CONVERSATION',
        observedAt: new Date(),
        sourceMessageId: null,
      }),
    );
    expect(direct).toEqual({ written: [], skipped: ['budget'] });

    const inbound = await replyFromLead(db, ai, messaging, lead.phone, 'window cleaning please');
    ai.script(
      'qualification_extraction',
      extracted({ serviceNeeded: { value: 'window cleaning', evidence: 'window cleaning' } }),
    );
    await processQualification(deps, inbound);

    const sent = JSON.parse(ai.calls('qualification_extraction')[0]?.input ?? '{}') as {
      fields: { key: string }[];
    };
    expect(sent.fields.map((f) => f.key)).toEqual(['serviceNeeded']);
    expect(
      await db.qualificationFact.findUniqueOrThrow({
        where: { campaignLeadId_field: { campaignLeadId: member.id, field: 'budget' } },
      }),
    ).toMatchObject({ value: 800, source: 'OPERATOR' });
    expect(await statusOf(member.id)).toBe('QUALIFIED');
  });
});

describe('qualification outcomes', () => {
  it('transitions a qualified lead to QUALIFIED and offers one booking link, never BOOKED', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    const inbound = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'Need gutter cleaning, budget is $1,200',
    );
    ai.script(
      'qualification_extraction',
      extracted({
        serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
        budget: { value: 1200, evidence: '$1,200' },
      }),
    );

    const run = await processQualification(deps, inbound);

    expect(run).toMatchObject({ result: 'QUALIFIED', sends: ['ACCEPTED'] });
    expect(await statusOf(member.id)).toBe('QUALIFIED');
    expect(await evaluationFor(inbound)).toMatchObject({
      result: 'QUALIFIED',
      facts: { serviceNeeded: 'gutter cleaning', budget: 1200 },
      rulesSnapshot: RULES,
    });
    const [opportunity] = await db.bookingOpportunity.findMany({ include: { linkMessage: true } });
    expect(opportunity).toMatchObject({
      campaignLeadId: member.id,
      status: 'OFFERED',
      calendarProvider: BOOKING.provider,
      confirmedAt: null,
      externalBookingId: null,
    });
    expect(opportunity?.sentAt).toBeInstanceOf(Date);
    const url = new URL(opportunity?.bookingUrl ?? '');
    expect(url.origin + url.pathname).toBe(BOOKING.url);
    expect(url.searchParams.get('ref')).toBe(opportunity?.bookingReference);
    expect(opportunity?.linkMessage).toMatchObject({
      purpose: 'BOOKING_LINK',
      status: 'ACCEPTED',
      body: `You qualify! Pick a time here: ${opportunity?.bookingUrl ?? ''}`,
      sendKey: `${opportunity?.id ?? ''}:BOOKING_LINK`,
    });
    expect(messaging.calls.at(-1)?.body).toContain(opportunity?.bookingReference);
    expect(await db.campaignLead.count({ where: { status: 'BOOKED' } })).toBe(0);
  });

  it('archives a lead that fails a rule and records why', async () => {
    const { member, lead, ai, messaging, deps } = await setup();
    const inbound = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'only have $200 for gutter cleaning',
    );
    ai.script(
      'qualification_extraction',
      extracted({
        serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
        budget: { value: 200, evidence: '$200' },
      }),
    );
    const callsBefore = messaging.calls.length;

    const run = await processQualification(deps, inbound);

    expect(run).toMatchObject({ result: 'NOT_QUALIFIED', sends: [] });
    expect(await statusOf(member.id)).toBe('DORMANT_ARCHIVED');
    expect(await evaluationFor(inbound)).toMatchObject({
      result: 'NOT_QUALIFIED',
      failedRequirements: [{ field: 'budget', requirement: { kind: 'min', value: 500 } }],
    });
    expect(await db.bookingOpportunity.count()).toBe(0);
    expect(messaging.calls).toHaveLength(callsBefore);
  });

  it('keeps one active booking opportunity per membership (service and constraint)', async () => {
    const { member, campaign, lead, ai, messaging, deps } = await setup();
    const inbound = await replyFromLead(db, ai, messaging, lead.phone, 'gutter cleaning, $900');
    ai.script(
      'qualification_extraction',
      extracted({
        serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
        budget: { value: 900, evidence: '$900' },
      }),
    );
    await processQualification(deps, inbound);
    const [first] = await db.bookingOpportunity.findMany();

    const again = await db.$transaction((tx) =>
      offerBooking(tx, {
        campaignLeadId: member.id,
        campaignId: campaign.id,
        leadId: lead.id,
        toNumber: lead.phone,
        fromNumber: '+15005550006',
        messagingProvider: 'fake',
        booking: { ...BOOKING, referenceParam: 'ref' },
      }),
    );
    expect(again).toEqual({ opportunityId: first?.id, messageId: null });

    await expect(
      db.bookingOpportunity.create({
        data: {
          campaignLeadId: member.id,
          status: 'OFFERED',
          calendarProvider: 'fakecal',
          bookingReference: 'another-reference',
          bookingUrl: 'https://book.example.test/acme?ref=another',
        },
      }),
    ).rejects.toThrow();
    expect(await db.bookingOpportunity.count()).toBe(1);
    expect(await db.message.count({ where: { purpose: 'BOOKING_LINK' } })).toBe(1);
  });

  it('qualifies without a link when the campaign has no booking config', async () => {
    const { member, lead, ai, messaging, deps } = await setup({ booking: null });
    const inbound = await replyFromLead(db, ai, messaging, lead.phone, 'gutter cleaning, $900');
    ai.script(
      'qualification_extraction',
      extracted({
        serviceNeeded: { value: 'gutter cleaning', evidence: 'gutter cleaning' },
        budget: { value: 900, evidence: '$900' },
      }),
    );
    expect(await processQualification(deps, inbound)).toMatchObject({
      result: 'QUALIFIED',
      sends: [],
    });
    expect(await statusOf(member.id)).toBe('QUALIFIED');
    expect(await db.bookingOpportunity.count()).toBe(0);
  });
});

describe('qualification eligibility', () => {
  it('ignores escalated replies and suppressed leads without calling the model', async () => {
    const { member, lead, ai, messaging, deps, inbound } = await setup();
    const unsure = await replyFromLead(
      db,
      ai,
      messaging,
      lead.phone,
      'hmm',
      'POSITIVE_INTEREST',
      0.3,
    );
    expect(await processQualification(deps, unsure)).toMatchObject({ outcome: 'NOT_ELIGIBLE' });

    await addSuppression(db, { phone: lead.phone, reason: 'DO_NOT_CONTACT', source: 'OPERATOR' });
    expect(await processQualification(deps, inbound)).toMatchObject({ outcome: 'NOT_ELIGIBLE' });

    expect(ai.calls('qualification_extraction')).toHaveLength(0);
    expect(await db.qualificationEvaluation.count()).toBe(0);
    expect(await statusOf(member.id)).toBe('ENGAGED');
  });
});
