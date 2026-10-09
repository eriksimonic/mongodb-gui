import { describe, expect, it } from 'vitest';
import { groupByShape, percentileNearestRank, shapeKey } from './shape';
import type { ProfileEntry } from './types';

function entry(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id: '0000000000000000',
    ts: '2026-10-05T08:15:00.000Z',
    ns: 'shop.orders',
    op: 'query',
    millis: 1,
    raw: {},
    ...overrides,
  };
}

function find(filter: unknown, overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return entry({ command: { find: 'orders', filter }, ...overrides });
}

describe('shapeKey', () => {
  it('returns the queryHash when the entry has one', () => {
    const key = shapeKey(find({ status: 'paid' }, { queryHash: 'DEADBEEF' }));
    expect(key).toBe('DEADBEEF');
  });

  it('ignores an empty queryHash and builds a key instead', () => {
    const key = shapeKey(find({ status: 'paid' }, { queryHash: '' }));
    expect(key).toContain('shop.orders');
  });

  it('gives the same key for finds that differ only in values', () => {
    expect(shapeKey(find({ status: 'paid' }))).toBe(shapeKey(find({ status: 'open' })));
  });

  it('gives different keys for different fields', () => {
    expect(shapeKey(find({ status: 'paid' }))).not.toBe(shapeKey(find({ customer: 'a' })));
  });

  it('keeps operator keys and collapses arrays', () => {
    const first = shapeKey(find({ total: { $gt: 10 }, status: { $in: ['paid', 'open'] } }));
    const second = shapeKey(find({ status: { $in: ['shipped'] }, total: { $gt: 99 } }));
    expect(first).toBe(second);
    expect(first).toContain('$gt');
    expect(first).toContain('[?]');
    expect(shapeKey(find({ total: { $lt: 10 } }))).not.toBe(shapeKey(find({ total: { $gt: 10 } })));
  });

  it('sorts keys so that field order does not split a shape', () => {
    expect(shapeKey(find({ a: 1, b: 2 }))).toBe(shapeKey(find({ b: 9, a: 8 })));
  });

  it('replaces values with a placeholder regardless of their type', () => {
    const withDate = shapeKey(find({ createdAt: new Date('2026-01-01T00:00:00Z') }));
    const withString = shapeKey(find({ createdAt: 'yesterday' }));
    expect(withDate).toBe(withString);
    expect(withDate).toContain('?');
  });

  it('separates the same filter on different namespaces or operations', () => {
    const base = shapeKey(find({ status: 'paid' }));
    expect(shapeKey(find({ status: 'paid' }, { ns: 'shop.customers' }))).not.toBe(base);
    expect(shapeKey(find({ status: 'paid' }, { op: 'command' }))).not.toBe(base);
  });

  it('separates commands that share a namespace', () => {
    const count = entry({ op: 'command', command: { count: 'orders', query: { status: 'paid' } } });
    const aggregate = entry({
      op: 'command',
      command: { aggregate: 'orders', pipeline: [{ $match: { status: 'paid' } }] },
    });
    expect(shapeKey(count)).not.toBe(shapeKey(aggregate));
  });

  it('uses the pipeline of an aggregate as its structure', () => {
    const first = entry({
      op: 'query',
      command: { aggregate: 'orders', pipeline: [{ $match: { status: 'paid' } }] },
    });
    const second = entry({
      op: 'query',
      command: { aggregate: 'orders', pipeline: [{ $match: { status: 'open' } }] },
    });
    expect(shapeKey(first)).toBe(shapeKey(second));
  });

  it('uses the match of an update as its structure', () => {
    const update = entry({
      op: 'update',
      command: { q: { orderNumber: 4 }, u: { $set: { touched: true } } },
    });
    const other = entry({
      op: 'update',
      command: { q: { orderNumber: 9 }, u: { $set: { touched: false } } },
    });
    expect(shapeKey(update)).toBe(shapeKey(other));
  });

  it('reads the filter of a legacy 4.4 entry from query', () => {
    const legacy = entry({ op: 'update', command: { query: { orderNumber: 3 } } });
    expect(shapeKey(legacy)).toContain('"orderNumber":?');
  });

  it('builds a key for an entry without a command', () => {
    expect(shapeKey(entry({ op: 'insert' }))).toBe('insert|shop.orders|-|-');
  });
});

describe('groupByShape', () => {
  it('groups entries with the same shape and sums their time', () => {
    const shapes = groupByShape([
      find({ status: 'paid' }, { millis: 2 }),
      find({ status: 'open' }, { millis: 4 }),
      find({ $where: 'sleep(60) || true' }, { millis: 70 }),
    ]);
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toMatchObject({ count: 1, totalMillis: 70, maxMillis: 70 });
    expect(shapes[1]).toMatchObject({ count: 2, totalMillis: 6, avgMillis: 3, maxMillis: 4 });
  });

  it('sorts shapes by total time, slowest first', () => {
    const shapes = groupByShape([
      find({ a: 1 }, { millis: 5 }),
      find({ a: 2 }, { millis: 5 }),
      find({ b: 1 }, { millis: 11 }),
    ]);
    expect(shapes.map((shape) => shape.totalMillis)).toEqual([11, 10]);
  });

  it('uses the slowest entry as the example and collects distinct plan summaries', () => {
    const fast = find({ a: 1 }, { millis: 1, planSummary: 'IXSCAN' });
    const slow = find({ a: 2 }, { millis: 9, planSummary: 'COLLSCAN' });
    const again = find({ a: 3 }, { millis: 3, planSummary: 'COLLSCAN' });
    const [shape] = groupByShape([fast, slow, again]);
    expect(shape?.example).toBe(slow);
    expect(shape?.planSummaries).toEqual(['COLLSCAN', 'IXSCAN']);
  });

  it('computes the nearest-rank p95 for a group', () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      find({ a: index }, { millis: index + 1 }),
    );
    const [shape] = groupByShape(entries);
    expect(shape?.count).toBe(20);
    expect(shape?.p95Millis).toBe(19);
    expect(shape?.maxMillis).toBe(20);
  });

  it('groups by queryHash even when the filter structure differs', () => {
    const shapes = groupByShape([
      find({ a: 1 }, { queryHash: 'HASH1' }),
      find({ a: 1, b: 2 }, { queryHash: 'HASH1' }),
    ]);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ key: 'HASH1', count: 2 });
  });

  it('returns no shapes for no entries', () => {
    expect(groupByShape([])).toEqual([]);
  });

  it('gives every shape a key that matches shapeKey', () => {
    const entries = [find({ a: 1 }), find({ a: 2 }, { op: 'command' })];
    const keys = groupByShape(entries).map((shape) => shape.key);
    expect(keys.sort()).toEqual(entries.map(shapeKey).sort());
  });
});

describe('percentileNearestRank', () => {
  it('returns the value at rank ceil(p * n)', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentileNearestRank(values, 0.95)).toBe(95);
    expect(percentileNearestRank(values, 0.5)).toBe(50);
    expect(percentileNearestRank(values, 1)).toBe(100);
  });

  it('rounds the rank up for a small sample', () => {
    expect(percentileNearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentileNearestRank([4], 0.95)).toBe(4);
  });

  it('returns zero for an empty sample', () => {
    expect(percentileNearestRank([], 0.95)).toBe(0);
  });
});
