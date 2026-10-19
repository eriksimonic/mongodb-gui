import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageCollectionsSchema, StorageDatabasesSchema } from '@mongo-gui/core';
import { getStorageCollections, getStorageDatabases } from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';

const STORAGE_DB = 'storage_test';
const ORDER_COUNT = 50;
const SECONDARY_INDEX = 'by_status';
const SUITE_TIMEOUT_MS = 60_000;

describe.each(MONGO_IMAGES)('storage usage on %s', (image) => {
  let mongo: StartedMongo | undefined;
  let client: MongoClient | undefined;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = new MongoClient(mongo.rootUri, { appName: 'storage-test' });
    await client.connect();
    const db = client.db(STORAGE_DB);
    const orders = db.collection('orders');
    await orders.insertMany(
      Array.from({ length: ORDER_COUNT }, (_, index) => ({
        index,
        status: index % 2 === 0 ? 'paid' : 'open',
        note: `order-${index}`,
      })),
    );
    await orders.createIndex({ status: 1 }, { name: SECONDARY_INDEX });
    await db.collection('customers').insertOne({ name: 'Ada' });
    // A capped collection works on every image in the matrix, unlike a timeseries collection.
    await db.createCollection('events', { capped: true, size: 65_536 });
    await db.createCollection('orders_view', { viewOn: 'orders', pipeline: [] });
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  function connected(): MongoClient {
    if (client === undefined) {
      throw new Error('the server was not started');
    }
    return client;
  }

  it(
    'lists databases with sizes and the disk totals when the server reports them',
    async () => {
      const result = await getStorageDatabases(connected());
      expect(StorageDatabasesSchema.safeParse(result).success).toBe(true);
      const storage = result.databases.find((database) => database.name === STORAGE_DB);
      expect(storage).toBeDefined();
      expect(storage?.empty).toBe(false);
      expect(storage?.sizeOnDisk).toBeGreaterThan(0);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads each collection with its counts, sizes and indexes',
    async () => {
      const result = await getStorageCollections(connected(), STORAGE_DB);
      expect(StorageCollectionsSchema.safeParse(result).success).toBe(true);
      expect(result.database).toBe(STORAGE_DB);

      const names = result.collections.map((collection) => collection.name);
      expect(names).toEqual(expect.arrayContaining(['orders', 'customers', 'events']));
      expect(names).not.toContain('orders_view');

      const orders = result.collections.find((collection) => collection.name === 'orders');
      expect(orders?.count).toBe(ORDER_COUNT);
      expect(orders?.error).toBeNull();
      expect(orders?.dataSize).toBeGreaterThan(0);
      const indexNames = orders?.indexes.map((index) => index.name) ?? [];
      expect(indexNames).toEqual(expect.arrayContaining(['_id_', SECONDARY_INDEX]));
      expect(orders?.indexes.every((index) => index.size >= 0)).toBe(true);
      // The root user may read $indexStats, so the operation counters are numbers here.
      const secondary = orders?.indexes.find((index) => index.name === SECONDARY_INDEX);
      expect(typeof secondary?.ops).toBe('number');
      expect(secondary?.since).not.toBeNull();

      const events = result.collections.find((collection) => collection.name === 'events');
      expect(events?.error).toBeNull();
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'returns an empty collection list for a database that does not exist',
    async () => {
      const result = await getStorageCollections(connected(), 'storage_missing_db');
      expect(StorageCollectionsSchema.safeParse(result).success).toBe(true);
      expect(result.collections).toEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );
});
