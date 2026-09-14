import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../../src/modules/leads/email.js';
import { normalizeLeadInput } from '../../src/modules/leads/lead-input.js';
import { normalizePhone } from '../../src/modules/leads/phone.js';

describe('normalizePhone', () => {
  it('accepts valid E.164 numbers unchanged', () => {
    expect(normalizePhone('+14155552671')).toEqual({ ok: true, e164: '+14155552671' });
    expect(normalizePhone('+447911123456')).toEqual({ ok: true, e164: '+447911123456' });
  });

  it('normalizes international formatting to E.164', () => {
    expect(normalizePhone(' +1 (415) 555-2671 ')).toEqual({ ok: true, e164: '+14155552671' });
    expect(normalizePhone('+44 7911 123456')).toEqual({ ok: true, e164: '+447911123456' });
  });

  it('normalizes local numbers only with an explicit country', () => {
    expect(normalizePhone('(415) 555-2671', 'US')).toEqual({ ok: true, e164: '+14155552671' });
    expect(normalizePhone('07911 123456', 'GB')).toEqual({ ok: true, e164: '+447911123456' });
  });

  it('never guesses a country for a national-format number', () => {
    expect(normalizePhone('(415) 555-2671')).toEqual({
      ok: false,
      reason: 'PHONE_COUNTRY_REQUIRED',
    });
  });

  it('keeps an international number when a different default country is given', () => {
    expect(normalizePhone('+44 7911 123456', 'US')).toEqual({ ok: true, e164: '+447911123456' });
  });

  it('rejects impossible or unparseable numbers', () => {
    expect(normalizePhone('12345', 'US')).toEqual({ ok: false, reason: 'INVALID_PHONE' });
    expect(normalizePhone('+1 555', 'US')).toEqual({ ok: false, reason: 'INVALID_PHONE' });
    expect(normalizePhone('+1 000 000 0000')).toEqual({ ok: false, reason: 'INVALID_PHONE' });
    expect(normalizePhone('call me maybe', 'US')).toEqual({ ok: false, reason: 'INVALID_PHONE' });
  });

  it('reports a missing phone', () => {
    expect(normalizePhone(undefined)).toEqual({ ok: false, reason: 'MISSING_PHONE' });
    expect(normalizePhone('   ')).toEqual({ ok: false, reason: 'MISSING_PHONE' });
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases valid addresses', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toEqual({
      ok: true,
      email: 'jane.doe@example.com',
    });
  });

  it('treats blank as no email', () => {
    expect(normalizeEmail(undefined)).toEqual({ ok: true, email: null });
    expect(normalizeEmail('  ')).toEqual({ ok: true, email: null });
  });

  it('rejects malformed addresses', () => {
    expect(normalizeEmail('jane@')).toEqual({ ok: false });
    expect(normalizeEmail('not an email')).toEqual({ ok: false });
    expect(normalizeEmail(`${'a'.repeat(250)}@x.com`)).toEqual({ ok: false });
  });
});

describe('normalizeLeadInput', () => {
  const context = { defaultCountry: undefined, sourceLabel: 'batch-label' };

  it('produces a normalized lead with the batch source as fallback', () => {
    const result = normalizeLeadInput(
      {
        phone: '+14155552671',
        firstName: ' Jane ',
        lastName: 'Doe',
        email: 'JANE@EXAMPLE.COM',
        externalId: 'crm-7',
        lastServiceDate: '2023-04-30',
        timezone: 'America/Los_Angeles',
      },
      context,
    );
    expect(result).toEqual({
      ok: true,
      ignoredFields: [],
      lead: {
        phone: '+14155552671',
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        source: 'batch-label',
        externalId: 'crm-7',
        lastServiceAt: new Date('2023-04-30T00:00:00.000Z'),
        timezone: 'America/Los_Angeles',
      },
    });
  });

  it('rejects the row only for phone problems', () => {
    expect(normalizeLeadInput({ firstName: 'No Phone' }, context)).toEqual({
      ok: false,
      reason: 'MISSING_PHONE',
    });
    expect(normalizeLeadInput({ phone: 'abc' }, context)).toEqual({
      ok: false,
      reason: 'INVALID_PHONE',
    });
  });

  it('keeps a valid-phone row but drops and reports invalid optional fields', () => {
    const result = normalizeLeadInput(
      {
        phone: '+14155552671',
        email: 'broken@',
        lastServiceDate: '04/30/2023',
        timezone: 'Mars/Olympus',
        firstName: 'x'.repeat(101),
      },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredFields.sort()).toEqual([
      'email',
      'firstName',
      'lastServiceDate',
      'timezone',
    ]);
    expect(result.lead).toMatchObject({
      email: null,
      firstName: null,
      lastServiceAt: null,
      timezone: null,
    });
  });

  it('rejects impossible calendar dates', () => {
    const result = normalizeLeadInput(
      { phone: '+14155552671', lastServiceDate: '2023-02-30' },
      context,
    );
    expect(result.ok && result.ignoredFields).toEqual(['lastServiceDate']);
  });
});
