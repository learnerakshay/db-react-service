import { describe, expect, it } from 'vitest';
import { campaignConfigSchema } from '../../src/modules/campaigns/campaigns.js';
import {
  renderStep1Message,
  step1TemplateSchema,
  type Step1Template,
} from '../../src/modules/messaging/template.js';

const template: Step1Template = {
  body: 'Hey {{firstName}}, are you still looking to {{ outcome }}?',
  variables: { outcome: 'book a tune-up' },
  fallbacks: { firstName: 'there' },
};

describe('step 1 template rendering', () => {
  it('renders explicit variables and the lead first name', () => {
    expect(renderStep1Message(template, { firstName: 'Jane', lastName: null })).toEqual({
      ok: true,
      body: 'Hey Jane, are you still looking to book a tune-up?',
    });
  });

  it('uses the fallback for missing, blank or overlong names', () => {
    for (const firstName of [null, '   ', 'x'.repeat(41)]) {
      expect(renderStep1Message(template, { firstName, lastName: null })).toEqual({
        ok: true,
        body: 'Hey there, are you still looking to book a tune-up?',
      });
    }
  });

  it('treats lead values as plain text', () => {
    const result = renderStep1Message(template, {
      firstName: 'Jane\n{{outcome}} $& $1',
      lastName: null,
    });
    expect(result).toEqual({
      ok: true,
      body: 'Hey Jane {{outcome}} $& $1, are you still looking to book a tune-up?',
    });
  });

  it('refuses templates that cannot render for every lead', () => {
    const cases: [Step1Template, string][] = [
      [{ ...template, fallbacks: {} }, 'lead variable "firstName" needs a fallback'],
      [{ ...template, variables: {} }, 'variable "outcome" is not defined'],
      [{ ...template, body: 'Hi {{constructor}}' }, 'variable "constructor" is not defined'],
      [{ ...template, body: 'Hi {{ first-name }}' }, 'invalid variable name "first-name"'],
      [{ ...template, body: 'Hi {{firstName}' }, 'has unbalanced {{ }} braces'],
    ];
    for (const [broken, message] of cases) {
      const rendered = renderStep1Message(broken, { firstName: 'Jane', lastName: null });
      expect(rendered.ok).toBe(false);
      const parsed = step1TemplateSchema.safeParse(broken);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((i) => i.message)).toContain(message);
    }
  });

  it('is validated as part of campaign config', () => {
    const base = {
      timezone: 'America/New_York',
      sendWindow: { start: '09:00', end: '18:00' },
      hourlyDispatchLimit: 30,
      followUpDelayHours: 48,
      archiveDelayDays: 14,
    };
    expect(campaignConfigSchema.safeParse(base).success).toBe(true);
    expect(campaignConfigSchema.safeParse({ ...base, messages: { step1: template } }).success).toBe(
      true,
    );
    expect(
      campaignConfigSchema.safeParse({ ...base, messages: { step1: { body: 'Hi {{firstName}}' } } })
        .success,
    ).toBe(false);
  });
});
