import { Binary, BSON, Timestamp, type Collection, type MongoClient } from 'mongodb';
import type { BalancerStatus, ShardInfo } from '@mongo-gui/core';
import {
  definedEntry,
  readArray,
  readBoolean,
  readField,
  readNumber,
  readRecord,
  readString,
  readStringArray,
} from '../documents';

export const CONFIG_DATABASE = 'config';

// Config documents are keyed by a string (a namespace, a database name or a setting name).
export interface ConfigDocument {
  _id: string;
  [field: string]: unknown;
}

export function configCollection(client: MongoClient, name: string): Collection<ConfigDocument> {
  return client.db(CONFIG_DATABASE).collection<ConfigDocument>(name);
}
const BALANCER_SETTING_ID = 'balancer';

// Chunk counts keyed by collection UUID (5.0 and newer) or namespace (4.4 and older), then by shard.
export type ChunkCounts = Map<string, Map<string, number>>;

export interface StorageTotals {
  readonly documents: number;
  readonly sizeBytes: number;
}

export interface ChunkTarget {
  readonly ns: string;
  readonly uuid: Binary | undefined;
}

export async function listShardRows(client: MongoClient): Promise<ShardInfo[]> {
  const reply: unknown = await client.db('admin').command({ listShards: 1 });
  return readArray(reply, 'shards').flatMap(toShardRow);
}

function toShardRow(raw: unknown): ShardInfo[] {
  const id = readString(raw, '_id');
  const host = readString(raw, 'host');
  if (id === undefined || host === undefined) {
    return [];
  }
  return [
    {
      id,
      host,
      tags: readStringArray(raw, 'tags'),
      ...definedEntry('state', readNumber(raw, 'state')),
      ...definedEntry('draining', readBoolean(raw, 'draining')),
    },
  ];
}

export function uuidKey(value: unknown): string | undefined {
  return value instanceof Binary ? value.toString('hex') : undefined;
}

export async function readChunkCounts(
  client: MongoClient,
  target?: ChunkTarget,
): Promise<ChunkCounts> {
  const stages: Record<string, unknown>[] = [];
  if (target !== undefined) {
    stages.push({
      $match:
        target.uuid === undefined
          ? { ns: target.ns }
          : { $or: [{ uuid: target.uuid }, { ns: target.ns }] },
    });
  }
  stages.push({
    $group: {
      _id: { uuid: '$uuid', ns: '$ns', shard: '$shard' },
      count: { $sum: 1 },
    },
  });
  const rows: unknown[] = await client
    .db(CONFIG_DATABASE)
    .collection('chunks')
    .aggregate(stages)
    .toArray();
  const counts: ChunkCounts = new Map();
  for (const row of rows) {
    const id = readRecord(row, '_id');
    const shard = readString(id, 'shard');
    const count = readNumber(row, 'count');
    const key = uuidKey(readField(id, 'uuid')) ?? readString(id, 'ns');
    if (shard === undefined || count === undefined || key === undefined) {
      continue;
    }
    const perShard = counts.get(key) ?? new Map<string, number>();
    perShard.set(shard, (perShard.get(shard) ?? 0) + count);
    counts.set(key, perShard);
  }
  return counts;
}

export async function readStorageByShard(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<Map<string, StorageTotals>> {
  const rows: unknown[] = await client
    .db(db)
    .collection(coll)
    .aggregate([{ $collStats: { storageStats: {} } }])
    .toArray();
  const totals = new Map<string, StorageTotals>();
  for (const row of rows) {
    const shard = readString(row, 'shard');
    if (shard === undefined) {
      continue;
    }
    const storage = readRecord(row, 'storageStats');
    const previous = totals.get(shard) ?? { documents: 0, sizeBytes: 0 };
    totals.set(shard, {
      documents: previous.documents + (readNumber(storage, 'count') ?? 0),
      sizeBytes: previous.sizeBytes + (readNumber(storage, 'size') ?? 0),
    });
  }
  return totals;
}

export async function readBalancerStatus(client: MongoClient): Promise<BalancerStatus> {
  const status: unknown = await client.db('admin').command({ balancerStatus: 1 });
  const settings: unknown = await configCollection(client, 'settings').findOne({
    _id: BALANCER_SETTING_ID,
  });
  const window = readRecord(settings, 'activeWindow');
  const start = readString(window, 'start');
  const stop = readString(window, 'stop');
  return {
    mode: toBalancerMode(readString(status, 'mode') ?? readString(settings, 'mode'), settings),
    inBalancerRound: readBoolean(status, 'inBalancerRound') ?? false,
    ...definedEntry('numBalancerRounds', readNumber(status, 'numBalancerRounds')),
    ...definedEntry(
      'activeWindow',
      start === undefined || stop === undefined ? undefined : { start, stop },
    ),
  };
}

// Servers before 6.0 store the balancer switch as a boolean "stopped" flag in config.settings.
function toBalancerMode(mode: string | undefined, settings: unknown): 'full' | 'off' {
  if (mode === 'full' || mode === 'off') {
    return mode;
  }
  return readBoolean(settings, 'stopped') === true ? 'off' : 'full';
}

export async function readClusterId(client: MongoClient): Promise<string | undefined> {
  const doc: unknown = await client.db(CONFIG_DATABASE).collection('version').findOne({});
  const id = readField(doc, 'clusterId');
  return id instanceof BSON.ObjectId ? id.toHexString() : undefined;
}

// Timestamps in config.collections are BSON timestamps, shown as "seconds:increment".
export function timestampText(value: unknown): string | undefined {
  return value instanceof Timestamp ? `${value.getHighBits()}:${value.getLowBits()}` : undefined;
}

// Canonical Extended JSON as a plain JSON value, so BSON types survive the RPC boundary.
export function toJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : BSON.EJSON.serialize(value, { relaxed: false });
}
