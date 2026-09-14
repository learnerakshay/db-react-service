import {
  isSupportedCountry,
  ParseError,
  parsePhoneNumberWithError,
  type CountryCode,
} from 'libphonenumber-js/max';

export type { CountryCode };

export type PhoneRejection = 'MISSING_PHONE' | 'INVALID_PHONE' | 'PHONE_COUNTRY_REQUIRED';

export type PhoneNormalization = { ok: true; e164: string } | { ok: false; reason: PhoneRejection };

export function isCountryCode(value: string): value is CountryCode {
  return isSupportedCountry(value);
}

/**
 * Normalize a raw phone number to E.164 using full libphonenumber metadata.
 *
 * - Numbers written internationally (+44 …) keep their own country regardless
 *   of `defaultCountry`.
 * - National-format numbers are only interpreted when `defaultCountry` was
 *   explicitly supplied by the import; the country is never guessed.
 * - Parsed but impossible numbers are rejected.
 */
export function normalizePhone(
  raw: string | undefined,
  defaultCountry?: CountryCode,
): PhoneNormalization {
  const input = raw?.trim() ?? '';
  if (input === '') return { ok: false, reason: 'MISSING_PHONE' };

  try {
    const parsed = parsePhoneNumberWithError(input, { defaultCountry, extract: false });
    return parsed.isValid()
      ? { ok: true, e164: parsed.number }
      : { ok: false, reason: 'INVALID_PHONE' };
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        ok: false,
        reason: err.message === 'INVALID_COUNTRY' ? 'PHONE_COUNTRY_REQUIRED' : 'INVALID_PHONE',
      };
    }
    throw err;
  }
}
