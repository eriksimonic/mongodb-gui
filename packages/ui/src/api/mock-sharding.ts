import {
  summarizeShardCollection,
  type BalancerStatus,
  type ShardCollectionCall,
  type ShardCollectionOutput,
  type ShardDistribution,
  type ShardInfo,
  type ShardedCollection,
  type ShardedDatabase,
  type ShardingOverview,
  type ShardKey,
  type RemoveShardStatus,
  type RpcClient,
  type RpcEvent,
  type ZoneInfo,
  type ZoneRange,
  rpcContract,
} from '@mongo-gui/core';
import { z } from 'zod';
import type { MockDatabase } from './mock-catalog';
import { fail, method } from './mock-support';

/** The sharded state one mock cluster keeps. Config rows are the sharded databases and collections. */
export interface MockCluster {
  shards: ShardInfo[];
  balancer: BalancerStatus;
  /** Sharded databases by name, with their primary shard. */
  shardedDatabases: Map<string, string>;
  collections: ShardedCollection[];
  ranges: (ZoneRange & { readonly zone: string })[];
}

const MOCK_BYTES_PER_DOCUMENT = 420;

/** Two shards, one sharded database (shop) with two sharded collections, uneven chunks and a zone. */
export function fixtureCluster(): MockCluster {
  return {
    shards: [
      { id: 'shard-a', host: 'rs-a/localhost:27018', state: 1, tags: [] },
      { id: 'shard-b', host: 'rs-b/localhost:27019', state: 1, tags: ['eu'] },
    ],
    balancer: {
      mode: 'full',
      inBalancerRound: false,
      numBalancerRounds: 412,
      activeWindow: { start: '23:00', stop: '06:00' },
    },
    shardedDatabases: new Map([['shop', 'shard-a']]),
    collections: [
      {
        ns: 'shop.orders',
        key: { region: 1, orderId: 1 },
        unique: false,
        chunkCount: 13,
        chunksPerShard: { 'shard-a': 9, 'shard-b': 4 },
        balancing: true,
        dataSizeBytes: 2_150_000,
        docCount: 5_120,
        avgChunkSizeBytes: 165_384,
      },
      {
        ns: 'shop.customers',
        key: { customerId: 'hashed' },
        unique: false,
        chunkCount: 10,
        chunksPerShard: { 'shard-a': 3, 'shard-b': 7 },
        balancing: true,
        dataSizeBytes: 610_000,
        docCount: 1_900,
        avgChunkSizeBytes: 61_000,
      },
    ],
    ranges: [{ zone: 'eu', ns: 'shop.orders', min: { region: 'EU' }, max: { region: 'EV' } }],
  };
}

export interface MockShardingContext {
  readonly latencyMs: number;
  /** Throws unless the vault is unlocked and the connection is connected. */
  guard(connectionId: string): void;
  /** The cluster of a sharded connection, or undefined for a standalone or replica set. */
  clusterOf(connectionId: string): MockCluster | undefined;
  catalogOf(connectionId: string): MockDatabase[];
  emit(event: RpcEvent): void;
}

function notSharded(): ShardingOverview {
  return { isSharded: false, shards: [], databases: [], collections: [], zones: [] };
}

function zonesOf(cluster: MockCluster): ZoneInfo[] {
  const names = new Set<string>();
  for (const shard of cluster.shards) {
    for (const tag of shard.tags) {
      names.add(tag);
    }
  }
  for (const range of cluster.ranges) {
    names.add(range.zone);
  }
  return [...names].sort().map((zone) => ({
    zone,
    shards: cluster.shards.filter((shard) => shard.tags.includes(zone)).map((shard) => shard.id),
    ranges: cluster.ranges
      .filter((range) => range.zone === zone)
      .map(({ ns, min, max }) => ({ ns, min, max })),
  }));
}

function overviewOf(cluster: MockCluster, catalog: MockDatabase[]): ShardingOverview {
  const databases: ShardedDatabase[] = catalog
    .map((database) => {
      const primary = cluster.shardedDatabases.get(database.name);
      return primary === undefined
        ? { name: database.name, primaryShard: '', partitioned: false }
        : { name: database.name, primaryShard: primary, partitioned: true };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    isSharded: true,
    mongosHost: 'localhost:27017',
    shards: cluster.shards,
    databases,
    collections: cluster.collections,
    balancer: cluster.balancer,
    zones: zonesOf(cluster),
    clusterId: 'mock-cluster-1',
  };
}

function parseKey(keyEjson: string): ShardKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keyEjson);
  } catch {
    throw fail('VALIDATION', 'The shard key must be a JSON object');
  }
  const result = z
    .record(z.string(), z.union([z.literal(1), z.literal(-1), z.literal('hashed')]))
    .safeParse(parsed);
  if (!result.success) {
    throw fail('VALIDATION', 'The shard key value must be 1, -1 or "hashed"');
  }
  return result.data;
}

