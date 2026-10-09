import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppErrorException, type AppError } from '@mongo-gui/core';
import {
  startMongo,
  CONTAINER_STARTUP_TIMEOUT_MS,
  type StartedMongo,
} from '../test/mongo-container';
import { startShardedCluster, type StartedShardedCluster } from '../test/sharded-cluster';
import { getShardingOverview, isMongos } from './overview';
import {
  addShardToZone,
  clearBalancerWindow,
  enableSharding,
  getShardDistribution,
  moveChunk,
  removeShardFromZone,
  removeShardStatus,
  setBalancerWindow,
  shardCollection,
  startBalancer,
  stopBalancer,
  updateZoneKeyRange,
} from './operations';

const CLUSTER_IMAGES = ['mongo:8.0.17', 'mongo:6.0'] as const;
const DATABASE = 'shop';
const COLLECTION = 'shop.orders';
const SHARD_ID = 'sh0';
const ZONE = 'hot';
const DOCUMENT_COUNT = 1000;
const STEP_TIMEOUT_MS = 60_000;

async function captureError(action: () => Promise<unknown>): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error;
    }
    throw error;
  }
  throw new Error('expected the action to fail with an AppErrorException');
}

// numInitialChunks: 4 on a single shard. 6.0 keeps the four presplit chunks. 8.0.17 merges the
// presplit chunks that land on the same shard, so one shard holds one chunk.
function expectedInitialChunks(image: (typeof CLUSTER_IMAGES)[number]): number {
  return image === 'mongo:8.0.17' ? 1 : 4;
}

// Range bounds are stored as Int32 or Int64 depending on the value, so compare the number.
function numericField(document: unknown, field: string): number | undefined {
  if (typeof document !== 'object' || document === null || !(field in document)) {
    return undefined;
  }
  const value: unknown = Reflect.get(document, field);
  const wrapped = typeof value === 'object' && value !== null ? value : undefined;
  const text =
    wrapped === undefined
      ? undefined
      : (Reflect.get(wrapped, '$numberInt') ?? Reflect.get(wrapped, '$numberLong'));
  return typeof text === 'string' ? Number(text) : undefined;
}

