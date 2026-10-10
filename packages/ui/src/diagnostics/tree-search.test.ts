import { describe, expect, it } from 'vitest';
import { childEntries, matchingPaths, pathKey, valueAtPath } from './tree-search';

const DOCUMENT = {
  wiredTiger: {
    cache: { 'bytes currently in the cache': 4096, 'maximum bytes configured': 8192 },
    log: { 'log bytes written': 12 },
  },
  connections: { current: 3, available: 100 },
  tags: ['alpha', { deep: 1 }],
};

/** The identity of a path given as keys. */
function keyOf(...segments: string[]): string {
  return pathKey(segments);
}

describe('matchingPaths', () => {
  it('returns undefined for an empty query, which means no filter', () => {
    expect(matchingPaths(DOCUMENT, '   ')).toBeUndefined();
  });

  it('keeps the matching nodes and every ancestor of them', () => {
    const visible = matchingPaths(DOCUMENT, 'maximum');
    expect(visible).toEqual(
      new Set([
        keyOf('wiredTiger'),
        keyOf('wiredTiger', 'cache'),
        keyOf('wiredTiger', 'cache', 'maximum bytes configured'),
      ]),
    );
  });

  it('matches a dotted path, so the children of a matching branch stay visible', () => {
    const visible = matchingPaths(DOCUMENT, 'WIREDTIGER.LOG');
    expect(visible).toEqual(
      new Set([
        keyOf('wiredTiger'),
        keyOf('wiredTiger', 'log'),
        keyOf('wiredTiger', 'log', 'log bytes written'),
      ]),
    );
  });

  it('keeps a match in an array with its index', () => {
    expect(matchingPaths(DOCUMENT, 'deep')).toEqual(
      new Set([keyOf('tags'), keyOf('tags', '1'), keyOf('tags', '1', 'deep')]),
    );
  });

  it('keeps nothing when no path matches', () => {
    expect(matchingPaths(DOCUMENT, 'no-such-key')).toEqual(new Set());
  });

  it('does not confuse a key that holds a dot with two nested keys', () => {
    const document = { 'a.b': { x: 1 }, a: { b: { y: 2 } } };
    const visible = matchingPaths(document, 'y');
    expect(visible).toEqual(new Set([keyOf('a'), keyOf('a', 'b'), keyOf('a', 'b', 'y')]));
    expect(visible?.has(keyOf('a.b'))).toBe(false);
  });
});

describe('valueAtPath', () => {
  it('returns the subtree at a path of keys', () => {
    expect(valueAtPath(DOCUMENT, ['connections'])).toEqual({ current: 3, available: 100 });
    expect(valueAtPath(DOCUMENT, ['tags', '1', 'deep'])).toBe(1);
  });

  it('returns the whole document for the empty path and undefined for a missing path', () => {
    expect(valueAtPath(DOCUMENT, [])).toBe(DOCUMENT);
    expect(valueAtPath(DOCUMENT, ['connections', 'missing'])).toBeUndefined();
  });

  it('reads a key that holds a dot as one key', () => {
    expect(valueAtPath({ 'a.b': 7 }, ['a.b'])).toBe(7);
  });
});

describe('childEntries', () => {
  it('lists object keys and array indexes, and nothing for a scalar', () => {
    expect(childEntries(['x'])).toEqual([['0', 'x']]);
    expect(childEntries(7)).toEqual([]);
  });
});
