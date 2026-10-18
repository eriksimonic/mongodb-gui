import { BSON, Binary, type MongoClient } from 'mongodb';
import type {
  CatalogNames,
  CollectionInfo,
  CollectionStats,
  DatabaseInfo,
  DatabaseStats,
  IndexInfo,
} from '@mongo-gui/core';
import {
  definedEntry,
  isPlainObject,
  readBoolean,
  readDate,
  readField,
  readNumber,
  readRecord,
  readString,
  readArray,
  type PlainObject,
} from './documents';
import { stringifyEjson } from './ejson';

export interface ListCollectionsOptions {
  readonly includeSystem?: boolean;
  /** Adds an estimated count and data size to each collection. A failed lookup leaves them out. */
  readonly withStats?: boolean;
}

type IndexUsage = NonNullable<IndexInfo['usage']>;

const SYSTEM_PREFIX = 'system.';

export async function listDatabases(client: MongoClient): Promise<DatabaseInfo[]> {
  const reply: unknown = await client.db('admin').command({ listDatabases: 1 });
  return readArray(reply, 'databases').flatMap(toDatabaseInfo).sort(byName);
}

export async function listCollections(
  client: MongoClient,
  db: string,
  options: ListCollectionsOptions = {},
): Promise<CollectionInfo[]> {
  const rows: unknown[] = await client.db(db).listCollections({}, { nameOnly: false }).toArray();
  const infos = rows
    .flatMap(toCollectionInfo)
    .filter((info) => options.includeSystem === true || !info.name.startsWith(SYSTEM_PREFIX))
    .sort(byName);
  if (options.withStats !== true) {
    return infos;
  }
  const result: CollectionInfo[] = [];
  for (let at = 0; at < infos.length; at += STATS_BATCH) {
    const batch = infos.slice(at, at + STATS_BATCH);
    result.push(...(await Promise.all(batch.map((info) => withStats(client, db, info)))));
  }
  return result;
}

const STATS_BATCH = 8;
const NAMES_CONCURRENCY = 8;

/** The pieces `listCatalogNames` needs, so the fallback can be tested without a server. */
export interface CatalogNameSource {
  /** One round trip over the whole server. May throw when the stage is unsupported or refused. */
  readonly catalog: () => Promise<unknown[]>;
  readonly databaseNames: () => Promise<string[]>;
  readonly collectionNames: (db: string) => Promise<unknown[]>;
}

/**
 * Every database and collection name, without stats. Tries `$listCatalog` first and falls back to
 * listDatabases plus one nameOnly listCollections per database, eight at a time. A database whose
 * listing fails is left out.
 */
export async function listCatalogNames(client: MongoClient): Promise<CatalogNames> {
  let memo = catalogStageMemo.get(client);
  if (memo === undefined) {
    memo = { unsupported: false };
    catalogStageMemo.set(client, memo);
  }
  return catalogNamesFrom(
    {
      catalog: () =>
        client
          .db('admin')
          .aggregate([
            { $listCatalog: {} },
            { $project: { db: 1, name: 1, type: 1, 'md.options.timeseries': 1 } },
          ])
          .toArray(),
      databaseNames: async () => {
        const reply: unknown = await client
          .db('admin')
          .command({ listDatabases: 1, nameOnly: true });
        return readArray(reply, 'databases').flatMap((row) => readString(row, 'name') ?? []);
      },
      collectionNames: async (db) => {
        const reply: unknown = await client
          .db(db)
          .command({ listCollections: 1, nameOnly: true, authorizedCollections: true });
        return readArray(readRecord(reply, 'cursor'), 'firstBatch');
      },
    },
    memo,
  );
}

/** Per client: whether `$listCatalog` is known to fail. A reconnect makes a new client. */
const catalogStageMemo = new WeakMap<MongoClient, CatalogStageMemo>();

export interface CatalogStageMemo {
  unsupported: boolean;
}

const UNRECOGNIZED_STAGE = 40324;
const UNAUTHORIZED = 13;

function isStageRefusal(error: unknown): boolean {
  const code = readNumber(error, 'code');
  return code === UNRECOGNIZED_STAGE || code === UNAUTHORIZED;
}

