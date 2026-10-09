import { Binary, type MongoClient } from 'mongodb';
import {
  AddShardToZoneInputSchema,
  BalancerWindowInputSchema,
  EnableShardingInputSchema,
  MoveChunkInputSchema,
  RemoveShardFromZoneInputSchema,
  RemoveShardInputSchema,
  ShardCollectionInputSchema,
  ShardDistributionSchema,
  ShardNamespaceSchema,
  UpdateZoneKeyRangeInputSchema,
  type AddShardToZoneInput,
  type BalancerStatus,
  type BalancerWindowInput,
  type EnableShardingInput,
  type MoveChunkInput,
  type RemoveShardFromZoneInput,
  type RemoveShardInput,
  type RemoveShardStatus,
  type ShardCollectionInput,
  type ShardDistribution,
  type UpdateZoneKeyRangeInput,
} from '@mongo-gui/core';
import {
  definedEntry,
  readField,
  readNumber,
  readRecord,
  readString,
  readStringArray,
  type PlainObject,
} from '../documents';
import { parseEjsonDocument } from '../management/ejson';
import {
  parseInput,
  refuseReservedDatabase,
  toAppException,
  validationError,
} from '../management/errors';
import {
  configCollection,
  listShardRows,
  readBalancerStatus,
  readChunkCounts,
  readStorageByShard,
  uuidKey,
} from './config-reader';
import { parseShardKey } from './shard-key';

const BALANCER_STOP_TIMEOUT_MS = 60_000;
const BALANCER_POLL_INTERVAL_MS = 500;
const BALANCER_SETTING_ID = 'balancer';
const PERCENT_SCALE = 10_000;

type RemoveShardCounts = Pick<
  RemoveShardStatus,
  'remainingChunks' | 'remainingDatabases' | 'remainingJumbo'
>;

export async function enableSharding(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<EnableShardingInput>(EnableShardingInputSchema, input);
  refuseReservedDatabase(parsed.database, 'enable sharding on');
  try {
    await client.db('admin').command({
      enableSharding: parsed.database,
      ...definedEntry('primaryShard', parsed.primaryShard),
    });
  } catch (error) {
    throw toAppException(error);
  }
}

export async function shardCollection(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<ShardCollectionInput>(ShardCollectionInputSchema, input);
  refuseReservedDatabase(parsed.database, 'shard collections in');
  const key = parseShardKey(parsed.keyEjson);
  try {
    await client.db('admin').command({
      shardCollection: `${parsed.database}.${parsed.collection}`,
      key,
      ...definedEntry('unique', parsed.unique),
      ...definedEntry('numInitialChunks', parsed.numInitialChunks),
      ...definedEntry('presplitHashedZones', parsed.presplitHashedZones),
    });
  } catch (error) {
    throw toAppException(error);
  }
}

export async function startBalancer(client: MongoClient): Promise<void> {
  try {
    await client.db('admin').command({ balancerStart: 1 });
  } catch (error) {
    throw toAppException(error);
  }
}

// balancerStop turns the balancer off. A round that is already running may take a while, so the
// call waits up to 60 seconds for it to finish. The returned status shows whether a round still runs.
export async function stopBalancer(client: MongoClient): Promise<BalancerStatus> {
  try {
    await client.db('admin').command({ balancerStop: 1 });
    const deadline = Date.now() + BALANCER_STOP_TIMEOUT_MS;
    let status = await readBalancerStatus(client);
    while (status.inBalancerRound && Date.now() < deadline) {
      await sleep(BALANCER_POLL_INTERVAL_MS);
      status = await readBalancerStatus(client);
    }
    return status;
  } catch (error) {
    throw toAppException(error);
  }
}

export async function setBalancerWindow(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<BalancerWindowInput>(BalancerWindowInputSchema, input);
  try {
    await configCollection(client, 'settings').updateOne(
      { _id: BALANCER_SETTING_ID },
      { $set: { activeWindow: { start: parsed.start, stop: parsed.stop } } },
      { upsert: true },
    );
  } catch (error) {
    throw toAppException(error);
  }
}

export async function clearBalancerWindow(client: MongoClient): Promise<void> {
  try {
    await configCollection(client, 'settings').updateOne(
      { _id: BALANCER_SETTING_ID },
      { $unset: { activeWindow: '' } },
    );
  } catch (error) {
    throw toAppException(error);
  }
}

export async function moveChunk(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<MoveChunkInput>(MoveChunkInputSchema, input);
  const find = parseEjsonDocument(parsed.findEjson, 'Chunk filter');
  if (Object.keys(find).length === 0) {
    throw validationError('The chunk filter needs a shard key value');
  }
  try {
    await client.db('admin').command({ moveChunk: parsed.ns, find, to: parsed.toShard });
  } catch (error) {
    throw toAppException(error);
  }
}

export async function addShardToZone(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<AddShardToZoneInput>(AddShardToZoneInputSchema, input);
  try {
    await client.db('admin').command({ addShardToZone: parsed.shard, zone: parsed.zone });
  } catch (error) {
    throw toAppException(error);
  }
}

export async function removeShardFromZone(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<RemoveShardFromZoneInput>(RemoveShardFromZoneInputSchema, input);
  try {
    await client.db('admin').command({ removeShardFromZone: parsed.shard, zone: parsed.zone });
  } catch (error) {
    throw toAppException(error);
  }
}

