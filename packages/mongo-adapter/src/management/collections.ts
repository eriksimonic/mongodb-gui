import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  ClearCollectionInputSchema,
  CreateCollectionInputSchema,
  CreateDatabaseInputSchema,
  DropCollectionInputSchema,
  DropDatabaseInputSchema,
  RenameCollectionInputSchema,
  type ClearCollectionInput,
  type CollectionInfo,
  type CreateCollectionInput,
  type CreateDatabaseInput,
  type DropCollectionInput,
  type DropDatabaseInput,
  type RenameCollectionInput,
} from '@mongo-gui/core';
import { listCollections } from '../catalog';
import {
  parseInput,
  refuseReservedDatabase,
  refuseSystemCollection,
  toAppException,
} from './errors';

const CLUSTERED_INDEX_NAME = 'clustered';

export async function createCollection(
  client: MongoClient,
  input: unknown,
): Promise<CollectionInfo> {
  const parsed = parseInput<CreateCollectionInput>(CreateCollectionInputSchema, input);
  try {
    await client.db(parsed.database).command({ create: parsed.name, ...toCreateOptions(parsed) });
    const created = (await listCollections(client, parsed.database)).find(
      (info) => info.name === parsed.name,
    );
    if (created === undefined) {
      throw new AppErrorException(
        appError('COMMAND_FAILED', 'The collection was not found after it was created'),
      );
    }
    return created;
  } catch (error) {
    throw toAppException(error);
  }
}

export async function renameCollection(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<RenameCollectionInput>(RenameCollectionInputSchema, input);
  refuseReservedDatabase(parsed.database, 'rename collections in');
  refuseSystemCollection(parsed.name, 'rename');
  try {
    await client.db('admin').command({
      renameCollection: `${parsed.database}.${parsed.name}`,
      to: `${parsed.database}.${parsed.newName}`,
      dropTarget: parsed.dropTarget ?? false,
    });
  } catch (error) {
    throw toAppException(error);
  }
}

export async function dropCollection(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<DropCollectionInput>(DropCollectionInputSchema, input);
  refuseReservedDatabase(parsed.database, 'drop collections in');
  refuseSystemCollection(parsed.name, 'drop');
  try {
    await client.db(parsed.database).collection(parsed.name).drop();
  } catch (error) {
    throw toAppException(error);
  }
}

export async function clearCollection(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<ClearCollectionInput>(ClearCollectionInputSchema, input);
  refuseReservedDatabase(parsed.database, 'clear collections in');
  refuseSystemCollection(parsed.name, 'clear');
  try {
    await client.db(parsed.database).collection(parsed.name).deleteMany({});
  } catch (error) {
    throw toAppException(error);
  }
}

// MongoDB has no create-database command. A database exists once it holds a collection,
// so this creates the initial collection.
export async function createDatabase(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<CreateDatabaseInput>(CreateDatabaseInputSchema, input);
  refuseReservedDatabase(parsed.database, 'create');
  try {
    await client.db(parsed.database).command({ create: parsed.initialCollection });
  } catch (error) {
    throw toAppException(error);
  }
}

export async function dropDatabase(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<DropDatabaseInput>(DropDatabaseInputSchema, input);
  refuseReservedDatabase(parsed.database, 'drop');
  try {
    await client.db(parsed.database).dropDatabase();
  } catch (error) {
    throw toAppException(error);
  }
}

function toCreateOptions(input: CreateCollectionInput): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (input.capped !== undefined) {
    options.capped = true;
    options.size = input.capped.sizeBytes;
    if (input.capped.maxDocuments !== undefined) {
      options.max = input.capped.maxDocuments;
    }
  }
  if (input.timeseries !== undefined) {
    const { expireAfterSeconds, ...timeseries } = input.timeseries;
    options.timeseries = timeseries;
    if (expireAfterSeconds !== undefined) {
      options.expireAfterSeconds = expireAfterSeconds;
    }
  }
  if (input.clusteredIndex === true) {
    options.clusteredIndex = { key: { _id: 1 }, unique: true, name: CLUSTERED_INDEX_NAME };
  }
  if (input.collation !== undefined) {
    options.collation = input.collation;
  }
  if (input.validator !== undefined) {
    options.validator = input.validator;
  }
  if (input.validationLevel !== undefined) {
    options.validationLevel = input.validationLevel;
  }
  if (input.validationAction !== undefined) {
    options.validationAction = input.validationAction;
  }
  return options;
}
