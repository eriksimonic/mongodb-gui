import type { MongoClient } from 'mongodb';
import { listDatabases } from '../catalog';
import {
  definedEntry,
  readBoolean,
  readField,
  readRecord,
  readString,
  type PlainObject,
} from '../documents';
import { toAppException } from '../management/errors';
import {
  CONFIG_DATABASE,
  listShardRows,
  readBalancerStatus,
  readChunkCounts,
  readClusterId,
  readStorageByShard,
  timestampText,
  toJsonValue,
  uuidKey,
  type ChunkCounts,
  type StorageTotals,
} from './config-reader';
import {
  ShardingOverviewSchema,
  type ShardedCollection,
  type ShardedDatabase,
  type ShardingOverview,
  type ZoneInfo,
  type ZoneRange,
} from '@mongo-gui/core';

const MONGOS_MESSAGE = 'isdbgrid';

export async function isMongos(client: MongoClient): Promise<boolean> {
  const hello: unknown = await client.db('admin').command({ hello: 1 });
  return readString(hello, 'msg') === MONGOS_MESSAGE;
}

// A plain mongod or replica set member has no config database to read, so it reports an empty
// overview instead of failing.
export async function getShardingOverview(client: MongoClient): Promise<ShardingOverview> {
  try {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    if (readString(hello, 'msg') !== MONGOS_MESSAGE) {
      return notSharded();
    }
    const [shards, databaseDocs, databaseNames, collectionDocs, chunks, balancer, clusterId] =
      await Promise.all([
        listShardRows(client),
        readConfigDocs(client, 'databases', {}),
        listDatabaseNames(client),
        readConfigDocs(client, 'collections', { dropped: { $ne: true } }),
        readChunkCounts(client),
        readBalancerStatus(client),
        readClusterId(client),
      ]);
    const collections = await Promise.all(
      collectionDocs.map((doc) => toShardedCollection(client, doc, chunks)),
    );
    return ShardingOverviewSchema.parse({
      isSharded: true,
      ...definedEntry('mongosHost', readString(hello, 'me')),
      shards,
      databases: mergeDatabases(databaseDocs.flatMap(toShardedDatabase), databaseNames),
      collections: collections.flatMap((collection) =>
        collection === undefined ? [] : [collection],
      ),
      balancer,
      zones: await readZones(client, shards),
      ...definedEntry('clusterId', clusterId),
    });
  } catch (error) {
    throw toAppException(error);
  }
}

async function listDatabaseNames(client: MongoClient): Promise<string[]> {
  return (await listDatabases(client)).map((database) => database.name);
}

function notSharded(): ShardingOverview {
  return { isSharded: false, shards: [], databases: [], collections: [], zones: [] };
}

function readConfigDocs(
  client: MongoClient,
  collection: string,
  filter: PlainObject,
): Promise<unknown[]> {
  return client.db(CONFIG_DATABASE).collection(collection).find(filter).toArray();
}

// config.databases holds only databases with sharding enabled. The legacy partitioned flag is not
// used: 6.0 and newer store false for databases that have sharding enabled.
function toShardedDatabase(raw: unknown): ShardedDatabase[] {
  const name = readString(raw, '_id');
  if (name === undefined) {
    return [];
  }
  const version = toJsonValue(readField(raw, 'version'));
  return [
    {
      name,
      primaryShard: readString(raw, 'primary') ?? '',
      partitioned: true,
      ...definedEntry('version', version),
    },
  ];
}

// Databases without sharding (admin, config and plain databases) come from listDatabases. They
// have no primary shard in config.databases, so their primaryShard is empty.
function mergeDatabases(
  configRows: readonly ShardedDatabase[],
  names: readonly string[],
): ShardedDatabase[] {
  const byName = new Map(configRows.map((row) => [row.name, row]));
  for (const name of names) {
    if (!byName.has(name)) {
      byName.set(name, { name, primaryShard: '', partitioned: false });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// A failed $collStats (for example during a migration) leaves the size fields out, and the
// rest of the overview still loads.
async function toShardedCollection(
  client: MongoClient,
  doc: unknown,
  chunks: ChunkCounts,
): Promise<ShardedCollection | undefined> {
  const ns = readString(doc, '_id');
  if (ns === undefined) {
    return undefined;
  }
  const uuid = uuidKey(readField(doc, 'uuid'));
  const perShard =
    (uuid === undefined ? undefined : chunks.get(uuid)) ??
    chunks.get(ns) ??
    new Map<string, number>();
  const chunkCount = [...perShard.values()].reduce((sum, count) => sum + count, 0);
  const sizes = await readCollectionTotals(client, ns);
  const dataSizeBytes = sizes?.sizeBytes;
  const docCount = sizes?.documents;
  const timestamp = timestampText(readField(doc, 'timestamp'));
  return {
    ns,
    key: readRecord(doc, 'key') ?? {},
    unique: readBoolean(doc, 'unique') ?? false,
    chunkCount,
    chunksPerShard: Object.fromEntries(perShard),
    balancing: readBoolean(doc, 'noBalance') !== true,
    ...definedEntry('timestamp', timestamp),
    ...definedEntry('dataSizeBytes', dataSizeBytes),
    ...definedEntry('docCount', docCount),
    ...definedEntry(
      'avgChunkSizeBytes',
      dataSizeBytes !== undefined && chunkCount > 0
        ? Math.round(dataSizeBytes / chunkCount)
        : undefined,
    ),
  };
}

async function readCollectionTotals(
  client: MongoClient,
  ns: string,
): Promise<StorageTotals | undefined> {
  const dot = ns.indexOf('.');
  try {
    const byShard = await readStorageByShard(client, ns.slice(0, dot), ns.slice(dot + 1));
    const totals = [...byShard.values()];
    return {
      documents: totals.reduce((sum, item) => sum + item.documents, 0),
      sizeBytes: totals.reduce((sum, item) => sum + item.sizeBytes, 0),
    };
  } catch {
    return undefined;
  }
}

// Zones come from the tags on shards (config.shards and listShards) and from key ranges
// bound to a tag (config.tags).
async function readZones(
  client: MongoClient,
  shards: { readonly id: string; readonly tags: readonly string[] }[],
): Promise<ZoneInfo[]> {
  const zones = new Map<string, { shards: Set<string>; ranges: ZoneRange[] }>();
  const zoneOf = (name: string): { shards: Set<string>; ranges: ZoneRange[] } => {
    const existing = zones.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = { shards: new Set<string>(), ranges: [] };
    zones.set(name, created);
    return created;
  };
  for (const shard of shards) {
    for (const tag of shard.tags) {
      zoneOf(tag).shards.add(shard.id);
    }
  }
  const rangeDocs = await readConfigDocs(client, 'tags', {});
  for (const doc of rangeDocs) {
    const zone = readString(doc, 'tag');
    const ns = readString(doc, 'ns');
    if (zone === undefined || ns === undefined) {
      continue;
    }
    zoneOf(zone).ranges.push({
      ns,
      min: toJsonValue(readField(doc, 'min')),
      max: toJsonValue(readField(doc, 'max')),
    });
  }
  return [...zones.entries()]
    .map(([zone, value]) => ({
      zone,
      shards: [...value.shards].sort(),
      ranges: value.ranges,
    }))
    .sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0));
}
