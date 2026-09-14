import { z } from 'zod';

/**
 * Deterministic Step 1 templates. `{{name}}` placeholders are substituted with
 * plain string replacement; nothing is evaluated. A template that could render
 * with a missing value is rejected when the campaign config is validated.
 */

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const LEAD_TEMPLATE_VARIABLES = ['firstName', 'lastName'] as const;
type LeadTemplateVariable = (typeof LEAD_TEMPLATE_VARIABLES)[number];

const MAX_TEMPLATE_LENGTH = 480;
export const MAX_RENDERED_LENGTH = 640;
const MAX_LEAD_VALUE_LENGTH = 40;

const baseTemplateSchema = z.object({
  body: z.string().trim().min(1).max(MAX_TEMPLATE_LENGTH),
  variables: z
    .record(z.string().regex(VARIABLE_NAME), z.string().trim().min(1).max(200))
    .default({}),
  fallbacks: z
    .object({
      firstName: z.string().trim().min(1).max(MAX_LEAD_VALUE_LENGTH).optional(),
      lastName: z.string().trim().min(1).max(MAX_LEAD_VALUE_LENGTH).optional(),
    })
    .strict()
    .default({}),
});

export type Step1Template = z.infer<typeof baseTemplateSchema>;

export const step1TemplateSchema = baseTemplateSchema.superRefine((template, ctx) => {
  for (const message of templateIssues(template)) {
    ctx.addIssue({ code: 'custom', path: ['body'], message });
  }
});

export interface TemplateLead {
  firstName: string | null;
  lastName: string | null;
}

export type RenderResult = { ok: true; body: string } | { ok: false; reason: string };

/** Problems that would make the template unrenderable for some lead. */
export function templateIssues(template: Step1Template): string[] {
  const issues: string[] = [];
  const outsidePlaceholders = template.body.replace(PLACEHOLDER, '');
  if (outsidePlaceholders.includes('{{') || outsidePlaceholders.includes('}}')) {
    issues.push('has unbalanced {{ }} braces');
  }
  for (const match of template.body.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!VARIABLE_NAME.test(name)) {
      issues.push(`invalid variable name "${name}"`);
    } else if (isLeadVariable(name)) {
      if (template.fallbacks[name] === undefined)
        issues.push(`lead variable "${name}" needs a fallback`);
    } else if (!Object.hasOwn(template.variables, name)) {
      issues.push(`variable "${name}" is not defined`);
    }
  }
  return issues;
}

/** Produce the exact body to send, or a reason it cannot be produced. */
export function renderStep1Message(template: Step1Template, lead: TemplateLead): RenderResult {
  const issues = templateIssues(template);
  if (issues.length > 0) return { ok: false, reason: issues.join('; ') };

  const body = template.body.replace(PLACEHOLDER, (_placeholder, rawName: string) => {
    const name = rawName.trim();
    if (isLeadVariable(name)) return cleanLeadValue(lead[name]) ?? template.fallbacks[name] ?? '';
    return Object.hasOwn(template.variables, name) ? (template.variables[name] ?? '') : '';
  });

  if (body.length > MAX_RENDERED_LENGTH)
    return { ok: false, reason: 'rendered message is too long' };
  return { ok: true, body };
}

function isLeadVariable(name: string): name is LeadTemplateVariable {
  return (LEAD_TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

/** Lead data is untrusted: strip control/format characters and overlong values. */
function cleanLeadValue(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' || cleaned.length > MAX_LEAD_VALUE_LENGTH ? null : cleaned;
}
