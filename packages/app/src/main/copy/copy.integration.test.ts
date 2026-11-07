import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { MongoClient, type Collection } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  parseToolLine,
  type ConnectionProfile,
  type CopyOptions,
  type CopyProgress,
  type RpcEvent,
} from '@mongo-gui/core';
import {
  dropCollectionIfExists,
  mergeCollection,
  readBackupServerInfo,
  renameCollection,
} from '@mongo-gui/mongo-adapter';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  seedCatalog,
  startMongo,
  supportsTimeseries,
  type StartedMongo,
} from '../../../../mongo-adapter/src/test/mongo-container';
import type { ToolsEndpoint } from '../backup/endpoint';
import { runTool } from '../backup/tool-process';
import { createToolsRegistry } from '../tools/registry';
import { toolEnv } from '../tools/tool-env';
import { createCopyService, type CopyJobs } from './copy-service';

// The same image as backup.integration.test.ts. Time series needs 5.0 or newer.
const IMAGE = 'mongo:8.0.17';
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS * 2 + 240_000;
const TEST_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 90_000;
const SECRET = 'integration-secret';
const SOURCE_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const TARGET_ID = '7a1d2e3f-4b5c-4d6e-8f70-123456789abc';
const SYSTEM_DATABASES = ['admin', 'config', 'local'];
const BULK_BATCHES = 24;
const BULK_BATCH_SIZE = 5000;
// The live timeline holds the restore input back for this long. mongodump then blocks on a full pipe
// and prints a progress line every 3 s, so the test does not depend on how fast the machine restores.
const LIVE_BATCHES = 200;
const LIVE_DOCUMENTS = LIVE_BATCHES * BULK_BATCH_SIZE;
const LIVE_HOLD_MS = 7_000;
const LIVE_TIMEOUT_MS = 240_000;

const appRoot = join(__dirname, '..', '..', '..');
const toolsDir =
  process.env['MONGO_TOOLS_DIR'] ??
  join(appRoot, 'resources', 'mongo-tools', `${process.platform}-${process.arch}`);
const hasTools = existsSync(join(toolsDir, 'install.json'));

