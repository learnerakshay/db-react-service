import { CampaignLeadStatus, CampaignStatus } from '../../generated/prisma/enums.js';
import {
  isWithinSendWindow,
  localTimeOfDay,
  resolveRecipientTimezone,
  type SendWindow,
  type TimezoneSource,
} from './send-window.js';

export type IneligibleReason =
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'INVALID_MEMBERSHIP_STATE'
  | 'SUPPRESSED'
  | 'TIMEZONE_UNAVAILABLE'
  | 'OUTSIDE_SEND_WINDOW'
  | 'HOURLY_LIMIT_REACHED';

export type DispatchEligibility =
  | {
      eligible: true;
      reason: 'ELIGIBLE';
      timezone: string;
      timezoneSource: TimezoneSource;
      localTime: string;
    }
  | { eligible: false; reason: IneligibleReason };

export interface EligibilityInput {
  campaignStatus: CampaignStatus;
  sendWindow: SendWindow;
  campaignTimezone: string | null;
  membershipStatus: CampaignLeadStatus;
  leadTimezone: string | null;
  /** Result of a suppression lookup made at the admission point. */
  suppressed: boolean;
  remainingCapacity: number;
  /** Reference instant; never read from the clock here. */
  now: Date;
}

/**
 * The single authoritative dispatch-eligibility rule. Pure: all facts are
 * passed in, so it is deterministic and testable at any instant.
 *
 * Checks run in this order and the first failure is returned. Suppression is
 * checked before timing so a suppressed member is identified even outside
 * its window. Lead existence and a valid E.164 phone are guaranteed by
 * foreign key and CHECK constraints, so they need no reason code.
 */
export function evaluateDispatchEligibility(input: EligibilityInput): DispatchEligibility {
  if (input.campaignStatus !== CampaignStatus.ACTIVE) return ineligible('CAMPAIGN_NOT_ACTIVE');
  if (input.membershipStatus !== CampaignLeadStatus.STAGED) {
    return ineligible('INVALID_MEMBERSHIP_STATE');
  }
  if (input.suppressed) return ineligible('SUPPRESSED');

  const zone = resolveRecipientTimezone(input.leadTimezone, input.campaignTimezone);
  if (zone === null) return ineligible('TIMEZONE_UNAVAILABLE');

  const localTime = localTimeOfDay(input.now, zone.timezone);
  if (!isWithinSendWindow(localTime, input.sendWindow)) return ineligible('OUTSIDE_SEND_WINDOW');

  if (input.remainingCapacity <= 0) return ineligible('HOURLY_LIMIT_REACHED');

  return {
    eligible: true,
    reason: 'ELIGIBLE',
    timezone: zone.timezone,
    timezoneSource: zone.source,
    localTime,
  };
}

function ineligible(reason: IneligibleReason): DispatchEligibility {
  return { eligible: false, reason };
}
