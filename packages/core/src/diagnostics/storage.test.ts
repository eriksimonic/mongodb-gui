import { describe, expect, it } from 'vitest';
import { StorageCollectionSchema, StorageCollectionsSchema, StorageDatabasesSchema } from './storage';

const collection = {
  name: 'orders',
  type: 'collection',
  count: 1200,
  dataSize: 4096,
  avgObjSize: 3,
  storageSize: 8192,
  freeStorageSize: null,
  totalIndexSize: 16384,
  indexes: [{ name: '_id_', size: 8192, ops: 0, since: '2026-10-01T00:00:00.000Z' }],
  error: null,
};

describe('StorageDatabasesSchema', () => {
  it('parses a valid sample', () => {
    const parsed = StorageDatabasesSchema.parse({
      databases: [{ name: 'shop', sizeOnDisk: 20480, empty: false }],
      fsUsedSize: 301,
      fsTotalSize: 512,
    });
    expect(parsed.databases[0]?.name).toBe('shop');
  });

  it('rejects a negative size', () => {
    expect(
      StorageDatabasesSchema.safeParse({
        databases: [{ name: 'shop', sizeOnDisk: -1, empty: false }],
        fsUsedSize: null,
        fsTotalSize: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(
      StorageDatabasesSchema.safeParse({
        databases: [{ sizeOnDisk: 1, empty: true }],
        fsUsedSize: null,
        fsTotalSize: null,
      }).success,
    ).toBe(false);
  });
});

describe('StorageCollectionsSchema', () => {
  it('parses a valid sample', () => {
    const parsed = StorageCollectionsSchema.parse({ database: 'shop', collections: [collection] });
    expect(parsed.collections[0]?.indexes[0]?.ops).toBe(0);
  });

  it('accepts an entry with an error and null index stats', () => {
    const parsed = StorageCollectionSchema.parse({
      ...collection,
      dataSize: 0,
      storageSize: 0,
      totalIndexSize: 0,
      indexes: [{ name: '_id_', size: 0, ops: null, since: null }],
      error: 'not authorized',
    });
    expect(parsed.error).toBe('not authorized');
  });

  it('rejects a negative size and a missing name', () => {
    expect(
      StorageCollectionSchema.safeParse({ ...collection, storageSize: -5 }).success,
    ).toBe(false);
    const withoutName: Record<string, unknown> = { ...collection };
    delete withoutName.name;
    expect(StorageCollectionSchema.safeParse(withoutName).success).toBe(false);
  });
});
