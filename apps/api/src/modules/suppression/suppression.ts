import type { DbClient } from '../../db/client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { SuppressionReason, SuppressionSource } from '../../generated/prisma/enums.js';
import { ValidationError } from '../../lib/errors.js';
import { normalizeEmail } from '../leads/email.js';
import { normalizePhone, type CountryCode } from '../leads/phone.js';

export interface SuppressionInput {
  phone?: string;
  email?: string;
  /** Only needed when `phone` is written in national format. */
  defaultCountry?: CountryCode;
  reason: SuppressionReason;
  source: SuppressionSource;
  reference?: string;
  note?: string;
}

export interface SuppressedIdentities {
  phones: Set<string>;
  emails: Set<string>;
}

/**
 * Record a permanent, global suppression. Entries are append-only: the
 * database rejects UPDATE and DELETE on SuppressionEntry. Identities are
 * normalized with the same rules as leads so lookups always match.
 */
export async function addSuppression(db: DbClient, input: SuppressionInput) {
  let phone: string | null = null;
  if (input.phone !== undefined && input.phone.trim() !== '') {
    const normalized = normalizePhone(input.phone, input.defaultCountry);
    if (!normalized.ok) {
      throw new ValidationError('Invalid suppression phone', [
        { path: 'phone', message: normalized.reason },
      ]);
    }
    phone = normalized.e164;
  }

  const email = normalizeEmail(input.email);
  if (!email.ok) {
    throw new ValidationError('Invalid suppression email', [{ path: 'email', message: 'invalid' }]);
  }

  if (phone === null && email.email === null) {
    throw new ValidationError('A suppression entry requires a phone or an email');
  }

  return db.suppressionEntry.create({
    data: {
      phone,
      email: email.email,
      reason: input.reason,
      source: input.source,
      reference: input.reference ?? null,
      note: input.note ?? null,
    },
  });
}

/** Which of the given normalized identities are suppressed. One query. */
export async function findSuppressed(
  db: DbClient,
  identities: { phones: readonly string[]; emails: readonly string[] },
): Promise<SuppressedIdentities> {
  const result: SuppressedIdentities = { phones: new Set(), emails: new Set() };

  const conditions: Prisma.SuppressionEntryWhereInput[] = [];
  if (identities.phones.length > 0) conditions.push({ phone: { in: [...identities.phones] } });
  if (identities.emails.length > 0) conditions.push({ email: { in: [...identities.emails] } });
  if (conditions.length === 0) return result;

  const entries = await db.suppressionEntry.findMany({
    where: { OR: conditions },
    select: { phone: true, email: true },
  });
  for (const entry of entries) {
    if (entry.phone !== null) result.phones.add(entry.phone);
    if (entry.email !== null) result.emails.add(entry.email);
  }
  return result;
}
