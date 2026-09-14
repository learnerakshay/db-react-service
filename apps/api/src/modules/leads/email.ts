import { z } from 'zod';

const MAX_EMAIL_LENGTH = 254;
const emailSyntax = z.email();

export type EmailNormalization = { ok: true; email: string | null } | { ok: false };

/**
 * Canonical form: trimmed and lowercased. Syntax check only; this says nothing
 * about deliverability. A blank value is valid and means "no email".
 */
export function normalizeEmail(raw: string | undefined): EmailNormalization {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return { ok: true, email: null };
  if (value.length > MAX_EMAIL_LENGTH || !emailSyntax.safeParse(value).success) {
    return { ok: false };
  }
  return { ok: true, email: value };
}
