import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { getStorageCollections } from './storage';

interface FakeCollection {
  readonly name: string;
  readonly type: 'collection' | 'view';
}

interface FakeOptions {
  readonly collections: readonly FakeCollection[];
  // Collections whose $collStats call fails.
  readonly failStorage?: readonly string[];
  readonly failIndexStats?: boolean;
  readonly delayMs?: number;
}

interface FakeClient {
  readonly client: MongoClient;
  readonly touched: string[];
  readonly peak: () => number;
}

// A fake client that answers listCollections, $collStats and $indexStats. It tracks how many
// aggregate calls are in flight at once and which collections were queried.
function fakeClient(options: FakeOptions): FakeClient {
  const touched: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const collection = (name: string) => ({
    aggregate: (pipeline: Record<string, unknown>[]) => ({
      toArray: async (): Promise<unknown[]> => {
        touched.push(name);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await delay(options.delayMs ?? 0);
          if (pipeline[0] !== undefined && '$collStats' in pipeline[0]) {
            if (options.failStorage?.includes(name) === true) {
              throw new Error(`storage denied on ${name}`);
            }
            return [{ storageStats: storageStats() }];
          }
          if (options.failIndexStats === true) {
            throw new Error('indexStats denied');
          }
          return [
            { name: '_id_', accesses: { ops: 3, since: new Date('2026-01-01T00:00:00Z') } },
            { name: 'customer_1', accesses: { ops: 0, since: new Date('2026-01-01T00:00:00Z') } },
          ];
        } finally {
          inFlight -= 1;
        }
      },
    }),
  });
  const db = () => ({
    listCollections: () => ({
      toArray: async (): Promise<unknown[]> =>
        options.collections.map((entry) => ({ name: entry.name, type: entry.type, options: {} })),
    }),
    collection,
  });
  const client = { db } as unknown as MongoClient;
  return { client, touched, peak: () => peak };
}

function storageStats(): Record<string, unknown> {
  return {
    count: 10,
    size: 1000,
    avgObjSize: 100,
    storageSize: 4096,
    freeStorageSize: 0,
    totalIndexSize: 800,
    indexSizes: { _id_: 400, customer_1: 400 },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('getStorageCollections', () => {
  it('skips views and never queries them', async () => {
    const fake = fakeClient({
      collections: [
        { name: 'orders', type: 'collection' },
        { name: 'orders_view', type: 'view' },
      ],
    });
    const result = await getStorageCollections(fake.client, 'shop');
    expect(result.collections.map((entry) => entry.name)).toEqual(['orders']);
    expect(fake.touched).not.toContain('orders_view');
  });

  it('runs at most two collections at a time and keeps the input order', async () => {
    const fake = fakeClient({
      collections: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, type: 'collection' })),
      delayMs: 5,
    });
    const result = await getStorageCollections(fake.client, 'shop');
    expect(fake.peak()).toBe(2);
    expect(result.collections.map((entry) => entry.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('turns a failing collection into an entry with error set and keeps the others', async () => {
    const fake = fakeClient({
      collections: [
        { name: 'bad', type: 'collection' },
        { name: 'good', type: 'collection' },
      ],
      failStorage: ['bad'],
    });
    const result = await getStorageCollections(fake.client, 'shop');
    const bad = result.collections.find((entry) => entry.name === 'bad');
    const good = result.collections.find((entry) => entry.name === 'good');
    expect(bad?.error).toBe('storage denied on bad');
    expect(bad?.count).toBe(0);
    expect(bad?.indexes).toEqual([]);
    expect(good?.error).toBeNull();
    expect(good?.count).toBe(10);
  });

  it('reports ops and since as null when $indexStats fails, and keeps the sizes', async () => {
    const fake = fakeClient({
      collections: [{ name: 'orders', type: 'collection' }],
      failIndexStats: true,
    });
    const result = await getStorageCollections(fake.client, 'shop');
    const orders = result.collections[0];
    expect(orders?.error).toBeNull();
    expect(orders?.indexes.map((index) => index.name)).toEqual(['_id_', 'customer_1']);
    for (const index of orders?.indexes ?? []) {
      expect(index.ops).toBeNull();
      expect(index.since).toBeNull();
      expect(index.size).toBe(400);
    }
  });
});
