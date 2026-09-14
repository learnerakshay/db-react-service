import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { assertCsvParses, openCsv, resolveColumns } from '../../src/modules/imports/csv.js';
import { ImportSourceError, type SourceRow } from '../../src/modules/imports/ingestion.js';
import { ValidationError } from '../../src/lib/errors.js';

async function readAll(csv: string) {
  const source = await openCsv(Readable.from([csv]), 64 * 1024);
  const header = source.header ?? [];
  const resolution = resolveColumns(header);
  if (!resolution.ok) throw new Error('unexpected header failure');
  const rows: SourceRow[] = [];
  for await (const row of source.rows(resolution.columns)) rows.push(row);
  return { header, rows };
}

describe('resolveColumns', () => {
  it('matches common header aliases regardless of case and separators', () => {
    const result = resolveColumns([
      'First_Name',
      'LAST NAME',
      'Mobile-Number',
      'E-mail',
      'Last Service Date',
    ]);
    expect(result).toEqual({
      ok: true,
      columns: { firstName: 0, lastName: 1, phone: 2, email: 3, lastServiceDate: 4 },
    });
  });

  it('prefers explicit mapping over aliases', () => {
    const result = resolveColumns(['Phone', 'Cell #'], { phone: 'cell #' });
    expect(result).toEqual({ ok: true, columns: { phone: 1 } });
  });

  it('rejects a header without a phone column', () => {
    const result = resolveColumns(['First Name', 'Email']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([
      { path: 'header', message: 'required phone column not found' },
    ]);
  });

  it('rejects mappings that name a missing column', () => {
    const result = resolveColumns(['Phone'], { email: 'Contact Email' });
    expect(!result.ok && result.issues[0]?.path).toBe('mapping.email');
  });

  it('rejects duplicate headers', () => {
    const result = resolveColumns(['Phone', 'phone']);
    expect(result.ok).toBe(false);
  });
});

describe('openCsv', () => {
  it('streams records mapped to canonical fields, handling BOM, quotes and blank lines', async () => {
    const { header, rows } = await readAll(
      '﻿First Name,Phone,Email\n"Doe, Jane",+14155552671,jane@example.com\n\nBob,+447911123456,\n',
    );
    expect(header).toEqual(['First Name', 'Phone', 'Email']);
    expect(rows).toEqual([
      {
        rowNumber: 1,
        kind: 'record',
        input: { firstName: 'Doe, Jane', phone: '+14155552671', email: 'jane@example.com' },
      },
      {
        rowNumber: 2,
        kind: 'record',
        input: { firstName: 'Bob', phone: '+447911123456', email: '' },
      },
    ]);
  });

  it('isolates rows whose column count does not match the header', async () => {
    const { rows } = await readAll(
      'Phone,Email\n+14155552671\n+447911123456,a@b.co,extra\n+16502530000,c@d.co,,\n',
    );
    expect(rows.map((r) => r.kind)).toEqual(['malformed', 'malformed', 'record']);
  });

  it('reports an empty file as having no header', async () => {
    const source = await openCsv(Readable.from(['']), 1024);
    expect(source.header).toBeUndefined();
  });

  it('wraps read failures after the header in ImportSourceError', async () => {
    const input = new Readable({ read() {} });
    // csv-parse holds back the last record until more data arrives, so push two.
    input.push('Phone\n+14155552671\n+447911123456\n');
    const source = await openCsv(input, 1024);
    const iterator = source.rows({ phone: 0 });
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'record' } });
    const pending = iterator.next();
    input.destroy(new Error('disk read failed'));
    await expect(pending).rejects.toBeInstanceOf(ImportSourceError);
  });
});

describe('assertCsvParses', () => {
  it('accepts well-formed CSV, including malformed-width rows', async () => {
    await expect(
      assertCsvParses(Readable.from(['Phone,Email\n+14155552671\n']), 1024),
    ).resolves.toBeUndefined();
  });

  it('rejects unrecoverable syntax with the line number, before any import work', async () => {
    const err: unknown = await assertCsvParses(
      Readable.from(['Phone\n+14155552671\n"unterminated']),
      1024,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([
      { path: 'line 3', message: 'CSV_QUOTE_NOT_CLOSED' },
    ]);
  });

  it('rejects an unparseable header as a validation error', async () => {
    await expect(openCsv(Readable.from([`${'x'.repeat(2000)}\n`]), 1024)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