describe.each(CLUSTER_IMAGES)('sharding on %s', (image) => {
  let cluster: StartedShardedCluster;
  let mongos: MongoClient;
  let shard: MongoClient;

  beforeAll(async () => {
    cluster = await startShardedCluster(image);
    mongos = new MongoClient(cluster.mongosUri);
    shard = new MongoClient(cluster.shardUri);
    await mongos.connect();
    await shard.connect();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await mongos?.close();
    await shard?.close();
    await cluster?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it('recognises mongos and not the shard mongod', async () => {
    expect(await isMongos(mongos)).toBe(true);
    expect(await isMongos(shard)).toBe(false);
  });

  it('reports one shard, the config and admin databases, and no sharded collections', async () => {
    const overview = await getShardingOverview(mongos);
    expect(overview.isSharded).toBe(true);
    expect(overview.shards.map((item) => item.id)).toEqual([SHARD_ID]);
    expect(overview.shards[0]?.host).toBe('sh0/shard:27018');
    expect(overview.databases.map((item) => item.name)).toEqual(expect.arrayContaining(['config']));
    expect(overview.collections).toEqual([]);
    expect(overview.zones).toEqual([]);
  });

  it(
    'enables sharding and shards a hashed collection with numInitialChunks 4',
    async () => {
      await enableSharding(mongos, { database: DATABASE });
      await shardCollection(mongos, {
        database: DATABASE,
        collection: 'orders',
        keyEjson: '{"customerId":"hashed"}',
        numInitialChunks: 4,
      });
      const overview = await getShardingOverview(mongos);
      const database = overview.databases.find((item) => item.name === DATABASE);
      expect(database?.partitioned).toBe(true);
      expect(database?.primaryShard).toBe(SHARD_ID);
      const collection = overview.collections.find((item) => item.ns === COLLECTION);
      expect(collection).toBeDefined();
      expect(collection?.key).toEqual({ customerId: 'hashed' });
      expect(collection?.unique).toBe(false);
      expect(collection?.balancing).toBe(true);
      expect(collection?.chunksPerShard).toEqual({ [SHARD_ID]: collection?.chunkCount });
      expect(collection?.chunkCount).toBe(expectedInitialChunks(image));
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'reports every inserted document in the shard distribution',
    async () => {
      const orders = mongos.db(DATABASE).collection('orders');
      await orders.insertMany(
        Array.from({ length: DOCUMENT_COUNT }, (_, index) => ({
          customerId: index,
          total: index * 1.5,
          status: 'paid',
        })),
      );
      const distribution = await getShardDistribution(mongos, COLLECTION);
      expect(distribution.totalDocuments).toBe(DOCUMENT_COUNT);
      expect(distribution.totalSizeBytes).toBeGreaterThan(0);
      expect(distribution.shards).toEqual([
        expect.objectContaining({
          shard: SHARD_ID,
          documents: DOCUMENT_COUNT,
          chunks: expectedInitialChunks(image),
          documentPercent: 100,
        }),
      ]);
    },
    STEP_TIMEOUT_MS,
  );

  it('rejects an empty or unsupported shard key before the server sees it', async () => {
    const empty = await captureError(() =>
      shardCollection(mongos, { database: DATABASE, collection: 'empty', keyEjson: '{}' }),
    );
    expect(empty.code).toBe('VALIDATION');
    const unsupported = await captureError(() =>
      shardCollection(mongos, {
        database: DATABASE,
        collection: 'text',
        keyEjson: '{"customerId":"text"}',
      }),
    );
    expect(unsupported.code).toBe('VALIDATION');
    expect(unsupported.message).toContain('customerId');
  });

  it('shows the balancer mode and the balancer window', async () => {
    const stopped = await stopBalancer(mongos);
    expect(stopped.mode).toBe('off');
    expect(stopped.inBalancerRound).toBe(false);
    expect((await getShardingOverview(mongos)).balancer?.mode).toBe('off');

    await startBalancer(mongos);
    expect((await getShardingOverview(mongos)).balancer?.mode).toBe('full');

    await setBalancerWindow(mongos, { start: '01:00', stop: '05:00' });
    expect((await getShardingOverview(mongos)).balancer?.activeWindow).toEqual({
      start: '01:00',
      stop: '05:00',
    });

    await clearBalancerWindow(mongos);
    expect((await getShardingOverview(mongos)).balancer?.activeWindow).toBeUndefined();

    const badWindow = await captureError(() =>
      setBalancerWindow(mongos, { start: '24:00', stop: '05:00' }),
    );
    expect(badWindow.code).toBe('VALIDATION');
  });

  it('lists a zone with its shard and key range, then removes them', async () => {
    await addShardToZone(mongos, { shard: SHARD_ID, zone: ZONE });
    await updateZoneKeyRange(mongos, {
      ns: COLLECTION,
      minEjson: '{"customerId":{"$numberLong":"-1000"}}',
      maxEjson: '{"customerId":{"$numberLong":"1000"}}',
      zone: ZONE,
    });
    const withRange = (await getShardingOverview(mongos)).zones;
    expect(withRange).toHaveLength(1);
    expect(withRange[0]?.zone).toBe(ZONE);
    expect(withRange[0]?.shards).toEqual([SHARD_ID]);
    expect(withRange[0]?.ranges).toHaveLength(1);
    expect(withRange[0]?.ranges[0]?.ns).toBe(COLLECTION);
    expect(numericField(withRange[0]?.ranges[0]?.min, 'customerId')).toBe(-1000);
    expect(numericField(withRange[0]?.ranges[0]?.max, 'customerId')).toBe(1000);

    await updateZoneKeyRange(mongos, {
      ns: COLLECTION,
      minEjson: '{"customerId":{"$numberLong":"-1000"}}',
      maxEjson: '{"customerId":{"$numberLong":"1000"}}',
      zone: null,
    });
    expect((await getShardingOverview(mongos)).zones[0]?.ranges).toEqual([]);

    await removeShardFromZone(mongos, { shard: SHARD_ID, zone: ZONE });
    expect((await getShardingOverview(mongos)).zones).toEqual([]);
  });

  // The server accepts a move to the shard that already holds the chunk and does nothing.
  it('treats a move to the shard that already holds the chunk as a no-op', async () => {
    await expect(
      moveChunk(mongos, { ns: COLLECTION, findEjson: '{"customerId":1}', toShard: SHARD_ID }),
    ).resolves.toBeUndefined();
  });

  it('maps a move to a shard that does not exist to COMMAND_FAILED', async () => {
    const error = await captureError(() =>
      moveChunk(mongos, { ns: COLLECTION, findEjson: '{"customerId":1}', toShard: 'sh9' }),
    );
    expect(error.code).toBe('COMMAND_FAILED');
  });

  it('refuses a chunk filter without a shard key value', async () => {
    const error = await captureError(() =>
      moveChunk(mongos, { ns: COLLECTION, findEjson: '{}', toShard: SHARD_ID }),
    );
    expect(error.code).toBe('VALIDATION');
  });

  it('refuses to remove the only shard and says why', async () => {
    const error = await captureError(() => removeShardStatus(mongos, { shard: SHARD_ID }));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('only shard');
  });

  it('refuses to remove a shard that does not exist', async () => {
    const error = await captureError(() => removeShardStatus(mongos, { shard: 'sh9' }));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('sh9');
  });
});

describe('standalone mongod', () => {
  const image = 'mongo:8.0.17';
  let standalone: StartedMongo;
  let client: MongoClient;

  beforeAll(async () => {
    standalone = await startMongo(image);
    client = new MongoClient(standalone.rootUri);
    await client.connect();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await standalone?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it('returns an empty, non-sharded overview', async () => {
    expect(await isMongos(client)).toBe(false);
    expect(await getShardingOverview(client)).toEqual({
      isSharded: false,
      shards: [],
      databases: [],
      collections: [],
      zones: [],
    });
  });
});