export async function catalogNamesFrom(
  source: CatalogNameSource,
  memo: CatalogStageMemo = { unsupported: false },
): Promise<CatalogNames> {
  if (!memo.unsupported) {
    try {
      return groupCatalog(await source.catalog());
    } catch (error) {
      if (isStageRefusal(error)) {
        memo.unsupported = true;
      }
      // Any other failure also uses the per-database listing for this fetch.
    }
  }
  const names = await source.databaseNames();
  const databases: CatalogNames['databases'] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < names.length) {
      const name = names[next++] as string;
      try {
        const rows = await source.collectionNames(name);
        databases.push({ name, collections: rows.flatMap(toNameEntry) });
      } catch {
        // A database the user cannot list is skipped.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(NAMES_CONCURRENCY, names.length) }, worker));
  return sortCatalog(databases);
}

function toNameEntry(raw: unknown): CatalogNames['databases'][number]['collections'] {
  const name = readString(raw, 'name');
  if (name === undefined || name.startsWith(SYSTEM_PREFIX)) {
    return [];
  }
  return [{ name, type: toCollectionType(readString(raw, 'type')) }];
}

function groupCatalog(rows: unknown[]): CatalogNames {
  const byDb = new Map<string, CatalogNames['databases'][number]['collections']>();
  const seen = new Set<string>();
  for (const row of rows) {
    const db = readString(row, 'db');
    const name = readString(row, 'name');
    if (db === undefined || name === undefined || name.startsWith(SYSTEM_PREFIX)) {
      continue;
    }
    const type =
      readString(row, 'type') === 'view'
        ? 'view'
        : readRecord(readRecord(readRecord(row, 'md'), 'options'), 'timeseries') !== undefined
          ? 'timeseries'
          : 'collection';
    // mongos returns a collection once per shard that holds it.
    const id = `${db}\0${name}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const list = byDb.get(db) ?? [];
    list.push({ name, type });
    byDb.set(db, list);
  }
  return sortCatalog([...byDb].map(([name, collections]) => ({ name, collections })));
}

function sortCatalog(databases: CatalogNames['databases']): CatalogNames {
  return {
    databases: databases
      .map((db) => ({ ...db, collections: [...db.collections].sort(byName) }))
      .sort(byName),
  };
}

/** The collection with its metadata count and size. Never throws: stats are decoration. */
async function withStats(
  client: MongoClient,
  db: string,
  info: CollectionInfo,
): Promise<CollectionInfo> {
  if (info.type === 'view') {
    return info;
  }
  try {
    const storage = await readStorageStats(client, db, info.name);
    const count = readNumber(storage, 'count');
    const size = readNumber(storage, 'size');
    return {
      ...info,
      ...definedEntry('count', count),
      ...definedEntry('size', size),
    };
  } catch {
    try {
      const count = await client.db(db).collection(info.name).estimatedDocumentCount();
      return { ...info, count };
    } catch {
      return info;
    }
  }
}

export async function collectionStats(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<CollectionStats> {
  const ns = `${db}.${coll}`;
  const info = await findCollection(client, db, coll);
  if (info?.type === 'view') {
    return toCollectionStats(ns, undefined, 0);
  }
  const storage = await readStorageStats(client, db, coll);
  const count =
    readNumber(storage, 'count') ?? (await client.db(db).collection(coll).estimatedDocumentCount());
  return toCollectionStats(ns, storage, count);
}

/**
 * The collection's document count from its metadata, which is cheap and may be stale. A view has
 * no count of its own, so it reports zero.
 */
export async function estimatedDocumentCount(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<number> {
  const info = await findCollection(client, db, coll);
  if (info?.type === 'view') {
    return 0;
  }
  return client.db(db).collection(coll).estimatedDocumentCount();
}

export async function databaseStats(client: MongoClient, db: string): Promise<DatabaseStats> {
  const reply: unknown = await client.db(db).stats();
  return {
    db,
    collections: readNumber(reply, 'collections') ?? 0,
    views: readNumber(reply, 'views') ?? 0,
    objects: readNumber(reply, 'objects') ?? 0,
    dataSize: readNumber(reply, 'dataSize') ?? 0,
    storageSize: readNumber(reply, 'storageSize') ?? 0,
    indexes: readNumber(reply, 'indexes') ?? 0,
    indexSize: readNumber(reply, 'indexSize') ?? 0,
  };
}

export async function listIndexes(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<IndexInfo[]> {
  const info = await findCollection(client, db, coll);
  if (info?.type === 'view') {
    return [];
  }
  // Raw BSON values keep Long, Date and Decimal128 types for the EJSON output.
  const descriptors: unknown[] = await client
    .db(db)
    .collection(coll)
    .listIndexes({ promoteLongs: false, promoteValues: false })
    .toArray();
  const [usage, storage] = await Promise.all([
    readUsage(client, db, coll),
    readStorageStats(client, db, coll),
  ]);
  const sizes = toIndexSizes(readField(storage, 'indexSizes'));
  return descriptors.flatMap((descriptor) => toIndexInfo(descriptor, usage, sizes));
}

async function findCollection(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<CollectionInfo | undefined> {
  const rows: unknown[] = await client
    .db(db)
    .listCollections({ name: coll }, { nameOnly: false })
    .toArray();
  return rows.flatMap(toCollectionInfo)[0];
}

async function readStorageStats(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<PlainObject | undefined> {
  const rows: unknown[] = await client
    .db(db)
    .collection(coll)
    .aggregate([{ $collStats: { storageStats: {} } }])
    .toArray();
  return readRecord(rows[0], 'storageStats');
}

async function readUsage(
  client: MongoClient,
  db: string,
  coll: string,
): Promise<Map<string, IndexUsage>> {
  try {
    const rows: unknown[] = await client
      .db(db)
      .collection(coll)
      .aggregate([{ $indexStats: {} }])
      .toArray();
    return collectUsage(rows);
  } catch {
    return new Map();
  }
}

function collectUsage(rows: unknown[]): Map<string, IndexUsage> {
  const usage = new Map<string, IndexUsage>();
  for (const row of rows) {
    const name = readString(row, 'name');
    const accesses = readRecord(row, 'accesses');
    const since = readDate(accesses, 'since');
    if (name === undefined || since === undefined) {
      continue;
    }
    const ops = readNumber(accesses, 'ops') ?? 0;
    const sinceIso = since.toISOString();
    const previous = usage.get(name);
    usage.set(
      name,
      previous === undefined
        ? { ops, since: sinceIso }
        : {
            ops: previous.ops + ops,
            since: previous.since < sinceIso ? previous.since : sinceIso,
          },
    );
  }
  return usage;
}

function toDatabaseInfo(raw: unknown): DatabaseInfo[] {
  const name = readString(raw, 'name');
  if (name === undefined) {
    return [];
  }
  return [
    {
      name,
      ...definedEntry('sizeOnDisk', readNumber(raw, 'sizeOnDisk')),
      ...definedEntry('empty', readBoolean(raw, 'empty')),
    },
  ];
}

function toCollectionInfo(raw: unknown): CollectionInfo[] {
  const name = readString(raw, 'name');
  if (name === undefined) {
    return [];
  }
  return [
    {
      name,
      type: toCollectionType(readString(raw, 'type')),
      ...definedEntry('options', readRecord(raw, 'options')),
      ...definedEntry('info', toInfoBlock(readRecord(raw, 'info'))),
    },
  ];
}

function toCollectionType(value: string | undefined): CollectionInfo['type'] {
  if (value === 'view' || value === 'timeseries') {
    return value;
  }
  return 'collection';
}

function toInfoBlock(info: PlainObject | undefined): CollectionInfo['info'] {
  if (info === undefined) {
    return undefined;
  }
  return {
    ...definedEntry('readOnly', readBoolean(info, 'readOnly')),
    ...definedEntry('uuid', toUuidHex(readField(info, 'uuid'))),
  };
}

function toUuidHex(value: unknown): string | undefined {
  if (value instanceof Binary) {
    return value.toString('hex');
  }
  return typeof value === 'string' ? value : undefined;
}

function toCollectionStats(ns: string, storage: unknown, count: number): CollectionStats {
  return {
    ns,
    count,
    size: readNumber(storage, 'size') ?? 0,
    storageSize: readNumber(storage, 'storageSize') ?? 0,
    avgObjSize: readNumber(storage, 'avgObjSize') ?? 0,
    nindexes: readNumber(storage, 'nindexes') ?? 0,
    totalIndexSize: readNumber(storage, 'totalIndexSize') ?? 0,
    capped: readBoolean(storage, 'capped') ?? false,
    indexSizes: toIndexSizes(readField(storage, 'indexSizes')),
  };
}

function toIndexSizes(sizes: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!isPlainObject(sizes)) {
    return result;
  }
  for (const [name, value] of Object.entries(sizes)) {
    if (typeof value === 'number') {
      result[name] = value;
    }
  }
  return result;
}

function toIndexInfo(
  descriptor: unknown,
  usage: Map<string, IndexUsage>,
  sizes: Record<string, number>,
): IndexInfo[] {
  const name = readString(descriptor, 'name');
  const key = toKeySpec(readRecord(descriptor, 'key'));
  if (name === undefined || key === undefined) {
    return [];
  }
  return [
    {
      name,
      key,
      ...definedEntry('unique', readBoolean(descriptor, 'unique')),
      ...definedEntry('sparse', readBoolean(descriptor, 'sparse')),
      ...definedEntry('hidden', readBoolean(descriptor, 'hidden')),
      ...definedEntry('expireAfterSeconds', numericField(descriptor, 'expireAfterSeconds')),
      ...definedEntry(
        'partialFilterExpressionEjson',
        ejsonField(descriptor, 'partialFilterExpression'),
      ),
      ...definedEntry('collationEjson', ejsonField(descriptor, 'collation')),
      ...definedEntry('wildcardProjectionEjson', ejsonField(descriptor, 'wildcardProjection')),
      ...definedEntry('weights', weightsOf(descriptor)),
      ...definedEntry('defaultLanguage', readString(descriptor, 'default_language')),
      ...definedEntry('extraOptionsEjson', extraOptionsOf(descriptor)),
      ...definedEntry('size', sizes[name]),
      ...definedEntry('usage', usage.get(name)),
    },
  ];
}

function toKeySpec(key: PlainObject | undefined): Record<string, number | string> | undefined {
  if (key === undefined) {
    return undefined;
  }
  const spec: Record<string, number | string> = {};
  for (const [field, direction] of Object.entries(key)) {
    if (typeof direction === 'string') {
      spec[field] = direction;
      continue;
    }
    const numeric = numericValue(direction);
    if (numeric !== undefined) {
      spec[field] = numeric;
    }
  }
  return spec;
}

// Raw descriptors hold BSON wrappers for numbers. Plain numbers and wrappers both count here.
function numericField(source: unknown, key: string): number | undefined {
  return readNumber(source, key) ?? numericValue(readField(source, key));
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof BSON.Int32 || value instanceof BSON.Double) {
    return value.valueOf();
  }
  if (value instanceof BSON.Long) {
    return value.toNumber();
  }
  return undefined;
}

// The options that toIndexInfo maps to their own fields. Every other option is an extra.
// createIndex refuses extra options that name one of these.
export const HELD_INDEX_OPTIONS: readonly string[] = [
  'v',
  'key',
  'name',
  'ns',
  'unique',
  'sparse',
  'hidden',
  'expireAfterSeconds',
  'partialFilterExpression',
  'collation',
  'wildcardProjection',
  'weights',
  'default_language',
];

function weightsOf(descriptor: unknown): Record<string, number> | undefined {
  const raw = readRecord(descriptor, 'weights');
  if (raw === undefined) {
    return undefined;
  }
  const weights: Record<string, number> = {};
  for (const [field, value] of Object.entries(raw)) {
    const weight = numericValue(value);
    if (weight !== undefined) {
      weights[field] = weight;
    }
  }
  return weights;
}

// Options the draft does not hold, as EJSON. Editing an index passes them back unchanged.
function extraOptionsOf(descriptor: unknown): string | undefined {
  if (!isPlainObject(descriptor)) {
    return undefined;
  }
  const extras = Object.entries(descriptor).filter(([key]) => !HELD_INDEX_OPTIONS.includes(key));
  return extras.length === 0 ? undefined : stringifyEjson(Object.fromEntries(extras));
}

// Canonical EJSON text for an index option document, so BSON types survive the RPC boundary.
function ejsonField(source: unknown, key: string): string | undefined {
  const value = readRecord(source, key);
  return value === undefined ? undefined : stringifyEjson(value);
}

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  if (a.name < b.name) {
    return -1;
  }
  return a.name > b.name ? 1 : 0;
}
