import { describe, expect, it } from 'vitest';
import {
  CollectionInfoSchema,
  CollectionStatsSchema,
  DatabaseInfoSchema,
  DatabaseStatsSchema,
  IndexInfoSchema,
} from './catalog';

describe('DatabaseInfoSchema', () => {
  it('accepts a database with size and emptiness', () => {
    expect(
      DatabaseInfoSchema.safeParse({ name: 'shop', sizeOnDisk: 4096, empty: false }).success,
    ).toBe(true);
  });

  it('rejects a negative size', () => {
    expect(DatabaseInfoSchema.safeParse({ name: 'shop', sizeOnDisk: -1 }).success).toBe(false);
  });
});

describe('CollectionInfoSchema', () => {
  it('accepts a timeseries collection with options and info', () => {
    const collection = {
      name: 'readings',
      type: 'timeseries',
      options: { timeseries: { timeField: 'ts' } },
      info: { readOnly: false, uuid: 'd2a1' },
    };
    expect(CollectionInfoSchema.safeParse(collection).success).toBe(true);
  });

  it('rejects an unknown collection type', () => {
    expect(CollectionInfoSchema.safeParse({ name: 'x', type: 'bucket' }).success).toBe(false);
  });
});

describe('CollectionStatsSchema', () => {
  it('accepts stats with per-index sizes', () => {
    const stats = {
      ns: 'shop.orders',
      count: 1200,
      size: 480000,
      storageSize: 262144,
      avgObjSize: 400,
      nindexes: 2,
      totalIndexSize: 81920,
      capped: false,
      indexSizes: { _id_: 40960, status_1: 40960 },
    };
    expect(CollectionStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('rejects a fractional document count', () => {
    const stats = {
      ns: 'shop.orders',
      count: 1.5,
      size: 0,
      storageSize: 0,
      avgObjSize: 0,
      nindexes: 1,
      totalIndexSize: 0,
      capped: false,
      indexSizes: {},
    };
    expect(CollectionStatsSchema.safeParse(stats).success).toBe(false);
  });
});

describe('DatabaseStatsSchema', () => {
  it('accepts database stats', () => {
    const stats = {
      db: 'shop',
      collections: 3,
      views: 1,
      objects: 5000,
      dataSize: 2000000,
      storageSize: 1000000,
      indexes: 5,
      indexSize: 300000,
    };
    expect(DatabaseStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('rejects a missing field', () => {
    expect(DatabaseStatsSchema.safeParse({ db: 'shop', collections: 3 }).success).toBe(false);
  });
});

describe('IndexInfoSchema', () => {
  it('accepts an index with special key types and usage', () => {
    const index = {
      name: 'location_2dsphere',
      key: { location: '2dsphere', status: -1, _id: 1 },
      sparse: true,
      hidden: false,
      expireAfterSeconds: 3600,
      partialFilterExpression: { status: 'paid' },
      collation: { locale: 'en' },
      size: 40960,
      usage: { ops: 12, since: '2026-10-01T00:00:00.000Z' },
    };
    expect(IndexInfoSchema.safeParse(index).success).toBe(true);
  });

  it('accepts legacy numeric key values such as 0 and -1.0', () => {
    expect(IndexInfoSchema.safeParse({ name: 'a_0', key: { a: 0, b: -1.0 } }).success).toBe(true);
  });

  it('rejects a key value that is neither a number nor a string', () => {
    expect(IndexInfoSchema.safeParse({ name: 'a_1', key: { a: true } }).success).toBe(false);
  });
});
