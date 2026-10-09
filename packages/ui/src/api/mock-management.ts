import {
  rpcContract,
  type CollectionInfo,
  type CreateCollectionInput,
  type CreateIndexInput,
  type IndexBuildProgress,
  type IndexInfo,
  type RpcClient,
  type RpcEvent,
} from '@mongo-gui/core';
import {
  buildProgress,
  defaultIndexName,
  failsValidator,
  findDatabase,
  findMockCollection,
  idKey,
  isMockDocument,
  matchesFilter,
  objectIdHex,
  type MockBuild,
  type MockCollection,
  type MockDatabase,
  type MockDocument,
} from './mock-catalog';
import { fail, method } from './mock-support';

/** What the management calls need from the mock backend. */
export interface MockManagementContext {
  readonly latencyMs: number;
  /** Throws unless the vault is unlocked and the connection is connected. */
  guard(connectionId: string): void;
  catalogOf(connectionId: string): MockDatabase[];
  buildsOf(connectionId: string): MockBuild[];
  emit(event: RpcEvent): void;
  now(): number;
}

const EMPTY_DATABASE_SIZE = 4096;
const DEFAULT_INDEX_SIZE = 8192;
const SAMPLE_IDS_LIMIT = 20;
const FIRST_GENERATED_ID = 0x100000;

let generatedIds = 0;

function newObjectId(): MockDocument {
  generatedIds += 1;
  return { $oid: objectIdHex(FIRST_GENERATED_ID + generatedIds) };
}

/** Parses EJSON text the mock can read. The mock accepts JSON and `$oid`-style wrappers only. */
function parseText(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw fail('VALIDATION', `${label} is not valid EJSON`);
  }
}

function parseObject(text: string, label: string): MockDocument {
  const value = parseText(text, label);
  if (!isMockDocument(value)) {
    throw fail('VALIDATION', `${label} must be a JSON object`);
  }
  return value;
}

/** A validator is enforced when its level is not off and its action is error. */
function enforces(collection: MockCollection): boolean {
  return collection.validationLevel !== 'off' && collection.validationAction === 'error';
}

function assertValid(collection: MockCollection, document: MockDocument): void {
  if (enforces(collection) && failsValidator(document, collection.validator)) {
    throw fail('COMMAND_FAILED', 'Document failed validation');
  }
}

function requireCollection(
  context: MockManagementContext,
  connectionId: string,
  database: string,
  collection: string,
): MockCollection {
  const found = findMockCollection(context.catalogOf(connectionId), database, collection);
  if (found === undefined) {
    throw fail('COMMAND_FAILED', 'Collection not found', `${database}.${collection}`);
  }
  return found;
}

function requireDocument(collection: MockCollection, idText: string): number {
  const index = collection.documents.findIndex(
    (document) => idKey(document._id) === idKey(parseText(idText, 'The _id')),
  );
  if (index === -1) {
    throw fail('VALIDATION', 'No document has that _id');
  }
  return index;
}

function removeDatabaseIfEmpty(catalog: MockDatabase[], database: MockDatabase): void {
  if (database.collections.length === 0) {
    const index = catalog.indexOf(database);
    if (index !== -1) {
      catalog.splice(index, 1);
    }
  }
}

function collectionInfoFor(input: CreateCollectionInput): CollectionInfo {
  const options: Record<string, unknown> = {};
  if (input.capped !== undefined) {
    options.capped = true;
    options.size = input.capped.sizeBytes;
    if (input.capped.maxDocuments !== undefined) {
      options.max = input.capped.maxDocuments;
    }
  }
  if (input.timeseries !== undefined) {
    options.timeseries = { ...input.timeseries };
  }
  if (input.collationEjson !== undefined) {
    options.collation = parseObject(input.collationEjson, 'The collation');
  }
  const info: CollectionInfo = {
    name: input.name,
    type: input.timeseries === undefined ? 'collection' : 'timeseries',
  };
  if (Object.keys(options).length > 0) {
    info.options = options;
  }
  return info;
}

function newCollection(input: CreateCollectionInput): MockCollection {
  const idIndex: IndexInfo = { name: '_id_', key: { _id: 1 }, size: 20_480 };
  return {
    info: collectionInfoFor(input),
    documents: [],
    indexes: [idIndex],
    validator:
      input.validatorEjson === undefined ? {} : parseObject(input.validatorEjson, 'The validator'),
    validationLevel: input.validationLevel ?? 'strict',
    validationAction: input.validationAction ?? 'error',
  };
}

