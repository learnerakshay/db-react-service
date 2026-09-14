import { LEAD_INPUT_FIELDS, type ApiErrorIssue, type LeadInputField } from '@cadentor/shared';
import { CsvError, parse, type Options } from 'csv-parse';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError } from '../../lib/errors.js';
import type { RawLeadInput } from '../leads/lead-input.js';
import { ImportSourceError, type SourceRow } from './ingestion.js';

/**
 * CSV ingestion adapter. Knows about headers, aliases and column positions;
 * produces canonical SourceRows. All hygiene lives in the ingestion service.
 */

/** Explicit mapping: canonical field → CSV header name. */
export type ColumnMapping = Partial<Record<LeadInputField, string>>;
export type ColumnIndexes = Partial<Record<LeadInputField, number>>;

/** Recognized header names, compared after `normalizeHeader`. */
const HEADER_ALIASES: Readonly<Record<LeadInputField, readonly string[]>> = {
  firstName: ['first name', 'firstname', 'first', 'given name'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
  phone: [
    'phone',
    'phone number',
    'mobile',
    'mobile phone',
    'mobile number',
    'cell',
    'cell phone',
    'telephone',
  ],
  email: ['email', 'email address', 'e mail'],
  source: ['source', 'lead source'],
  externalId: ['external id', 'lead id', 'customer id', 'id'],
  lastServiceDate: ['last service date', 'last service', 'last contact date', 'last visit date'],
  timezone: ['timezone', 'time zone'],
};

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, ' ')
    .trim();
}

export type HeaderResolution =
  { ok: true; columns: ColumnIndexes } | { ok: false; issues: ApiErrorIssue[] };

/**
 * Resolve canonical fields to column positions. Explicit mapping wins; other
 * fields fall back to aliases. The phone column is required.
 */
export function resolveColumns(
  header: readonly string[],
  mapping: ColumnMapping = {},
): HeaderResolution {
  const issues: ApiErrorIssue[] = [];
  const positions = new Map<string, number>();

  header.forEach((name, index) => {
    const key = normalizeHeader(name);
    if (key === '') return;
    if (positions.has(key)) {
      issues.push({ path: `header[${index}]`, message: `duplicate column header "${name}"` });
      return;
    }
    positions.set(key, index);
  });

  const columns: ColumnIndexes = {};
  for (const field of LEAD_INPUT_FIELDS) {
    const explicit = mapping[field];
    if (explicit !== undefined) {
      const index = positions.get(normalizeHeader(explicit));
      if (index === undefined) {
        issues.push({
          path: `mapping.${field}`,
          message: `column "${explicit}" is not in the CSV header`,
        });
      } else {
        columns[field] = index;
      }
      continue;
    }
    const alias = HEADER_ALIASES[field].find((candidate) => positions.has(candidate));
    if (alias !== undefined) columns[field] = positions.get(alias);
  }

  if (columns.phone === undefined && mapping.phone === undefined) {
    issues.push({ path: 'header', message: 'required phone column not found' });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, columns };
}

function csvParserOptions(maxRecordBytes: number): Options {
  return {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    max_record_size: maxRecordBytes,
  };
}

/**
 * Parse the whole source once without writing anything. Imports run this
 * first so a syntax error rejects the upload before any row is persisted;
 * otherwise how many rows survived would depend on stream chunk boundaries.
 */
export async function assertCsvParses(input: Readable, maxRecordBytes: number): Promise<void> {
  const discard = new Writable({
    objectMode: true,
    write(_record, _encoding, callback) {
      callback();
    },
  });
  try {
    await pipeline(input, parse(csvParserOptions(maxRecordBytes)), discard);
  } catch (err) {
    if (!(err instanceof CsvError)) throw err;
    const line: unknown = (err as CsvError & { lines?: unknown }).lines;
    throw new ValidationError(
      'CSV could not be parsed',
      [{ path: typeof line === 'number' ? `line ${line}` : 'file', message: err.code }],
      err,
    );
  }
}

export interface CsvSource {
  /** Undefined for an empty file. */
  header: string[] | undefined;
  rows(columns: ColumnIndexes): AsyncGenerator<SourceRow>;
  close(): void;
}

/**
 * Open a streamed CSV. Records are parsed incrementally (bounded memory);
 * `maxRecordBytes` caps any single record.
 *
 * Row numbers count data records after the header, skipping blank lines.
 * A record whose field count differs from the header (ignoring trailing empty
 * cells) is yielded as `malformed`. Call `assertCsvParses` first; a read
 * failure after that (e.g. I/O) stops the stream with ImportSourceError.
 */
export async function openCsv(input: Readable, maxRecordBytes: number): Promise<CsvSource> {
  const parser = parse(csvParserOptions(maxRecordBytes));
  input.on('error', (err) => parser.destroy(err));
  input.pipe(parser);
  const records = parser[Symbol.asyncIterator]() as AsyncIterator<string[]>;

  const close = () => {
    input.unpipe(parser);
    parser.destroy();
    input.destroy();
  };

  let header: string[] | undefined;
  try {
    const first = await records.next();
    header = first.done === true ? undefined : first.value;
  } catch (err) {
    close();
    throw new ValidationError('CSV header could not be parsed', [], err);
  }

  async function* rows(columns: ColumnIndexes): AsyncGenerator<SourceRow> {
    const width = header?.length ?? 0;
    let rowNumber = 0;
    for (;;) {
      let next: IteratorResult<string[]>;
      try {
        next = await records.next();
      } catch (err) {
        throw new ImportSourceError(
          err instanceof CsvError ? 'CSV_PARSE_ERROR' : 'SOURCE_READ_ERROR',
          {
            cause: err,
          },
        );
      }
      if (next.done === true) return;
      rowNumber++;

      const values = next.value;
      if (!fitsHeader(values, width)) {
        yield { rowNumber, kind: 'malformed' };
        continue;
      }
      yield { rowNumber, kind: 'record', input: pick(values, columns) };
    }
  }

  return { header, rows, close };
}

function fitsHeader(values: readonly string[], width: number): boolean {
  if (values.length === width) return true;
  return values.length > width && values.slice(width).every((value) => value === '');
}

function pick(values: readonly string[], columns: ColumnIndexes): RawLeadInput {
  const input: RawLeadInput = {};
  for (const field of LEAD_INPUT_FIELDS) {
    const index = columns[field];
    if (index !== undefined) input[field] = values[index];
  }
  return input;
}
