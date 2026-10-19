import type { Collection, MongoClient } from 'mongodb';
import type {
  CollectionInfo,
  StorageCollection,
  StorageCollections,
  StorageDatabases,
} from '@mongo-gui/core';
import { listCollections, listDatabases } from '../catalog';
import { readDate, readNumber, readRecord, readString, type PlainObject } from '../documents';

// Read-only storage usage for the Storage panel. Only read commands run here. Each collection call
// has its own time limit, and at most COLLECTION_CONCURRENCY collections are read at once.
const MAX_TIME_MS = 5000;
const COLLECTION_CONCURRENCY = 2;

type IndexAccess = { readonly ops: number | null; readonly since: string | null };

export async function getStorageDatabases(client: MongoClient): Promise<StorageDatabases> {
  const databases = await listDatabases(client);
  const fs = await readFsSizes(client);
  return {
    databases: databases.map((database) => ({
      name: database.name,
      sizeOnDisk: database.sizeOnDisk ?? 0,
      empty: database.empty ?? false,
    })),
    ...fs,
  };
}

// Reads storage stats and index usage for every collection of one database. Views are skipped.
// A failure on one collection becomes an entry with `error` set, so the call does not throw for the
// whole database.
export async function getStorageCollections(
  client: MongoClient,
  database: string,
): Promise<StorageCollections> {
  const infos = (await listCollections(client, database)).filter((info) => info.type !== 'view');
  const collections = await mapWithLimit(infos, COLLECTION_CONCURRENCY, (info) =>
    readCollectionStorage(client, database, info),
  );
  return { database, collections };
}

// The admin dbStats reports the disk size. Some setups refuse it, and then both values are null.
async function readFsSizes(
  client: MongoClient,
): Promise<{ fsUsedSize: number | null; fsTotalSize: number | null }> {
  try {
    const reply: unknown = await client.db('admin').command({ dbStats: 1 });
    return {
      fsUsedSize: readNumber(reply, 'fsUsedSize') ?? null,
      fsTotalSize: readNumber(reply, 'fsTotalSize') ?? null,
    };
  } catch {
    return { fsUsedSize: null, fsTotalSize: null };
  }
}

async function readCollectionStorage(
  client: MongoClient,
  database: string,
  info: CollectionInfo,
): Promise<StorageCollection> {
  const type = info.type === 'timeseries' ? 'timeseries' : 'collection';
  const collection = client.db(database).collection(info.name);
  let storage: PlainObject | undefined;
  try {
    const rows: unknown[] = await collection
      .aggregate([{ $collStats: { storageStats: { scale: 1 } } }], { maxTimeMS: MAX_TIME_MS })
      .toArray();
    storage = readRecord(rows[0], 'storageStats');
  } catch (error) {
    return failedCollection(info.name, type, error);
  }
  if (storage === undefined) {
    return failedCollection(info.name, type, new Error('the server returned no storage stats'));
  }
  const usage = await readIndexUsage(collection);
  const indexSizes = readRecord(storage, 'indexSizes') ?? {};
  return {
    name: info.name,
    type,
    count: readNumber(storage, 'count') ?? 0,
    dataSize: readNumber(storage, 'size') ?? 0,
    avgObjSize: readNumber(storage, 'avgObjSize') ?? 0,
    storageSize: readNumber(storage, 'storageSize') ?? 0,
    freeStorageSize: readNumber(storage, 'freeStorageSize') ?? null,
    totalIndexSize: readNumber(storage, 'totalIndexSize') ?? 0,
    indexes: Object.entries(indexSizes).map(([name, size]) => {
      const access = usage?.get(name);
      return {
        name,
        size: typeof size === 'number' ? size : 0,
        ops: access?.ops ?? null,
        since: access?.since ?? null,
      };
    }),
    error: null,
  };
}

// $indexStats counts operations since the server started. A refusal returns undefined, so the
// indexes show null for ops and since instead of failing the collection.
async function readIndexUsage(
  collection: Collection,
): Promise<Map<string, IndexAccess> | undefined> {
  try {
    const rows: unknown[] = await collection
      .aggregate([{ $indexStats: {} }], { maxTimeMS: MAX_TIME_MS })
      .toArray();
    const usage = new Map<string, IndexAccess>();
    for (const row of rows) {
      const name = readString(row, 'name');
      if (name === undefined) {
        continue;
      }
      const accesses = readRecord(row, 'accesses');
      usage.set(name, {
        ops: readNumber(accesses, 'ops') ?? null,
        since: readDate(accesses, 'since')?.toISOString() ?? null,
      });
    }
    return usage;
  } catch {
    return undefined;
  }
}

function failedCollection(
  name: string,
  type: StorageCollection['type'],
  error: unknown,
): StorageCollection {
  return {
    name,
    type,
    count: 0,
    dataSize: 0,
    avgObjSize: 0,
    storageSize: 0,
    freeStorageSize: null,
    totalIndexSize: 0,
    indexes: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