function indexFrom(input: CreateIndexInput, name: string): IndexInfo {
  const options = input.options;
  const info: IndexInfo = { name, key: input.keys, size: DEFAULT_INDEX_SIZE };
  if (options.unique !== undefined) {
    info.unique = options.unique;
  }
  if (options.sparse !== undefined) {
    info.sparse = options.sparse;
  }
  if (options.hidden !== undefined) {
    info.hidden = options.hidden;
  }
  if (options.expireAfterSeconds !== undefined) {
    info.expireAfterSeconds = options.expireAfterSeconds;
  }
  if (options.partialFilterExpressionEjson !== undefined) {
    info.partialFilterExpressionEjson = options.partialFilterExpressionEjson;
  }
  if (options.collationEjson !== undefined) {
    info.collationEjson = options.collationEjson;
  }
  if (options.wildcardProjectionEjson !== undefined) {
    info.wildcardProjectionEjson = options.wildcardProjectionEjson;
  }
  return info;
}

/** Sets a dotted path on a copy of the document. Intermediate objects are copied too. */
function withPath(document: MockDocument, path: string, value: unknown): MockDocument {
  const [head, ...rest] = path.split('.');
  if (head === undefined) {
    return document;
  }
  if (rest.length === 0) {
    return { ...document, [head]: value };
  }
  const child = isMockDocument(document[head]) ? document[head] : {};
  return { ...document, [head]: withPath(child, rest.join('.'), value) };
}

/** Removes a dotted path from a copy of the document. */
function withoutPath(document: MockDocument, path: string): MockDocument {
  const [head, ...rest] = path.split('.');
  if (head === undefined) {
    return document;
  }
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(document).filter(([key]) => key !== head));
  }
  const child = document[head];
  if (!isMockDocument(child)) {
    return document;
  }
  return { ...document, [head]: withoutPath(child, rest.join('.')) };
}

function sampleIds(failing: readonly MockDocument[]): string[] {
  return failing.slice(0, SAMPLE_IDS_LIMIT).map((document) => idKey(document._id));
}