function distributionOf(cluster: MockCluster, collection: ShardedCollection): ShardDistribution {
  const documents = collection.docCount ?? 0;
  const sizeBytes = collection.dataSizeBytes ?? documents * MOCK_BYTES_PER_DOCUMENT;
  const total = collection.chunkCount;
  const shards = cluster.shards.map((shard) => {
    const chunks = collection.chunksPerShard[shard.id] ?? 0;
    const share = total === 0 ? 0 : chunks / total;
    const shardDocuments = Math.round(documents * share);
    return {
      shard: shard.id,
      documents: shardDocuments,
      sizeBytes: Math.round(sizeBytes * share),
      chunks,
      documentPercent:
        documents === 0 ? 0 : Math.round((shardDocuments / documents) * 10_000) / 100,
    };
  });
  return { ns: collection.ns, totalDocuments: documents, totalSizeBytes: sizeBytes, shards };
}

function requireCluster(cluster: MockCluster | undefined): MockCluster {
  if (cluster === undefined) {
    throw fail('COMMAND_FAILED', 'This server is not a sharded cluster');
  }
  return cluster;
}

function requireShard(cluster: MockCluster, shard: string): ShardInfo {
  const found = cluster.shards.find((item) => item.id === shard);
  if (found === undefined) {
    throw fail('COMMAND_FAILED', 'Shard not found', shard);
  }
  return found;
}

function requireCollection(cluster: MockCluster, ns: string): ShardedCollection {
  const found = cluster.collections.find((item) => item.ns === ns);
  if (found === undefined) {
    throw fail('COMMAND_FAILED', 'The collection is not sharded', ns);
  }
  return found;
}

