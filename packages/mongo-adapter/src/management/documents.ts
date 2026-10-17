import type { Document, MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  FindDocumentByIdInputSchema,
  ReplaceDocumentInputSchema,
  SampleDocumentsInputSchema,
  UpdateDocumentFieldsInputSchema,
  type FindDocumentByIdInput,
  type ReplaceDocumentInput,
  type SampleDocumentsInput,
  type UpdateDocumentFieldsInput,
  validationError,
} from '@mongo-gui/core';
import type { PlainObject } from '../documents';
import { parseEjson, parseEjsonDocument, stringifyEjson } from '../ejson';
import { parseInput, toAppException } from './errors';

const ID_LABEL = 'The _id';
const DOCUMENT_LABEL = 'The document';

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

// Returns the first documents in natural order as canonical EJSON. The create index dialog uses
// them to suggest field names.
export async function sampleDocuments(client: MongoClient, input: unknown): Promise<string[]> {
  const parsed = parseInput<SampleDocumentsInput>(SampleDocumentsInputSchema, input);
  try {
    const rows = await client
      .db(parsed.database)
      .collection<PlainObject>(parsed.collection)
      .find({}, { limit: parsed.limit, promoteLongs: false, promoteValues: false })
      .toArray();
    return rows.map((row) => stringifyEjson(row));
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
