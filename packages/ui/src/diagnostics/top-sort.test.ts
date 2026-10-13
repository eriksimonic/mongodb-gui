import type { TopEntry } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { readCount, sortTop, topDelta, topTotals, writeCount } from './top-sort';

const stat = (timeMs: number, count: number) => ({ timeMs, count });

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

function snapshotEntry(ns: string, timeMs: number, queries: number): TopEntry {
  const none = { timeMs: 0, count: 0 };
  return {
    ns,
    total: { timeMs, count: queries },
    readLock: none,
    writeLock: none,
    queries: { timeMs, count: queries },
    getmore: none,
    insert: none,
    update: none,
    remove: none,
    commands: none,
  };
}

describe('topDelta', () => {
  it('subtracts the earlier snapshot and drops idle namespaces', () => {
    const result = topDelta(
      [snapshotEntry('a.b', 10, 2), snapshotEntry('a.c', 5, 1)],
      [snapshotEntry('a.b', 30, 5), snapshotEntry('a.c', 5, 1)],
    );
    expect(result.map((row) => row.ns)).toEqual(['a.b']);
    expect(result[0]?.total.timeMs).toBe(20);
    expect(result[0]?.queries.count).toBe(3);
  });

  it('counts a new namespace from zero and clamps a counter that went down', () => {
    const result = topDelta(
      [snapshotEntry('a.b', 50, 9)],
      [snapshotEntry('a.b', 4, 1), snapshotEntry('a.n', 7, 2)],
    );
    expect(result.find((row) => row.ns === 'a.b')?.total.timeMs ?? 0).toBe(0);
    expect(result.find((row) => row.ns === 'a.n')?.total.timeMs).toBe(7);
  });
});
