import type { StorageCollection, StorageCollections, StorageDatabases } from '@mongo-gui/core';

// Deterministic storage usage for the mock backend. Sizes are bytes.

const MB = 1024 * 1024;
const GB = 1024 * MB;
const SERVER_STARTED = '2026-10-01T08:00:00.000Z';

interface IndexFixture {
  name: string;
  size: number;
  /** null when $indexStats was denied. */
  ops: number | null;
}

interface CollectionFixture {
  name: string;
  type?: 'collection' | 'timeseries';
  count: number;
  dataSize: number;
  storageSize: number;
  freeStorageSize: number | null;
  indexes: IndexFixture[];
  /** Set for a collection whose stats could not be read. */
  error?: string;
}

interface DatabaseFixture {
  name: string;
  collections: CollectionFixture[];
}

const mb = (value: number): number => Math.round(value * MB);

const DATABASES: readonly DatabaseFixture[] = [
  {
    name: 'shop',
    collections: [
      {
        name: 'orders',
        count: 1_850_000,
        dataSize: mb(1900),
        storageSize: mb(640),
        freeStorageSize: mb(96),
        indexes: [
          { name: '_id_', size: mb(58), ops: 1_204_311 },
          { name: 'customerId_1', size: mb(41), ops: 88_120 },
          { name: 'status_1_createdAt_-1', size: mb(36), ops: 402_900 },
          { name: 'legacyRef_1', size: mb(22), ops: 0 },
        ],
      },
      {
        name: 'customers',
        count: 240_000,
        dataSize: mb(120),
        storageSize: mb(38),
        freeStorageSize: null,
        indexes: [
          { name: '_id_', size: mb(9), ops: 51_000 },
          { name: 'email_1', size: mb(14), ops: 19_400 },
        ],
      },
      {
        name: 'products',
        count: 12_400,
        dataSize: mb(46),
        storageSize: mb(15),
        freeStorageSize: mb(2),
        indexes: [
          { name: '_id_', size: mb(1.2), ops: 90_000 },
          { name: 'sku_1', size: mb(1), ops: 0 },
          { name: 'category_1', size: mb(0.8), ops: 4_310 },
        ],
      },
      {
        name: 'carts',
        count: 58_000,
        dataSize: mb(22),
        storageSize: mb(7),
        freeStorageSize: mb(11),
        indexes: [
          { name: '_id_', size: mb(2), ops: 300_000 },
          { name: 'userId_1', size: mb(2), ops: null },
        ],
      },
      {
        // Indexes bigger than the data.
        name: 'reviews',
        count: 9_000,
        dataSize: mb(4),
        storageSize: mb(1),
        freeStorageSize: null,
        indexes: [
          { name: '_id_', size: mb(1), ops: 20 },
          { name: 'productId_1_rating_-1', size: mb(3.2), ops: 14_000 },
        ],
      },
      {
        name: 'counters',
        count: 14,
        dataSize: mb(0.02),
        storageSize: mb(0.02),
        freeStorageSize: null,
        indexes: [{ name: '_id_', size: mb(0.03), ops: 2_400 }],
      },
    ],
  },
  {
    name: 'analytics',
    collections: [
      {
        name: 'pageviews',
        type: 'timeseries',
        count: 3_100_000,
        dataSize: mb(480),
        storageSize: mb(120),
        freeStorageSize: null,
        indexes: [{ name: 'metadata.site_1_timestamp_1', size: mb(6), ops: 2_100 }],
      },
      {
        name: 'sessions',
        count: 90_000,
        dataSize: mb(40),
        storageSize: mb(14),
        freeStorageSize: mb(3),
        indexes: [
          { name: '_id_', size: mb(2), ops: 9_000 },
          { name: 'userId_1', size: mb(1.5), ops: 4_100 },
        ],
      },
      {
        name: 'dailyRollups',
        count: 720,
        dataSize: mb(6),
        storageSize: mb(2),
        freeStorageSize: mb(0.5),
        indexes: [
          { name: '_id_', size: mb(0.1), ops: 5_000 },
          { name: 'day_1', size: mb(0.05), ops: 3_100 },
        ],
      },
      {
        name: 'funnelSteps',
        count: 1_200,
        dataSize: mb(0.9),
        storageSize: mb(0.3),
        freeStorageSize: null,
        indexes: [{ name: '_id_', size: mb(0.05), ops: 1_200 }],
      },
      {
        name: 'archive',
        count: 0,
        dataSize: 0,
        storageSize: 0,
        freeStorageSize: null,
        indexes: [],
        error: 'not authorized',
      },
    ],
  },
  {
    name: 'logs',
    collections: [
      {
        name: 'app',
        count: 2_400_000,
        dataSize: mb(900),
        storageSize: mb(210),
        freeStorageSize: mb(40),
        indexes: [
          { name: '_id_', size: mb(30), ops: 800 },
          { name: 'level_1_ts_-1', size: mb(25), ops: 61_000 },
        ],
      },
      {
        name: 'access',
        count: 5_100_000,
        dataSize: mb(1400),
        storageSize: mb(260),
        freeStorageSize: null,
        indexes: [
          { name: '_id_', size: mb(60), ops: 3_200 },
          { name: 'path_1', size: mb(40), ops: 220 },
        ],
      },
      {
        name: 'errors',
        count: 18_000,
        dataSize: mb(30),
        storageSize: mb(9),
        freeStorageSize: mb(1),
        indexes: [
          { name: '_id_', size: mb(0.6), ops: 400 },
          { name: 'fingerprint_1', size: mb(0.4), ops: 9 },
        ],
      },
      {
        name: 'audit',
        count: 310_000,
        dataSize: mb(120),
        storageSize: mb(33),
        freeStorageSize: mb(4),
        indexes: [
          { name: '_id_', size: mb(6), ops: 12 },
          { name: 'actor_1', size: mb(5), ops: 2_100 },
        ],
      },
      {
        name: 'jobs',
        count: 4_500,
        dataSize: mb(5),
        storageSize: mb(2),
        freeStorageSize: null,
        indexes: [
          { name: '_id_', size: mb(0.2), ops: 60 },
          { name: 'status_1', size: mb(0.1), ops: 88 },
        ],
      },
    ],
  },
];

