import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  CreateIndexInputSchema,
  DatabaseNameSchema,
  DropIndexInputSchema,
  PROTECTED_INDEX_NAMES,
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
import { parseEjsonDocument } from './ejson';
import { parseInput, toAppException, validationError } from './errors';

const INDEX_BUILD_MESSAGE_PREFIX = 'Index Build';
const INDEX_BUILD_MESSAGE_PATTERN = /^Index Build:?\s*/;
const PERCENT = 100;

// One build can appear as a client operation and as an IndexBuildsCoordinator operation.
// Both rows carry the same index, so each build is reported once.
interface BuildRow {
  readonly key: string;
  // Higher ranks win: a row with a percentage beats one with a phase, which beats one with neither.
  readonly rank: number;
  readonly progress: IndexBuildProgress;
}

export async function createIndex(client: MongoClient, input: unknown): Promise<IndexInfo> {
  const parsed = parseInput<CreateIndexInput>(CreateIndexInputSchema, input);
  const name = parsed.options.name ?? defaultIndexName(parsed.keys);
  try {
    const spec: Record<string, unknown> = {
      key: parsed.keys,
      name,
      ...toIndexOptions(parsed.options),
    };
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
  if (PROTECTED_INDEX_NAMES.includes(parsed.name)) {
    throw validationError(`The ${parsed.name} index cannot be dropped`);
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
  const scope =
    database === undefined ? undefined : parseInput<string>(DatabaseNameSchema, database);
  try {
    const rows: unknown[] = await client
      .db('admin')
      .aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }])
      .toArray();
    return collapseBuilds(rows.flatMap((row) => toBuildRow(row, scope)));
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
  if (options.unique !== undefined) {
    result.unique = options.unique;
  }
  if (options.sparse !== undefined) {
    result.sparse = options.sparse;
  }
  if (options.hidden !== undefined) {
    result.hidden = options.hidden;
  }
  if (options.expireAfterSeconds !== undefined) {
    result.expireAfterSeconds = options.expireAfterSeconds;
  }
  if (options.weights !== undefined) {
    result.weights = options.weights;
  }
  if (options.defaultLanguage !== undefined) {
    result.default_language = options.defaultLanguage;
  }
  if (options.partialFilterExpressionEjson !== undefined) {
    result.partialFilterExpression = parseEjsonDocument(
      options.partialFilterExpressionEjson,
      'The partial filter expression',
    );
  }
  if (options.collationEjson !== undefined) {
    result.collation = parseEjsonDocument(options.collationEjson, 'The collation');
  }
  if (options.wildcardProjectionEjson !== undefined) {
    result.wildcardProjection = parseEjsonDocument(
      options.wildcardProjectionEjson,
      'The wildcard projection',
    );
  }
  return result;
}

function toBuildRow(row: unknown, scope: string | undefined): BuildRow[] {
  const ns = readString(row, 'ns') ?? '';
  const command = readRecord(row, 'command');
  const createIndexes = readString(command, 'createIndexes');
  const msg = readString(row, 'msg') ?? '';
  const isBuild = createIndexes !== undefined || msg.startsWith(INDEX_BUILD_MESSAGE_PREFIX);
  const opid = readField(row, 'opid');
  if (!isBuild || (typeof opid !== 'string' && typeof opid !== 'number')) {
    return [];
  }
  const dot = ns.indexOf('.');
  const databaseName = dot < 0 ? readString(command, '$db') : ns.slice(0, dot);
  const collection = createIndexes ?? (dot < 0 ? undefined : ns.slice(dot + 1));
  if (databaseName === undefined || collection === undefined) {
    return [];
  }
  if (scope !== undefined && databaseName !== scope) {
    return [];
  }
  const indexName = readArray(command, 'indexes')
    .map((spec) => readString(spec, 'name'))
    .filter((name): name is string => name !== undefined)
    .join(', ');
  const progress = readRecord(row, 'progress');
  const done = readNumber(progress, 'done');
  const total = readNumber(progress, 'total');
  // The phase is the text before the first colon or repeated "Index Build" prefix, so the
  // progress detail that follows it is dropped.
  const stripped = msg.replace(INDEX_BUILD_MESSAGE_PATTERN, '');
  const phase = (stripped.split(/:|Index Build/)[0] ?? '').trim();
  const percent =
    done !== undefined && total !== undefined && total > 0
      ? Math.min(PERCENT, (done / total) * PERCENT)
      : undefined;
  return [
    {
      key: `${databaseName}.${collection}\u0000${indexName}`,
      rank: (percent === undefined ? 0 : 2) + (phase === '' ? 0 : 1),
      progress: {
        collection,
        indexName,
        phase: phase === '' ? 'running' : phase,
        ...definedEntry('progressPercent', percent),
        opid,
      },
    },
  ];
}

// Keeps one row per build, the highest ranked one. Ties keep the first row seen.
function collapseBuilds(rows: BuildRow[]): IndexBuildProgress[] {
  const best = new Map<string, BuildRow>();
  for (const row of rows) {
    const existing = best.get(row.key);
    if (existing === undefined || row.rank > existing.rank) {
      best.set(row.key, row);
    }
  }
  return [...best.values()].map((row) => row.progress);
}
