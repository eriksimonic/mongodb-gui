import { describe, expect, it } from 'vitest';
import type { ImportPreview } from '@mongo-gui/core';
import {
  csvOptionsFor,
  DEFAULT_IMPORT_DRAFT,
  importOptionsFor,
  importProblemsOf,
  isAbsolutePath,
  mappingRowsFrom,
  parseNullMarkers,
  targetCollection,
  type ImportDraft,
  type MappingRow,
} from './import-model';

const PREVIEW: ImportPreview = {
  detectedFormat: 'csv',
  fields: [
    { name: 'order_id', inferredType: 'string', examples: ['ord-1'], nullCount: 0 },
    { name: 'total', inferredType: 'double', examples: ['19.90'], nullCount: 2 },
  ],
  sampleRows: [],
  warnings: [],
};

const DRAFT: ImportDraft = { ...DEFAULT_IMPORT_DRAFT, path: '/data/orders.csv' };

function rowsOf(overrides: Partial<MappingRow>[] = []): MappingRow[] {
  return mappingRowsFrom(PREVIEW).map((row, index) => ({ ...row, ...overrides[index] }));
}

describe('import model', () => {
  it('accepts POSIX and Windows absolute paths only', () => {
    expect(isAbsolutePath('/data/orders.csv')).toBe(true);
    expect(isAbsolutePath('C:\\data\\orders.csv')).toBe(true);
    expect(isAbsolutePath('orders.csv')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });

  it('starts every field mapped to its own name with the inferred type', () => {
    const rows = rowsOf();
    expect(rows.map((row) => [row.source, row.target, row.type, row.skip])).toEqual([
      ['order_id', 'order_id', 'string', false],
      ['total', 'total', 'double', false],
    ]);
  });

  it('turns null markers into a list and drops blanks and repeats', () => {
    expect(parseNullMarkers(' null, NULL ,, n/a, null')).toEqual(['null', 'NULL', 'n/a']);
    expect(csvOptionsFor({ ...DRAFT.csv, nullText: 'null' }).nullValues).toEqual(['', 'null']);
  });

  it('reports no problems for a valid draft', () => {
    expect(importProblemsOf(DRAFT, rowsOf(), false)).toEqual([]);
  });

  it('reports a relative path, an empty new collection name and a bad batch size', () => {
    const problems = importProblemsOf(
      { ...DRAFT, path: 'orders.csv', batchSize: 0 },
      rowsOf(),
      true,
    );
    expect(problems.map((problem) => problem.field).sort()).toEqual([
      'batchSize',
      'collection',
      'path',
    ]);
  });

  it('refuses two fields mapped to one target and a target with an empty segment', () => {
    const duplicate = importProblemsOf(DRAFT, rowsOf([{}, { target: 'order_id' }]), false);
    expect(duplicate.map((problem) => problem.message)).toEqual([
      'Two fields are mapped to "order_id"',
    ]);

    const empty = importProblemsOf(DRAFT, rowsOf([{ target: 'address..city' }]), false);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.field).toBe('mapping');
  });

  it('ignores skipped rows when it checks the mapping', () => {
    const problems = importProblemsOf(
      DRAFT,
      rowsOf([{ skip: true, target: 'a..b' }, { skip: true }]),
      false,
    );
    expect(problems.map((problem) => problem.field)).toEqual(['mapping']);
    expect(problems[0]?.message).toBe('Map at least one field');
  });

  it('requires an upsert key only in upsert mode', () => {
    expect(importProblemsOf({ ...DRAFT, upsertKey: '' }, rowsOf(), false)).toEqual([]);
    const problems = importProblemsOf(
      { ...DRAFT, mode: 'upsert', upsertKey: 'a..b' },
      rowsOf(),
      false,
    );
    expect(problems.map((problem) => problem.field)).toEqual(['upsertKey']);
  });

  it('builds the options the backend reads, with skipped rows marked', () => {
    const options = importOptionsFor(
      { ...DRAFT, formatChoice: 'csv', mode: 'upsert', upsertKey: ' order_id ', batchSize: 250 },
      'csv',
      rowsOf([{}, { skip: true, target: 'total_eur' }]),
    );
    expect(options).toEqual({
      format: 'csv',
      csv: expect.objectContaining({ delimiter: ',', hasHeader: true }),
      mappings: [
        { source: 'order_id', target: 'order_id', type: 'string', skip: false },
        { source: 'total', target: 'total_eur', type: 'double', skip: true },
      ],
      mode: 'upsert',
      upsertKey: 'order_id',
      batchSize: 250,
      stopOnError: false,
    });
  });

  it('leaves the CSV options out for JSON input', () => {
    const options = importOptionsFor(DRAFT, 'ndjson', rowsOf());
    expect(options).not.toHaveProperty('csv');
  });

  it('names the target collection from the existing one or the typed name', () => {
    expect(targetCollection({ ...DRAFT, newCollection: ' archive ' }, 'orders')).toBe('orders');
    expect(targetCollection({ ...DRAFT, newCollection: ' archive ' }, undefined)).toBe('archive');
  });
});
