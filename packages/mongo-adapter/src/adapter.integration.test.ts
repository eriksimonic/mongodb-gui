import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  CollectionInfoSchema,
  CollectionStatsSchema,
  ConnectionStatusSchema,
  ConnectionTestResultSchema,
  DatabaseInfoSchema,
  DatabaseStatsSchema,
  IndexInfoSchema,
  type ConnectionProfile,
  type ConnectionStatus,
} from '@mongo-gui/core';
import {
  collectionStats,
  ConnectionManager,
  databaseStats,
  listCollections,
  listDatabases,
  listIndexes,
} from './index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  METRIC_COUNT,
  MONGO_IMAGES,
  SEED_DB,
  findClosedPort,
  seedCatalog,
  startMongo,
  supportsTimeseries,
  type StartedMongo,
} from './test/mongo-container';

const SUITE_TIMEOUT_MS = 30_000;
const FAILURE_BUDGET_MS = 8_000;
const UNROUTABLE_HOST = '10.255.255.1';
const SETTLE_POLL_MS = 150;
const SETTLE_TIMEOUT_MS = 10_000;

function makeProfile(uri: string, connectTimeoutMs?: number): ConnectionProfile {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'integration',
    uri,
    createdAt: now,
    updatedAt: now,
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
  };
}

async function captureAppErrorCode(action: () => unknown): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

// Counts server-side connections opened by this adapter (appName mongo-gui), including monitors.
async function countAdapterConnections(rootUri: string): Promise<number> {
  const probe = new MongoClient(rootUri, { appName: 'probe' });
  try {
    await probe.connect();
    const rows = await probe
      .db('admin')
      .aggregate([
        { $currentOp: { allUsers: true, idleConnections: true } },
        { $match: { 'clientMetadata.application.name': 'mongo-gui' } },
      ])
      .toArray();
    return rows.length;
  } finally {
    await probe.close();
  }
}

// Waits until three reads in a row agree, so driver teardown has finished.
async function settledConnectionCount(rootUri: string): Promise<number> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previous = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = await countAdapterConnections(rootUri);
    stableReads = current === previous ? stableReads + 1 : 1;
    previous = current;
    if (stableReads >= 3) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return previous;
}