/** The management calls of the mock, with the same input and output contract as the router. */
export function createManagementCalls(context: MockManagementContext): RpcClient['management'] {
  const { latencyMs } = context;
  const changed = (connectionId: string, scope: { database: string; collection?: string }) =>
    context.emit(
      scope.collection === undefined
        ? { type: 'catalog:changed', connectionId, database: scope.database }
        : {
            type: 'catalog:changed',
            connectionId,
            database: scope.database,
            collection: scope.collection,
          },
    );
  const calls = rpcContract.management;

  return {
    createCollection: method(calls.createCollection, latencyMs, (input) => {
      context.guard(input.connectionId);
      const catalog = context.catalogOf(input.connectionId);
      let database = findDatabase(catalog, input.database);
      if (database === undefined) {
        database = { name: input.database, sizeOnDisk: EMPTY_DATABASE_SIZE, collections: [] };
        catalog.push(database);
      }
      if (database.collections.some((item) => item.info.name === input.name)) {
        throw fail(
          'COMMAND_FAILED',
          'Collection already exists',
          `${input.database}.${input.name}`,
        );
      }
      const created = newCollection(input);
      database.collections.push(created);
      changed(input.connectionId, { database: input.database, collection: input.name });
      return created.info;
    }),

    renameCollection: method(calls.renameCollection, latencyMs, (input) => {
      context.guard(input.connectionId);
      const database = findDatabase(context.catalogOf(input.connectionId), input.database);
      const source = requireCollection(context, input.connectionId, input.database, input.name);
      const target = database?.collections.find((item) => item.info.name === input.newName);
      if (database === undefined) {
        throw fail('COMMAND_FAILED', 'Database not found', input.database);
      }
      if (target !== undefined) {
        if (input.dropTarget !== true) {
          throw fail('COMMAND_FAILED', 'Target collection already exists', input.newName);
        }
        database.collections = database.collections.filter((item) => item !== target);
      }
      source.info = { ...source.info, name: input.newName };
      changed(input.connectionId, { database: input.database, collection: input.name });
    }),

    dropCollection: method(calls.dropCollection, latencyMs, (input) => {
      context.guard(input.connectionId);
      const catalog = context.catalogOf(input.connectionId);
      const database = findDatabase(catalog, input.database);
      requireCollection(context, input.connectionId, input.database, input.name);
      if (database !== undefined) {
        database.collections = database.collections.filter((item) => item.info.name !== input.name);
        removeDatabaseIfEmpty(catalog, database);
      }
      changed(input.connectionId, { database: input.database, collection: input.name });
    }),

    clearCollection: method(calls.clearCollection, latencyMs, (input) => {
      context.guard(input.connectionId);
      requireCollection(context, input.connectionId, input.database, input.name).documents = [];
      changed(input.connectionId, { database: input.database, collection: input.name });
    }),

    createDatabase: method(calls.createDatabase, latencyMs, (input) => {
      context.guard(input.connectionId);
      const catalog = context.catalogOf(input.connectionId);
      let database = findDatabase(catalog, input.database);
      if (database === undefined) {
        database = { name: input.database, sizeOnDisk: EMPTY_DATABASE_SIZE, collections: [] };
        catalog.push(database);
      }
      if (database.collections.some((item) => item.info.name === input.initialCollection)) {
        throw fail('COMMAND_FAILED', 'Collection already exists', input.initialCollection);
      }
      database.collections.push(
        newCollection({ database: input.database, name: input.initialCollection }),
      );
      changed(input.connectionId, { database: input.database });
    }),

    dropDatabase: method(calls.dropDatabase, latencyMs, (input) => {
      context.guard(input.connectionId);
      const catalog = context.catalogOf(input.connectionId);
      const index = catalog.findIndex((item) => item.name === input.database);
      if (index !== -1) {
        catalog.splice(index, 1);
      }
      const builds = context.buildsOf(input.connectionId);
      const kept = builds.filter((build) => build.database !== input.database);
      builds.splice(0, builds.length, ...kept);
      changed(input.connectionId, { database: input.database });
    }),

    createIndex: method(calls.createIndex, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const name = input.options.name ?? defaultIndexName(input.keys);
      if (collection.indexes.some((index) => index.name === name)) {
        throw fail('COMMAND_FAILED', 'An index with that name already exists', name);
      }
      const created = indexFrom(input, name);
      collection.indexes.push(created);
      changed(input.connectionId, { database: input.database, collection: input.collection });
      return created;
    }),

    dropIndex: method(calls.dropIndex, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const index = collection.indexes.findIndex((item) => item.name === input.name);
      if (index === -1) {
        throw fail('COMMAND_FAILED', 'Index not found', input.name);
      }
      collection.indexes.splice(index, 1);
      changed(input.connectionId, { database: input.database, collection: input.collection });
    }),

    setIndexHidden: method(calls.setIndexHidden, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const index = collection.indexes.find((item) => item.name === input.name);
      if (index === undefined) {
        throw fail('COMMAND_FAILED', 'Index not found', input.name);
      }
      index.hidden = input.hidden;
      changed(input.connectionId, { database: input.database, collection: input.collection });
    }),

    listIndexBuilds: method(calls.listIndexBuilds, latencyMs, (input) => {
      context.guard(input.connectionId);
      const now = context.now();
      return context
        .buildsOf(input.connectionId)
        .filter((build) => input.database === undefined || build.database === input.database)
        .map((build) => buildProgress(build, now))
        .filter((row): row is IndexBuildProgress => row !== undefined);
    }),

    getValidation: method(calls.getValidation, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      return {
        validatorEjson: JSON.stringify(collection.validator),
        validationLevel: collection.validationLevel,
        validationAction: collection.validationAction,
      };
    }),

    setValidation: method(calls.setValidation, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      collection.validator = parseObject(input.rules.validatorEjson, 'The validator');
      collection.validationLevel = input.rules.validationLevel;
      collection.validationAction = input.rules.validationAction;
      changed(input.connectionId, { database: input.database, collection: input.collection });
    }),

    checkValidation: method(calls.checkValidation, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const validator =
        input.validatorEjson === undefined
          ? collection.validator
          : parseObject(input.validatorEjson, 'The validator');
      const failing = collection.documents
        .slice(0, input.sampleSize)
        .filter((document) => failsValidator(document, validator));
      if (failing.length === 0) {
        return { ok: true, errors: [], failingIds: [] };
      }
      return {
        ok: false,
        errors: [{ message: `${failing.length} sampled documents fail the validator.` }],
        failingIds: sampleIds(failing),
      };
    }),

    insertDocument: method(calls.insertDocument, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const parsed = parseObject(input.documentEjson, 'The document');
      const document: MockDocument =
        parsed._id === undefined ? { _id: newObjectId(), ...parsed } : parsed;
      const id = idKey(document._id);
      if (collection.documents.some((item) => idKey(item._id) === id)) {
        throw fail('COMMAND_FAILED', 'A document with that _id already exists');
      }
      assertValid(collection, document);
      collection.documents.push(document);
      changed(input.connectionId, { database: input.database, collection: input.collection });
      return JSON.stringify(document._id);
    }),

    replaceDocument: method(calls.replaceDocument, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const index = requireDocument(collection, input.idEjson);
      const existing = collection.documents[index];
      const replacement = parseObject(input.documentEjson, 'The document');
      if (existing === undefined) {
        throw fail('VALIDATION', 'No document has that _id');
      }
      const next: MockDocument =
        replacement._id === undefined ? { _id: existing._id, ...replacement } : replacement;
      if (idKey(next._id) !== idKey(existing._id)) {
        throw fail('COMMAND_FAILED', 'The _id field cannot be changed');
      }
      assertValid(collection, next);
      collection.documents[index] = next;
      changed(input.connectionId, { database: input.database, collection: input.collection });
    }),

    updateDocumentFields: method(calls.updateDocumentFields, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const index = requireDocument(collection, input.idEjson);
      const setFields =
        input.setEjson === undefined ? {} : parseObject(input.setEjson, 'The $set fields');
      const unsetPaths = input.unsetPaths ?? [];
      if (Object.keys(setFields).length === 0 && unsetPaths.length === 0) {
        throw fail('VALIDATION', 'Nothing to update: give at least one field to set or unset');
      }
      if ('_id' in setFields) {
        throw fail(
          'COMMAND_FAILED',
          'Performing an update on the path _id would modify the immutable field _id',
        );
      }
      const current = collection.documents[index];
      if (current === undefined) {
        throw fail('VALIDATION', 'No document has that _id');
      }
      let next = current;
      for (const [path, value] of Object.entries(setFields)) {
        next = withPath(next, path, value);
      }
      for (const path of unsetPaths) {
        next = withoutPath(next, path);
      }
      assertValid(collection, next);
      collection.documents[index] = next;
      changed(input.connectionId, { database: input.database, collection: input.collection });
    }),

    deleteDocuments: method(calls.deleteDocuments, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const ids = new Set(input.idsEjson.map((text) => idKey(parseText(text, 'The _id'))));
      const before = collection.documents.length;
      collection.documents = collection.documents.filter(
        (document) => !ids.has(idKey(document._id)),
      );
      changed(input.connectionId, { database: input.database, collection: input.collection });
      return before - collection.documents.length;
    }),

    countDocuments: method(calls.countDocuments, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const filter = parseObject(input.filterEjson, 'The filter');
      return collection.documents.filter((document) => matchesFilter(document, filter)).length;
    }),

    deleteByFilter: method(calls.deleteByFilter, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const filter = parseObject(input.filterEjson, 'The filter');
      const matching = collection.documents.filter((document) => matchesFilter(document, filter));
      if (matching.length !== input.expectedCount) {
        throw fail(
          'VALIDATION',
          `The filter now matches ${matching.length} documents, not the expected ${input.expectedCount}. Refresh the count and try again.`,
        );
      }
      collection.documents = collection.documents.filter(
        (document) => !matchesFilter(document, filter),
      );
      changed(input.connectionId, { database: input.database, collection: input.collection });
      return matching.length;
    }),

    findDocumentById: method(calls.findDocumentById, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      const id = idKey(parseText(input.idEjson, 'The _id'));
      const found = collection.documents.find((document) => idKey(document._id) === id);
      return found === undefined ? null : JSON.stringify(found);
    }),

    sampleDocuments: method(calls.sampleDocuments, latencyMs, (input) => {
      context.guard(input.connectionId);
      const collection = requireCollection(
        context,
        input.connectionId,
        input.database,
        input.collection,
      );
      return collection.documents.slice(0, input.limit).map((document) => JSON.stringify(document));
    }),
  };
}
