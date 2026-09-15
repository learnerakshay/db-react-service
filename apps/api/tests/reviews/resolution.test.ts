import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { applyBookingEvent } from '../../src/modules/conversion/booking-events.js';
import { sendStep1Message } from '../../src/modules/messaging/outbound.js';
import {
  resolveReview,
  resumeLeadAutomation,
  takeOverLead,
  type OperatorContext,
} from '../../src/modules/reviews/resolution.js';
import { FakeAiProvider } from '../helpers/ai.js';
import { bookingEvent, qualifiedMember, replyFromLead } from '../helpers/conversion.js';
import { connectTestDatabase, resetDatabase } from '../helpers/db.js';
import { NY_MORNING } from '../helpers/dispatch.js';
import {
  createMessagingCampaign,
  FakeMessagingProvider,
  outboundDeps,
  queuedMembers,
} from '../helpers/messaging.js';
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

const context = (now = new Date()): OperatorContext => ({
  actor: { id: 'ops', role: 'OPERATOR' },
  requestId: 'req-test-00000001',
  now,
  transactionTimeoutMs: 30_000,
});

const processingOf = (inboundMessageId: string) =>
  db.replyProcessing.findUniqueOrThrow({ where: { inboundMessageId } });
const statusOf = async (id: string) =>
  (await db.campaignLead.findUniqueOrThrow({ where: { id } })).status;
const auditCount = (action: 'REVIEW_RESOLVED' | 'RESUME_AUTOMATION' | 'HUMAN_TAKEOVER') =>
  db.operatorAuditEvent.count({ where: { action } });

/** A contacted lead with one open LOW_CONFIDENCE review. */
async function escalatedLead() {
  const messaging = new FakeMessagingProvider();
  const ai = new FakeAiProvider();
  const contacted = await contactedLead(db, messaging);
  const inbound = await replyFromLead(
    db,
    ai,
    messaging,
    contacted.lead.phone,
    'hmm?',
    'AMBIGUOUS',
    0.3,
  );
  const review = await processingOf(inbound);
  expect(review).toMatchObject({ status: 'ESCALATED', reviewResolvedAt: null });
  return { ...contacted, messaging, ai, review };
}

