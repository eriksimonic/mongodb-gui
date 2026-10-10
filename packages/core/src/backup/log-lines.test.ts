import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseToolLine } from './log-lines';

function fixture(name: string): string[] {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter(Boolean);
}

describe('parseToolLine', () => {
  it('parses a dump to an archive', () => {
    const kinds = fixture('dump-progress.txt').map((l) => parseToolLine(l).kind);
    expect(kinds).toEqual([
      'writing',
      'writing',
      'writing',
      'writing',
      'dumped',
      'dumped',
      'dumped',
      'bar',
      'bar',
      'bar',
      'bar',
      'dumped',
    ]);
  });

  it('reads a progress bar with counts', () => {
    const line = fixture('dump-progress.txt')[7]!;
    expect(parseToolLine(line)).toEqual({
      kind: 'bar',
      namespace: 'shop.orders',
      timeseries: false,
      done: 141578,
      total: 400000,
      unit: 'documents',
      percent: 35.4,
    });
  });

  it('maps a time series bucket collection to its view name', () => {
    const lines = fixture('dump-progress.txt');
    expect(parseToolLine(lines[3]!)).toEqual({
      kind: 'writing',
      namespace: 'shop.ts',
      timeseries: true,
    });
    expect(parseToolLine(lines[6]!)).toMatchObject({
      kind: 'dumped',
      namespace: 'shop.ts',
      timeseries: true,
      documents: 2,
    });
  });

  it('reads singular and plural document counts', () => {
    expect(parseToolLine(fixture('dump-dir.txt')[3]!)).toMatchObject({
      kind: 'dumped',
      documents: 1,
    });
    expect(parseToolLine(fixture('dump-dir.txt')[5]!)).toMatchObject({
      kind: 'dumped',
      documents: 400000,
    });
  });

  it('parses a dump to a folder', () => {
    expect(fixture('dump-dir.txt').map((l) => parseToolLine(l).kind)).toEqual([
      'writing',
      'writing',
      'writing',
      'dumped',
      'dumped',
      'dumped',
    ]);
  });

  it('parses restore lines', () => {
    const lines = fixture('restore.txt').map(parseToolLine);
    expect(lines.map((l) => l.kind)).toEqual([
      'other',
      'other',
      'restoring',
      'bar',
      'bar',
      'bar',
      'restored',
      'restoring',
      'bar-open',
      'restored',
      'warning',
      'failed',
      'summary',
    ]);
    expect(lines[3]).toMatchObject({
      kind: 'bar',
      unit: 'bytes',
      done: Math.round(86.6 * 1024 * 1024),
      total: 250 * 1024 * 1024,
    });
    expect(lines[8]).toEqual({
      kind: 'bar-open',
      namespace: 'shop.capped',
      timeseries: false,
      done: 1536,
      unit: 'bytes',
    });
    expect(lines[9]).toMatchObject({ kind: 'restored', documents: 1, failures: 0 });
    expect(lines[11]).toEqual({
      kind: 'failed',
      reason: 'shop.bad: error restoring from dir/shop/bad.bson: duplicate key error',
    });
    expect(lines[12]).toEqual({ kind: 'summary', restored: 400001, failed: 3 });
  });

  it('works without a timestamp', () => {
    expect(parseToolLine('writing `a.b` to `x`')).toMatchObject({
      kind: 'writing',
      namespace: 'a.b',
    });
  });

  it('keeps unknown text', () => {
    expect(parseToolLine('2026-10-10T18:42:22.807+0200\tpreparing')).toEqual({
      kind: 'other',
      text: 'preparing',
    });
  });

  it('converts every size unit with a 1024 base', () => {
    const bar = (s: string) => parseToolLine(`[########................]  a.b  ${s}/1TB  (1.0%)`);
    expect(bar('1KB')).toMatchObject({ done: 1024, total: 1024 ** 4 });
    expect(bar('2GB')).toMatchObject({ done: 2 * 1024 ** 3 });
  });
});
