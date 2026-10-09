import { randomUUID } from 'node:crypto';
import { BSON, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  CollectionInfoSchema,
  IndexInfoSchema,
  type AppError,
} from '@mongo-gui/core';
import { listCollections, listDatabases, listIndexes } from '../catalog';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  supportsTimeseries,
  type StartedMongo,
} from '../test/mongo-container';
import {
  clearCollection,
  createCollection,
  createDatabase,
  dropCollection,
  dropDatabase,
  renameCollection,
} from './collections';
import {
  deleteByFilter,
  deleteDocuments,
  findDocumentById,
  insertDocument,
  replaceDocument,
  updateDocumentFields,
} from './documents';
import { createIndex, dropIndex, listIndexBuilds, setIndexHidden } from './indexes';
import { checkDocumentsAgainstValidator, getValidation, setValidation } from './validation';

const { EJSON } = BSON;

// Fixture documents use plain string or number _id values, which the driver's ObjectId default rejects.
type Fixture = { _id?: string | number; [field: string]: unknown };
const LONG_TIMEOUT_MS = 120_000;
const BUILD_DOCUMENT_COUNT = 200_000;
const BUILD_POLL_LIMIT_MS = 5_000;
const BUILD_POLL_INTERVAL_MS = 50;
const SECRET_TEXT = 'hunter2-secret';

const NAME_SCHEMA = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['name'],
    properties: { name: { bsonType: 'string' } },
  },
};

