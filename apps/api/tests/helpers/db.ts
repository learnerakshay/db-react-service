import { createHash, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createDatabase, type Database } from '../../src/db/client.js';
import { createLogger } from '../../src/lib/logger.js';
import { getImportBatch, startImportBatch } from '../../src/modules/imports/batches.js';
import { ingestRows, type SourceRow } from '../../src/modules/imports/ingestion.js';
import type { RawLeadInput } from '../../src/modules/leads/lead-input.js';
import type { CountryCode } from '../../src/modules/leads/phone.js';

export const silentLogger = createLogger('silent');

export function connectTestDatabase(): Database {
  return createDatabase(inject('databaseUrl'));
}

/** TRUNCATE does not fire the SuppressionEntry row trigger, so this is allowed. */
export async function resetDatabase(db: Database): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ImportRowResult", "CampaignLead", "ImportBatch", "Campaign", "Lead", "SuppressionEntry", "ProviderWebhookEvent", "Message", "ReplyProcessing", "KnowledgeItem" CASCADE',
  );
}

export type TestRow = RawLeadInput | 'malformed';

export async function* sourceRows(rows: readonly TestRow[]): AsyncGenerator<SourceRow> {
  let rowNumber = 0;
  for (const row of rows) {
    rowNumber++;
    await Promise.resolve();
    yield row === 'malformed'
      ? { rowNumber, kind: 'malformed' }
      : { rowNumber, kind: 'record', input: row };
  }
}

export interface TestImportOptions {
  campaignId?: string;
  defaultCountry?: CountryCode;
  chunkSize?: number;
}

/** Run a full import through the real ingestion service and database. */
export async function importRows(
  db: Database,
  rows: readonly TestRow[],
  options: TestImportOptions = {},
) {
  const batch = await startImportBatch(
    db,
    {
      sourceType: 'CSV',
      sourceReference: 'test.csv',
      sourceLabel: 'test-import',
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'),
      defaultCountry: options.defaultCountry,
      campaignId: options.campaignId ?? null,
    },
    { staleAfterMs: 60_000 },
  );
  await ingestRows(
    { db, logger: silentLogger, chunkSize: options.chunkSize ?? 2 },
    {
      batchId: batch.id,
      campaignId: batch.campaignId,
      defaultCountry: options.defaultCountry,
      sourceLabel: 'test-import',
    },
    sourceRows(rows),
  );
  const result = await getImportBatch(db, batch.id);
  const rowResults = await db.importRowResult.findMany({
    where: { importBatchId: batch.id },
    orderBy: { rowNumber: 'asc' },
  });
  return { ...result, rows: rowResults };
}

export async function createTestCampaign(db: Database, name = 'Test campaign') {
  return db.campaign.create({
    data: {
      name,
      config: {
        timezone: 'America/New_York',
        sendWindow: { start: '09:00', end: '18:00' },
        hourlyDispatchLimit: 60,
        followUpDelayHours: 48,
        archiveDelayDays: 14,
      },
    },
  });
}
