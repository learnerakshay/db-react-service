import { describe, expect, it } from 'vitest';
import type { IntentAnalysis } from '../../src/modules/replies/classifier.js';
import { routeReply, type RouterInput } from '../../src/modules/replies/router.js';
import { REPLY_TEMPLATES } from '../helpers/replies.js';

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

const base: RouterInput = {
  analysis: analysis('POSITIVE_INTEREST'),
  confidenceThreshold: 0.75,
  resolution: 'MATCHED',
  membershipStatus: 'STEP_1_SENT',
  awaitingHumanReview: false,
  clarificationAlreadySent: false,
  templates: REPLY_TEMPLATES,
};

describe('deterministic reply router', () => {
  it('maps confident classifications to their allowed actions', () => {
    expect(routeReply(base)).toEqual({ action: 'ENGAGE', reply: REPLY_TEMPLATES.positive });
    expect(routeReply({ ...base, analysis: analysis('SPECIFIC_QUESTION') })).toEqual({
      action: 'ANSWER_QUESTION',
    });
    expect(routeReply({ ...base, analysis: analysis('NOT_INTERESTED') })).toEqual({
      action: 'CLOSE_DECLINED',
      reply: REPLY_TEMPLATES.decline,
    });
    expect(routeReply({ ...base, analysis: analysis('HARD_OPT_OUT') })).toEqual({
      action: 'OPT_OUT',
    });
    expect(routeReply({ ...base, analysis: analysis('AMBIGUOUS') })).toEqual({
      action: 'CLARIFY',
      reply: REPLY_TEMPLATES.clarify,
    });
  });

  it('escalates anything below the confidence threshold, including suspected opt-outs', () => {
    for (const classification of [
      'POSITIVE_INTEREST',
      'SPECIFIC_QUESTION',
      'NOT_INTERESTED',
      'HARD_OPT_OUT',
      'AMBIGUOUS',
    ] as const) {
      expect(routeReply({ ...base, analysis: analysis(classification, 0.74) })).toEqual({
        action: 'HUMAN_REVIEW',
        reason: 'LOW_CONFIDENCE',
        engage: false,
      });
    }
    expect(routeReply({ ...base, analysis: analysis('POSITIVE_INTEREST', 0.75) }).action).toBe(
      'ENGAGE',
    );
  });

  it('opts out without campaign context but never replies without one', () => {
    for (const resolution of ['AMBIGUOUS_CAMPAIGN', 'NO_CAMPAIGN', 'UNKNOWN_SENDER'] as const) {
      expect(routeReply({ ...base, resolution, analysis: analysis('HARD_OPT_OUT') })).toEqual({
        action: 'OPT_OUT',
      });
      expect(routeReply({ ...base, resolution, membershipStatus: null })).toEqual({
        action: 'HUMAN_REVIEW',
        reason: resolution,
        engage: false,
      });
    }
  });

  it('does not automate closed conversations or ones awaiting a human', () => {
    for (const membershipStatus of ['OPTED_OUT', 'DORMANT_ARCHIVED', 'QUEUED', 'BOOKED'] as const) {
      expect(routeReply({ ...base, membershipStatus })).toMatchObject({
        action: 'HUMAN_REVIEW',
        reason: 'CONVERSATION_CLOSED',
      });
    }
    expect(routeReply({ ...base, membershipStatus: 'ENGAGED' }).action).toBe('ENGAGE');
    expect(routeReply({ ...base, awaitingHumanReview: true })).toMatchObject({
      reason: 'AWAITING_HUMAN_REVIEW',
    });
  });

  it('escalates when no approved template exists, and clarifies at most once', () => {
    expect(routeReply({ ...base, templates: {} })).toEqual({
      action: 'HUMAN_REVIEW',
      reason: 'NO_REPLY_TEMPLATE',
      engage: true,
    });
    expect(routeReply({ ...base, templates: {}, analysis: analysis('NOT_INTERESTED') })).toEqual({
      action: 'CLOSE_DECLINED',
      reply: null,
    });
    expect(
      routeReply({ ...base, analysis: analysis('AMBIGUOUS'), clarificationAlreadySent: true }),
    ).toMatchObject({
      reason: 'AMBIGUOUS_REPLY',
    });
    expect(routeReply({ ...base, analysis: analysis('AMBIGUOUS'), templates: {} })).toMatchObject({
      reason: 'AMBIGUOUS_REPLY',
    });
  });
});
