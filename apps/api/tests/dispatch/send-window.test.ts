import { describe, expect, it } from 'vitest';
import {
  evaluateDispatchEligibility,
  type EligibilityInput,
} from '../../src/modules/dispatch/eligibility.js';
import {
  isWithinSendWindow,
  localTimeOfDay,
  resolveRecipientTimezone,
} from '../../src/modules/dispatch/send-window.js';

const WINDOW = { start: '09:00', end: '18:00' };

describe('localTimeOfDay', () => {
  it('converts an instant to recipient wall-clock time', () => {
    const instant = new Date('2026-07-15T14:05:00Z');
    expect(localTimeOfDay(instant, 'America/New_York')).toBe('10:05');
    expect(localTimeOfDay(instant, 'America/Los_Angeles')).toBe('07:05');
    expect(localTimeOfDay(instant, 'Europe/London')).toBe('15:05');
    expect(localTimeOfDay(instant, 'Asia/Kolkata')).toBe('19:35');
  });

  it('renders midnight as 00:00', () => {
    expect(localTimeOfDay(new Date('2026-07-15T04:00:00Z'), 'America/New_York')).toBe('00:00');
  });

  it('applies the US spring-forward DST change (2026-03-08)', () => {
    // Same UTC time, one day apart: EST (UTC-5) before, EDT (UTC-4) after.
    expect(localTimeOfDay(new Date('2026-03-07T13:30:00Z'), 'America/New_York')).toBe('08:30');
    expect(localTimeOfDay(new Date('2026-03-08T13:30:00Z'), 'America/New_York')).toBe('09:30');
  });

  it('applies the US fall-back DST change (2026-11-01)', () => {
    expect(localTimeOfDay(new Date('2026-10-31T22:30:00Z'), 'America/New_York')).toBe('18:30');
    expect(localTimeOfDay(new Date('2026-11-01T22:30:00Z'), 'America/New_York')).toBe('17:30');
  });

  it('applies UK DST independently of the US', () => {
    // 2026-03-15: US already on EDT, UK still on GMT.
    expect(localTimeOfDay(new Date('2026-03-15T08:30:00Z'), 'Europe/London')).toBe('08:30');
    expect(localTimeOfDay(new Date('2026-04-15T08:30:00Z'), 'Europe/London')).toBe('09:30');
  });
});

describe('isWithinSendWindow', () => {
  it('includes the start and excludes the end', () => {
    expect(isWithinSendWindow('08:59', WINDOW)).toBe(false);
    expect(isWithinSendWindow('09:00', WINDOW)).toBe(true);
    expect(isWithinSendWindow('17:59', WINDOW)).toBe(true);
    expect(isWithinSendWindow('18:00', WINDOW)).toBe(false);
  });
});

describe('resolveRecipientTimezone', () => {
  it('prefers a valid lead timezone', () => {
    expect(resolveRecipientTimezone('America/Chicago', 'America/New_York')).toEqual({
      timezone: 'America/Chicago',
      source: 'LEAD',
    });
  });

  it('falls back to the explicit campaign timezone', () => {
    expect(resolveRecipientTimezone(null, 'America/New_York')).toEqual({
      timezone: 'America/New_York',
      source: 'CAMPAIGN',
    });
    expect(resolveRecipientTimezone('Not/AZone', 'America/New_York')).toEqual({
      timezone: 'America/New_York',
      source: 'CAMPAIGN',
    });
  });

  it('returns null when neither is available', () => {
    expect(resolveRecipientTimezone(null, null)).toBeNull();
    expect(resolveRecipientTimezone('Not/AZone', null)).toBeNull();
  });
});

describe('evaluateDispatchEligibility', () => {
  const base: EligibilityInput = {
    campaignStatus: 'ACTIVE',
    sendWindow: WINDOW,
    campaignTimezone: 'America/New_York',
    membershipStatus: 'STAGED',
    leadTimezone: null,
    suppressed: false,
    remainingCapacity: 5,
    now: new Date('2026-07-15T14:00:00Z'), // 10:00 New York
  };

  it('admits an eligible member and explains the decision', () => {
    expect(evaluateDispatchEligibility(base)).toEqual({
      eligible: true,
      reason: 'ELIGIBLE',
      timezone: 'America/New_York',
      timezoneSource: 'CAMPAIGN',
      localTime: '10:00',
    });
  });

  it.each([
    [{ campaignStatus: 'DRAFT' }, 'CAMPAIGN_NOT_ACTIVE'],
    [{ campaignStatus: 'PAUSED' }, 'CAMPAIGN_NOT_ACTIVE'],
    [{ campaignStatus: 'COMPLETED' }, 'CAMPAIGN_NOT_ACTIVE'],
    [{ membershipStatus: 'QUEUED' }, 'INVALID_MEMBERSHIP_STATE'],
    [{ membershipStatus: 'OPTED_OUT' }, 'INVALID_MEMBERSHIP_STATE'],
    [{ suppressed: true }, 'SUPPRESSED'],
    [{ campaignTimezone: null }, 'TIMEZONE_UNAVAILABLE'],
    [{ now: new Date('2026-07-15T12:00:00Z') }, 'OUTSIDE_SEND_WINDOW'],
    [{ leadTimezone: 'America/Los_Angeles' }, 'OUTSIDE_SEND_WINDOW'],
    [{ remainingCapacity: 0 }, 'HOURLY_LIMIT_REACHED'],
  ] as const)('%o -> %s', (override, reason) => {
    expect(evaluateDispatchEligibility({ ...base, ...override })).toEqual({
      eligible: false,
      reason,
    });
  });

  it('reports suppression even outside the send window', () => {
    const result = evaluateDispatchEligibility({
      ...base,
      suppressed: true,
      now: new Date('2026-07-15T03:00:00Z'),
    });
    expect(result.reason).toBe('SUPPRESSED');
  });
});
