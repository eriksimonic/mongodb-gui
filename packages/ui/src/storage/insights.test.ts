import { describe, expect, it } from 'vitest';
import { computeInsights, type TaggedCollection } from './insights';

function collection(overrides: Partial<TaggedCollection> & { name: string }): TaggedCollection {
  return {
    database: 'shop',
    type: 'collection',
    count: 0,
    dataSize: 0,
    avgObjSize: 0,
    storageSize: 0,
    freeStorageSize: null,
    totalIndexSize: 0,
    indexes: [],
    error: null,
    ...overrides,
  };
}

describe('computeInsights', () => {
  it('returns empty results for empty input', () => {
    expect(computeInsights([])).toEqual({
      topCollections: [],
      topIndexes: [],
      unusedIndexes: { items: [], totalSize: 0 },
      indexHeavyCollections: [],
      reclaimableSize: null,
    });
  });

  it('handles one collection', () => {
    const result = computeInsights([
      collection({
        name: 'orders',
        dataSize: 100,
        storageSize: 120,
        totalIndexSize: 40,
        freeStorageSize: 8,
        indexes: [{ name: '_id_', size: 20, ops: 5, since: null }],
      }),
    ]);
    expect(result.topCollections.map((c) => c.name)).toEqual(['orders']);
    expect(result.topIndexes).toEqual([
      { name: '_id_', size: 20, ops: 5, since: null, database: 'shop', collection: 'orders' },
    ]);
    expect(result.indexHeavyCollections).toEqual([]);
    expect(result.reclaimableSize).toBe(8);
  });

  it('keeps the top 5 collections and indexes by size', () => {
    const collections = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      collection({
        name: `c${n}`,
        storageSize: n * 10,
        indexes: [{ name: `i${n}`, size: n, ops: 1, since: null }],
      }),
    );
    const result = computeInsights(collections);
    expect(result.topCollections.map((c) => c.name)).toEqual(['c7', 'c6', 'c5', 'c4', 'c3']);
    expect(result.topIndexes.map((i) => i.size)).toEqual([7, 6, 5, 4, 3]);
  });

  it('keeps equal values and does not drop them', () => {
    const result = computeInsights([
      collection({ name: 'a', storageSize: 10 }),
      collection({ name: 'b', storageSize: 10 }),
    ]);
    expect(result.topCollections.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('lists unused indexes with their summed size and excludes _id_', () => {
    const result = computeInsights([
      collection({
        name: 'orders',
        indexes: [
          { name: '_id_', size: 50, ops: 0, since: null },
          { name: 'by_customer', size: 30, ops: 0, since: '2026-10-01T00:00:00.000Z' },
          { name: 'by_date', size: 10, ops: 4, since: null },
        ],
      }),
      collection({
        name: 'users',
        database: 'analytics',
        indexes: [{ name: 'by_email', size: 5, ops: 0, since: null }],
      }),
    ]);
    expect(result.unusedIndexes.items.map((i) => `${i.database}.${i.collection}.${i.name}`)).toEqual([
      'shop.orders.by_customer',
      'analytics.users.by_email',
    ]);
    expect(result.unusedIndexes.totalSize).toBe(35);
  });

  it('does not treat a null ops count as unused', () => {
    const result = computeInsights([
      collection({
        name: 'orders',
        indexes: [{ name: 'by_date', size: 12, ops: null, since: null }],
      }),
    ]);
    expect(result.unusedIndexes).toEqual({ items: [], totalSize: 0 });
  });

  it('flags collections whose index size is larger than data size', () => {
    const big = collection({ name: 'events', dataSize: 100, totalIndexSize: 150 });
    const small = collection({ name: 'users', dataSize: 100, totalIndexSize: 100 });
    const result = computeInsights([big, small]);
    expect(result.indexHeavyCollections.map((c) => c.name)).toEqual(['events']);
  });

  it('sums reclaimable space only over collections that report it', () => {
    const result = computeInsights([
      collection({ name: 'a', freeStorageSize: 4 }),
      collection({ name: 'b', freeStorageSize: null }),
      collection({ name: 'c', freeStorageSize: 6 }),
    ]);
    expect(result.reclaimableSize).toBe(10);
  });

  it('returns null reclaimable space when no collection reports it', () => {
    const result = computeInsights([collection({ name: 'a' }), collection({ name: 'b' })]);
    expect(result.reclaimableSize).toBeNull();
  });
});
