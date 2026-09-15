import { z } from 'zod';

/**
 * Operator-defined qualification and booking settings, stored in the campaign
 * config snapshot. A deliberately small rule set: every configured field is
 * required, and each may add value requirements. Nothing here is industry-specific.
 */

/** Short keys keep `<campaignLeadId>:QUALIFICATION_QUESTION:<key>` within Message.sendKey (80). */
export const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,19}$/;

export const BOOKING_URL_PLACEHOLDER = '{{bookingUrl}}';

const text = z.string().trim().min(1).max(200);

const requirementSchema = z.discriminatedUnion('kind', [
  /** Value must be known. Implied for every field; allowed for readability. */
  z.object({ kind: z.literal('present') }).strict(),
  /** Exact match. Strings compare case-insensitively after trimming. */
  z.object({ kind: z.literal('equals'), value: z.union([text, z.number(), z.boolean()]) }).strict(),
  /** String field: value must be one of these (case-insensitive). */
  z.object({ kind: z.literal('oneOf'), values: z.array(text).min(1).max(50) }).strict(),
  /** Number field: value >= min. */
  z.object({ kind: z.literal('min'), value: z.number() }).strict(),
  /** Number field: value <= max. */
  z.object({ kind: z.literal('max'), value: z.number() }).strict(),
]);

export type QualificationRequirement = z.infer<typeof requirementSchema>;

export const FIELD_TYPES = ['string', 'number', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const fieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY, 'must start with a lowercase letter, max 20 characters'),
    type: z.enum(FIELD_TYPES),
    /** Tells the extractor what to look for. Never used to decide qualification. */
    description: text,
    /** Fixed text sent when this is the next missing field. No question = never asked. */
    question: z.string().trim().min(1).max(320).optional(),
    requirements: z.array(requirementSchema).max(5).default([]),
  })
  .strict()
  .superRefine((field, ctx) => {
    field.requirements.forEach((requirement, index) => {
      const problem = requirementTypeProblem(field.type, requirement);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', path: ['requirements', index], message: problem });
      }
    });
  });

export type QualificationField = z.infer<typeof fieldSchema>;

export const qualificationConfigSchema = z
  .object({ fields: z.array(fieldSchema).min(1).max(20) })
  .strict()
  .refine((config) => new Set(config.fields.map((f) => f.key)).size === config.fields.length, {
    path: ['fields'],
    message: 'field keys must be unique',
  });

export type QualificationConfig = z.infer<typeof qualificationConfigSchema>;

export const bookingConfigSchema = z
  .object({
    /** Calendar provider name whose verified webhooks confirm these bookings. */
    provider: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    /** Operator-supplied scheduling page. */
    url: z.url({ protocol: /^https$/ }).max(800),
    /** Query parameter carrying the booking reference back through the provider. */
    referenceParam: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .default('ref'),
    /** Fixed SMS text containing `{{bookingUrl}}` exactly once. */
    message: z
      .string()
      .trim()
      .min(1)
      .max(320)
      .refine((value) => value.split(BOOKING_URL_PLACEHOLDER).length === 2, {
        message: `must contain ${BOOKING_URL_PLACEHOLDER} exactly once`,
      }),
  })
  .strict();

export type BookingConfig = z.infer<typeof bookingConfigSchema>;

function requirementTypeProblem(
  type: FieldType,
  requirement: QualificationRequirement,
): string | null {
  switch (requirement.kind) {
    case 'present':
      return null;
    case 'equals':
      return typeof requirement.value === type ? null : `equals value must be a ${type}`;
    case 'oneOf':
      return type === 'string' ? null : 'oneOf applies to string fields only';
    case 'min':
    case 'max':
      return type === 'number' ? null : `${requirement.kind} applies to number fields only`;
  }
}
