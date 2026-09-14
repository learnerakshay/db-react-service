import { isLeadInputField, LEAD_INPUT_FIELDS, type ImportBatchDetail } from '@cadentor/shared';
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { ImportSourceType } from '../generated/prisma/enums.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { receiveMultipartFile, removeUploadedFile } from '../lib/upload.js';
import {
  getImportBatch,
  startImportBatch,
  type ImportBatchWithIssues,
} from '../modules/imports/batches.js';
import { assertCsvParses, openCsv, resolveColumns } from '../modules/imports/csv.js';
import { ingestRows } from '../modules/imports/ingestion.js';
import { isCountryCode, type CountryCode } from '../modules/leads/phone.js';
import type { ApiRouterDependencies } from './api.js';

const mappingSchema = z.partialRecord(z.enum(LEAD_INPUT_FIELDS), z.string().trim().min(1).max(200));

const csvImportFieldsSchema = z.object({
  source: z.string().trim().min(1).max(200).optional(),
  defaultCountry: z
    .string()
    .trim()
    .toUpperCase()
    .transform((value, ctx): CountryCode => {
      if (isCountryCode(value)) return value;
      ctx.addIssue({
        code: 'custom',
        message: 'must be a supported ISO 3166-1 alpha-2 country code',
      });
      return z.NEVER;
    })
    .optional(),
  campaignId: z.uuid().optional(),
  /** JSON object: canonical field → CSV header, e.g. {"phone":"Mobile #"}. */
  mapping: z
    .string()
    .transform((value, ctx): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be a JSON object' });
        return z.NEVER;
      }
    })
    .pipe(mappingSchema)
    .optional(),
});

const importIdSchema = z.uuid();

export function importsRouter({ db, config, logger }: ApiRouterDependencies): Router {
  const router = Router();

  /**
   * multipart/form-data: file (CSV, required), source, defaultCountry,
   * campaignId, mapping. Processes synchronously and returns the batch.
   */
  router.post('/csv', async (req, res) => {
    const upload = await receiveMultipartFile(req, {
      fieldName: 'file',
      maxBytes: config.imports.maxFileBytes,
    });

    try {
      const parsed = csvImportFieldsSchema.safeParse(upload.fields);
      if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid import options');
      const options = parsed.data;

      await assertCsvParses(createReadStream(upload.file.path), config.imports.maxRecordBytes);
      const csv = await openCsv(createReadStream(upload.file.path), config.imports.maxRecordBytes);
      try {
        if (csv.header === undefined) throw new ValidationError('CSV file is empty');
        const resolution = resolveColumns(csv.header, options.mapping);
        if (!resolution.ok) throw new ValidationError('CSV header is invalid', resolution.issues);

        const sourceLabel = options.source ?? upload.file.filename;
        const batch = await startImportBatch(
          db,
          {
            sourceType: ImportSourceType.CSV,
            sourceReference: upload.file.filename,
            sourceLabel,
            contentHash: upload.file.sha256,
            defaultCountry: options.defaultCountry,
            campaignId: options.campaignId ?? null,
          },
          { staleAfterMs: config.imports.staleAfterMs },
        );

        await ingestRows(
          { db, logger, chunkSize: config.imports.chunkSize },
          {
            batchId: batch.id,
            campaignId: batch.campaignId,
            defaultCountry: options.defaultCountry,
            sourceLabel,
          },
          csv.rows(resolution.columns),
        );

        res.status(201).json(toImportBatchDetail(await getImportBatch(db, batch.id)));
      } finally {
        csv.close();
      }
    } finally {
      await removeUploadedFile(upload.file.path);
    }
  });

  router.get('/:id', async (req, res) => {
    const id = importIdSchema.safeParse(req.params.id);
    if (!id.success) throw new NotFoundError('Import not found');
    res.json(toImportBatchDetail(await getImportBatch(db, id.data)));
  });

  return router;
}

function toImportBatchDetail({
  batch,
  issues,
  issuesTruncated,
}: ImportBatchWithIssues): ImportBatchDetail {
  return {
    id: batch.id,
    sourceType: batch.sourceType,
    sourceReference: batch.sourceReference,
    sourceLabel: batch.sourceLabel,
    status: batch.status,
    campaignId: batch.campaignId,
    defaultCountry: batch.defaultCountry,
    counts: {
      total: batch.totalRows,
      accepted: batch.acceptedCount,
      newLeads: batch.newLeadCount,
      duplicates: batch.duplicateCount,
      suppressed: batch.suppressedCount,
      invalid: batch.invalidCount,
      failed: batch.failedCount,
      staged: batch.stagedCount,
    },
    errorCode: batch.errorCode,
    startedAt: batch.startedAt.toISOString(),
    completedAt: batch.completedAt?.toISOString() ?? null,
    issues: issues.map((row) => ({
      rowNumber: row.rowNumber,
      outcome: row.outcome,
      reason: row.reason,
      ignoredFields: row.ignoredFields.filter(isLeadInputField),
    })),
    issuesTruncated,
  };
}