const FS_TOTAL_SIZE = 512 * GB;
const FS_USED_SIZE = 301 * GB;

function toCollection(fixture: CollectionFixture): StorageCollection {
  const type = fixture.type ?? 'collection';
  if (fixture.error !== undefined) {
    return {
      name: fixture.name,
      type,
      count: 0,
      dataSize: 0,
      avgObjSize: 0,
      storageSize: 0,
      freeStorageSize: null,
      totalIndexSize: 0,
      indexes: [],
      error: fixture.error,
    };
  }
  const indexes = fixture.indexes.map((index) => ({
    name: index.name,
    size: index.size,
    ops: index.ops,
    since: index.ops === null ? null : SERVER_STARTED,
  }));
  return {
    name: fixture.name,
    type,
    count: fixture.count,
    dataSize: fixture.dataSize,
    avgObjSize: fixture.count > 0 ? Math.round(fixture.dataSize / fixture.count) : 0,
    storageSize: fixture.storageSize,
    freeStorageSize: fixture.freeStorageSize,
    totalIndexSize: indexes.reduce((sum, index) => sum + index.size, 0),
    indexes,
    error: null,
  };
}

const COLLECTIONS: ReadonlyMap<string, StorageCollection[]> = new Map(
  DATABASES.map((database) => [database.name, database.collections.map(toCollection)]),
);

function sizeOnDisk(collections: readonly StorageCollection[]): number {
  return collections.reduce(
    (sum, collection) => sum + collection.storageSize + collection.totalIndexSize,
    0,
  );
}

/** The storage databases of the mock, with the disk totals. */
export function mockStorageDatabases(): StorageDatabases {
  return {
    databases: Array.from(COLLECTIONS, ([name, collections]) => ({
      name,
      sizeOnDisk: sizeOnDisk(collections),
      empty: collections.length === 0,
    })),
    fsUsedSize: FS_USED_SIZE,
    fsTotalSize: FS_TOTAL_SIZE,
  };
}

/** The collections of one mock database, or undefined when the database is not in the mock. */
export function mockStorageCollections(database: string): StorageCollections | undefined {
  const collections = COLLECTIONS.get(database);
  return collections === undefined ? undefined : { database, collections };
}
