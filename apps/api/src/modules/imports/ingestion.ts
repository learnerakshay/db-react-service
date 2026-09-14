import type { LeadInputField } from '@cadentor/shared';
import type { Database, DbClient } from '../../db/client.js';
import { hasPrismaCode } from '../../db/errors.js';
import {
  ImportBatchStatus,
  ImportRowOutcome,
  ImportRowReason,
} from '../../generated/prisma/enums.js';
import type { Logger } from '../../lib/logger.js';
import { stageLeadsForCampaign } from '../campaigns/membership.js';
import { normalizeLeadInput, type NormalizedLead, type RawLeadInput } from '../leads/lead-input.js';
import { resolveLeadsByPhone } from '../leads/leads.js';
import type { CountryCode } from '../leads/phone.js';
import { findSuppressed } from '../suppression/suppression.js';

/** One row from any ingestion adapter, already mapped to canonical fields. */
export type SourceRow =
  | { rowNumber: number; kind: 'record'; input: RawLeadInput }
  | { rowNumber: number; kind: 'malformed' };

/** The source cannot be read further. Rows read before the failure are kept. */
export class ImportSourceError extends Error {
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(`Import source failed: ${code}`, options);
    this.name = 'ImportSourceError';
    this.code = code;
  }
}

export interface ImportContext {
  batchId: string;
  campaignId: string | null;
  defaultCountry: CountryCode | undefined;
  sourceLabel: string;
}

export interface IngestionDependencies {
  db: Database;
  logger: Logger;
  /** Rows per transaction. Bounds transaction size and lock time. */
  chunkSize: number;
}

interface RowResult {
  rowNumber: number;
  outcome: ImportRowOutcome;
  reason: ImportRowReason | null;
  ignoredFields: LeadInputField[];
  leadId: string | null;
}

interface Candidate {
  rowNumber: number;
  lead: NormalizedLead;
  ignoredFields: LeadInputField[];
}

type PreparedRow =
  { kind: 'result'; result: RowResult } | { kind: 'candidate'; candidate: Candidate };

const CHUNK_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_CHUNK_ATTEMPTS = 3;

/**
 * Canonical ingestion pipeline shared by every adapter:
 *
 *   validate + normalize → dedupe within import → suppression check
 *   → create or reuse lead → stage into campaign (optional) → record outcome
 *
 * Rows are persisted in bounded transactions of `chunkSize`. Each chunk writes
 * its leads, memberships, row results and batch counters atomically, so counts
 * can never drift from row results. A chunk that cannot be written is rolled
 * back and its rows are recorded as FAILED; other chunks are unaffected.
 *
 * Outcome precedence per row: INVALID > DUPLICATE (earlier row in this import
 * has the same phone; first occurrence wins, later rows are not merged)
 * > SUPPRESSED > EXISTING > CREATED.
 */
export async function ingestRows(
  deps: IngestionDependencies,
  context: ImportContext,
  rows: AsyncIterable<SourceRow>,
): Promise<void> {
  const seenPhones = new Set<string>();
  let pending: PreparedRow[] = [];
  let sourceError: ImportSourceError | undefined;

  try {
    try {
      for await (const row of rows) {
        pending.push(prepareRow(row, context, seenPhones));
        if (pending.length >= deps.chunkSize) {
          await flushChunk(deps, context, pending, seenPhones);
          pending = [];
        }
      }
    } catch (err) {
      if (!(err instanceof ImportSourceError)) throw err;
      sourceError = err;
    }
    await flushChunk(deps, context, pending, seenPhones);
  } catch (err) {
    await finishBatch(deps.db, context.batchId, 'INTERNAL_ERROR').catch((finishErr: unknown) => {
      deps.logger.error(
        { err: finishErr, operation: 'import.finish', importBatchId: context.batchId },
        'could not mark import batch as failed',
      );
    });
    throw err;
  }

  if (sourceError !== undefined) {
    deps.logger.warn(
      { operation: 'import.read', importBatchId: context.batchId, errorCode: sourceError.code },
      'import source stopped early; rows read so far were kept',
    );
  }
  await finishBatch(deps.db, context.batchId, sourceError?.code);
}

export function prepareRow(
  row: SourceRow,
  context: ImportContext,
  seenPhones: Set<string>,
): PreparedRow {
  if (row.kind === 'malformed') {
    return rejected(row.rowNumber, ImportRowOutcome.INVALID, ImportRowReason.MALFORMED_ROW);
  }

  const normalized = normalizeLeadInput(row.input, {
    defaultCountry: context.defaultCountry,
    sourceLabel: context.sourceLabel,
  });
  if (!normalized.ok) {
    return rejected(row.rowNumber, ImportRowOutcome.INVALID, normalized.reason);
  }

  if (seenPhones.has(normalized.lead.phone)) {
    return rejected(row.rowNumber, ImportRowOutcome.DUPLICATE, ImportRowReason.DUPLICATE_IN_BATCH);
  }
  seenPhones.add(normalized.lead.phone);

  return {
    kind: 'candidate',
    candidate: {
      rowNumber: row.rowNumber,
      lead: normalized.lead,
      ignoredFields: normalized.ignoredFields,
    },
  };
}

function rejected(
  rowNumber: number,
  outcome: ImportRowOutcome,
  reason: ImportRowReason,
): PreparedRow {
  return {
    kind: 'result',
    result: { rowNumber, outcome, reason, ignoredFields: [], leadId: null },
  };
}

