import { AppErrorException } from '@mongo-gui/core';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dropCollectionIfExists,
  mergeCollection,
  renameCollection,
  serverIdentity,
  type CollectionRef,
  type MergeCounts,
} from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';
import {
  REPLICA_SET_NAME,
  connectTo,
  startReplicaSet,
  withClient,
  type ReplicaSetHarness,
} from '../test/replica-set';

const COPY_DB = 'copy_test';
const TEST_TIMEOUT_MS = 60_000;
// Used for the cross-server identity checks. One image keeps the number of containers low.
const IDENTITY_IMAGE = 'mongo:8.0.17';
// A user with only the read role cannot run serverStatus.
const RESTRICTED_USER = 'copy_reader';
const RESTRICTED_PASSWORD = 'reader-secret';

// The driver types a default _id as ObjectId. The tests use numeric and string ids.
type TestDoc = { _id: number | string; [field: string]: unknown };

function ref(collection: string): CollectionRef {
  return { db: COPY_DB, collection };
}

function renameInput(name: string, newName: string, dropTarget: boolean) {
  return { database: COPY_DB, name, newName, dropTarget };
}

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not started`);
  }
  return value;
}

describe.each(MONGO_IMAGES)('copy helpers on %s', (image) => {
  let mongo: StartedMongo | undefined;
  let client: MongoClient | undefined;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = await connectTo(mongo.rootUri);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  beforeEach(async () => {
    await connected().db(COPY_DB).dropDatabase();
  });

  function connected(): MongoClient {
    return requireDefined(client, 'the server');
  }

  function names(): Promise<string[]> {
    return connected()
      .db(COPY_DB)
      .listCollections({}, { nameOnly: true })
      .toArray()
      .then((rows) => rows.map((row) => row.name).sort());
  }

  describe('renameCollection and dropCollectionIfExists', () => {
    it(
      'renames a collection and keeps its documents',
      async () => {
        const db = connected().db(COPY_DB);
        await db.collection<TestDoc>('items').insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

        await renameCollection(connected(), renameInput('items', 'items_copy', false));

        expect(await names()).toEqual(['items_copy']);
        expect(await db.collection<TestDoc>('items_copy').countDocuments()).toBe(3);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fails on an existing target without dropTarget and keeps both collections',
      async () => {
        const db = connected().db(COPY_DB);
        await db.collection<TestDoc>('items').insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
        await db.collection<TestDoc>('items_copy').insertOne({ _id: 'old' });

        const error: unknown = await renameCollection(
          connected(),
          renameInput('items', 'items_copy', false),
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(AppErrorException);
        expect(error).toMatchObject({ error: { codeName: 'NamespaceExists' } });
        expect(await db.collection<TestDoc>('items').countDocuments()).toBe(3);
        expect(await db.collection<TestDoc>('items_copy').countDocuments()).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'replaces an existing target with dropTarget',
      async () => {
        const db = connected().db(COPY_DB);
        await db.collection<TestDoc>('items').insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
        await db.collection<TestDoc>('items_copy').insertOne({ _id: 'old' });

        await renameCollection(connected(), renameInput('items', 'items_copy', true));

        expect(await names()).toEqual(['items_copy']);
        expect(await db.collection<TestDoc>('items_copy').countDocuments()).toBe(3);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'drops an existing collection and ignores a missing one',
      async () => {
        await connected().db(COPY_DB).collection<TestDoc>('items').insertOne({ _id: 1 });

        await dropCollectionIfExists(connected(), ref('items'));
        expect(await names()).toEqual([]);

        await expect(dropCollectionIfExists(connected(), ref('items'))).resolves.toBeUndefined();
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('mergeCollection', () => {
    it(
      'copies the filtered documents in batches and replaces matching _ids',
      async () => {
        const db = connected().db(COPY_DB);
        const source = db.collection<TestDoc>('source');
        const target = db.collection<TestDoc>('target');
        await source.insertMany(
          Array.from({ length: 20 }, (_, index) => ({
            _id: index,
            group: index % 2 === 0 ? 'even' : 'odd',
            value: index,
          })),
        );
        await target.insertMany([
          { _id: 0, value: 'old' },
          { _id: 99, keep: true },
        ]);
        const progress: MergeCounts[] = [];

        const result = await mergeCollection({
          source,
          target,
          filter: { group: 'even' },
          batchSize: 3,
          onProgress: (counts) => progress.push(counts),
        });

        expect(result).toEqual({ written: 10, failed: 0 });
        expect(progress.map((counts) => counts.written)).toEqual([3, 6, 9, 10]);
        expect(await target.countDocuments()).toBe(11);
        expect(await target.findOne({ _id: 0 })).toMatchObject({ group: 'even', value: 0 });
        expect(await target.findOne({ _id: 99 })).toMatchObject({ keep: true });
        expect(await target.countDocuments({ group: 'odd' })).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'counts a document that violates a unique index and writes the rest of the batch',
      async () => {
        const db = connected().db(COPY_DB);
        const source = db.collection<TestDoc>('source');
        const target = db.collection<TestDoc>('target');
        await target.createIndex({ code: 1 }, { unique: true });
        await target.insertOne({ _id: 'x', code: 'taken' });
        await source.insertMany([
          { _id: 1, code: 'a' },
          { _id: 2, code: 'taken' },
          { _id: 3, code: 'b' },
        ]);

        const result = await mergeCollection({ source, target, batchSize: 10 });

        expect(result).toEqual({ written: 2, failed: 1 });
        expect(await target.findOne({ _id: 2 })).toBeNull();
        expect(await target.findOne({ _id: 3 })).toMatchObject({ code: 'b' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'stops between batches when the signal aborts',
      async () => {
        const db = connected().db(COPY_DB);
        const source = db.collection<TestDoc>('source');
        const target = db.collection<TestDoc>('target');
        await source.insertMany(Array.from({ length: 20 }, (_, index) => ({ _id: index })));
        const controller = new AbortController();

        const result = await mergeCollection({
          source,
          target,
          batchSize: 5,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        });

        expect(result).toEqual({ written: 5, failed: 0 });
        expect(await target.countDocuments()).toBe(5);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'writes nothing when the signal is already aborted',
      async () => {
        const db = connected().db(COPY_DB);
        const source = db.collection<TestDoc>('source');
        const target = db.collection<TestDoc>('target');
        await source.insertMany(Array.from({ length: 20 }, (_, index) => ({ _id: index })));
        const controller = new AbortController();
        controller.abort();

        const result = await mergeCollection({
          source,
          target,
          batchSize: 5,
          signal: controller.signal,
        });

        expect(result).toEqual({ written: 0, failed: 0 });
        expect(await target.countDocuments()).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('serverIdentity', () => {
    it(
      'reports the server host, and two clients to the same server get equal identities',
      async () => {
        const uri = requireDefined(mongo, 'the server').rootUri;
        const first = await serverIdentity(connected());
        const second = await withClient(uri, serverIdentity);

        expect(first.hosts).toHaveLength(1);
        expect(first.replicaSet).toBeUndefined();
        expect(second).toEqual(first);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'falls back to the connection host list when the user cannot run serverStatus',
      async () => {
        await connected()
          .db('admin')
          .command({
            createUser: RESTRICTED_USER,
            pwd: RESTRICTED_PASSWORD,
            roles: [{ role: 'read', db: COPY_DB }],
          });
        const url = new URL(requireDefined(mongo, 'the server').rootUri);
        url.username = RESTRICTED_USER;
        url.password = RESTRICTED_PASSWORD;

        const seen = await withClient(url.toString(), async (restricted) => ({
          statusDenied: await restricted
            .db('admin')
            .command({ serverStatus: 1 })
            .then(
              () => false,
              () => true,
            ),
          identity: await serverIdentity(restricted),
          connectionHosts: restricted.options.hosts.map((host) => host.toString()),
        }));

        expect(seen.statusDenied).toBe(true);
        expect(seen.connectionHosts).toHaveLength(1);
        expect(seen.identity).toEqual({ hosts: seen.connectionHosts, replicaSet: undefined });
      },
      TEST_TIMEOUT_MS,
    );
  });
});

describe('serverIdentity tells servers apart', () => {
  let first: StartedMongo | undefined;
  let second: StartedMongo | undefined;
  let set: ReplicaSetHarness | undefined;

  beforeAll(async () => {
    // Starts one at a time, so only one container set runs at once.
    first = await startMongo(IDENTITY_IMAGE);
    second = await startMongo(IDENTITY_IMAGE);
    set = await startReplicaSet(IDENTITY_IMAGE, 1);
  }, CONTAINER_STARTUP_TIMEOUT_MS * 3);

  afterAll(async () => {
    await set?.stop();
    await second?.stop();
    await first?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it(
    'gives two standalone servers different identities',
    async () => {
      const a = await withClient(requireDefined(first, 'the first server').rootUri, serverIdentity);
      const b = await withClient(
        requireDefined(second, 'the second server').rootUri,
        serverIdentity,
      );

      expect(a.hosts).not.toEqual(b.hosts);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports the set name and the member host of a replica set',
    async () => {
      const [node] = requireDefined(set, 'the replica set').nodes;
      const member = requireDefined(node, 'the replica set member');

      const identity = await withClient(member.directUri, serverIdentity);

      expect(identity).toEqual({ hosts: [member.host], replicaSet: REPLICA_SET_NAME });
    },
    TEST_TIMEOUT_MS,
  );
});
