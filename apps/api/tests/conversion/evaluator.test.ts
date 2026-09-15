import { describe, expect, it } from 'vitest';
import { campaignConfigSchema } from '../../src/modules/campaigns/campaigns.js';
import { canTransitionCampaignLead } from '../../src/modules/campaigns/membership.js';
import {
  bookingConfigSchema,
  qualificationConfigSchema,
  type QualificationConfig,
} from '../../src/modules/conversion/config.js';
import { evaluateQualification } from '../../src/modules/conversion/evaluator.js';
import { BOOKING, QUALIFICATION } from '../helpers/conversion.js';

const rules: QualificationConfig = qualificationConfigSchema.parse({
  fields: [
    { key: 'serviceNeeded', type: 'string', description: 'service' },
    {
      key: 'serviceAreaEligible',
      type: 'boolean',
      description: 'in area',
      requirements: [{ kind: 'equals', value: true }],
    },
    {
      key: 'budget',
      type: 'number',
      description: 'budget',
      requirements: [
        { kind: 'min', value: 500 },
        { kind: 'max', value: 5000 },
      ],
    },
    { key: 'age', type: 'number', description: 'age', requirements: [{ kind: 'min', value: 18 }] },
    {
      key: 'city',
      type: 'string',
      description: 'city',
      requirements: [{ kind: 'oneOf', values: ['Dallas', 'Austin'] }],
    },
    {
      key: 'plan',
      type: 'string',
      description: 'plan',
      requirements: [{ kind: 'equals', value: 'Premium' }],
    },
  ],
});

const passing = {
  serviceNeeded: 'roof repair',
  serviceAreaEligible: true,
  budget: 700,
  age: 18,
  city: ' dallas ',
  plan: 'PREMIUM',
};

const facts = (values: Record<string, unknown>) => new Map(Object.entries(values));

describe('evaluateQualification (pure, no AI)', () => {
  it('qualifies when every rule passes (boundaries inclusive, strings case-insensitive)', () => {
    expect(evaluateQualification(rules, facts(passing))).toEqual({
      result: 'QUALIFIED',
      missingFields: [],
      failedRequirements: [],
      nextField: null,
    });
  });

  it('rejects when a known value fails a rule, naming the rule', () => {
    const decision = evaluateQualification(
      rules,
      facts({ ...passing, budget: 200, city: 'Houston' }),
    );
    expect(decision.result).toBe('NOT_QUALIFIED');
    expect(decision.failedRequirements).toEqual([
      { field: 'budget', requirement: { kind: 'min', value: 500 } },
      { field: 'city', requirement: { kind: 'oneOf', values: ['Dallas', 'Austin'] } },
    ]);
    expect(
      evaluateQualification(rules, facts({ ...passing, serviceAreaEligible: false })).result,
    ).toBe('NOT_QUALIFIED');
    expect(evaluateQualification(rules, facts({ ...passing, budget: 5001 })).result).toBe(
      'NOT_QUALIFIED',
    );
    expect(evaluateQualification(rules, facts({ ...passing, age: 17 })).result).toBe(
      'NOT_QUALIFIED',
    );
  });

  it('is pending with the first missing field (config order) when nothing failed', () => {
    const rest = Object.entries(passing).filter(
      ([key]) => key !== 'serviceNeeded' && key !== 'budget',
    );
    expect(evaluateQualification(rules, new Map(rest))).toEqual({
      result: 'PENDING_INFORMATION',
      missingFields: ['serviceNeeded', 'budget'],
      failedRequirements: [],
      nextField: 'serviceNeeded',
    });
  });

  it('a failed rule wins over missing information', () => {
    expect(evaluateQualification(rules, facts({ budget: 100 })).result).toBe('NOT_QUALIFIED');
  });

  it('treats wrong types and blank strings as missing, never as passing', () => {
    const decision = evaluateQualification(
      rules,
      facts({ ...passing, budget: '700', serviceAreaEligible: 'true', serviceNeeded: '  ' }),
    );
    expect(decision.result).toBe('PENDING_INFORMATION');
    expect(decision.missingFields).toEqual(['serviceNeeded', 'serviceAreaEligible', 'budget']);
  });

  it('has no input through which a model could assert the result', () => {
    const decision = evaluateQualification(
      rules,
      facts({ qualified: true, result: 'QUALIFIED', confidence: 1 }),
    );
    expect(decision.result).toBe('PENDING_INFORMATION');
  });
});

describe('qualification and booking config validation', () => {
  it('accepts the test configs inside a campaign config', () => {
    const parsed = campaignConfigSchema.safeParse({
      timezone: 'America/New_York',
      sendWindow: { start: '09:00', end: '18:00' },
      hourlyDispatchLimit: 10,
      followUpDelayHours: 48,
      archiveDelayDays: 14,
      qualification: QUALIFICATION,
      booking: BOOKING,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects rules that do not fit the field type, duplicate keys and long keys', () => {
    const field = { key: 'budget', type: 'string', description: 'x' };
    expect(
      qualificationConfigSchema.safeParse({
        fields: [{ ...field, requirements: [{ kind: 'min', value: 1 }] }],
      }).success,
    ).toBe(false);
    expect(
      qualificationConfigSchema.safeParse({
        fields: [{ ...field, type: 'number', requirements: [{ kind: 'oneOf', values: ['a'] }] }],
      }).success,
    ).toBe(false);
    expect(
      qualificationConfigSchema.safeParse({
        fields: [{ ...field, type: 'boolean', requirements: [{ kind: 'equals', value: 'yes' }] }],
      }).success,
    ).toBe(false);
    expect(qualificationConfigSchema.safeParse({ fields: [field, field] }).success).toBe(false);
    expect(
      qualificationConfigSchema.safeParse({
        fields: [{ ...field, key: 'aVeryLongFieldKeyOver20' }],
      }).success,
    ).toBe(false);
    expect(qualificationConfigSchema.safeParse({ fields: [] }).success).toBe(false);
  });

  it('requires an https booking url and exactly one {{bookingUrl}} placeholder', () => {
    expect(
      bookingConfigSchema.safeParse({ ...BOOKING, url: 'http://book.example.test' }).success,
    ).toBe(false);
    expect(bookingConfigSchema.safeParse({ ...BOOKING, message: 'Book now!' }).success).toBe(false);
    expect(
      bookingConfigSchema.safeParse({ ...BOOKING, message: '{{bookingUrl}} {{bookingUrl}}' })
        .success,
    ).toBe(false);
  });
});

describe('conversion transitions', () => {
  it('allows a cancelled booking to return to QUALIFIED and nothing else backwards', () => {
    expect(canTransitionCampaignLead('ENGAGED', 'QUALIFIED')).toBe(true);
    expect(canTransitionCampaignLead('QUALIFIED', 'BOOKED')).toBe(true);
    expect(canTransitionCampaignLead('BOOKED', 'QUALIFIED')).toBe(true);
    expect(canTransitionCampaignLead('BOOKED', 'ENGAGED')).toBe(false);
    expect(canTransitionCampaignLead('QUALIFIED', 'ENGAGED')).toBe(false);
    expect(canTransitionCampaignLead('DORMANT_ARCHIVED', 'QUALIFIED')).toBe(false);
  });
});
