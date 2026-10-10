import { describe, expect, it } from 'vitest';
import { childEntries, matchingPaths, valueAtPath } from './tree-search';

const DOCUMENT = {
  wiredTiger: {
    cache: { 'bytes currently in the cache': 4096, 'maximum bytes configured': 8192 },
    log: { 'log bytes written': 12 },
  },
  connections: { current: 3, available: 100 },
  tags: ['alpha', { deep: 1 }],
};

describe('matchingPaths', () => {
  it('returns undefined for an empty query, which means no filter', () => {
    expect(matchingPaths(DOCUMENT, '   ')).toBeUndefined();
  });

  it('keeps the matching paths and every ancestor of them', () => {
    const visible = matchingPaths(DOCUMENT, 'maximum');
    expect(visible).toEqual(
      new Set(['wiredTiger', 'wiredTiger.cache', 'wiredTiger.cache.maximum bytes configured']),
    );
  });

  it('matches a dotted path, so the children of a matching branch stay visible', () => {
    const visible = matchingPaths(DOCUMENT, 'WIREDTIGER.LOG');
    expect(visible).toEqual(
      new Set(['wiredTiger', 'wiredTiger.log', 'wiredTiger.log.log bytes written']),
    );
  });

  it('keeps a match in an array with its index segment', () => {
    expect(matchingPaths(DOCUMENT, 'deep')).toEqual(new Set(['tags', 'tags.[1]', 'tags.[1].deep']));
  });

  it('keeps nothing when no path matches', () => {
    expect(matchingPaths(DOCUMENT, 'no-such-key')).toEqual(new Set());
  });
});

describe('valueAtPath', () => {
  it('returns the subtree at a dotted path', () => {
    expect(valueAtPath(DOCUMENT, 'connections')).toEqual({ current: 3, available: 100 });
    expect(valueAtPath(DOCUMENT, 'tags.[1].deep')).toBe(1);
  });

  it('returns the whole document for the empty path and undefined for a missing path', () => {
    expect(valueAtPath(DOCUMENT, '')).toBe(DOCUMENT);
    expect(valueAtPath(DOCUMENT, 'connections.missing')).toBeUndefined();
  });
});

describe('childEntries', () => {
  it('lists object keys and array indexes, and nothing for a scalar', () => {
    expect(childEntries(['x'])).toEqual([['[0]', 'x']]);
    expect(childEntries(7)).toEqual([]);
  });
});
