import { describe, expect, it } from 'vitest';
import { CopyOptionsSchema, CopyProgressSchema } from './options';

const SOURCE = '6f1c2b1e-8a2d-4c3b-9e1f-0a1b2c3d4e5f';
const TARGET = '7a2c3d4e-8b3e-4d4c-8f2a-1b2c3d4e5f60';

function options(items: unknown[] = [{ source: 'orders', target: 'orders' }]) {
  return {
    sourceConnectionId: SOURCE,
    targetConnectionId: TARGET,
    sourceDatabase: 'shop',
    targetDatabase: 'shop_copy',
    items,
    mode: 'replace',
  };
}

describe('CopyOptionsSchema', () => {
  it('accepts an item with a filter', () => {
    const parsed = CopyOptionsSchema.safeParse(
      options([{ source: 'orders', target: 'recent', filter: '{"total":{"$gt":10}}' }]),
    );
    expect(parsed.success).toBe(true);
  });

  it('refuses a system collection as an item', () => {
    expect(
      CopyOptionsSchema.safeParse(options([{ source: 'system.views', target: 'v' }])).success,
    ).toBe(false);
  });

  it('refuses a copy with no items', () => {
    expect(CopyOptionsSchema.safeParse(options([])).success).toBe(false);
  });

  it('refuses an unknown mode', () => {
    expect(CopyOptionsSchema.safeParse({ ...options(), mode: 'sync' }).success).toBe(false);
  });

  it('refuses two items that write the same target collection', () => {
    const parsed = CopyOptionsSchema.safeParse(
      options([
        { source: 'orders', target: 'copy' },
        { source: 'invoices', target: 'copy' },
      ]),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({ path: ['items', 1, 'target'] }),
    );
  });

  it('still refuses two items on one target when acknowledged and a confirmation are set', () => {
    const parsed = CopyOptionsSchema.safeParse({
      ...options([
        { source: 'orders', target: 'copy' },
        { source: 'invoices', target: 'copy' },
      ]),
      acknowledged: ['copy-timeseries-target'],
      confirmation: 'shop_copy',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({ path: ['items', 1, 'target'] }),
    );
  });

  it('defaults acknowledged to an empty list and leaves confirmation unset', () => {
    const parsed = CopyOptionsSchema.parse(options());
    expect(parsed.acknowledged).toEqual([]);
    expect(parsed.confirmation).toBeUndefined();
  });

  it('accepts acknowledged codes from the backup and copy lists and a confirmation', () => {
    expect(
      CopyOptionsSchema.safeParse({
        ...options(),
        acknowledged: ['server-too-old', 'copy-overlap'],
        confirmation: 'shop_copy',
      }).success,
    ).toBe(true);
    expect(
      CopyOptionsSchema.safeParse({ ...options(), acknowledged: ['made-up-code'] }).success,
    ).toBe(false);
    expect(
      CopyOptionsSchema.safeParse({ ...options(), confirmation: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('accepts items whose target names differ only by case', () => {
    const parsed = CopyOptionsSchema.safeParse(
      options([
        { source: 'orders', target: 'Copy' },
        { source: 'invoices', target: 'copy' },
      ]),
    );
    expect(parsed.success).toBe(true);
  });
});

describe('CopyProgressSchema', () => {
  it('parses a progress event with no error', () => {
    const parsed = CopyProgressSchema.safeParse({
      phase: 'copying',
      documents: 0,
      collectionsDone: 0,
      collectionsTotal: 1,
      failedDocuments: 0,
      skippedDocuments: 0,
      lines: [],
      elapsedMs: 0,
      done: false,
      cancelled: false,
    });
    expect(parsed.success).toBe(true);
  });
});
