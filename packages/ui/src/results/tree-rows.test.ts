import { describe, expect, it } from 'vitest';
import { copyTextOf, exactCopyTextOf, visibleRows, COLLAPSED } from './tree-rows';

describe('copyTextOf', () => {
  it('copies an ObjectId in its mongosh form, in full', () => {
    expect(copyTextOf({ $oid: '65a1b2c3d4e5f60718293a4b' })).toBe(
      'ObjectId("65a1b2c3d4e5f60718293a4b")',
    );
  });

  it('copies a Long in its mongosh form with every digit', () => {
    expect(copyTextOf({ $numberLong: '9007199254740993' })).toBe('Long("9007199254740993")');
  });

  it('copies a document or an array as JSON', () => {
    expect(copyTextOf({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(copyTextOf([1, 2])).toBe('[\n  1,\n  2\n]');
  });

  it('copies a plain string as it is', () => {
    expect(copyTextOf('paid')).toBe('paid');
  });
});

describe('shortened values in rows', () => {
  const marker = { $mgTruncated: { t: 'array', n: 200000 } };
  const preview = {
    _id: 1,
    big: marker,
    nested: { inner: marker, ok: 'x' },
    $mgTruncated: { ref: 'a/b', chars: 3_600_000 },
  };

  it('makes a marker a leaf row and leaves the root marker out of the rows', () => {
    const rows = visibleRows([preview], { expandAll: true, overrides: {} });
    expect(rows.map((row) => row.path)).toEqual([
      '',
      '_id',
      'big',
      'nested',
      'nested.inner',
      'nested.ok',
    ]);
    expect(rows.find((row) => row.path === 'big')).toMatchObject({
      hasChildren: false,
      expanded: false,
      type: 'Array',
    });
    expect(rows.find((row) => row.path === 'nested.inner')?.hasChildren).toBe(false);
  });

  it('opens a preview of a 200k-element array document into a bounded number of rows', () => {
    const documents = Array.from({ length: 50 }, () => preview);
    const rows = visibleRows(documents, { expandAll: true, overrides: {} });
    expect(rows.length).toBeLessThan(2000);
    expect(visibleRows(documents, COLLAPSED)).toHaveLength(50);
  });

  it('offers no copy text for a marker or for a value that holds one', () => {
    expect(exactCopyTextOf(marker)).toBeUndefined();
    expect(exactCopyTextOf(preview.nested)).toBeUndefined();
    expect(exactCopyTextOf(preview)).toBeUndefined();
    expect(exactCopyTextOf('ok')).toBe('ok');
    expect(exactCopyTextOf({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