function uniqueDatabase(): string {
  return `mgmt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureError(action: () => Promise<unknown>): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error;
    }
    throw error;
  }
  throw new Error('expected the action to fail with an AppErrorException');
}

describe.each(MONGO_IMAGES)('management on %s', (image) => {
  let mongo: StartedMongo;
  let client: MongoClient;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = new MongoClient(mongo.rootUri);
    await client.connect();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  describe('collections and databases', () => {
    it('creates a normal collection', async () => {
      const database = uniqueDatabase();
      const info = await createCollection(client, { database, name: 'orders' });
      expect(info).toMatchObject({ name: 'orders', type: 'collection' });
      expect(CollectionInfoSchema.safeParse(info).success).toBe(true);
    });

    it('creates a capped collection', async () => {
      const database = uniqueDatabase();
      const info = await createCollection(client, {
        database,
        name: 'events',
        capped: { sizeBytes: 65536, maxDocuments: 100 },
      });
      expect(info.options).toMatchObject({ capped: true, size: 65536, max: 100 });
    });

    it.skipIf(!supportsTimeseries(image))('creates a timeseries collection', async () => {
      const database = uniqueDatabase();
      const info = await createCollection(client, {
        database,
        name: 'metrics',
        timeseries: { timeField: 't', metaField: 'm', granularity: 'minutes' },
      });
      expect(info.type).toBe('timeseries');
    });

    it('creates a collection with a validator', async () => {
      const database = uniqueDatabase();
      await createCollection(client, {
        database,
        name: 'people',
        validator: NAME_SCHEMA,
        validationLevel: 'moderate',
        validationAction: 'warn',
      });
      expect(await getValidation(client, database, 'people')).toEqual({
        validator: NAME_SCHEMA,
        validationLevel: 'moderate',
        validationAction: 'warn',
      });
    });

    it('renames a collection and fails on an existing target without dropTarget', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('draft').insertOne({ x: 1 });
      await client.db(database).collection<Fixture>('final').insertOne({ x: 2 });

      const error = await captureError(() =>
        renameCollection(client, { database, name: 'draft', newName: 'final' }),
      );
      expect(error.code).toBe('COMMAND_FAILED');

      await renameCollection(client, {
        database,
        name: 'draft',
        newName: 'final',
        dropTarget: true,
      });
      const names = (await listCollections(client, database)).map((info) => info.name);
      expect(names).toEqual(['final']);
      expect(
        await client.db(database).collection<Fixture>('final').findOne({ x: 1 }),
      ).not.toBeNull();
    });

    it('clears a collection and keeps it', async () => {
      const database = uniqueDatabase();
      const collection = client.db(database).collection<Fixture>('log');
      await collection.insertMany([{ a: 1 }, { a: 2 }]);
      await clearCollection(client, { database, name: 'log' });
      expect(await collection.countDocuments()).toBe(0);
      const names = (await listCollections(client, database)).map((info) => info.name);
      expect(names).toEqual(['log']);
    });

    it('drops a collection', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('temp').insertOne({ a: 1 });
      await dropCollection(client, { database, name: 'temp' });
      expect(await listCollections(client, database)).toEqual([]);
    });

    it('refuses to drop or clear in the admin, local and config databases', async () => {
      for (const database of ['admin', 'local', 'config']) {
        const dropped = await captureError(() =>
          dropCollection(client, { database, name: 'anything' }),
        );
        expect(dropped.code).toBe('VALIDATION');
        const cleared = await captureError(() =>
          clearCollection(client, { database, name: 'anything' }),
        );
        expect(cleared.code).toBe('VALIDATION');
      }
    });

    it('refuses to drop, clear or rename system collections', async () => {
      const database = uniqueDatabase();
      const dropped = await captureError(() =>
        dropCollection(client, { database, name: 'system.views' }),
      );
      expect(dropped.code).toBe('VALIDATION');
      const cleared = await captureError(() =>
        clearCollection(client, { database, name: 'system.profile' }),
      );
      expect(cleared.code).toBe('VALIDATION');
      const renamed = await captureError(() =>
        renameCollection(client, { database, name: 'system.views', newName: 'views' }),
      );
      expect(renamed.code).toBe('VALIDATION');
    });

    it('creates a database that then appears in listDatabases', async () => {
      const database = uniqueDatabase();
      await createDatabase(client, { database, initialCollection: 'first' });
      const names = (await listDatabases(client)).map((info) => info.name);
      expect(names).toContain(database);
      expect((await listCollections(client, database)).map((info) => info.name)).toEqual(['first']);
    });

    it('drops a database', async () => {
      const database = uniqueDatabase();
      await createDatabase(client, { database, initialCollection: 'gone' });
      await dropDatabase(client, { database });
      const names = (await listDatabases(client)).map((info) => info.name);
      expect(names).not.toContain(database);
    });

    it('refuses to drop the admin database', async () => {
      const error = await captureError(() => dropDatabase(client, { database: 'admin' }));
      expect(error.code).toBe('VALIDATION');
    });
  });

  describe('indexes', () => {
    it('creates a compound index with the default name', async () => {
      const database = uniqueDatabase();
      await client
        .db(database)
        .collection<Fixture>('orders')
        .insertOne({ status: 'paid', createdAt: 1 });
      const index = await createIndex(client, {
        database,
        collection: 'orders',
        keys: { status: 1, createdAt: -1 },
        options: {},
      });
      expect(index).toMatchObject({
        name: 'status_1_createdAt_-1',
        key: { status: 1, createdAt: -1 },
      });
      expect(IndexInfoSchema.safeParse(index).success).toBe(true);
    });

    it('creates a unique index', async () => {
      const database = uniqueDatabase();
      const index = await createIndex(client, {
        database,
        collection: 'users',
        keys: { email: 1 },
        options: { name: 'email_unique', unique: true },
      });
      expect(index.unique).toBe(true);
    });

    it('creates a TTL index that round-trips expireAfterSeconds', async () => {
      const database = uniqueDatabase();
      const index = await createIndex(client, {
        database,
        collection: 'sessions',
        keys: { expiresAt: 1 },
        options: { name: 'expires_ttl', expireAfterSeconds: 3600 },
      });
      expect(index.expireAfterSeconds).toBe(3600);
    });

    it('creates a partial index whose filter round-trips', async () => {
      const database = uniqueDatabase();
      const filter = { status: { $eq: 'paid' } };
      const index = await createIndex(client, {
        database,
        collection: 'orders',
        keys: { total: 1 },
        options: { name: 'paid_total', partialFilterExpression: filter },
      });
      expect(index.partialFilterExpression).toEqual(filter);
    });

    it('creates a text index', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('articles').insertOne({ body: 'hello world' });
      const index = await createIndex(client, {
        database,
        collection: 'articles',
        keys: { body: 'text' },
        options: { name: 'body_text', weights: { body: 2 }, defaultLanguage: 'english' },
      });
      expect(index.name).toBe('body_text');
      expect(index.key).toHaveProperty('_fts', 'text');
    });

    it('creates a hashed index', async () => {
      const database = uniqueDatabase();
      const index = await createIndex(client, {
        database,
        collection: 'items',
        keys: { sku: 'hashed' },
        options: {},
      });
      expect(index.key).toEqual({ sku: 'hashed' });
    });

    it('creates a wildcard index that round-trips wildcardProjection', async () => {
      const database = uniqueDatabase();
      const projection = { a: 1, b: 1 };
      const index = await createIndex(client, {
        database,
        collection: 'attributes',
        keys: { '$**': 1 },
        options: { name: 'attrs_wildcard', wildcardProjection: projection },
      });
      expect(index.wildcardProjection).toEqual(projection);
      const listed = (await listIndexes(client, database, 'attributes')).find(
        (entry) => entry.name === 'attrs_wildcard',
      );
      expect(listed?.wildcardProjection).toEqual(projection);
    });

    it('reports a duplicate-key unique index build as COMMAND_FAILED', async () => {
      const database = uniqueDatabase();
      await client
        .db(database)
        .collection<Fixture>('dupes')
        .insertMany([{ k: 1 }, { k: 1 }]);
      const error = await captureError(() =>
        createIndex(client, {
          database,
          collection: 'dupes',
          keys: { k: 1 },
          options: { unique: true },
        }),
      );
      expect(error.code).toBe('COMMAND_FAILED');
    });

    it('drops an index and refuses to drop _id_', async () => {
      const database = uniqueDatabase();
      await createIndex(client, {
        database,
        collection: 'orders',
        keys: { sku: 1 },
        options: { name: 'sku_1' },
      });
      await dropIndex(client, { database, collection: 'orders', name: 'sku_1' });
      const names = (await listIndexes(client, database, 'orders')).map((index) => index.name);
      expect(names).not.toContain('sku_1');

      const error = await captureError(() =>
        dropIndex(client, { database, collection: 'orders', name: '_id_' }),
      );
      expect(error.code).toBe('VALIDATION');
    });

    it('hides and unhides an index', async () => {
      const database = uniqueDatabase();
      await createIndex(client, {
        database,
        collection: 'orders',
        keys: { sku: 1 },
        options: { name: 'sku_1' },
      });
      await setIndexHidden(client, { database, collection: 'orders', name: 'sku_1', hidden: true });
      const hidden = (await listIndexes(client, database, 'orders')).find(
        (index) => index.name === 'sku_1',
      );
      expect(hidden?.hidden).toBe(true);

      await setIndexHidden(client, {
        database,
        collection: 'orders',
        name: 'sku_1',
        hidden: false,
      });
      const visible = (await listIndexes(client, database, 'orders')).find(
        (index) => index.name === 'sku_1',
      );
      expect(visible?.hidden).not.toBe(true);
    });

    it(
      'lists index builds while a build runs on a large collection',
      async () => {
        const database = uniqueDatabase();
        const collection = client.db(database).collection<Fixture>('large');
        const documents = Array.from({ length: BUILD_DOCUMENT_COUNT }, (_, index) => ({
          n: index,
          s: `value-${index % 1000}-${index}`,
        }));
        await collection.insertMany(documents);

        let settled = false;
        const build = createIndex(client, {
          database,
          collection: 'large',
          keys: { s: 1, n: 1 },
          options: { name: 's_1_n_1' },
        }).finally(() => {
          settled = true;
        });

        let outcome: 'observed' | 'empty' = 'empty';
        const deadline = Date.now() + BUILD_POLL_LIMIT_MS;
        while (outcome === 'empty' && !settled && Date.now() < deadline) {
          const builds = await listIndexBuilds(client, database);
          if (builds.length > 0) {
            outcome = 'observed';
            expect(builds[0]).toMatchObject({ collection: 'large', indexName: 's_1_n_1' });
            expect(typeof builds[0]?.phase).toBe('string');
          } else {
            await sleep(BUILD_POLL_INTERVAL_MS);
          }
        }
        await build;
        expect(['observed', 'empty']).toContain(outcome);
      },
      LONG_TIMEOUT_MS,
    );
  });

  describe('validation', () => {
    it('returns defaults for a collection without a validator', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('plain').insertOne({ a: 1 });
      expect(await getValidation(client, database, 'plain')).toEqual({
        validator: {},
        validationLevel: 'strict',
        validationAction: 'error',
      });
    });

    it('sets and clears a validator', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('people').insertOne({ name: 'ada' });
      await setValidation(client, {
        database,
        collection: 'people',
        rules: { validator: NAME_SCHEMA, validationLevel: 'strict', validationAction: 'error' },
      });
      expect(await getValidation(client, database, 'people')).toEqual({
        validator: NAME_SCHEMA,
        validationLevel: 'strict',
        validationAction: 'error',
      });

      await setValidation(client, {
        database,
        collection: 'people',
        rules: { validator: {}, validationLevel: 'off', validationAction: 'warn' },
      });
      expect(await getValidation(client, database, 'people')).toEqual({
        validator: {},
        validationLevel: 'off',
        validationAction: 'warn',
      });
    });

    it('reports sampled documents that fail the validator', async () => {
      const database = uniqueDatabase();
      await client
        .db(database)
        .collection<Fixture>('people')
        .insertMany([
          { _id: 'good-1', name: 'ada' },
          { _id: 'good-2', name: 'grace' },
          { _id: 'bad-1', name: 1 },
          { _id: 'bad-2' },
        ]);
      await setValidation(client, {
        database,
        collection: 'people',
        rules: { validator: NAME_SCHEMA, validationLevel: 'strict', validationAction: 'error' },
      });

      const result = await checkDocumentsAgainstValidator(client, database, 'people', 100);
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      const message = result.errors[0]?.message ?? '';
      expect(message).toContain('2 sampled documents fail the validator');
      expect(message).toContain('"bad-1"');
      expect(message).toContain('"bad-2"');
      expect(message).not.toContain('"good-1"');
    });

    it('reports ok when every sampled document passes', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('people').insertOne({ name: 'ada' });
      await setValidation(client, {
        database,
        collection: 'people',
        rules: { validator: NAME_SCHEMA, validationLevel: 'strict', validationAction: 'error' },
      });
      expect(await checkDocumentsAgainstValidator(client, database, 'people', 10)).toEqual({
        ok: true,
        errors: [],
      });
    });

    it('reports ok when no validator is set', async () => {
      const database = uniqueDatabase();
      await client.db(database).collection<Fixture>('people').insertOne({ name: 1 });
      expect(await checkDocumentsAgainstValidator(client, database, 'people', 10)).toEqual({
        ok: true,
        errors: [],
      });
    });
  });

  describe('documents', () => {
    it('inserts a document and returns its _id as EJSON', async () => {
      const database = uniqueDatabase();
      const idText = await insertDocument(client, {
        database,
        collection: 'orders',
        documentEjson:
          '{"_id": {"$oid": "64b000000000000000000001"}, "total": {"$numberLong": "5"}}',
      });
      expect(idText).toBe('{"$oid":"64b000000000000000000001"}');
      const found = await findDocumentById(client, {
        database,
        collection: 'orders',
        idEjson: idText,
      });
      expect(found).not.toBeNull();
      expect(EJSON.parse(found ?? 'null', { relaxed: false })).toEqual({
        _id: BSON.ObjectId.createFromHexString('64b000000000000000000001'),
        total: BSON.Long.fromNumber(5),
      });
    });

    it('generates an _id when the document has none', async () => {
      const database = uniqueDatabase();
      const idText = await insertDocument(client, {
        database,
        collection: 'orders',
        documentEjson: '{"status": "open"}',
      });
      expect(idText).toMatch(/^\{"\$oid":"[0-9a-f]{24}"\}$/);
    });

    it('returns null for a missing _id', async () => {
      const database = uniqueDatabase();
      expect(
        await findDocumentById(client, {
          database,
          collection: 'orders',
          idEjson: '"nope"',
        }),
      ).toBeNull();
    });

    it('replaces a document by _id and fails for a missing _id', async () => {
      const database = uniqueDatabase();
      await client
        .db(database)
        .collection<Fixture>('orders')
        .insertOne({ _id: 'o-1', status: 'open' });
      await replaceDocument(client, {
        database,
        collection: 'orders',
        idEjson: '"o-1"',
        documentEjson: '{"status": "paid"}',
      });
      expect(
        await client.db(database).collection<Fixture>('orders').findOne({ _id: 'o-1' }),
      ).toMatchObject({
        status: 'paid',
      });

      const error = await captureError(() =>
        replaceDocument(client, {
          database,
          collection: 'orders',
          idEjson: '"missing"',
          documentEjson: '{"status": "paid"}',
        }),
      );
      expect(error.code).toBe('VALIDATION');
    });

    it('sets and unsets fields by _id', async () => {
      const database = uniqueDatabase();
      await client
        .db(database)
        .collection<Fixture>('orders')
        .insertOne({ _id: 'o-2', status: 'open', note: 'rush' });
      await updateDocumentFields(client, {
        database,
        collection: 'orders',
        idEjson: '"o-2"',
        setEjson: '{"status": "paid"}',
        unsetPaths: ['note'],
      });
      const updated = await client
        .db(database)
        .collection<Fixture>('orders')
        .findOne({ _id: 'o-2' });
      expect(updated).toMatchObject({ status: 'paid' });
      expect(updated).not.toHaveProperty('note');

      const missing = await captureError(() =>
        updateDocumentFields(client, {
          database,
          collection: 'orders',
          idEjson: '"missing"',
          setEjson: '{"status": "paid"}',
        }),
      );
      expect(missing.code).toBe('VALIDATION');

      const empty = await captureError(() =>
        updateDocumentFields(client, {
          database,
          collection: 'orders',
          idEjson: '"o-2"',
          setEjson: '{}',
        }),
      );
      expect(empty.code).toBe('VALIDATION');
    });

    it('deletes documents by _id list and returns the count', async () => {
      const database = uniqueDatabase();
      const collection = client.db(database).collection<Fixture>('orders');
      await collection.insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
      expect(
        await deleteDocuments(client, {
          database,
          collection: 'orders',
          idsEjson: ['1', '{"$numberInt":"2"}'],
        }),
      ).toBe(2);
      expect(await collection.countDocuments()).toBe(1);
      expect(await deleteDocuments(client, { database, collection: 'orders', idsEjson: [] })).toBe(
        0,
      );
    });

    it('deletes by filter only when the expected count matches', async () => {
      const database = uniqueDatabase();
      const collection = client.db(database).collection<Fixture>('orders');
      await collection.insertMany([
        { group: 'a' },
        { group: 'a' },
        { group: 'a' },
        { group: 'b' },
        { group: 'b' },
      ]);

      const stale = await captureError(() =>
        deleteByFilter(client, {
          database,
          collection: 'orders',
          filterEjson: '{"group": "a"}',
          expectedCount: 4,
        }),
      );
      expect(stale.code).toBe('VALIDATION');
      expect(await collection.countDocuments()).toBe(5);

      const deleted = await deleteByFilter(client, {
        database,
        collection: 'orders',
        filterEjson: '{"group": "a"}',
        expectedCount: 3,
      });
      expect(deleted).toBe(3);
      expect(await collection.countDocuments()).toBe(2);
    });

    it('rejects invalid EJSON without echoing the document', async () => {
      const database = uniqueDatabase();
      const error = await captureError(() =>
        insertDocument(client, {
          database,
          collection: 'orders',
          documentEjson: `{"secret": "${SECRET_TEXT}", "broken": x}`,
        }),
      );
      expect(error.code).toBe('VALIDATION');
      expect(JSON.stringify(error)).not.toContain(SECRET_TEXT);
    });

    it('rejects an EJSON value that is not an object for a document', async () => {
      const database = uniqueDatabase();
      const error = await captureError(() =>
        insertDocument(client, {
          database,
          collection: 'orders',
          documentEjson: '[1, 2]',
        }),
      );
      expect(error.code).toBe('VALIDATION');
    });
  });
});
