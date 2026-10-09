import { describe, expect, it } from 'vitest';
import {
  AbsolutePathSchema,
  CsvOptionsSchema,
  ExportRequestSchema,
  FieldMappingSchema,
  ImportOptionsSchema,
  ImportRequestSchema,
  ImportPreviewRequestSchema,
  TransferProgressSchema,
} from './types';

describe('AbsolutePathSchema', () => {
  it.each(['/tmp/data.csv', 'C:\\data\\orders.json', 'D:/exports/x.ndjson', '\\\\share\\x.csv'])(
    'accepts %s',
    (path) => {
      expect(AbsolutePathSchema.safeParse(path).success).toBe(true);
    },
  );

  it.each(['data.csv', './data.csv', '', 'relative\\x.csv', '/tmp/bad\u0000name'])(
    'refuses %j',
    (path) => {
      expect(AbsolutePathSchema.safeParse(path).success).toBe(false);
    },
  );
});

describe('CsvOptionsSchema', () => {
  it('applies the documented defaults', () => {
    expect(CsvOptionsSchema.parse({})).toEqual({
      delimiter: ',',
      quote: '"',
      hasHeader: true,
      nullValues: ['', 'null', 'NULL'],
      trim: false,
    });
  });

  it('refuses delimiters outside the allowed set', () => {
    expect(CsvOptionsSchema.safeParse({ delimiter: ':' }).success).toBe(false);
    expect(CsvOptionsSchema.safeParse({ delimiter: '\t' }).success).toBe(true);
  });
});

describe('FieldMappingSchema', () => {
  it('defaults the type to auto and accepts dotted targets', () => {
    expect(FieldMappingSchema.parse({ source: 'city', target: 'address.city' })).toEqual({
      source: 'city',
      target: 'address.city',
      type: 'auto',
    });
  });

  it('refuses empty target segments', () => {
    expect(FieldMappingSchema.safeParse({ source: 'a', target: 'a..b' }).success).toBe(false);
    expect(FieldMappingSchema.safeParse({ source: 'a', target: '.a' }).success).toBe(false);
  });
});

describe('ImportOptionsSchema', () => {
  it('defaults to insert mode, batches of 500, and _id as the upsert key', () => {
    const parsed = ImportOptionsSchema.parse({ format: 'ndjson' });
    expect(parsed).toEqual({
      format: 'ndjson',
      mode: 'insert',
      upsertKey: '_id',
      batchSize: 500,
      stopOnError: false,
    });
  });

  it('caps the batch size at 5000', () => {
    expect(ImportOptionsSchema.safeParse({ format: 'csv', batchSize: 5000 }).success).toBe(true);
    expect(ImportOptionsSchema.safeParse({ format: 'csv', batchSize: 5001 }).success).toBe(false);
    expect(ImportOptionsSchema.safeParse({ format: 'csv', batchSize: 0 }).success).toBe(false);
  });

  it('does not accept the dropBeforeImport option in this task', () => {
    const parsed = ImportOptionsSchema.parse({ format: 'csv', dropBeforeImport: true });
    expect(parsed).not.toHaveProperty('dropBeforeImport');
  });
});

describe('ImportRequestSchema', () => {
  it('requires an absolute path and a collection that is not a system collection', () => {
    const base = { database: 'shop', options: { format: 'csv' } };
    expect(
      ImportRequestSchema.safeParse({ ...base, collection: 'orders', path: '/tmp/o.csv' }).success,
    ).toBe(true);
    expect(
      ImportRequestSchema.safeParse({ ...base, collection: 'orders', path: 'o.csv' }).success,
    ).toBe(false);
    expect(
      ImportRequestSchema.safeParse({ ...base, collection: 'system.views', path: '/tmp/o.csv' })
        .success,
    ).toBe(false);
  });
});

describe('ImportPreviewRequestSchema', () => {
  it('defaults the sample size', () => {
    expect(ImportPreviewRequestSchema.parse({ path: '/tmp/o.csv' }).sampleRows).toBe(100);
  });
});

describe('ExportRequestSchema', () => {
  it('defaults the CSV flattening and EJSON mode', () => {
    const parsed = ExportRequestSchema.parse({
      database: 'shop',
      collection: 'orders',
      path: '/tmp/out.csv',
      options: { format: 'csv', csv: { columns: ['a'] } },
    });
    expect(parsed.options).toEqual({
      format: 'csv',
      csv: { delimiter: ',', columns: ['a'], flattenArrays: 'json' },
      ejsonMode: 'canonical',
    });
  });

  it('refuses a non-positive limit', () => {
    const request = {
      database: 'shop',
      collection: 'orders',
      path: '/tmp/out.json',
      options: { format: 'ndjson', limit: 0 },
    };
    expect(ExportRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('TransferProgressSchema', () => {
  it('accepts a progress event with an error and row errors', () => {
    const progress = {
      processed: 10,
      inserted: 8,
      updated: 0,
      matched: 0,
      failed: 2,
      elapsedMs: 15,
      done: true,
      error: { code: 'CANCELLED', message: 'Import cancelled' },
      errors: [{ row: 3, message: '"x" is not a 32-bit integer' }],
      warnings: [],
    };
    expect(TransferProgressSchema.parse(progress)).toEqual(progress);
  });

  it('refuses unknown error codes', () => {
    const progress = {
      processed: 0,
      inserted: 0,
      updated: 0,
      matched: 0,
      failed: 0,
      elapsedMs: 0,
      done: false,
      error: { code: 'NOPE', message: 'x' },
      errors: [],
      warnings: [],
    };
    expect(TransferProgressSchema.safeParse(progress).success).toBe(false);
  });
});
