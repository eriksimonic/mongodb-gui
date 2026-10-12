import { describe, expect, it } from 'vitest';
import type { TopEntry } from '@mongo-gui/core';
import { topDelta } from './top-sort';

function entry(ns: string, timeMs: number, queries: number): TopEntry {
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
      [entry('a.b', 10, 2), entry('a.c', 5, 1)],
      [entry('a.b', 30, 5), entry('a.c', 5, 1)],
    );
    expect(result.map((row) => row.ns)).toEqual(['a.b']);
    expect(result[0]?.total.timeMs).toBe(20);
    expect(result[0]?.queries.count).toBe(3);
  });

  it('counts a new namespace from zero and clamps a counter that went down', () => {
    const result = topDelta([entry('a.b', 50, 9)], [entry('a.b', 4, 1), entry('a.n', 7, 2)]);
    expect(result.find((row) => row.ns === 'a.b')?.total.timeMs ?? 0).toBe(0);
    expect(result.find((row) => row.ns === 'a.n')?.total.timeMs).toBe(7);
  });
});
