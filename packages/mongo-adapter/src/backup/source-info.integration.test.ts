import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBackupServerInfo } from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';

const SETUP_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 60_000;
const TEST_TIMEOUT_MS = 30_000;
const ORDER_COUNT = 3;

describe.each(['mongo:4.4', 'mongo:8.0.17'] as const)('MongoDB %s backup server info', (image) => {
  const db = `backup_${randomUUID().replaceAll('-', '')}`;
  const timeseries = image === 'mongo:8.0.17';
  let mongo: StartedMongo;
  let client: MongoClient;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = new MongoClient(mongo.rootUri, { appName: 'backup-info-integration' });
    await client.connect();
    const target = client.db(db);
    await target
      .collection('orders')
      .insertMany(Array.from({ length: ORDER_COUNT }, (_, index) => ({ index })));
    await target.createCollection('log', { capped: true, size: 4096 });
    await target.createCollection('recent', { viewOn: 'orders', pipeline: [] });
    if (timeseries) {
      await target.createCollection('cpu', { timeseries: { timeField: 'at' } });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await client?.db(db).dropDatabase();
    } finally {
      await client?.close();
      await mongo?.stop();
    }
  }, SETUP_TIMEOUT_MS);

  it(
    'reads the server facts without a scope',
    async () => {
      const info = await readBackupServerInfo(client);
      expect(info.serverVersion.startsWith(image.split(':')[1] ?? '')).toBe(true);
      expect(info.fcv).toBe(timeseries ? '8.0' : '4.4');
      expect(info.storageEngine).toBe('wiredTiger');
      expect(info.topology).toBe('standalone');
      expect(info.databases).toContain(db);
      expect(info.namespaces).toEqual([]);
      expect(info.namespacesTruncated).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lists the namespaces of a database with types and flags',
    async () => {
      const info = await readBackupServerInfo(client, { kind: 'database', database: db });
      const byName = new Map(info.namespaces.map((entry) => [entry.collection, entry]));
      expect(byName.get('orders')).toMatchObject({ type: 'collection', documents: ORDER_COUNT });
      expect(byName.get('log')).toMatchObject({ type: 'collection', capped: true });
      expect(byName.get('recent')).toMatchObject({ type: 'view' });
      expect(byName.get('recent')?.documents).toBeUndefined();
      expect([...byName.keys()].some((name) => name.startsWith('system.'))).toBe(false);
      if (timeseries) {
        expect(byName.get('cpu')).toMatchObject({ type: 'timeseries' });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'narrows to one collection',
    async () => {
      const info = await readBackupServerInfo(client, {
        kind: 'collection',
        database: db,
        collection: 'orders',
      });
      expect(info.namespaces.map((entry) => entry.collection)).toEqual(['orders']);
    },
    TEST_TIMEOUT_MS,
  );
});
