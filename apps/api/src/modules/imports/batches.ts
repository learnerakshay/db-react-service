import type { DbClient } from '../../db/client.js';
import { hasPrismaCode } from '../../db/errors.js';
import type { ImportBatch, ImportRowResult } from '../../generated/prisma/client.js';
import {
  ImportBatchStatus,
  ImportRowOutcome,
  type ImportSourceType,
} from '../../generated/prisma/enums.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { requireStageableCampaign } from '../campaigns/campaigns.js';
import type { CountryCode } from '../leads/phone.js';

export interface StartImportInput {
  sourceType: ImportSourceType;
  sourceReference: string | null;
  sourceLabel: string;
  /** SHA-256 hex of the full source content. */
  contentHash: string;
  defaultCountry: CountryCode | undefined;
  campaignId: string | null;
}

export interface StartImportOptions {
  /** A PROCESSING batch older than this is presumed dead (process crash). */
  staleAfterMs: number;
  now?: Date;
}

/**
 * Open a PROCESSING batch. The database allows only one PROCESSING batch per
 * content hash (partial unique index), so the same file cannot be imported
 * twice concurrently. Completed re-imports are allowed and resolve to
 * EXISTING rows.
 */
export async function startImportBatch(
  db: DbClient,
  input: StartImportInput,
  options: StartImportOptions,
): Promise<ImportBatch> {
  const now = options.now ?? new Date();
  if (input.campaignId !== null) await requireStageableCampaign(db, input.campaignId);

  await db.importBatch.updateMany({
    where: {
      contentHash: input.contentHash,
      status: ImportBatchStatus.PROCESSING,
      startedAt: { lt: new Date(now.getTime() - options.staleAfterMs) },
    },
    data: { status: ImportBatchStatus.FAILED, errorCode: 'STALE_PROCESSING', completedAt: now },
  });

  try {
    return await db.importBatch.create({
      data: {
        sourceType: input.sourceType,
        sourceReference: input.sourceReference,
        sourceLabel: input.sourceLabel,
        contentHash: input.contentHash,
        defaultCountry: input.defaultCountry ?? null,
        campaignId: input.campaignId,
      },
    });
  } catch (err) {
    if (hasPrismaCode(err, 'P2002')) {
      throw new ConflictError('An identical import is already processing', err);
    }
    throw err;
  }
}

export interface ImportBatchWithIssues {
  batch: ImportBatch;
  issues: Pick<ImportRowResult, 'rowNumber' | 'outcome' | 'reason' | 'ignoredFields'>[];
  issuesTruncated: boolean;
}

/** Batch plus rows that were rejected or accepted with dropped fields. */
export async function getImportBatch(
  db: DbClient,
  importBatchId: string,
  issueLimit = 1000,
): Promise<ImportBatchWithIssues> {
  const batch = await db.importBatch.findUnique({ where: { id: importBatchId } });
  if (batch === null) throw new NotFoundError('Import not found');

  const issues = await db.importRowResult.findMany({
    where: {
      importBatchId,
      OR: [
        { outcome: { notIn: [ImportRowOutcome.CREATED, ImportRowOutcome.EXISTING] } },
        { NOT: { ignoredFields: { isEmpty: true } } },
      ],
    },
    orderBy: { rowNumber: 'asc' },
    take: issueLimit + 1,
    select: { rowNumber: true, outcome: true, reason: true, ignoredFields: true },
  });

  return {
    batch,
    issues: issues.slice(0, issueLimit),
    issuesTruncated: issues.length > issueLimit,
  };
}
