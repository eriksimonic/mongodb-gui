import type { TopEntry } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { readCount, sortTop, topTotals, writeCount } from './top-sort';

const stat = (time: number, count: number) => ({ time, count });

function entry(ns: string, time: number, reads: number, writes: number): TopEntry {
  return {
    ns,
    total: stat(time, reads + writes),
    readLock: stat(time / 2, 0),
    writeLock: stat(time / 4, 0),
    queries: stat(0, reads),
    getmore: stat(0, 0),
    insert: stat(0, writes),
    update: stat(0, 0),
    remove: stat(0, 0),
    commands: stat(0, 1),
  };
}

const ENTRIES = [
  entry('shop.orders', 900, 30, 4),
  entry('admin.users', 40, 2, 0),
  entry('shop.products', 300, 10, 9),
];

describe('top columns', () => {
  it('counts reads as queries and getmore, and writes as inserts, updates and removes', () => {
    expect(readCount(ENTRIES[0] as TopEntry)).toBe(30);
    expect(writeCount(ENTRIES[2] as TopEntry)).toBe(9);
  });

  it('sums every column for the totals row', () => {
    expect(topTotals(ENTRIES)).toEqual({
      total: 1240,
      reads: 42,
      writes: 13,
      readLock: 620,
      writeLock: 310,
      commands: 3,
    });
  });
});

describe('sortTop', () => {
  it('sorts by total time, largest first by default', () => {
    expect(sortTop(ENTRIES, { column: 'total', direction: 'desc' }).map((item) => item.ns)).toEqual(
      ['shop.orders', 'shop.products', 'admin.users'],
    );
  });

  it('sorts namespaces as text, ascending', () => {
    expect(sortTop(ENTRIES, { column: 'ns', direction: 'asc' }).map((item) => item.ns)).toEqual([
      'admin.users',
      'shop.orders',
      'shop.products',
    ]);
  });

  it('sorts writes ascending without changing the input', () => {
    const sorted = sortTop(ENTRIES, { column: 'writes', direction: 'asc' });
    expect(sorted.map((item) => item.ns)).toEqual(['admin.users', 'shop.orders', 'shop.products']);
    expect(ENTRIES[0]?.ns).toBe('shop.orders');
  });
});
