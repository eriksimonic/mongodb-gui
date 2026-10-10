import type { ChangeEvent } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  appendRows,
  keySummaryOf,
  operationColor,
  pipelineProblem,
  resumeTokenProblem,
  rowsThrough,
  targetKeyOf,
  visibleRows,
  wallTimeText,
  type ChangeRow,
} from './changes-model';

function row(id: string, operationType = 'insert', coll = 'orders'): ChangeRow {
  const event: ChangeEvent = {
    id,
    operationType,
    resumeTokenEjson: `{"_data":"${id}"}`,
    sizeBytes: 10,
    rawEjson: '{}',
    ns: { db: 'shop', coll },
    documentKeyEjson: `{"_id":{"$oid":"${id.padStart(24, '0')}"}}`,
  };
  return { key: `w:${id}`, event };
}

describe('appendRows', () => {
  it('keeps the newest rows and reports how many oldest rows went', () => {
    const existing = [row('1'), row('2')];
    const incoming = [row('3'), row('4'), row('5')];

    const result = appendRows(existing, incoming, 4);

    expect(result.rows.map((item) => item.event.id)).toEqual(['2', '3', '4', '5']);
    expect(result.trimmed).toBe(1);
  });

  it('keeps every row under the cap', () => {
    const result = appendRows([row('1')], [row('2')], 5);

    expect(result.rows).toHaveLength(2);
    expect(result.trimmed).toBe(0);
  });
});

describe('visibleRows', () => {
  const rows = [row('1', 'insert'), row('2', 'update', 'customers'), row('3', 'delete')];

  it('lists the newest first by default and the oldest first on request', () => {
    expect(visibleRows(rows, 'newest', '').map((item) => item.event.id)).toEqual(['3', '2', '1']);
    expect(visibleRows(rows, 'oldest', '').map((item) => item.event.id)).toEqual(['1', '2', '3']);
  });

  it('filters by namespace, operation and document key without case', () => {
    expect(visibleRows(rows, 'oldest', 'CUSTOMERS').map((item) => item.event.id)).toEqual(['2']);
    expect(visibleRows(rows, 'oldest', 'delete').map((item) => item.event.id)).toEqual(['3']);
    expect(
      visibleRows(rows, 'oldest', '000000000000000000000002').map((item) => item.event.id),
    ).toEqual(['2']);
  });
});

describe('rowsThrough', () => {
  it('keeps the row and the rows before it, or nothing when the key is unknown', () => {
    const rows = [row('1'), row('2'), row('3')];

    expect(rowsThrough(rows, 'w:2')?.map((item) => item.event.id)).toEqual(['1', '2']);
    expect(rowsThrough(rows, 'w:9')).toBeUndefined();
  });
});

describe('input checks', () => {
  it('accepts an empty pipeline and an array of stages', () => {
    expect(pipelineProblem('')).toBeUndefined();
    expect(pipelineProblem('[{"$match": {"operationType": "insert"}}]')).toBeUndefined();
  });

  it('refuses text that is not JSON and JSON that is not an array', () => {
    expect(pipelineProblem('[{')).toBe('The pipeline is not valid JSON.');
    expect(pipelineProblem('{"$match": {}}')).toBe('The pipeline must be an array of stages.');
  });

  it('accepts a resume token document and refuses anything else', () => {
    expect(resumeTokenProblem('')).toBeUndefined();
    expect(resumeTokenProblem('{"_data": "8267"}')).toBeUndefined();
    expect(resumeTokenProblem('["8267"]')).toBe(
      'The resume token must be a JSON document, for example {"_data": "..."}.',
    );
    expect(resumeTokenProblem('8267')).toBe(
      'The resume token must be a JSON document, for example {"_data": "..."}.',
    );
  });
});

describe('display helpers', () => {
  it('colours each operation and leaves unknown ones grey', () => {
    expect(operationColor('insert')).toBe('green');
    expect(operationColor('update')).toBe('blue');
    expect(operationColor('replace')).toBe('violet');
    expect(operationColor('delete')).toBe('red');
    expect(operationColor('invalidate')).toBe('gray');
  });

  it('shortens long keys with an ellipsis', () => {
    const long = `{"_id": "${'x'.repeat(200)}"}`;
    const summary = keySummaryOf(long);

    expect(summary.length).toBe(80);
    expect(summary.endsWith('…')).toBe(true);
    expect(keySummaryOf(undefined)).toBe('');
  });

  it('shows a dash for a missing or invalid wall time', () => {
    expect(wallTimeText(undefined)).toBe('-');
    expect(wallTimeText('not a date')).toBe('-');
    expect(wallTimeText('2026-10-10T10:00:00.250Z')).toMatch(/\.250$/);
  });

  it('names the target of each scope', () => {
    expect(targetKeyOf({ kind: 'deployment' })).toBe('deployment');
    expect(targetKeyOf({ kind: 'database', database: 'shop' })).toBe('database:shop');
    expect(targetKeyOf({ kind: 'collection', database: 'shop', collection: 'orders' })).toBe(
      'collection:shop.orders',
    );
  });
});