/** The sharding calls of the mock. Each call checks the input as the router does. */
export function createShardingCalls(context: MockShardingContext): RpcClient['sharding'] {
  const { latencyMs } = context;
  const s = rpcContract.sharding;

  // Every call runs with the connection checks. Calls that need a cluster fail on a standalone.
  function guardCluster(connectionId: string): MockCluster {
    context.guard(connectionId);
    return requireCluster(context.clusterOf(connectionId));
  }

  return {
    overview: method(s.overview, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      const cluster = context.clusterOf(connectionId);
      return cluster === undefined
        ? notSharded()
        : overviewOf(cluster, context.catalogOf(connectionId));
    }),
    collectionDistribution: method(
      s.collectionDistribution,
      latencyMs,
      ({ connectionId, namespace }) => {
        const cluster = guardCluster(connectionId);
        return distributionOf(cluster, requireCollection(cluster, namespace));
      },
    ),
    setBalancer: method(s.setBalancer, latencyMs, ({ connectionId, enabled }) => {
      const cluster = guardCluster(connectionId);
      cluster.balancer = { ...cluster.balancer, mode: enabled ? 'full' : 'off' };
      return cluster.balancer;
    }),
    setBalancerWindow: method(s.setBalancerWindow, latencyMs, ({ connectionId, start, stop }) => {
      const cluster = guardCluster(connectionId);
      cluster.balancer = { ...cluster.balancer, activeWindow: { start, stop } };
    }),
    clearBalancerWindow: method(s.clearBalancerWindow, latencyMs, ({ connectionId }) => {
      const cluster = guardCluster(connectionId);
      const { mode, inBalancerRound, numBalancerRounds } = cluster.balancer;
      cluster.balancer = {
        mode,
        inBalancerRound,
        ...(numBalancerRounds === undefined ? {} : { numBalancerRounds }),
      };
    }),
    enableSharding: method(
      s.enableSharding,
      latencyMs,
      ({ connectionId, database, primaryShard }) => {
        const cluster = guardCluster(connectionId);
        const known = context.catalogOf(connectionId).some((item) => item.name === database);
        if (!known) {
          throw fail('COMMAND_FAILED', 'Database not found', database);
        }
        if (!cluster.shardedDatabases.has(database)) {
          cluster.shardedDatabases.set(database, primaryShard ?? cluster.shards[0]?.id ?? '');
        }
        context.emit({ type: 'catalog:changed', connectionId, database });
      },
    ),
    shardCollection: method(
      s.shardCollection,
      latencyMs,
      (input: ShardCollectionCall & { readonly connectionId: string }): ShardCollectionOutput => {
        const cluster = guardCluster(input.connectionId);
        const summary = summarizeShardCollection({
          database: input.database,
          collection: input.collection,
          key: parseKey(input.keyEjson),
          unique: input.unique,
          presplitHashedZones: input.presplitHashedZones,
          numInitialChunks: input.numInitialChunks,
        });
        if (!input.confirmed) {
          return { applied: false, summary };
        }
        if (!cluster.shardedDatabases.has(input.database)) {
          throw fail('COMMAND_FAILED', 'Sharding is not enabled on this database', input.database);
        }
        if (cluster.collections.some((item) => item.ns === summary.namespace)) {
          throw fail('COMMAND_FAILED', 'The collection is already sharded', summary.namespace);
        }
        const database = context
          .catalogOf(input.connectionId)
          .find((item) => item.name === input.database);
        const documents =
          database?.collections.find((item) => item.info.name === input.collection)?.documents
            .length ?? 0;
        const initial = input.numInitialChunks ?? 1;
        const primary = cluster.shardedDatabases.get(input.database) ?? cluster.shards[0]?.id ?? '';
        cluster.collections = [
          ...cluster.collections,
          {
            ns: summary.namespace,
            key: summary.key,
            unique: summary.unique,
            chunkCount: initial,
            chunksPerShard: { [primary]: initial },
            balancing: true,
            docCount: documents,
            dataSizeBytes: documents * MOCK_BYTES_PER_DOCUMENT,
          },
        ];
        context.emit({
          type: 'catalog:changed',
          connectionId: input.connectionId,
          database: input.database,
          collection: input.collection,
        });
        return { applied: true, summary };
      },
    ),
    moveChunk: method(s.moveChunk, latencyMs, ({ connectionId, ns, toShard }) => {
      const cluster = guardCluster(connectionId);
      const collection = requireCollection(cluster, ns);
      requireShard(cluster, toShard);
      const from = Object.entries(collection.chunksPerShard).find(
        ([shard, count]) => shard !== toShard && count > 0,
      );
      if (from !== undefined) {
        collection.chunksPerShard = {
          ...collection.chunksPerShard,
          [from[0]]: from[1] - 1,
          [toShard]: (collection.chunksPerShard[toShard] ?? 0) + 1,
        };
      }
    }),
    addShardToZone: method(s.addShardToZone, latencyMs, ({ connectionId, shard, zone }) => {
      const cluster = guardCluster(connectionId);
      const target = requireShard(cluster, shard);
      target.tags = [...new Set([...target.tags, zone])];
    }),
    removeShardFromZone: method(
      s.removeShardFromZone,
      latencyMs,
      ({ connectionId, shard, zone }) => {
        const cluster = guardCluster(connectionId);
        const target = requireShard(cluster, shard);
        target.tags = target.tags.filter((tag) => tag !== zone);
      },
    ),
    updateZoneKeyRange: method(
      s.updateZoneKeyRange,
      latencyMs,
      ({ connectionId, ns, minEjson, maxEjson, zone }) => {
        const cluster = guardCluster(connectionId);
        requireCollection(cluster, ns);
        const min: unknown = JSON.parse(minEjson);
        const max: unknown = JSON.parse(maxEjson);
        cluster.ranges = cluster.ranges.filter(
          (range) => !(range.ns === ns && JSON.stringify(range.min) === JSON.stringify(min)),
        );
        if (zone !== null) {
          cluster.ranges = [...cluster.ranges, { zone, ns, min, max }];
        }
      },
    ),
    removeShard: method(
      s.removeShard,
      latencyMs,
      ({ connectionId, shard, confirmDraining }): RemoveShardStatus => {
        const cluster = guardCluster(connectionId);
        const target = requireShard(cluster, shard);
        const base = { shard, host: target.host, shardCount: cluster.shards.length };
        if (cluster.shards.length === 1) {
          throw fail(
            'VALIDATION',
            `${shard} is the only shard, and a cluster needs at least one shard`,
          );
        }
        if (confirmDraining !== true) {
          return {
            ...base,
            dryRun: true,
            wouldDrain: true,
            message: `Draining ${shard} moves all of its chunks to the other shards. Pass confirmDraining: true to start it.`,
          };
        }
        return { ...base, dryRun: false, wouldDrain: false, state: 'started' };
      },
    ),
  };
}
