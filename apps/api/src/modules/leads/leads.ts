import type { DbClient } from '../../db/client.js';
import type { NormalizedLead } from './lead-input.js';

export interface ResolvedLead {
  id: string;
  created: boolean;
}

/**
 * Create leads that do not exist yet and reuse the ones that do, keyed by
 * E.164 phone. Must run inside a transaction.
 *
 * Concurrency: `phone` is UNIQUE and inserts use ON CONFLICT DO NOTHING, so a
 * concurrent import inserting the same phone makes this call wait for it and
 * then treat that lead as existing. Inputs are processed in phone order to
 * keep lock ordering consistent between concurrent imports.
 *
 * Existing leads are enriched with `mergeLeadMetadata` (fill-empty-only).
 */
export async function resolveLeadsByPhone(
  tx: DbClient,
  leads: readonly NormalizedLead[],
  importBatchId: string,
): Promise<Map<string, ResolvedLead>> {
  const resolved = new Map<string, ResolvedLead>();
  if (leads.length === 0) return resolved;

  const ordered = [...leads].sort((a, b) => (a.phone < b.phone ? -1 : a.phone > b.phone ? 1 : 0));
  const phones = ordered.map((lead) => lead.phone);

  const existing = await tx.lead.findMany({
    where: { phone: { in: phones } },
    select: { id: true, phone: true },
  });
  for (const lead of existing) resolved.set(lead.phone, { id: lead.id, created: false });

  const toCreate = ordered.filter((lead) => !resolved.has(lead.phone));
  if (toCreate.length > 0) {
    const created = await tx.lead.createManyAndReturn({
      data: toCreate.map((lead) => ({ ...lead, firstImportBatchId: importBatchId })),
      skipDuplicates: true,
      select: { id: true, phone: true },
    });
    for (const lead of created) resolved.set(lead.phone, { id: lead.id, created: true });

    // Rows skipped by ON CONFLICT were committed by a concurrent import.
    const raced = toCreate.filter((lead) => !resolved.has(lead.phone)).map((lead) => lead.phone);
    if (raced.length > 0) {
      const winners = await tx.lead.findMany({
        where: { phone: { in: raced } },
        select: { id: true, phone: true },
      });
      for (const lead of winners) resolved.set(lead.phone, { id: lead.id, created: false });
    }
  }

  for (const lead of ordered) {
    const match = resolved.get(lead.phone);
    if (match === undefined) {
      throw new Error('Lead resolution invariant violated: phone neither created nor found');
    }
    if (!match.created) await mergeLeadMetadata(tx, match.id, lead);
  }

  return resolved;
}

/**
 * Merge rule for re-imported leads: a field is written only when the stored
 * value is NULL and the incoming value is not. Existing values are never
 * overwritten, even when they differ. `phone`, `source`, `status` and
 * provenance are never changed by imports. Single atomic statement.
 */
export async function mergeLeadMetadata(
  tx: DbClient,
  leadId: string,
  incoming: NormalizedLead,
): Promise<void> {
  const lastServiceDate = incoming.lastServiceAt?.toISOString().slice(0, 10) ?? null;
  await tx.$executeRaw`
    UPDATE "Lead" SET
      "firstName"     = COALESCE("firstName", ${incoming.firstName}::varchar),
      "lastName"      = COALESCE("lastName", ${incoming.lastName}::varchar),
      "email"         = COALESCE("email", ${incoming.email}::varchar),
      "externalId"    = COALESCE("externalId", ${incoming.externalId}::varchar),
      "lastServiceAt" = COALESCE("lastServiceAt", ${lastServiceDate}::date),
      "timezone"      = COALESCE("timezone", ${incoming.timezone}::varchar),
      "updatedAt"     = now()
    WHERE "id" = ${leadId}::uuid
      AND (
        ("firstName" IS NULL AND ${incoming.firstName}::varchar IS NOT NULL) OR
        ("lastName" IS NULL AND ${incoming.lastName}::varchar IS NOT NULL) OR
        ("email" IS NULL AND ${incoming.email}::varchar IS NOT NULL) OR
        ("externalId" IS NULL AND ${incoming.externalId}::varchar IS NOT NULL) OR
        ("lastServiceAt" IS NULL AND ${lastServiceDate}::date IS NOT NULL) OR
        ("timezone" IS NULL AND ${incoming.timezone}::varchar IS NOT NULL)
      )`;
}
