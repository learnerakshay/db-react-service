import {
  CampaignLeadStatus,
  EscalationReason,
  InboundResolution,
  IntentClassification,
} from '../../generated/prisma/enums.js';
import type { IntentAnalysis } from './classifier.js';
import type { ReplyTemplates } from './reply-templates.js';

export interface RouterInput {
  analysis: IntentAnalysis;
  confidenceThreshold: number;
  resolution: InboundResolution;
  /** Status of the matched membership; null when there is none. */
  membershipStatus: CampaignLeadStatus | null;
  /** An earlier message from this lead is still escalated to a human. */
  awaitingHumanReview: boolean;
  /** A clarification was already sent in this conversation. */
  clarificationAlreadySent: boolean;
  templates: ReplyTemplates;
}

export type RouteDecision =
  | { action: 'OPT_OUT' }
  | { action: 'ENGAGE'; reply: string }
  | { action: 'ANSWER_QUESTION' }
  | { action: 'CLOSE_DECLINED'; reply: string | null }
  | { action: 'CLARIFY'; reply: string }
  | { action: 'HUMAN_REVIEW'; reason: EscalationReason; engage: boolean };

const OPEN_CONVERSATION: readonly CampaignLeadStatus[] = [
  CampaignLeadStatus.STEP_1_SENT,
  CampaignLeadStatus.ENGAGED,
];

const RESOLUTION_REASON: Readonly<Record<Exclude<InboundResolution, 'MATCHED'>, EscalationReason>> =
  {
    AMBIGUOUS_CAMPAIGN: EscalationReason.AMBIGUOUS_CAMPAIGN,
    NO_CAMPAIGN: EscalationReason.NO_CAMPAIGN,
    UNKNOWN_SENDER: EscalationReason.UNKNOWN_SENDER,
  };

function review(reason: EscalationReason, engage = false): RouteDecision {
  return { action: 'HUMAN_REVIEW', reason, engage };
}

/**
 * The single mapping from a validated analysis to allowed actions. Pure and
 * deterministic: the model only supplies the classification and confidence.
 *
 *  1. Below the confidence threshold nothing semantic happens → human review
 *     (this includes suspected opt-outs: no promotional conversation continues).
 *  2. Confident HARD_OPT_OUT → opt out, even without campaign context
 *     (suppression is lead-level and always safe).
 *  3. Everything else needs one matched, open conversation and no pending
 *     human review; otherwise → human review.
 *  4. POSITIVE_INTEREST → engage + configured reply; QUESTION → grounded answer;
 *     NOT_INTERESTED → close + optional acknowledgement; AMBIGUOUS → one
 *     configured clarification, then human review.
 */
export function routeReply(input: RouterInput): RouteDecision {
  const { analysis, templates } = input;

  if (analysis.confidence < input.confidenceThreshold)
    return review(EscalationReason.LOW_CONFIDENCE);
  if (analysis.classification === IntentClassification.HARD_OPT_OUT) return { action: 'OPT_OUT' };

  if (input.resolution !== InboundResolution.MATCHED)
    return review(RESOLUTION_REASON[input.resolution]);
  if (input.membershipStatus === null || !OPEN_CONVERSATION.includes(input.membershipStatus)) {
    return review(EscalationReason.CONVERSATION_CLOSED);
  }
  if (input.awaitingHumanReview) return review(EscalationReason.AWAITING_HUMAN_REVIEW);

  switch (analysis.classification) {
    case IntentClassification.POSITIVE_INTEREST:
      return templates.positive === undefined
        ? review(EscalationReason.NO_REPLY_TEMPLATE, true)
        : { action: 'ENGAGE', reply: templates.positive };
    case IntentClassification.SPECIFIC_QUESTION:
      return { action: 'ANSWER_QUESTION' };
    case IntentClassification.NOT_INTERESTED:
      return { action: 'CLOSE_DECLINED', reply: templates.decline ?? null };
    case IntentClassification.AMBIGUOUS:
      return input.clarificationAlreadySent || templates.clarify === undefined
        ? review(EscalationReason.AMBIGUOUS_REPLY)
        : { action: 'CLARIFY', reply: templates.clarify };
  }
}
