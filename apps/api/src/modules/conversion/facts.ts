import type { DbClient } from '../../db/client.js';
import { QualificationFactSource } from '../../generated/prisma/enums.js';
import { ValidationError } from '../../lib/errors.js';
import type { QualificationConfig } from './config.js';
import { parseFactValue, type FactValue } from './evaluator.js';

/** Higher rank wins. Equal rank: the value stated later wins. */
export const FACT_SOURCE_RANK: Readonly<Record<QualificationFactSource, number>> = {
  OPERATOR: 3,
  IMPORT: 2,
  SYSTEM: 2,
  CONVERSATION: 1,
};

export interface FactInput {
  field: string;
  value: FactValue;
}

export interface StoredFact {
  value: unknown;
  source: QualificationFactSource;
  observedAt: Date;
}

export async function loadQualificationFacts(
  db: DbClient,
  campaignLeadId: string,
): Promise<Map<string, StoredFact>> {
  const rows = await db.qualificationFact.findMany({
    where: { campaignLeadId },
    select: { field: true, value: true, source: true, observedAt: true },
  });
  return new Map(
    rows.map((row) => [
      row.field,
      { value: row.value, source: row.source, observedAt: row.observedAt },
    ]),
  );
}

/**
 * Write facts for one membership, never silently replacing a higher-precedence
 * value: those writes are skipped and returned so callers can record them.
 * Values must match their configured field type. Callers serialize writers by
 * holding the membership row lock.
 */
export async function recordQualificationFacts(
  tx: DbClient,
  input: {
    campaignLeadId: string;
    config: QualificationConfig;
    facts: readonly FactInput[];
    source: QualificationFactSource;
    observedAt: Date;
    sourceMessageId: string | null;
  },
): Promise<{ written: string[]; skipped: string[] }> {
  const fields = new Map(input.config.fields.map((field) => [field.key, field]));
  for (const fact of input.facts) {
    const field = fields.get(fact.field);
    if (field === undefined || parseFactValue(field, fact.value) === undefined) {
      throw new ValidationError('Invalid qualification fact', [
        { path: fact.field, message: 'unknown field or wrong value type' },
      ]);
    }
  }

  const existing = await loadQualificationFacts(tx, input.campaignLeadId);
  const written: string[] = [];
  const skipped: string[] = [];

  for (const fact of input.facts) {
    const current = existing.get(fact.field);
    if (current !== undefined && !replaces(input.source, input.observedAt, current)) {
      skipped.push(fact.field);
      continue;
    }
    const data = {
      value: fact.value,
      source: input.source,
      observedAt: input.observedAt,
      sourceMessageId:
        input.source === QualificationFactSource.CONVERSATION ? input.sourceMessageId : null,
    };
    await tx.qualificationFact.upsert({
      where: { campaignLeadId_field: { campaignLeadId: input.campaignLeadId, field: fact.field } },
      create: { campaignLeadId: input.campaignLeadId, field: fact.field, ...data },
      update: data,
    });
    written.push(fact.field);
  }
  return { written, skipped };
}

function replaces(source: QualificationFactSource, observedAt: Date, current: StoredFact): boolean {
  const rank = FACT_SOURCE_RANK[source];
  const currentRank = FACT_SOURCE_RANK[current.source];
  if (rank !== currentRank) return rank > currentRank;
  return observedAt.getTime() >= current.observedAt.getTime();
}
