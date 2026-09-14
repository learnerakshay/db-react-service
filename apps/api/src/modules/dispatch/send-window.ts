import { isValidTimeZone } from '../../config/env.js';

/** Recipient-local window, HH:MM 24h. `start` is inclusive, `end` exclusive. */
export interface SendWindow {
  start: string;
  end: string;
}

export type TimezoneSource = 'LEAD' | 'CAMPAIGN';

export interface ResolvedTimezone {
  timezone: string;
  source: TimezoneSource;
}

/**
 * Timezone resolution order:
 *   1. the lead's stored timezone, when valid
 *   2. the campaign's explicit fallback timezone, when configured and valid
 *   3. none — the lead is not dispatch-eligible
 * Never inferred from phone number, IP, address or geography.
 */
export function resolveRecipientTimezone(
  leadTimezone: string | null,
  campaignTimezone: string | null,
): ResolvedTimezone | null {
  if (leadTimezone !== null && isValidTimeZone(leadTimezone)) {
    return { timezone: leadTimezone, source: 'LEAD' };
  }
  if (campaignTimezone !== null && isValidTimeZone(campaignTimezone)) {
    return { timezone: campaignTimezone, source: 'CAMPAIGN' };
  }
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Wall-clock "HH:MM" at `instant` in an IANA timezone. Uses the runtime's ICU
 * timezone database, so DST transitions are applied correctly.
 */
export function localTimeOfDay(instant: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }

  let hour = '';
  let minute = '';
  for (const part of formatter.formatToParts(instant)) {
    if (part.type === 'hour') hour = part.value;
    else if (part.type === 'minute') minute = part.value;
  }
  return `${hour}:${minute}`;
}

/** HH:MM strings compare correctly as text. */
export function isWithinSendWindow(localTime: string, window: SendWindow): boolean {
  return localTime >= window.start && localTime < window.end;
}
