import type { Document, MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  DeleteByFilterInputSchema,
  DeleteDocumentsInputSchema,
  FindDocumentByIdInputSchema,
  InsertDocumentInputSchema,
  ReplaceDocumentInputSchema,
  UpdateDocumentFieldsInputSchema,
  type DeleteByFilterInput,
  type DeleteDocumentsInput,
  type FindDocumentByIdInput,
  type InsertDocumentInput,
  type ReplaceDocumentInput,
  type UpdateDocumentFieldsInput,
} from '@mongo-gui/core';
import type { PlainObject } from '../documents';
import { parseEjson, parseEjsonDocument, stringifyEjson } from './ejson';
import {
  parseInput,
  refuseReservedDatabase,
  refuseSystemCollection,
  toAppException,
  validationError,
} from './errors';

const ID_LABEL = 'The _id';
const DOCUMENT_LABEL = 'The document';
const FILTER_LABEL = 'The filter';

export async function insertDocument(client: MongoClient, input: unknown): Promise<string> {
  const parsed = parseInput<InsertDocumentInput>(InsertDocumentInputSchema, input);
  const document = parseEjsonDocument(parsed.documentEjson, DOCUMENT_LABEL);
  try {
    const result = await client
      .db(parsed.database)
      .collection<PlainObject>(parsed.collection)
      .insertOne(document);
    return stringifyEjson(result.insertedId);
  } catch (error) {
    throw toAppException(error);
  }
}

export async function replaceDocument(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<ReplaceDocumentInput>(ReplaceDocumentInputSchema, input);
  const id = parseEjson(parsed.idEjson, ID_LABEL);
  const replacement = parseEjsonDocument(parsed.documentEjson, DOCUMENT_LABEL);
  try {
    const result = await client
      .db(parsed.database)
      .collection<PlainObject>(parsed.collection)
      .replaceOne(byId(id), replacement, { upsert: false });
    if (result.matchedCount === 0) {
      throw notFound();
    }
  } catch (error) {
    throw toAppException(error);
  }
}

export async function updateDocumentFields(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<UpdateDocumentFieldsInput>(UpdateDocumentFieldsInputSchema, input);
  const id = parseEjson(parsed.idEjson, ID_LABEL);
  const update = buildUpdate(parsed);
  try {
    const result = await client
      .db(parsed.database)
      .collection<PlainObject>(parsed.collection)
      .updateOne(byId(id), update);
    if (result.matchedCount === 0) {
      throw notFound();
    }
  } catch (error) {
    throw toAppException(error);
  }
}

export async function deleteDocuments(client: MongoClient, input: unknown): Promise<number> {
  const parsed = parseInput<DeleteDocumentsInput>(DeleteDocumentsInputSchema, input);
  refuseReservedDatabase(parsed.database, 'delete documents in');
  refuseSystemCollection(parsed.collection, 'delete documents in');
  const ids = parsed.idsEjson.map((text) => parseEjson(text, ID_LABEL));
  if (ids.length === 0) {
    return 0;
  }
  try {
    const result = await client
      .db(parsed.database)
      .collection<PlainObject>(parsed.collection)
      .deleteMany(byIds(ids));
    return result.deletedCount;
  } catch (error) {
    throw toAppException(error);
  }
}

// The count check and the delete are two round trips, so a write between them can make the
// deleted count differ from expectedCount. The caller gets the real deleted count back.
export async function deleteByFilter(client: MongoClient, input: unknown): Promise<number> {
  const parsed = parseInput<DeleteByFilterInput>(DeleteByFilterInputSchema, input);
  refuseReservedDatabase(parsed.database, 'delete documents in');
  refuseSystemCollection(parsed.collection, 'delete documents in');
  const filter = parseEjsonDocument(parsed.filterEjson, FILTER_LABEL);
  const collection = client.db(parsed.database).collection<PlainObject>(parsed.collection);
  try {
    const matching = await collection.countDocuments(filter);
    if (matching !== parsed.expectedCount) {
      throw validationError(
        `The filter now matches ${matching} documents, not the expected ${parsed.expectedCount}. Refresh the count and try again.`,
      );
    }
    const result = await collection.deleteMany(filter);
    return result.deletedCount;
  } catch (error) {
    throw toAppException(error);
  }
}

export async function findDocumentById(
  client: MongoClient,
  input: unknown,
): Promise<string | null> {
  const parsed = parseInput<FindDocumentByIdInput>(FindDocumentByIdInputSchema, input);
  const id = parseEjson(parsed.idEjson, ID_LABEL);
  try {
    const document = await client
      .db(parsed.database)
      .collection<PlainObject>(parsed.collection)
      // Keep Long and typed values as BSON wrappers so the EJSON text keeps their types.
      .findOne(byId(id), { promoteLongs: false, promoteValues: false });
    return document === null ? null : stringifyEjson(document);
  } catch (error) {
    throw toAppException(error);
  }
}

function buildUpdate(input: UpdateDocumentFieldsInput): PlainObject {
  const setFields =
    input.setEjson === undefined
      ? undefined
      : parseEjsonDocument(input.setEjson, 'The $set fields');
  const unsetPaths = input.unsetPaths ?? [];
  const update: PlainObject = {};
  if (setFields !== undefined && Object.keys(setFields).length > 0) {
    update.$set = setFields;
  }
  if (unsetPaths.length > 0) {
    update.$unset = Object.fromEntries(unsetPaths.map((path) => [path, '']));
  }
  if (Object.keys(update).length === 0) {
    throw validationError('Nothing to update: give at least one field to set or unset');
  }
  return update;
}

function notFound(): AppErrorException {
  return new AppErrorException(appError('VALIDATION', 'No document has that _id'));
}

// The driver types _id as ObjectId. Document values are untyped, so an arbitrary BSON _id fits.
function byId(id: unknown): Document {
  return { _id: id };
}

function byIds(ids: unknown[]): Document {
  return { _id: { $in: ids } };
}