// A null zone removes the key range from the zone it belongs to.
export async function updateZoneKeyRange(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<UpdateZoneKeyRangeInput>(UpdateZoneKeyRangeInputSchema, input);
  const min = parseEjsonDocument(parsed.minEjson, 'Range minimum');
  const max = parseEjsonDocument(parsed.maxEjson, 'Range maximum');
  try {
    await client.db('admin').command({
      updateZoneKeyRange: parsed.ns,
      min,
      max,
      zone: parsed.zone,
    });
  } catch (error) {
    throw toAppException(error);
  }
}

// Documents and bytes per shard come from $collStats through mongos. Chunk counts come from
// config.chunks. Every shard in the cluster appears, including shards that hold nothing.
export async function getShardDistribution(
  client: MongoClient,
  input: unknown,
): Promise<ShardDistribution> {
  const ns = parseInput<string>(ShardNamespaceSchema, input);
  const dot = ns.indexOf('.');
  try {
    const [shards, storage, collectionDoc] = await Promise.all([
      listShardRows(client),
      readStorageByShard(client, ns.slice(0, dot), ns.slice(dot + 1)),
      configCollection(client, 'collections').findOne({ _id: ns }),
    ]);
    const uuid = readField(collectionDoc, 'uuid');
    const chunks = await readChunkCounts(client, {
      ns,
      uuid: uuid instanceof Binary ? uuid : undefined,
    });
    const uuidHex = uuidKey(uuid);
    const perShard = (uuidHex === undefined ? undefined : chunks.get(uuidHex)) ?? chunks.get(ns);
    const shardIds = [...new Set([...shards.map((shard) => shard.id), ...storage.keys()])].sort();
    const totals = [...storage.values()];
    const totalDocuments = totals.reduce((sum, item) => sum + item.documents, 0);
    const totalSizeBytes = totals.reduce((sum, item) => sum + item.sizeBytes, 0);
    return ShardDistributionSchema.parse({
      ns,
      totalDocuments,
      totalSizeBytes,
      shards: shardIds.map((shard) => {
        const item = storage.get(shard) ?? { documents: 0, sizeBytes: 0 };
        return {
          shard,
          documents: item.documents,
          sizeBytes: item.sizeBytes,
          chunks: perShard?.get(shard) ?? 0,
          documentPercent: percentOf(item.documents, totalDocuments),
        };
      }),
    });
  } catch (error) {
    throw toAppException(error);
  }
}

// This is a dry run unless confirmDraining is true. Both paths refuse the last shard and any shard
// that is the primary of a database.
export async function removeShardStatus(
  client: MongoClient,
  input: unknown,
): Promise<RemoveShardStatus> {
  const parsed = parseInput<RemoveShardInput>(RemoveShardInputSchema, input);
  try {
    const shards = await listShardRows(client);
    const target = shards.find((shard) => shard.id === parsed.shard);
    if (target === undefined) {
      throw validationError(`There is no shard named ${parsed.shard} in this cluster`);
    }
    if (shards.length === 1) {
      throw validationError(
        `${parsed.shard} is the only shard, and a cluster needs at least one shard`,
      );
    }
    const owned: unknown[] = await configCollection(client, 'databases')
      .find({ primary: parsed.shard })
      .toArray();
    const ownedNames = owned.flatMap((doc) => {
      const name = readString(doc, '_id');
      return name === undefined ? [] : [name];
    });
    const base = { shard: target.id, host: target.host, shardCount: shards.length };
    if (parsed.confirmDraining !== true) {
      if (ownedNames.length > 0) {
        throw validationError(
          `${parsed.shard} is the primary shard of ${ownedNames.join(', ')}. Confirming the drain moves those databases to other shards.`,
        );
      }
      return {
        ...base,
        dryRun: true,
        wouldDrain: true,
        message: `Draining ${parsed.shard} moves all of its chunks to the other shards. Pass confirmDraining: true to start it.`,
      };
    }
    const reply: unknown = await client.db('admin').command({ removeShard: parsed.shard });
    return {
      ...base,
      dryRun: false,
      wouldDrain: false,
      ...definedEntry('state', toRemoveState(readString(reply, 'state'))),
      ...definedEntry('message', readString(reply, 'msg')),
      databasesToMove: moveList(readStringArray(reply, 'dbsToMove'), ownedNames),
      ...remainingCounts(readRecord(reply, 'remaining')),
    };
  } catch (error) {
    throw toAppException(error);
  }
}

// The server lists the databases it moves. Before it reports them, the owned names stand in.
function moveList(reported: string[], owned: string[]): string[] {
  return reported.length > 0 ? reported : owned;
}

function remainingCounts(remaining: PlainObject | undefined): RemoveShardCounts {
  return {
    ...definedEntry('remainingChunks', readNumber(remaining, 'chunks')),
    ...definedEntry('remainingDatabases', readNumber(remaining, 'dbs')),
    ...definedEntry('remainingJumbo', readNumber(remaining, 'jumbo')),
  };
}

function toRemoveState(state: string | undefined): RemoveShardStatus['state'] {
  return state === 'started' || state === 'ongoing' || state === 'completed' ? state : undefined;
}

// Whole percent with two decimals, so 1 of 3 documents reads as 33.33.
function percentOf(part: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.round((part / total) * PERCENT_SCALE) / (PERCENT_SCALE / 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
