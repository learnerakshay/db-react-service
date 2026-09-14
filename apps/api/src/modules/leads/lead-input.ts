import type { LeadInputField } from '@cadentor/shared';
import { z } from 'zod';
import { isValidTimeZone } from '../../config/env.js';
import { normalizeEmail } from './email.js';
import { normalizePhone, type CountryCode, type PhoneRejection } from './phone.js';

/**
 * Canonical lead input produced by every ingestion adapter (CSV today; CRM and
 * Sheets later). Values are raw strings exactly as read from the source.
 */
export type RawLeadInput = Partial<Record<LeadInputField, string>>;

/** A lead ready to persist. Field names match the Lead model. */
export interface NormalizedLead {
  phone: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  source: string;
  externalId: string | null;
  lastServiceAt: Date | null;
  timezone: string | null;
}

export interface NormalizationContext {
  /** Only set when the import explicitly supplied a country. */
  defaultCountry: CountryCode | undefined;
  /** Used when the row carries no source of its own. */
  sourceLabel: string;
}

export type LeadNormalization =
  | { ok: true; lead: NormalizedLead; ignoredFields: LeadInputField[] }
  | { ok: false; reason: PhoneRejection };

const MAX_NAME_LENGTH = 100;
const MAX_SOURCE_LENGTH = 200;
const MAX_EXTERNAL_ID_LENGTH = 200;

const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/**
 * Contact identity rule: a valid phone is the only required field, because
 * this service reaches leads by SMS. The row is rejected only when the phone
 * is missing or invalid. Any other invalid optional field is dropped and
 * reported in `ignoredFields`; it never silently passes through.
 */
export function normalizeLeadInput(
  input: RawLeadInput,
  context: NormalizationContext,
): LeadNormalization {
  const phone = normalizePhone(input.phone, context.defaultCountry);
  if (!phone.ok) return { ok: false, reason: phone.reason };

  const ignoredFields: LeadInputField[] = [];

  const text = (field: LeadInputField, maxLength: number): string | null => {
    const value = input[field]?.trim() ?? '';
    if (value === '') return null;
    if (value.length > maxLength) {
      ignoredFields.push(field);
      return null;
    }
    return value;
  };

  const firstName = text('firstName', MAX_NAME_LENGTH);
  const lastName = text('lastName', MAX_NAME_LENGTH);
  const source = text('source', MAX_SOURCE_LENGTH) ?? context.sourceLabel;
  const externalId = text('externalId', MAX_EXTERNAL_ID_LENGTH);

  const email = normalizeEmail(input.email);
  if (!email.ok) ignoredFields.push('email');

  let lastServiceAt: Date | null = null;
  const rawDate = input.lastServiceDate?.trim() ?? '';
  if (rawDate !== '') {
    if (isoDate.safeParse(rawDate).success) {
      lastServiceAt = new Date(rawDate.slice(0, 10));
    } else {
      ignoredFields.push('lastServiceDate');
    }
  }

  let timezone: string | null = null;
  const rawTimezone = input.timezone?.trim() ?? '';
  if (rawTimezone !== '') {
    if (isValidTimeZone(rawTimezone)) {
      timezone = rawTimezone;
    } else {
      ignoredFields.push('timezone');
    }
  }

  return {
    ok: true,
    lead: {
      phone: phone.e164,
      email: email.ok ? email.email : null,
      firstName,
      lastName,
      source,
      externalId,
      lastServiceAt,
      timezone,
    },
    ignoredFields,
  };
}