describe('human review resolution', () => {
  it('persists the resolution, operator and note without rewriting the routed outcome', async () => {
    const { review, lead } = await escalatedLead();
    const now = new Date('2026-09-15T10:00:00Z');

    const result = await resolveReview(
      db,
      review.id,
      { resolution: 'MARK_HANDLED', note: 'Called the customer back' },
      context(now),
    );
    expect(result).toEqual({
      changed: true,
      resolvedCount: 1,
      automation: { mode: 'AUTOMATION_ACTIVE', pausedAt: null },
      membershipStatus: null,
    });
    expect(await db.replyProcessing.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({
      status: 'ESCALATED',
      action: 'HUMAN_REVIEW',
      escalationReason: 'LOW_CONFIDENCE',
      reviewResolvedAt: now,
      reviewResolution: 'MARK_HANDLED',
      reviewResolvedBy: 'ops',
      reviewNote: 'Called the customer back',
    });
    const audit = await db.operatorAuditEvent.findFirstOrThrow();
    expect(audit).toMatchObject({
      actorId: 'ops',
      action: 'REVIEW_RESOLVED',
      targetType: 'REVIEW',
      targetId: review.id,
      requestId: 'req-test-00000001',
      metadata: { resolution: 'MARK_HANDLED', resolvedCount: 1, leadId: lead.id, hasNote: true },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('Called the customer');
  });

  it('is idempotent for the same resolution and rejects a conflicting one', async () => {
    const { review } = await escalatedLead();
    await resolveReview(db, review.id, { resolution: 'MARK_HANDLED', note: null }, context());

    const repeated = await resolveReview(
      db,
      review.id,
      { resolution: 'MARK_HANDLED', note: null },
      context(),
    );
    expect(repeated).toMatchObject({ changed: false, resolvedCount: 0 });
    await expect(
      resolveReview(db, review.id, { resolution: 'RESUME_AUTOMATION', note: null }, context()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await auditCount('REVIEW_RESOLVED')).toBe(1);
  });

  it('resume automation resolves the escalations that were blocking automated replies', async () => {
    const { lead, member, messaging, ai } = await escalatedLead();

    // Blocked: a clear positive reply still waits for the human.
    const blocked = await replyFromLead(db, ai, messaging, lead.phone, 'Yes, I am interested');
    expect(await processingOf(blocked)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'AWAITING_HUMAN_REVIEW',
    });
    expect(await statusOf(member.id)).toBe('STEP_1_SENT');

    const resumed = await resumeLeadAutomation(db, lead.id, context());
    expect(resumed).toMatchObject({ changed: true, resolvedReviews: 2 });
    expect(
      await db.replyProcessing.count({
        where: { leadId: lead.id, status: 'ESCALATED', reviewResolvedAt: null },
      }),
    ).toBe(0);

    // Unblocked: the next eligible reply is handled automatically.
    const next = await replyFromLead(db, ai, messaging, lead.phone, 'Yes please, book me in');
    expect(await processingOf(next)).toMatchObject({ status: 'COMPLETED', action: 'ENGAGE' });
    expect(await statusOf(member.id)).toBe('ENGAGED');

    // History is kept; a repeat changes nothing and adds no audit.
    expect(await db.replyProcessing.count({ where: { leadId: lead.id } })).toBe(3);
    expect(await resumeLeadAutomation(db, lead.id, context())).toMatchObject({ changed: false });
    expect(await auditCount('RESUME_AUTOMATION')).toBe(1);
  });

  it('keep-takeover resolution preserves the pause', async () => {
    const { review, lead, messaging, ai } = await escalatedLead();

    const result = await resolveReview(
      db,
      review.id,
      { resolution: 'KEEP_HUMAN_TAKEOVER', note: null },
      context(),
    );
    expect(result.automation?.mode).toBe('HUMAN_TAKEOVER');
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).automationPausedAt,
    ).not.toBeNull();

    const next = await replyFromLead(db, ai, messaging, lead.phone, 'Yes please');
    expect(await processingOf(next)).toMatchObject({
      status: 'ESCALATED',
      escalationReason: 'HUMAN_TAKEOVER',
    });
  });

  it('archives through the transition service, withdrawing an open booking offer', async () => {
    const qualified = await qualifiedMember(db);
    const inbound = await replyFromLead(
      db,
      qualified.ai,
      qualified.messaging,
      qualified.lead.phone,
      'hm',
      'AMBIGUOUS',
      0.3,
    );
    const review = await processingOf(inbound);

    const result = await resolveReview(
      db,
      review.id,
      { resolution: 'ARCHIVE', note: null },
      context(),
    );
    expect(result).toMatchObject({ changed: true, membershipStatus: 'DORMANT_ARCHIVED' });
    expect(await statusOf(qualified.member.id)).toBe('DORMANT_ARCHIVED');
    expect(
      await db.bookingOpportunity.findUniqueOrThrow({ where: { id: qualified.opportunity.id } }),
    ).toMatchObject({ status: 'CANCELLED' });
  });

  it('refuses to archive a BOOKED membership and leaves the review open', async () => {
    const qualified = await qualifiedMember(db);
    await applyBookingEvent(
      db,
      'fakecal',
      bookingEvent({
        kind: 'BOOKING_CREATED',
        bookingReference: qualified.opportunity.bookingReference,
      }),
      { transactionTimeoutMs: 30_000 },
    );
    const inbound = await replyFromLead(
      db,
      qualified.ai,
      qualified.messaging,
      qualified.lead.phone,
      'hm',
      'AMBIGUOUS',
      0.3,
    );
    const review = await processingOf(inbound);

    await expect(
      resolveReview(db, review.id, { resolution: 'ARCHIVE', note: null }, context()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await statusOf(qualified.member.id)).toBe('BOOKED');
    expect((await processingOf(inbound)).reviewResolvedAt).toBeNull();
    expect(
      await db.bookingOpportunity.findUniqueOrThrow({ where: { id: qualified.opportunity.id } }),
    ).toMatchObject({ status: 'CONFIRMED' });
    expect(await auditCount('REVIEW_RESOLVED')).toBe(0);
  });

  it('keeps suppression stronger than an operator resuming automation', async () => {
    const messaging = new FakeMessagingProvider();
    const campaign = await createMessagingCampaign(db);
    const [member] = await queuedMembers(db, campaign.id, [{}]);
    if (member === undefined) throw new Error('no member');
    const lead = await db.lead.findUniqueOrThrow({ where: { id: member.leadId } });

    await takeOverLead(db, lead.id, context());
    await receive(db, lead.phone, 'STOP');
    const resumed = await resumeLeadAutomation(db, lead.id, context());
    expect(resumed.automation.mode).toBe('AUTOMATION_ACTIVE');

    const sent = await sendStep1Message(outboundDeps(db, messaging), member.id, NY_MORNING);
    expect(['CANCELLED_SUPPRESSED', 'SKIPPED_NOT_QUEUED']).toContain(sent.outcome);
    expect(messaging.calls).toHaveLength(0);
    expect(await statusOf(member.id)).toBe('OPTED_OUT');
    expect(await auditCount('HUMAN_TAKEOVER')).toBe(1);
  });
});