interface NumberedDocument {
  _id: number;
  v: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function profileOf(id: string, name: string, production: boolean): ConnectionProfile {
  return { id, name, production } as unknown as ConnectionProfile;
}

function endpointOf(uri: string, profileName: string, hostPort: string): ToolsEndpoint {
  return {
    uri,
    profileName,
    readPreference: 'primary',
    secrets: [uri, SECRET],
    status: {
      state: 'connected',
      serverVersion: IMAGE.slice('mongo:'.length),
      topology: 'standalone',
      hosts: [hostPort],
    },
  };
}

function hostPortOf(uri: string): string {
  return /@([^/]+)\//.exec(uri)?.[1] ?? '';
}

describe.skipIf(!hasTools)('copy with the real tools on two servers', () => {
  let source: StartedMongo;
  let target: StartedMongo;
  let sourceClient: MongoClient;
  let targetClient: MongoClient;
  let work: string;
  const events: RpcEvent[] = [];
  let service: CopyJobs;
  const profiles: Record<string, ConnectionProfile> = {};
  // Zero except during the live timeline test.
  let restoreHoldMs = 0;

  /** The real runTool, except that a restore reads its input only after restoreHoldMs. */
  function heldRunTool(options: Parameters<typeof runTool>[0]): ReturnType<typeof runTool> {
    if (
      restoreHoldMs === 0 ||
      !options.binary.endsWith('mongorestore') ||
      options.stdin === undefined
    ) {
      return runTool(options);
    }
    const source = options.stdin;
    const held = new PassThrough();
    const timer = setTimeout(() => {
      if (!held.destroyed) source.pipe(held);
    }, restoreHoldMs);
    held.once('close', () => clearTimeout(timer));
    return runTool({ ...options, stdin: held });
  }

  const progressOf = (jobId: string): CopyProgress[] =>
    events.flatMap((event) =>
      event.type === 'copy:progress' && event.jobId === jobId ? [event.progress] : [],
    );

  async function finish(jobId: string): Promise<CopyProgress> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      const last = progressOf(jobId).find((progress) => progress.done);
      if (last !== undefined) return last;
      if (Date.now() > deadline) throw new Error('the job did not finish in time');
      await sleep(50);
    }
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('the condition was not met in time');
      await sleep(10);
    }
  }

  // Runs one copy with the restore input held back, and returns its job id and final event.
  async function runHeld(options: CopyOptions): Promise<{ jobId: string; final: CopyProgress }> {
    restoreHoldMs = LIVE_HOLD_MS;
    try {
      const jobId = await service.start(options);
      return { jobId, final: await finish(jobId) };
    } finally {
      restoreHoldMs = 0;
    }
  }

  async function runCopy(options: CopyOptions): Promise<CopyProgress> {
    return finish(await service.start(options));
  }

  function copyOptions(overrides: Partial<CopyOptions> = {}): CopyOptions {
    return {
      sourceConnectionId: SOURCE_ID,
      targetConnectionId: TARGET_ID,
      sourceDatabase: 'shop',
      targetDatabase: 'shop',
      items: [{ source: 'orders', target: 'orders' }],
      mode: 'replace',
      acknowledged: [],
      ...overrides,
    };
  }

  async function resetServer(client: MongoClient): Promise<void> {
    const { databases } = await client.db().admin().listDatabases();
    for (const database of databases) {
      if (!SYSTEM_DATABASES.includes(database.name)) {
        await client.db(database.name).dropDatabase();
      }
    }
  }

  // User collections only. Time series collections also list system.buckets.<name>.
  const collectionNames = async (client: MongoClient, database: string): Promise<string[]> =>
    (await client.db(database).listCollections({}, { nameOnly: true }).toArray())
      .map((info) => info.name)
      .filter((name) => !name.startsWith('system.'))
      .sort();

  const indexNames = async (
    client: MongoClient,
    database: string,
    collection: string,
  ): Promise<string[]> =>
    (await client.db(database).collection(collection).indexes()).map((index) => index.name ?? '');

  const temporaryNames = async (client: MongoClient, database: string): Promise<string[]> =>
    (await collectionNames(client, database)).filter((name) => name.startsWith('__copy_'));

  async function insertRange(
    collection: Collection<NumberedDocument>,
    ids: number[],
    value: string,
  ): Promise<void> {
    await collection.insertMany(ids.map((_id) => ({ _id, v: value })));
  }

  beforeAll(async () => {
    source = await startMongo(IMAGE);
    target = await startMongo(IMAGE);
    sourceClient = new MongoClient(source.rootUri);
    targetClient = new MongoClient(target.rootUri);
    await sourceClient.connect();
    await targetClient.connect();
    work = mkdtempSync(join(tmpdir(), 'copy-it-'));
    const roots = {
      bundled: toolsDir,
      downloaded: join(work, 'downloaded'),
      tmp: join(work, 'tmp'),
    };
    mkdirSync(roots.tmp, { recursive: true });
    const registry = createToolsRegistry({
      roots,
      spawn,
      platform: process.platform,
      arch: process.arch,
    });
    const listed = await registry.list('auto');
    if (listed.resolved === undefined) throw new Error('no healthy tools install found');
    profiles[SOURCE_ID] = profileOf(SOURCE_ID, 'Source', false);
    profiles[TARGET_ID] = profileOf(TARGET_ID, 'Target', false);
    const endpoints: Record<string, ToolsEndpoint> = {
      [SOURCE_ID]: endpointOf(source.rootUri, 'Source', hostPortOf(source.rootUri)),
      [TARGET_ID]: endpointOf(target.rootUri, 'Target', hostPortOf(target.rootUri)),
    };
    service = createCopyService({
      registry,
      getClient: (id) => (id === SOURCE_ID ? sourceClient : targetClient),
      getProfile: (id) => {
        const profile = profiles[id];
        if (profile === undefined) throw new Error(`no profile for ${id}`);
        return profile;
      },
      endpoint: async (id) => endpoints[id] as ToolsEndpoint,
      readServerInfo: readBackupServerInfo,
      rename: renameCollection,
      dropIfExists: dropCollectionIfExists,
      merge: mergeCollection,
      runTool: heldRunTool,
      spawn,
      emit: (event) => events.push(event),
      now: () => Date.now(),
      tmpRoot: roots.tmp,
      platform: process.platform,
    });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    events.length = 0;
    profiles[SOURCE_ID] = profileOf(SOURCE_ID, 'Source', false);
    profiles[TARGET_ID] = profileOf(TARGET_ID, 'Target', false);
    await resetServer(sourceClient);
    await resetServer(targetClient);
    await seedCatalog(source.rootUri, supportsTimeseries(IMAGE));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await service?.dispose();
    await sourceClient?.close();
    await targetClient?.close();
    await source?.stop();
    await target?.stop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
    // Nothing the app emitted may carry the password.
    expect(JSON.stringify(events)).not.toContain(SECRET);
  }, SUITE_TIMEOUT_MS);

  it(
    'copies one collection with a rename and a filter, and leaves the source unchanged',
    async () => {
      const sourceIndexes = await indexNames(sourceClient, 'shop', 'orders');
      const final = await runCopy(
        copyOptions({
          targetDatabase: 'archive',
          items: [{ source: 'orders', target: 'paid_orders', filter: '{"status":"paid"}' }],
        }),
      );

      expect(final).toMatchObject({
        done: true,
        cancelled: false,
        documents: 25,
        collectionsDone: 1,
        collectionsTotal: 1,
      });
      expect(final.error).toBeUndefined();
      const copied = targetClient.db('archive').collection('paid_orders');
      expect(await copied.countDocuments()).toBe(25);
      expect(await copied.countDocuments({ status: { $ne: 'paid' } })).toBe(0);
      expect(await indexNames(targetClient, 'archive', 'paid_orders')).toContain(
        'status_1_createdAt_-1',
      );
      expect(await collectionNames(targetClient, 'archive')).toEqual(['paid_orders']);
      expect(await sourceClient.db('shop').collection('orders').countDocuments()).toBe(50);
      expect(await indexNames(sourceClient, 'shop', 'orders')).toEqual(sourceIndexes);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'copies a whole database with several collections and skips the view',
    async () => {
      const final = await runCopy(
        copyOptions({
          targetDatabase: 'shopcopy',
          items: [
            { source: 'orders', target: 'orders' },
            { source: 'events', target: 'events' },
            { source: 'paidOrders', target: 'paidOrders' },
          ],
        }),
      );

      expect(final).toMatchObject({
        done: true,
        cancelled: false,
        documents: 60,
        collectionsDone: 2,
        collectionsTotal: 2,
      });
      expect(final.error).toBeUndefined();
      expect(await collectionNames(targetClient, 'shopcopy')).toEqual(['events', 'orders']);
      const copy = targetClient.db('shopcopy');
      expect(await copy.collection('orders').countDocuments()).toBe(50);
      expect(await copy.collection('events').countDocuments()).toBe(10);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'copies a time series collection in a whole-database copy into a new database',
    async () => {
      const final = await runCopy(
        copyOptions({
          targetDatabase: 'shopcopy',
          items: [
            { source: 'orders', target: 'orders' },
            { source: 'events', target: 'events' },
            { source: 'metrics', target: 'metrics' },
          ],
        }),
      );

      // mongodump counts the bucket documents: metrics adds 1, not its 5 points.
      expect(final).toMatchObject({
        done: true,
        cancelled: false,
        documents: 61,
        collectionsDone: 3,
        collectionsTotal: 3,
      });
      expect(final.error).toBeUndefined();
      const copy = targetClient.db('shopcopy');
      const [info] = await copy.listCollections({ name: 'metrics' }).toArray();
      expect(info?.type).toBe('timeseries');
      expect(await copy.collection('metrics').countDocuments()).toBe(5);
      expect(await collectionNames(targetClient, 'shopcopy')).toEqual([
        'events',
        'metrics',
        'orders',
      ]);
      expect(await temporaryNames(targetClient, 'shopcopy')).toEqual([]);
      // The bucket must not land in the source database name on the target server.
      expect(await collectionNames(targetClient, 'shop')).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'copies a time series collection to a new name on the second server',
    async () => {
      const final = await runCopy(
        copyOptions({ items: [{ source: 'metrics', target: 'metrics_copy' }] }),
      );

      expect(final).toMatchObject({ done: true, cancelled: false, collectionsDone: 1 });
      expect(final.error).toBeUndefined();
      const copy = targetClient.db('shop');
      const [info] = await copy
        .listCollections({ name: 'metrics_copy' }, { nameOnly: false })
        .toArray();
      expect(info?.type).toBe('timeseries');
      expect(info?.options).toMatchObject({ timeseries: { timeField: 't', metaField: 'm' } });
      expect(await copy.collection('metrics_copy').countDocuments()).toBe(5);
      expect(await collectionNames(targetClient, 'shop')).toEqual(['metrics_copy']);
      expect(await sourceClient.db('shop').collection('metrics').countDocuments()).toBe(5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a merge from a time series collection with no job',
    async () => {
      const failure = await service
        .start(copyOptions({ mode: 'merge', items: [{ source: 'metrics', target: 'metrics' }] }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppErrorException);
      expect((failure as AppErrorException).error).toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('Merge cannot copy time series collections'),
      });
      expect(events).toEqual([]);
      expect(await collectionNames(targetClient, 'shop')).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an insert only from a time series collection into a plain collection',
    async () => {
      const dest = targetClient.db('shop').collection('metrics');
      await dest.insertOne({ keep: true });

      const failure = await service
        .start(
          copyOptions({ mode: 'insertOnly', items: [{ source: 'metrics', target: 'metrics' }] }),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppErrorException);
      expect((failure as AppErrorException).error).toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('Insert only cannot add time series data'),
      });
      expect(events).toEqual([]);
      expect(await dest.find().toArray()).toEqual([expect.objectContaining({ keep: true })]);
      expect(await dest.countDocuments()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'replaces an existing target, restores its indexes and leaves no temporary collection',
    async () => {
      const old = targetClient.db('shop').collection('orders');
      await old.insertMany([{ legacy: true }, { legacy: true }, { legacy: true }]);
      await old.createIndex({ legacy: 1 });

      const final = await runCopy(copyOptions());

      expect(final).toMatchObject({ done: true, cancelled: false, documents: 50 });
      expect(final.error).toBeUndefined();
      const replaced = targetClient.db('shop').collection('orders');
      expect(await replaced.countDocuments()).toBe(50);
      expect(await replaced.countDocuments({ legacy: true })).toBe(0);
      const names = await indexNames(targetClient, 'shop', 'orders');
      expect(names).toEqual(expect.arrayContaining(['status_1_createdAt_-1', 'expiresAt_1']));
      expect(names).not.toContain('legacy_1');
      expect(await collectionNames(targetClient, 'shop')).toEqual(['orders']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels a replace mid-copy and keeps the old target data',
    async () => {
      const padding = 'x'.repeat(512);
      const bulk = sourceClient.db('shop').collection('bulk');
      for (let batch = 0; batch < BULK_BATCHES; batch++) {
        await bulk.insertMany(
          Array.from({ length: BULK_BATCH_SIZE }, (_, index) => ({
            n: batch * BULK_BATCH_SIZE + index,
            padding,
          })),
        );
      }
      await targetClient
        .db('shop')
        .collection('bulk')
        .insertMany([{ keep: true }, { keep: true }, { keep: true }]);

      const jobId = await service.start(
        copyOptions({ items: [{ source: 'bulk', target: 'bulk' }] }),
      );
      // Cancel on the first event of the job. The tools need longer than that to connect and dump
      // 120000 documents, so the cancel lands while they run. Waiting for tool output raced the
      // restore, which could finish before the cancel.
      await waitFor(() => progressOf(jobId).some((progress) => progress.phase === 'copying'));
      service.cancel(jobId);
      const final = await finish(jobId);

      expect(final).toMatchObject({ done: true, cancelled: true });
      expect(final.error?.code).toBe('CANCELLED');
      const kept = targetClient.db('shop').collection('bulk');
      expect(await kept.countDocuments()).toBe(3);
      expect(await kept.countDocuments({ keep: true })).toBe(3);
      expect(await collectionNames(targetClient, 'shop')).toEqual(['bulk']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'merge overwrites by _id, keeps extra target documents and leaves target indexes alone',
    async () => {
      const sourceMerge = sourceClient.db('shop').collection<NumberedDocument>('merge');
      await insertRange(sourceMerge, [1, 2, 3, 4, 5], 'new');
      await sourceMerge.createIndex({ v: 1 });
      const dest = targetClient.db('shop').collection<NumberedDocument>('merge');
      await insertRange(dest, [1, 2], 'old');
      await dest.insertOne({ _id: 100, v: 'extra' });
      await dest.createIndex({ extra: 1 });

      const final = await runCopy(
        copyOptions({ mode: 'merge', items: [{ source: 'merge', target: 'merge' }] }),
      );

      expect(final).toMatchObject({ done: true, cancelled: false, documents: 5 });
      expect(final.error).toBeUndefined();
      expect(await dest.find({}, { sort: { _id: 1 } }).toArray()).toEqual([
        { _id: 1, v: 'new' },
        { _id: 2, v: 'new' },
        { _id: 3, v: 'new' },
        { _id: 4, v: 'new' },
        { _id: 5, v: 'new' },
        { _id: 100, v: 'extra' },
      ]);
      expect(await indexNames(targetClient, 'shop', 'merge')).toEqual(['_id_', 'extra_1']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'insert only skips existing _ids, completes and counts the skipped documents',
    async () => {
      await insertRange(
        sourceClient.db('shop').collection<NumberedDocument>('insert'),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        'new',
      );
      const dest = targetClient.db('shop').collection<NumberedDocument>('insert');
      await insertRange(dest, [1, 2, 3, 4, 5], 'old');

      const final = await runCopy(
        copyOptions({ mode: 'insertOnly', items: [{ source: 'insert', target: 'insert' }] }),
      );

      expect(final.error).toBeUndefined();
      expect(final).toMatchObject({
        done: true,
        cancelled: false,
        documents: 5,
        skippedDocuments: 5,
      });
      expect(await dest.find({}, { sort: { _id: 1 } }).toArray()).toEqual([
        { _id: 1, v: 'old' },
        { _id: 2, v: 'old' },
        { _id: 3, v: 'old' },
        { _id: 4, v: 'old' },
        { _id: 5, v: 'old' },
        { _id: 6, v: 'new' },
        { _id: 7, v: 'new' },
        { _id: 8, v: 'new' },
        { _id: 9, v: 'new' },
        { _id: 10, v: 'new' },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'replaces a time series target in place and adds a note',
    async () => {
      const dest = targetClient.db('shop');
      await dest.createCollection('metrics', { timeseries: { timeField: 't', metaField: 'm' } });
      await dest.collection('metrics').insertMany([
        { t: new Date(0), m: { sensor: 'old' }, value: -1 },
        { t: new Date(60_000), m: { sensor: 'old' }, value: -2 },
      ]);

      const final = await runCopy(
        copyOptions({ items: [{ source: 'metrics', target: 'metrics' }] }),
      );

      // The count is not checked: mongodump counts the bucket documents (1), not the five points.
      expect(final).toMatchObject({ done: true, cancelled: false });
      expect(final.error).toBeUndefined();
      expect(final.notes?.some((note) => note.includes('time series'))).toBe(true);
      expect(await dest.collection('metrics').countDocuments()).toBe(5);
      expect(await dest.collection('metrics').countDocuments({ 'm.sensor': 'old' })).toBe(0);
      const [info] = await dest.listCollections({ name: 'metrics' }).toArray();
      expect(info?.type).toBe('timeseries');
      expect(await temporaryNames(targetClient, 'shop')).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // The Risks item. MongoDB 8.0.17 refuses renameCollection on a time series collection, so the
  // replace path can never rename one. The test records the refusal and the collection is left as is.
  it(
    'refuses to rename a time series collection, with or without dropTarget',
    async () => {
      const dest = targetClient.db('shop');
      await dest.createCollection('tsa', { timeseries: { timeField: 't', metaField: 'm' } });
      await dest.collection('tsa').insertOne({ t: new Date(0), m: { s: 'a' }, v: 1 });

      for (const dropTarget of [false, true]) {
        const failure = await renameCollection(targetClient, {
          database: 'shop',
          name: 'tsa',
          newName: 'tsb',
          dropTarget,
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AppErrorException);
        expect(JSON.stringify((failure as AppErrorException).error)).toContain(
          'cannot rename view: shop.tsa',
        );
      }
      expect(await collectionNames(targetClient, 'shop')).toEqual(['tsa']);
      expect(await dest.collection('tsa').countDocuments()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'copies to another database on the same server',
    async () => {
      const final = await runCopy(
        copyOptions({ targetConnectionId: SOURCE_ID, targetDatabase: 'shop2' }),
      );

      expect(final).toMatchObject({ done: true, cancelled: false, documents: 50 });
      expect(final.error).toBeUndefined();
      expect(await sourceClient.db('shop2').collection('orders').countDocuments()).toBe(50);
      expect(await sourceClient.db('shop').collection('orders').countDocuments()).toBe(50);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a same-server copy onto itself without a rename',
    async () => {
      const failure = await service
        .start(copyOptions({ targetConnectionId: SOURCE_ID }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppErrorException);
      expect((failure as AppErrorException).error).toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('writes to a collection it also reads'),
      });
      expect(events).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a production target until the exact database name is typed',
    async () => {
      profiles[TARGET_ID] = profileOf(TARGET_ID, 'Target', true);
      const options = copyOptions({ targetDatabase: 'archive' });

      for (const attempt of [options, { ...options, confirmation: 'Archive' }]) {
        const failure = await service.start(attempt).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AppErrorException);
        expect((failure as AppErrorException).error).toMatchObject({
          code: 'VALIDATION',
          message: expect.stringContaining('is a production connection'),
        });
      }
      expect(events).toEqual([]);
      expect(await collectionNames(targetClient, 'archive')).toEqual([]);

      const final = await runCopy({ ...options, confirmation: 'archive' });
      expect(final).toMatchObject({ done: true, cancelled: false, documents: 50 });
      expect(await targetClient.db('archive').collection('orders').countDocuments()).toBe(50);
    },
    TEST_TIMEOUT_MS,
  );
  it(
    'mongodump prints a bar that parseToolLine reads as documents, and a filtered dump prints a count',
    async () => {
      // mongodump prints a bar only while the dump is unfinished, so the collection must be larger
      // than the first output chunk that the held stream below keeps.
      const contract = sourceClient.db('shop').collection('contract');
      for (let batch = 0; batch < 60; batch++) {
        await contract.insertMany(
          Array.from({ length: BULK_BATCH_SIZE }, (_, index) => ({
            n: batch * BULK_BATCH_SIZE + index,
            padding: 'x'.repeat(100),
          })),
        );
      }
      const mongodump = join(
        toolsDir,
        'bin',
        process.platform === 'win32' ? 'mongodump.exe' : 'mongodump',
      );
      const baseArgs = [
        '--uri',
        source.rootUri,
        '--db',
        'shop',
        '--collection',
        'contract',
        '--archive',
      ];
      // Each run holds its first output chunk for 4 s, as a slow restore does, so it prints progress.
      const dumpLines = async (args: string[]): Promise<string[]> => {
        const lines: string[] = [];
        let released = false;
        const stdout = new Writable({
          write(_chunk, _encoding, callback) {
            if (released) {
              callback();
              return;
            }
            setTimeout(() => {
              released = true;
              callback();
            }, 4_000);
          },
        });
        await runTool({
          spawn,
          binary: mongodump,
          args,
          env: toolEnv(process.env, process.platform),
          cwd: work,
          stdout,
          secrets: [],
          onLine: (_parsed, text) => {
            lines.push(text);
          },
          platform: process.platform,
        });
        return lines;
      };

      const bars = (await dumpLines(baseArgs))
        .map((text) => parseToolLine(text))
        .filter((parsed) => parsed.kind === 'bar');
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) {
        expect(bar).toMatchObject({ kind: 'bar', unit: 'documents', namespace: 'shop.contract' });
      }

      const filtered = await dumpLines([...baseArgs, '--query', '{"n":{"$gte":0}}']);
      expect(filtered.some((text) => /\tshop\.contract\s+\d+$/.test(text))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports processed documents while a tool copy runs, for replace and insert only',
    async () => {
      const live = sourceClient.db('shop').collection('live');
      for (let batch = 0; batch < LIVE_BATCHES; batch++) {
        await live.insertMany(
          Array.from({ length: BULK_BATCH_SIZE }, (_, index) => ({
            n: batch * BULK_BATCH_SIZE + index,
            padding: 'x'.repeat(40),
          })),
        );
      }

      for (const mode of ['replace', 'insertOnly'] as const) {
        const target = mode === 'replace' ? 'live_replace' : 'live_insert';
        const { jobId, final } = await runHeld(
          copyOptions({ mode, items: [{ source: 'live', target }] }),
        );
        expect(final).toMatchObject({ done: true, cancelled: false, documents: LIVE_DOCUMENTS });
        expect(final.elapsedMs).toBeGreaterThan(LIVE_HOLD_MS);

        const processed = progressOf(jobId)
          .filter((progress) => !progress.done)
          .map((progress) => progress.processedDocuments ?? 0);
        // One bar arrives while the dump is unfinished, so a value between 0 and the total is seen.
        expect(processed.some((value) => value > 0 && value < LIVE_DOCUMENTS)).toBe(true);
        let increases = 0;
        for (let index = 1; index < processed.length; index++) {
          const before = processed[index - 1] ?? 0;
          const after = processed[index] ?? 0;
          expect(after).toBeGreaterThanOrEqual(before);
          if (after > before) increases += 1;
        }
        expect(increases).toBeGreaterThanOrEqual(2);
        expect(final.processedDocuments).toBe(LIVE_DOCUMENTS);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