async function flushChunk(
  deps: IngestionDependencies,
  context: ImportContext,
  rows: PreparedRow[],
  seenPhones: Set<string>,
): Promise<void> {
  if (rows.length === 0) return;

  try {
    await withConflictRetry(() =>
      deps.db.$transaction(
        async (tx) => {
          const { results, staged } = await persistChunk(tx, context, rows);
          await recordResults(tx, context.batchId, results, staged);
        },
        { timeout: CHUNK_TRANSACTION_TIMEOUT_MS },
      ),
    );
  } catch (err) {
    deps.logger.error(
      {
        err,
        operation: 'import.persistChunk',
        importBatchId: context.batchId,
        errorCode: 'DATABASE_ERROR',
        rowCount: rows.length,
      },
      'import chunk rolled back; its rows are recorded as FAILED',
    );
    const failed = rows.map((row): RowResult => {
      if (row.kind === 'result') return row.result;
      // Nothing from this chunk was written, so a later row with this phone
      // must not be classified as a duplicate of it.
      seenPhones.delete(row.candidate.lead.phone);
      return {
        rowNumber: row.candidate.rowNumber,
        outcome: ImportRowOutcome.FAILED,
        reason: ImportRowReason.PERSISTENCE_ERROR,
        ignoredFields: [],
        leadId: null,
      };
    });
    await deps.db.$transaction(async (tx) => {
      await recordResults(tx, context.batchId, failed, 0);
    });
  }
}

async function withConflictRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= MAX_CHUNK_ATTEMPTS || !hasPrismaCode(err, 'P2034')) throw err;
    }
  }
}

async function persistChunk(
  tx: DbClient,
  context: ImportContext,
  rows: readonly PreparedRow[],
): Promise<{ results: RowResult[]; staged: number }> {
  const results: RowResult[] = [];
  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (row.kind === 'result') results.push(row.result);
    else candidates.push(row.candidate);
  }

  let staged = 0;
  if (candidates.length > 0) {
    const suppressed = await findSuppressed(tx, {
      phones: candidates.map((c) => c.lead.phone),
      emails: candidates.flatMap((c) => (c.lead.email === null ? [] : [c.lead.email])),
    });

    const eligible: Candidate[] = [];
    for (const candidate of candidates) {
      const { phone, email } = candidate.lead;
      if (suppressed.phones.has(phone)) {
        results.push(
          outcome(candidate, ImportRowOutcome.SUPPRESSED, ImportRowReason.SUPPRESSED_PHONE, null),
        );
      } else if (email !== null && suppressed.emails.has(email)) {
        results.push(
          outcome(candidate, ImportRowOutcome.SUPPRESSED, ImportRowReason.SUPPRESSED_EMAIL, null),
        );
      } else {
        eligible.push(candidate);
      }
    }

    const resolved = await resolveLeadsByPhone(
      tx,
      eligible.map((c) => c.lead),
      context.batchId,
    );
    const leadIds: string[] = [];
    for (const candidate of eligible) {
      const lead = resolved.get(candidate.lead.phone);
      if (lead === undefined) throw new Error('Lead resolution returned no lead for candidate');
      leadIds.push(lead.id);
      results.push(
        outcome(
          candidate,
          lead.created ? ImportRowOutcome.CREATED : ImportRowOutcome.EXISTING,
          null,
          lead.id,
        ),
      );
    }

    if (context.campaignId !== null) {
      staged = await stageLeadsForCampaign(tx, {
        campaignId: context.campaignId,
        leadIds,
        importBatchId: context.batchId,
      });
    }
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber);
  return { results, staged };
}

function outcome(
  candidate: Candidate,
  rowOutcome: ImportRowOutcome,
  reason: ImportRowReason | null,
  leadId: string | null,
): RowResult {
  return {
    rowNumber: candidate.rowNumber,
    outcome: rowOutcome,
    reason,
    ignoredFields: candidate.ignoredFields,
    leadId,
  };
}

/** Row results and batch counters are always written together. */
async function recordResults(
  tx: DbClient,
  importBatchId: string,
  results: readonly RowResult[],
  staged: number,
): Promise<void> {
  if (results.length === 0) return;

  await tx.importRowResult.createMany({
    data: results.map((r) => ({
      importBatchId,
      rowNumber: r.rowNumber,
      outcome: r.outcome,
      reason: r.reason,
      ignoredFields: r.ignoredFields,
      leadId: r.leadId,
    })),
  });

  const count = (...outcomes: ImportRowOutcome[]) =>
    results.filter((r) => outcomes.includes(r.outcome)).length;

  await tx.importBatch.update({
    where: { id: importBatchId },
    data: {
      totalRows: { increment: results.length },
      acceptedCount: { increment: count(ImportRowOutcome.CREATED, ImportRowOutcome.EXISTING) },
      newLeadCount: { increment: count(ImportRowOutcome.CREATED) },
      duplicateCount: { increment: count(ImportRowOutcome.DUPLICATE) },
      suppressedCount: { increment: count(ImportRowOutcome.SUPPRESSED) },
      invalidCount: { increment: count(ImportRowOutcome.INVALID) },
      failedCount: { increment: count(ImportRowOutcome.FAILED) },
      stagedCount: { increment: staged },
    },
  });
}

async function finishBatch(
  db: DbClient,
  importBatchId: string,
  errorCode: string | undefined,
): Promise<void> {
  await db.importBatch.update({
    where: { id: importBatchId },
    data: {
      status: errorCode === undefined ? ImportBatchStatus.COMPLETED : ImportBatchStatus.FAILED,
      errorCode: errorCode ?? null,
      completedAt: new Date(),
    },
  });
}