describe.each(MONGO_IMAGES)('MongoDB %s adapter', (image) => {
  const [major = '', minor = ''] = image.slice('mongo:'.length).split('.');
  const versionPattern = new RegExp(`^${major}\\.${minor}\\.`);
  const timeseries = supportsTimeseries(image);
  const manager = new ConnectionManager();
  let mongo: StartedMongo | undefined;
  let profile: ConnectionProfile;
  let connected: ConnectionStatus;

  const requireMongo = (): StartedMongo => {
    if (mongo === undefined) {
      throw new Error('MongoDB container is not running');
    }
    return mongo;
  };

  beforeAll(async () => {
    mongo = await startMongo(image);
    await seedCatalog(mongo.rootUri, timeseries);
    profile = makeProfile(mongo.rootUri);
    connected = await manager.connect(profile);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await manager.disconnectAll();
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  it(
    'connects and reports version, standalone topology and no set name',
    () => {
      ConnectionStatusSchema.parse(connected);
      expect(connected).toMatchObject({
        state: 'connected',
        topology: 'standalone',
        hosts: [],
        serverVersion: expect.stringMatching(versionPattern) as unknown,
      });
      expect(connected).not.toHaveProperty('setName');
      expect(manager.status(profile.id)).toEqual(connected);
      expect(manager.isConnected(profile.id)).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'test returns version and topology and stores nothing',
    async () => {
      const probe = makeProfile(requireMongo().rootUri);
      const result = await manager.test(probe);
      ConnectionTestResultSchema.parse(result);
      expect(result).toMatchObject({
        ok: true,
        topology: 'standalone',
        serverVersion: expect.stringMatching(versionPattern) as unknown,
      });
      expect(manager.status(probe.id)).toEqual({ state: 'disconnected' });
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists databases with the seeded database, sorted by name',
    async () => {
      const databases = await listDatabases(manager.getClient(profile.id));
      databases.forEach((database) => DatabaseInfoSchema.parse(database));
      const names = databases.map((database) => database.name);
      expect(names).toEqual([...names].sort());
      expect(databases.find((database) => database.name === SEED_DB)).toMatchObject({
        name: SEED_DB,
        empty: false,
        sizeOnDisk: expect.any(Number) as unknown,
      });
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists collections with types, sorting and view options',
    async () => {
      const client = manager.getClient(profile.id);
      const collections = await listCollections(client, SEED_DB);
      collections.forEach((collection) => CollectionInfoSchema.parse(collection));
      const expectedTypes: [string, string][] = [
        ['events', 'collection'],
        ['orders', 'collection'],
        ['paidOrders', 'view'],
      ];
      if (timeseries) {
        expectedTypes.splice(1, 0, ['metrics', 'timeseries']);
      }
      expect(collections.map((collection) => [collection.name, collection.type])).toEqual(
        expectedTypes,
      );
      expect(collections.find((collection) => collection.name === 'paidOrders')?.options).toEqual(
        expect.objectContaining({ viewOn: 'orders' }) as unknown,
      );
      expect(collections.find((collection) => collection.name === 'orders')?.info?.uuid).toMatch(
        /^[0-9a-f]{32}$/,
      );
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'hides system collections unless includeSystem is set',
    async () => {
      const client = manager.getClient(profile.id);
      const withoutSystem = await listCollections(client, SEED_DB);
      expect(withoutSystem.some((collection) => collection.name.startsWith('system.'))).toBe(false);
      const withSystem = await listCollections(client, SEED_DB, { includeSystem: true });
      expect(withSystem.map((collection) => collection.name)).toContain('system.views');
      if (timeseries) {
        expect(withSystem.map((collection) => collection.name)).toContain('system.buckets.metrics');
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reports collection stats with count, index count and index sizes',
    async () => {
      const stats = await collectionStats(manager.getClient(profile.id), SEED_DB, 'orders');
      CollectionStatsSchema.parse(stats);
      expect(stats).toMatchObject({ ns: 'shop.orders', count: 50, nindexes: 3, capped: false });
      expect(Object.keys(stats.indexSizes).sort()).toEqual([
        '_id_',
        'expiresAt_1',
        'status_1_createdAt_-1',
      ]);
      expect(stats.totalIndexSize).toBeGreaterThan(0);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reports a capped collection as capped',
    async () => {
      const stats = await collectionStats(manager.getClient(profile.id), SEED_DB, 'events');
      CollectionStatsSchema.parse(stats);
      expect(stats).toMatchObject({ count: 10, capped: true });
    },
    SUITE_TIMEOUT_MS,
  );

  it.runIf(timeseries)(
    'reports timeseries collection stats and indexes',
    async () => {
      const client = manager.getClient(profile.id);
      const stats = await collectionStats(client, SEED_DB, 'metrics');
      CollectionStatsSchema.parse(stats);
      expect(stats.count).toBe(METRIC_COUNT);
      // Index listing on a timeseries collection differs by version (none on 6.0), so only the shape is checked.
      const indexes = await listIndexes(client, SEED_DB, 'metrics');
      indexes.forEach((index) => IndexInfoSchema.parse(index));
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'returns zeros for a view instead of failing',
    async () => {
      const stats = await collectionStats(manager.getClient(profile.id), SEED_DB, 'paidOrders');
      CollectionStatsSchema.parse(stats);
      expect(stats).toMatchObject({
        ns: 'shop.paidOrders',
        count: 0,
        size: 0,
        nindexes: 0,
        indexSizes: {},
      });
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reports database stats for the seeded database',
    async () => {
      const stats = await databaseStats(manager.getClient(profile.id), SEED_DB);
      DatabaseStatsSchema.parse(stats);
      // dbStats counts system.views, and from 5.0 the timeseries view and its system bucket collection.
      expect(stats).toMatchObject({
        db: SEED_DB,
        collections: timeseries ? 4 : 3,
        views: timeseries ? 2 : 1,
      });
      expect(stats.objects).toBeGreaterThanOrEqual(60);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists indexes with keys, TTL setting, sizes and usage',
    async () => {
      const indexes = await listIndexes(manager.getClient(profile.id), SEED_DB, 'orders');
      indexes.forEach((index) => IndexInfoSchema.parse(index));
      expect(indexes.map((index) => index.name).sort()).toEqual([
        '_id_',
        'expiresAt_1',
        'status_1_createdAt_-1',
      ]);
      const compound = indexes.find((index) => index.name === 'status_1_createdAt_-1');
      expect(compound?.key).toEqual({ status: 1, createdAt: -1 });
      const ttl = indexes.find((index) => index.name === 'expiresAt_1');
      expect(ttl).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 3600 });
      for (const index of indexes) {
        expect(index.size).toBeGreaterThanOrEqual(0);
      }
      const idIndex = indexes.find((index) => index.name === '_id_');
      expect(idIndex?.usage?.ops).toBeGreaterThanOrEqual(0);
      expect(idIndex?.usage?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists no indexes for a view',
    async () => {
      expect(await listIndexes(manager.getClient(profile.id), SEED_DB, 'paidOrders')).toEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'test reports AUTH_FAILED for a wrong password',
    async () => {
      const result = await manager.test(makeProfile(requireMongo().wrongPasswordUri));
      ConnectionTestResultSchema.parse(result);
      expect(result).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'test reports CONNECTION_FAILED for a refused port within the configured timeout',
    async () => {
      const port = await findClosedPort();
      const started = Date.now();
      const result = await manager.test(makeProfile(`mongodb://127.0.0.1:${port}/`, 2000));
      const elapsed = Date.now() - started;
      ConnectionTestResultSchema.parse(result);
      expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTION_FAILED' } });
      expect(elapsed).toBeLessThan(FAILURE_BUDGET_MS);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'test reports CONNECTION_TIMEOUT for an unroutable host within the configured timeout',
    async () => {
      const started = Date.now();
      const result = await manager.test(makeProfile(`mongodb://${UNROUTABLE_HOST}:27017/`, 2000));
      const elapsed = Date.now() - started;
      ConnectionTestResultSchema.parse(result);
      expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTION_TIMEOUT' } });
      expect(elapsed).toBeLessThan(FAILURE_BUDGET_MS);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'disconnect clears the status and the client',
    async () => {
      await manager.disconnect(profile.id);
      expect(manager.status(profile.id)).toEqual({ state: 'disconnected' });
      expect(manager.isConnected(profile.id)).toBe(false);
      expect(await captureAppErrorCode(() => manager.getClient(profile.id))).toBe('NOT_CONNECTED');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'notifies listeners on connect, reconnect, closed topology and disconnect',
    async () => {
      const other = new ConnectionManager();
      const states: string[] = [];
      const unsubscribe = other.onStatusChange((_id, status) => states.push(status.state));
      const reconnecting = makeProfile(requireMongo().rootUri);
      await other.connect(reconnecting);
      await other.connect(reconnecting);
      await other.getClient(reconnecting.id).close();
      expect(other.status(reconnecting.id).state).toBe('error');
      unsubscribe();
      await other.disconnect(reconnecting.id);
      expect(states).toEqual([
        'connecting',
        'connected',
        'disconnected',
        'connecting',
        'connected',
        'error',
      ]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'parallel connects to one profile leave exactly one live client',
    async () => {
      const rootUri = requireMongo().rootUri;
      const racer = new ConnectionManager();
      const racing = makeProfile(rootUri);
      expect(await settledConnectionCount(rootUri)).toBe(0);

      await racer.connect(racing);
      const singleClient = await settledConnectionCount(rootUri);
      expect(singleClient).toBeGreaterThan(0);
      await racer.disconnect(racing.id);
      expect(await settledConnectionCount(rootUri)).toBe(0);

      await Promise.all([racer.connect(racing), racer.connect(racing)]);
      expect(racer.status(racing.id).state).toBe('connected');
      expect(await settledConnectionCount(rootUri)).toBe(singleClient);

      await racer.disconnectAll();
      expect(await settledConnectionCount(rootUri)).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'connect followed by an immediate disconnect ends disconnected',
    async () => {
      const rootUri = requireMongo().rootUri;
      const quick = new ConnectionManager();
      const profileQuick = makeProfile(rootUri);
      const pending = quick.connect(profileQuick);
      await quick.disconnect(profileQuick.id);
      await pending;
      expect(quick.status(profileQuick.id)).toEqual({ state: 'disconnected' });
      expect(await settledConnectionCount(rootUri)).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );
});
