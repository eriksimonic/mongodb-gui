import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  CreateIndexInputSchema,
  DropIndexInputSchema,
  SetIndexHiddenInputSchema,
  type CreateIndexInput,
  type DropIndexInput,
  type IndexBuildProgress,
  type IndexInfo,
  type SetIndexHiddenInput,
} from '@mongo-gui/core';
import { listIndexes } from '../catalog';
import {
  definedEntry,
  readArray,
  readField,
  readNumber,
  readRecord,
  readString,
} from '../documents';
import { parseInput, toAppException, validationError } from './errors';

const ID_INDEX_NAME = '_id_';
const INDEX_BUILD_MESSAGE_PREFIX = 'Index Build';
const PERCENT = 100;

export async function createIndex(client: MongoClient, input: unknown): Promise<IndexInfo> {
  const parsed = parseInput<CreateIndexInput>(CreateIndexInputSchema, input);
  const name = parsed.options.name ?? defaultIndexName(parsed.keys);
  const spec: Record<string, unknown> = {
    key: parsed.keys,
    name,
    ...toIndexOptions(parsed.options),
  };
  try {
    await client.db(parsed.database).command({ createIndexes: parsed.collection, indexes: [spec] });
    const created = (await listIndexes(client, parsed.database, parsed.collection)).find(
      (index) => index.name === name,
    );
    if (created === undefined) {
      throw new AppErrorException(
        appError('COMMAND_FAILED', 'The index was not found after it was created'),
      );
    }
    return created;
  } catch (error) {
    throw toAppException(error);
  }
}

export async function dropIndex(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<DropIndexInput>(DropIndexInputSchema, input);
  if (parsed.name === ID_INDEX_NAME) {
    throw validationError('The _id index cannot be dropped');
  }
  try {
    await client
      .db(parsed.database)
      .command({ dropIndexes: parsed.collection, index: parsed.name });
  } catch (error) {
    throw toAppException(error);
  }
}

// collMod with index.hidden needs MongoDB 4.4 or newer.
export async function setIndexHidden(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<SetIndexHiddenInput>(SetIndexHiddenInputSchema, input);
  try {
    await client.db(parsed.database).command({
      collMod: parsed.collection,
      index: { name: parsed.name, hidden: parsed.hidden },
    });
  } catch (error) {
    throw toAppException(error);
  }
}

// Reads in-progress index builds from $currentOp. Pass a database to keep only its builds.
export async function listIndexBuilds(
  client: MongoClient,
  database?: string,
): Promise<IndexBuildProgress[]> {
  try {
    const rows: unknown[] = await client
      .db('admin')
      .aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }])
      .toArray();
    return rows.flatMap((row) => toBuildProgress(row, database));
  } catch (error) {
    throw toAppException(error);
  }
}

export function defaultIndexName(keys: Record<string, unknown>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');
}

function toIndexOptions(options: CreateIndexInput['options']): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const passThrough = [
    'unique',
    'sparse',
    'hidden',
    'expireAfterSeconds',
    'partialFilterExpression',
    'collation',
    'wildcardProjection',
    'background',
    'weights',
  ] as const;
  for (const key of passThrough) {
    const value = options[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  if (options.defaultLanguage !== undefined) {
    result.default_language = options.defaultLanguage;
  }
  return result;
}

function toBuildProgress(row: unknown, database: string | undefined): IndexBuildProgress[] {
  const ns = readString(row, 'ns');
  const dot = ns?.indexOf('.') ?? -1;
  if (ns === undefined || dot < 0) {
    return [];
  }
  const dbName = ns.slice(0, dot);
  if (database !== undefined && dbName !== database) {
    return [];
  }
  const command = readRecord(row, 'command');
  const msg = readString(row, 'msg') ?? '';
  const createIndexes = readString(command, 'createIndexes');
  const isBuild =
    readField(command, 'createIndexes') !== undefined || msg.startsWith(INDEX_BUILD_MESSAGE_PREFIX);
  const opid = readField(row, 'opid');
  if (!isBuild || (typeof opid !== 'string' && typeof opid !== 'number')) {
    return [];
  }
  const progress = readRecord(row, 'progress');
  const done = readNumber(progress, 'done');
  const total = readNumber(progress, 'total');
  const indexNames = readArray(command, 'indexes')
    .map((spec) => readString(spec, 'name'))
    .filter((name): name is string => name !== undefined);
  return [
    {
      collection: createIndexes ?? ns.slice(dot + 1),
      indexName: indexNames.join(', '),
      phase: msg === '' ? 'running' : msg,
      ...definedEntry(
        'progressPercent',
        done !== undefined && total !== undefined && total > 0
          ? Math.min(PERCENT, (done / total) * PERCENT)
          : undefined,
      ),
      opid,
    },
  ];
}
